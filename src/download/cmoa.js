/**
 * CMOA (Comic Cmoa) support, driving the vendored pure-Node engine.
 *
 * CMOA serves a scrambled "SpeedBinb" viewer. The engine reverses it offline, so
 * this adapter's job is only to resolve what the user asked for into a set of
 * volumes, then download each one and report progress.
 */

import path from 'node:path';
import fsp from 'node:fs/promises';

import { openVolume, downloadVolume } from '../../vendor/cmoa/src/downloader.js';

/** How many volumes to probe at once when expanding a title page. */
const PROBE_CONCURRENCY = 4;

/**
 * Stop scanning a series after this many consecutive missing volumes.
 *
 * A gap is not the end of a series, so stopping at the first miss would silently
 * drop later volumes; but scanning forever costs a request per number, so a run
 * of misses is treated as the end.
 */
const MISS_LIMIT = 4;

/**
 * CMOA content id for a title and volume.
 *
 * The title id is zero-padded to ten digits and the volume to four, so title
 * 167701 volume 2 is `0000167701_jp_0002`. The leading zeroes are pure padding.
 */
export function cmoaCid(titleId, volume) {
    return `${String(titleId).padStart(10, '0')}_jp_${String(volume).padStart(4, '0')}`;
}

/**
 * Retry and timeout options for a single CMOA request.
 *
 * Passing `undefined` lets the engine apply its own default rather than this
 * adapter inventing one, which keeps `--retries` an override instead of a
 * second, quietly-different policy.
 */
function retryOptions(ctx) {
    if (ctx?.retries == null) return {};
    return { retries: ctx.retries };
}

/** The viewer URL CMOA itself uses, kept identical so nothing downstream differs. */
export function cmoaViewerUrl(cid, returnUrl) {
    const back = returnUrl ? `&rurl=${encodeURIComponent(returnUrl)}` : '';
    return `https://www.cmoa.jp/bib/speedreader/?cid=${cid}&u0=1${back}`;
}

/**
 * Probe one cid to see whether that volume exists and can really be read.
 *
 * A missing cid answers `result=-120`, which is the normal end of a series.
 * Checking only that would still accept a volume whose metadata resolves but whose
 * images do not, so the first page is fetched for real as the proof: a metadata
 * call is cheap and can succeed for content the CDN then refuses.
 *
 * @returns {Promise<{cid: string, pages: number, title: string}|null>} null means
 *   "not downloadable". Transient network errors are rethrown rather than
 *   swallowed, so a flaky request is never mistaken for the end of a series.
 */
export async function probeCmoaVolume(cid, ctx = {}) {
    let volume;
    try {
        volume = await openVolume(cid, retryOptions(ctx));
    } catch (error) {
        if (/result=-120|unavailable, expired, or the cid is wrong/i.test(error.message)) return null;
        throw error;
    }
    if (!volume.pageCount) return null;
    try {
        // The cheapest possible proof: one page, smallest acceptable quality.
        // `fetchPage` takes the page object (its `src` is the real image path),
        // not an index; passing 0 sends `src=undefined` and 403s.
        const bytes = await volume.fetchPage(volume.pages[0], { quality: '1' });
        if (!bytes || bytes.length < 1024) return null;
    } catch (error) {
        // A refusal for this one volume is not a reason to abort the scan.
        if (/HTTP 40[13]/.test(error.message)) return null;
        throw error;
    }
    return { cid, pages: volume.pageCount, title: volume.subtitle || volume.title };
}

/**
 * Find every volume of a CMOA series.
 *
 * The list is not published anywhere, so it is discovered by probing in batches.
 */
export async function scanCmoaTitle(titleId, limit, scanCtx = {}) {
    const found = [];
    let misses = 0;
    for (let base = 1; base <= limit && misses < MISS_LIMIT; base += PROBE_CONCURRENCY) {
        const batch = [];
        for (let v = base; v < base + PROBE_CONCURRENCY && v <= limit; v++) {
            batch.push(probeCmoaVolume(cmoaCid(titleId, v), scanCtx).then((r) => ({ v, r })));
        }
        const settled = (await Promise.all(batch)).sort((a, b) => a.v - b.v);
        for (const { v, r } of settled) {
            if (r) {
                found.push({ volume: v, ...r });
                misses = 0;
            } else {
                misses++;
            }
        }
    }
    return found;
}

/**
 * Expand one CMOA input into concrete volume tasks.
 *
 * @param {object} det result from `detectSource`
 * @param {object} config parsed options
 * @returns {Promise<{tasks: object[], rejected: {input: string, error: string}[]}>}
 */
export async function resolveCmoaInput(det, config, input) {
    const wantsAll = /^(all|\*)$/i.test(config.cmVolume);
    const fromFlag = wantsAll
        ? null
        : config.cmVolume.split(',').map((v) => Number(v.trim())).filter((v) => Number.isInteger(v) && v > 0);

    if (!wantsAll && !fromFlag.length) {
        return {
            tasks: [],
            rejected: [{ input, error: `--cm-volume must be a volume number, a comma list, or "all" (got "${config.cmVolume}")` }],
        };
    }

    // A /vol/<n>/ in the URL is more specific than the flag, so it wins: that is
    // the whole point of pasting a volume-specific link.
    const wanted = det.volume != null ? [det.volume] : fromFlag;
    const make = (volume, cid) => ({
        input,
        kind: 'cmoa',
        cid,
        target: cid,
        url: cmoaViewerUrl(cid, det.url),
        fromTitleId: det.titleId,
        volume,
    });

    if (wanted) return { tasks: wanted.map((v) => make(v, cmoaCid(det.titleId, v))), rejected: [] };

    const found = await scanCmoaTitle(det.titleId, config.cmScanLimit, { retries: config.retries });
    if (!found.length) {
        return {
            tasks: [],
            rejected: [{ input, error: `title ${det.titleId} has no readable volumes (nothing responded to volumes 1-${config.cmScanLimit})` }],
        };
    }
    return { tasks: found.map((entry) => make(entry.volume, entry.cid)), rejected: [] };
}

/**
 * Download one CMOA volume.
 *
 * @param {object} task `{ cid, key, title? }`
 * @param {object} ctx `{ out, titleDir, concurrency, jobs, force, format, quality, progress }`
 * @returns {Promise<object>} a uniform store record
 */
export async function downloadCmoa(task, ctx) {
    const volume = await openVolume(task.cid, retryOptions(ctx));
    const title = volume.subtitle || task.cid;

    // Surface the real title immediately: opening the volume costs a round trip,
    // so without this the row shows a bare cid until the download finishes.
    ctx.progress?.update(task.key, { label: title, total: volume.pageCount, phase: 'downloading' });

    const folder = path.join(ctx.out, ctx.titleDir ? safeFolderName(title, task.cid) : task.cid);
    await fsp.mkdir(folder, { recursive: true });

    // Counted locally rather than read back from the display: `--quiet` and
    // `--json` build no display at all, so reaching into it for bookkeeping
    // turned every page into a phantom failure.
    let done = 0;
    let failed = 0;

    const result = await downloadVolume(volume, {
        outDir: folder,
        concurrency: ctx.concurrency,
        jobs: ctx.jobs,
        force: ctx.force,
        format: ctx.format,
        ...(ctx.quality != null ? { quality: String(ctx.quality) } : {}),
        onProgress: (event) => {
            if (event.error) {
                failed += 1;
                ctx.progress?.update(task.key, { failed });
                return;
            }
            done += 1;
            ctx.progress?.update(task.key, { phase: 'downloading', done, total: event.total });
        },
    });

    return {
        store: 'cmoa',
        id: task.cid,
        title,
        subtitle: volume.subtitle,
        folder,
        totalPages: result.total,
        downloaded: result.downloaded,
        skipped: result.skipped,
        failed: result.failed,
        bytes: result.bytes,
        failures: result.failures || [],
    };
}

/**
 * Filesystem-safe folder name.
 *
 * CMOA's `volume.title` is the SEO string ("... ｜ 漫画（マンガ）・電子書籍のコミックシーモア"),
 * so callers pass `subtitle` instead; this only makes it safe to write.
 */
export function safeFolderName(value, fallback = 'volume') {
    const base = String(value ?? '')
        .replace(/[/\\:*?"<>|]+/g, '_')
        .replace(/\s+/g, ' ')
        .trim();
    return base.slice(0, 80).replace(/[. ]+$/, '') || fallback;
}
