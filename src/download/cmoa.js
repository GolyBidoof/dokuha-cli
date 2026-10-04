import fsp from 'node:fs/promises';

import { openVolume, downloadVolume } from '../../vendor/cmoa/src/downloader.js';
import { timed } from '../phase-timer.js';
import { volumeFolder, writeVolumeMarker } from './volume-folder.js';
import { dedupeBy, fetchText, mapLimit, reject } from '../series.js';

const PROBE_CONCURRENCY = 4;

const MISS_LIMIT = 4;

const MAX_SERIES_PAGES = 50;

const ORIGIN = 'https://www.cmoa.jp';

export function cmoaCid(titleId, volume) {
    return `${String(titleId).padStart(10, '0')}_jp_${String(volume).padStart(4, '0')}`;
}

function retryOptions(ctx) {
    if (ctx?.retries == null) return {};
    return { retries: ctx.retries };
}

export function cmoaViewerUrl(cid, returnUrl) {
    const back = returnUrl ? `&rurl=${encodeURIComponent(returnUrl)}` : '';
    return `https://www.cmoa.jp/bib/speedreader/?cid=${cid}&u0=1${back}`;
}

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

        const bytes = await volume.fetchPage(volume.pages[0], { quality: '1' });
        if (!bytes || bytes.length < 1024) return null;
    } catch (error) {

        if (/HTTP 40[13]/.test(error.message)) return null;
        throw error;
    }
    return { cid, pages: volume.pageCount, title: volume.subtitle || volume.title };
}

export async function scanCmoaTitle(titleId, limit, scanCtx = {}) {
    const found = [];
    let misses = 0;
    for (let base = 1; base <= limit && misses < MISS_LIMIT; base += PROBE_CONCURRENCY) {
        const batch = [];
        for (let v = base; v < base + PROBE_CONCURRENCY && v <= limit; v++) {
            batch.push(probeCmoaVolume(cmoaCid(titleId, v), scanCtx)
                .then((r) => ({ v, r }), () => ({ v, r: null })));
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

export async function downloadCmoa(task, ctx) {
    const volume = await timed(ctx.timer, 'handshake', () => openVolume(task.cid, retryOptions(ctx)));
    const title = volume.subtitle || task.cid;

    ctx.progress?.update(task.key, { label: title, total: volume.pageCount, phase: 'downloading' });

    const folder = await volumeFolder(ctx, {
        title,
        id: task.cid,
        sample: task.sample === true,
    });
    await fsp.mkdir(folder, { recursive: true });

    let done = 0;
    let rebuilt = 0;
    let failed = 0;

    if (ctx.timer) {
        const inner = volume.fetchPage.bind(volume);
        volume.fetchPage = (...args) => timed(ctx.timer, 'fetch', () => inner(...args));
    }
    const result = await downloadVolume(volume, {
        outDir: folder,

        concurrency: ctx.cmoaConcurrency ?? ctx.concurrency,
        jobs: ctx.jobs,
        force: ctx.force,
        format: ctx.format,
        ...(ctx.quality != null ? { quality: String(ctx.quality) } : {}),
        ...(ctx.jpegQuality != null ? { jpegQuality: ctx.jpegQuality } : {}),
        onProgress: (event) => {
            if (event.error) {
                failed += 1;
                ctx.progress?.update(task.key, { failed });
                return;
            }
            // The engine owns this loop, so it is the only place that can say how
            // much of a page's time was the CDN and how much was the renderer.
            // Without the split, a CMOA profile shows a fetch figure and a wall time
            // and nothing about where the wall actually went.
            ctx.timer?.add('fetch', event.fetchMs);
            ctx.timer?.add('rebuild', event.renderMs);
            ctx.timer?.add('write', event.writeMs);
            // A page the CDN already served assembled is passed through untouched.
            // Counting them says whether the renderer is doing work at all.
            if (event.descrambled) rebuilt += 1;
            done += 1;
            ctx.progress?.update(task.key, { phase: 'downloading', done, total: event.total });
        },
    });

    await timed(ctx.timer, 'write', () => writeVolumeMarker(folder, { store: 'cmoa', id: task.cid, title }));

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
        rebuilt,
    };
}

export async function resolveCmoaSeries(det, input, options = {}) {
    const ctx = { ...options, origin: ORIGIN };
    const titleId = det.titleId || cmoaTitleIdFromCid(det.cid);
    if (!titleId) return reject(input, `could not read a CMOA title id out of "${input}"`);

    const pageUrl = (page) => `${ORIGIN}/title/${titleId}/?order=up${page > 1 ? `&page=${page}` : ''}`;

    const first = parseCmoaSeriesPage(await fetchText(pageUrl(1), ctx), titleId);
    if (!first.volumes.length) {
        return reject(input, `CMOA title ${titleId} listed no volumes on its title page`);
    }

    const last = Math.min(first.lastPage, MAX_SERIES_PAGES);
    const rest = await mapLimit(
        Array.from({ length: Math.max(0, last - 1) }, (_, i) => i + 2),
        PROBE_CONCURRENCY,
        async (page) => parseCmoaSeriesPage(await fetchText(pageUrl(page), ctx), titleId).volumes,
    );
    const volumes = dedupeBy(first.volumes.concat(...rest), (v) => v.volume);
    const free = volumes.filter((v) => v.free);
    const samplers = ctx.samplers ? volumes.filter((v) => !v.free && v.sample) : [];

    if (!free.length && !samplers.length) {
        const tail = ctx.samplers ? ', and it offers no 試し読み samplers either' : ' right now';
        return reject(input, `CMOA title ${titleId} has ${volumes.length} volumes and none of them are free${tail}`);
    }

    const make = (v, sample) => ({
        input,
        kind: 'cmoa',
        cid: v.cid,
        target: v.cid,
        url: cmoaViewerUrl(v.cid, det.url),
        volume: v.volume,
        fromTitleId: titleId,
        fromSeries: true,
        ...(sample ? { sample: true } : {}),
    });
    const tasks = free.map((v) => make(v, false)).concat(samplers.map((v) => make(v, true)));
    const note = `CMOA title ${titleId}: ${free.length} of ${volumes.length} volumes are free`
        + (samplers.length ? `, plus ${samplers.length} 試し読み samplers` : '');
    return { tasks, rejected: [], notes: [note] };
}

export const platform = {
    name: 'CMOA',
    id: 'cmoa',
    label: 'CMOA',
    lane: 'cpu',
    workerKey: 'cmoa',
    patterns: [
        { re: /cmoa\.jp\/title\/(\d+)\/vol\/(\d+)/i, kind: 'cmoa-title',
            build: (m, raw) => ({ kind: 'cmoa-title', titleId: m[1], volume: Number(m[2]), url: raw }) },
        { re: /cmoa\.jp\/title\/(\d+)/i, kind: 'cmoa-title',
            build: (m, raw) => ({ kind: 'cmoa-title', titleId: m[1], volume: null, url: raw }) },
        { re: /cmoa\.jp\/bib\/speedreader\/?\?[^\s]*?cid=(\d{10}_jp_\d{4})/i, kind: 'cmoa',
            build: (m, raw) => ({ kind: 'cmoa', cid: m[1], url: raw }) },
        { re: /^(\d{10}_jp_\d{4})$/, kind: 'cmoa',
            build: (m, raw) => ({ kind: 'cmoa', cid: m[1], url: raw }) },
    ],
    volumeId: (det) => det.cid ?? null,
    expand: (det) => det.kind === 'cmoa-title',
    resolve: resolveCmoaInput,
    series: resolveCmoaSeries,
    download: downloadCmoa,
};

export function parseCmoaLastPage(html) {
    let last = 1;
    for (const m of String(html ?? '').matchAll(/order=[a-z]+(?:&amp;|&)page=(\d+)/gi)) {
        const page = Number(m[1]);
        if (page > last) last = page;
    }
    return last;
}

export function parseCmoaSeriesPage(html, titleId) {
    const body = String(html ?? '');

    const marker = '<div class="title_vol_vox_vols_i clearfix"';
    const listAt = body.indexOf('id="comic_list"');
    const firstBlock = body.indexOf(marker, listAt >= 0 ? listAt : 0);
    const endAt = firstBlock >= 0 ? body.indexOf('class="pagination"', firstBlock) : -1;
    const scope = firstBlock >= 0
        ? body.slice(firstBlock, endAt > firstBlock ? endAt : body.length)
        : '';

    const padded = String(titleId).padStart(10, '0');
    const volumes = [];
    for (const block of scope.split(marker).slice(1)) {

        const contentId = (/_content_id="(\d+)"/.exec(block) || [])[1] || '';
        const chapter = (/_chapter_no_s="(\d+)"/.exec(block) || [])[1] || '';
        const composed = /^1(\d{10})(\d{4})$/.exec(contentId);
        const volume = composed && composed[1] === padded
            ? Number(composed[2])
            : (chapter ? Number(chapter) : null);
        if (!volume || volume < 1) continue;

        const free = /GA_free btn free/.test(block) && block.includes('無料で読む');

        const sample = /\/reader\/sample\//.test(block);
        volumes.push({ volume, cid: cmoaCid(titleId, volume), free, sample });
    }

    return { volumes: dedupeBy(volumes, (v) => v.volume), lastPage: parseCmoaLastPage(body) };
}

export function cmoaTitleIdFromCid(cid) {
    const m = /^(\d{10})_jp_\d{4}$/.exec(String(cid ?? ''));
    return m ? String(Number(m[1])) : null;
}
