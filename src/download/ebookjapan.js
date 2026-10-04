
import fsp from 'node:fs/promises';
import path from 'node:path';
import { collectPages } from '../../vendor/ebookjapan/page-list.mjs';
import { fetchWithRetry } from '../../vendor/ebookjapan/download.mjs';
import { loadGlue } from '../../vendor/ebookjapan/wasm.mjs';
import { assertSharpAvailable, composePage, recordShuffle, sharpAvailable } from './ebj-descramble.js';
import { safeFolderName, volumeFolder, writeVolumeMarker } from './volume-folder.js';
import { timed } from '../phase-timer.js';
import { adoptLegacyPages, pageFileName, stampPageTimes } from './page-files.js';
import { createSerialQueue } from '../serial.js';
import {
    EBJ_ORIGIN,
    ebookjapanVolumes,
    fetchEbookjapanDetail,
    fetchText,
    parseEbookjapanFreeVolumes,
    parseEbookjapanSamplerVolumes,
    parseEbookjapanSeriesPage,
    reject,
} from '../series.js';

const REFRESH_PASSES = 2;

const DEFAULT_RETRIES = 4;

const DEFAULT_CONCURRENCY = 32;

const MAX_CONCURRENCY = 256;

const EBJ_MAX_SEEDS = 8;

const collectExclusive = createSerialQueue();

function collectPagesSerial(target, { descramble = false, onUnknown, onNote, timer = null } = {}) {
    return collectExclusive(async () => {
        // The licence and the page list are the handshake; loading the descrambler's
        // WASM module and building the per-page shuffle table is preparation. The
        // second is not a store round trip at all, and on a cold cache the first is a
        // multi-megabyte download that used to be hidden inside `handshake`.
        const book = await timed(timer, 'handshake', () => collectPages(target, { quiet: true, onNote }));
        if (!descramble || !book?.totalPages) return { book, tiles: null };

        const tiles = [];
        const unknown = new Set();
        await timed(timer, 'prework', async () => {
            const glue = await loadGlue({ onNote });
            for (let i = 0; i < book.totalPages; i++) {
                const page = book.pages[i] || {};
                const recorded = recordShuffle(glue, i, { width: page.width || 0, height: page.height || 0 });
                for (const name of recorded.unknown) unknown.add(name);
                tiles.push(recorded.ops);
            }
            if (unknown.size && onUnknown) onUnknown([...unknown]);
        });
        return { book, tiles };
    });
}

const MANIFEST_FILE = 'manifest.json';

async function readEbookjapanManifest(folder) {
    const read = (name) => fsp.readFile(path.join(folder, name), 'utf8')
        .then((text) => JSON.parse(text), () => null);
    return await read(MANIFEST_FILE) || await read('metadata.json');
}

// The store's title arrives in whatever normalisation form it likes, and a
// title of "." or ".." would otherwise walk the folder out of --out, so this
// goes through the shared sanitiser rather than a second, looser rule-set.
const safeName = (value) => safeFolderName(String(value ?? '').normalize('NFC'), 'ebookjapan-volume');

async function isCompleteImage(file, size, extension) {
    let fh;
    try {
        fh = await fsp.open(file, 'r');
        const head = Buffer.alloc(12);
        const { bytesRead } = await fh.read(head, 0, 12, 0);
        if (bytesRead < 12) return false;
        if (extension === 'webp') {
            if (head.toString('latin1', 0, 4) !== 'RIFF') return false;
            if (head.toString('latin1', 8, 12) !== 'WEBP') return false;
        } else if (head[0] !== 0xff || head[1] !== 0xd8 || head[2] !== 0xff) {
            return false;
        }

        return head.readUInt32LE(4) + 8 === size;
    } catch {
        return false;
    } finally {
        await fh?.close().catch(() => {});
    }
}

function tell(progress, method, ...args) {
    if (typeof progress?.[method] !== 'function') return;
    try {
        progress[method](...args);
    } catch {

    }
}

function warn(progress, message) {
    if (typeof progress?.note === 'function') {
        tell(progress, 'note', message);
        return;
    }
    process.stderr.write(`${message}\n`);
}

function boxOf(row) {
    return { width: Number(row?.width) || 0, height: Number(row?.height) || 0 };
}

export async function downloadEbookjapan(task, ctx = {}) {
    const target = typeof task === 'string' ? task : task?.target;
    if (!target) throw new Error('ebookjapan: no target given');

    const key = task?.key || target;
    const out = ctx.out;
    if (!out) throw new Error('ebookjapan: ctx.out is required');

    let descramble;
    if (ctx.descramble === false) {
        descramble = false;
    } else if (ctx.descramble === true) {
        assertSharpAvailable();
        descramble = true;
    } else if (sharpAvailable()) {
        descramble = true;
    } else {
        descramble = false;
        warn(ctx.progress,
            'ebookjapan: pages are tile-scrambled and the optional "sharp" dependency is not installed,\n'
            + '  so the scrambled mosaic will be written as downloaded.\n'
            + '  Install it with:  npm install sharp');
    }

    const concurrency = Math.max(1, Math.min(MAX_CONCURRENCY,
        Number(ctx.ebConcurrency ?? ctx.concurrency) || DEFAULT_CONCURRENCY));

    const wanted = ctx.retries === undefined || ctx.retries === null ? DEFAULT_RETRIES : Number(ctx.retries);
    const retries = Number.isFinite(wanted) ? Math.max(0, wanted) : DEFAULT_RETRIES;
    const force = Boolean(ctx.force);
    const progress = ctx.progress;

    tell(progress, 'update', key, {
        label: task?.title || key,
        phase: 'downloading',
        total: 0,
        done: 0,
        failed: 0,
        bytes: 0,
    });

    // Not wrapped in `handshake` from here: `collectPagesSerial` times its own
    // handshake (licence + page list) and prework (WASM module + shuffle table)
    // separately, and an outer wrapper would swallow both into one number.
    const { book, tiles } = await collectPagesSerial(target, {
        descramble,
        timer: ctx.timer,
        onNote: (line) => warn(progress, line),
        onUnknown: (names) => warn(progress,
            `ebookjapan: page composition does not implement ${names.join(', ')}; `
            + 'the rebuilt pages may be wrong'),
    });
    if (!book?.totalPages) throw new Error(`ebookjapan: no pages found for ${target}`);

    const id = book.publication || book.code || book.fileId || String(target);
    const folder = await volumeFolder(ctx, {
        title: book.name,
        id,
        sample: task.sample === true,
        sanitize: safeName,
    });
    await fsp.mkdir(folder, { recursive: true });

    // A scrambled page is written as the store sent it, which is WebP. A rebuilt
    // one is ours to choose, and it is JPEG unless WebP is asked for: the source is
    // lossy, so there is nothing for a lossless codec to preserve, and every other
    // store's pages are JPEG.
    const format = ctx.format === 'webp' ? 'webp' : 'jpeg';
    const extension = descramble ? (format === 'jpeg' ? 'jpg' : 'webp') : 'webp';

    await adoptLegacyPages(folder, { count: book.totalPages, extension });

    const rows = book.pages.map((page, i) => ({
        ...page,
        file: pageFileName(i + 1, extension),
    }));

    const previous = force
        ? null
        : await readEbookjapanManifest(folder);
    const reuseExisting = !force && Boolean(previous?.descrambled) === descramble;

    tell(progress, 'update', key, { label: book.name || key, total: rows.length });

    const startedAt = performance.now();
    let next = 0;
    let settled = 0;
    let downloaded = 0;
    let skipped = 0;
    let failed = 0;
    let bytes = 0;

    const claim = () => (next < rows.length ? next++ : -1);

    const worker = async () => {
        for (;;) {
            const i = claim();
            if (i < 0) return;
            const row = rows[i];
            const dest = path.join(folder, row.file);

            if (reuseExisting) {

                const st = await fsp.stat(dest).catch(() => null);
                if (st && st.size > 0 && await isCompleteImage(dest, st.size, extension)) {
                    row.bytes = st.size;
                    bytes += st.size;
                    skipped++;
                    settled++;
                    tell(progress, 'update', key, { done: settled, skipped, bytes });
                    continue;
                }
            }

            if (!row.url) {
                row.error = 'no url';
                failed++;
            } else {
                try {
                    const buf = await timed(ctx.timer, 'fetch', () => fetchWithRetry(row.url, retries));

                    const composed = descramble
                        ? await timed(ctx.timer, 'rebuild',
                            () => composePage(buf, tiles[i], boxOf(rows[i]), { format }))
                        : null;
                    if (descramble && !composed) throw new Error('page composition produced no plan');
                    const data = composed ? composed.data : buf;
                    await timed(ctx.timer, 'write', () => fsp.writeFile(dest, data));
                    row.bytes = data.length;
                    bytes += data.length;
                    downloaded++;
                } catch (error) {
                    row.error = error.message;
                    failed++;
                }
            }
            settled++;
            tell(progress, 'update', key, { done: settled, failed, bytes });
        }
    };

    await Promise.all(Array.from({ length: Math.min(concurrency, rows.length) }, worker));

    for (let pass = 1; pass <= REFRESH_PASSES && failed > 0; pass++) {
        const retryable = rows.filter((row) => row.error);
        if (!retryable.length) break;

        let fresh;
        try {

            // A refresh pass re-reads the page list, so it is handshake time again;
            // `descramble: false` means no prework -- no module load, no shuffle table.
            fresh = (await collectPagesSerial(target, { descramble: false, timer: ctx.timer })).book;
        } catch {

            break;
        }

        let revived = 0;
        for (const row of retryable) {
            const url = fresh.pages?.[row.page]?.url;
            if (url) {
                row.url = url;
                row.error = '';
                revived++;
            }
        }
        if (!revived) break;

        tell(progress, 'note', `${book.name}: ${retryable.length} page(s) failed, retrying with fresh URLs`);

        let rnext = 0;
        const rclaim = () => (rnext < retryable.length ? rnext++ : -1);
        const retryWorker = async () => {
            for (;;) {
                const i = rclaim();
                if (i < 0) return;
                const row = retryable[i];
                try {
                    const buf = await timed(ctx.timer, 'fetch', () => fetchWithRetry(row.url, retries));
                    const composed = descramble
                        ? await timed(ctx.timer, 'rebuild',
                            () => composePage(buf, tiles[row.page], boxOf(row), { format }))
                        : null;
                    if (descramble && !composed) throw new Error('page composition produced no plan');
                    const data = composed ? composed.data : buf;
                    await timed(ctx.timer, 'write', () => fsp.writeFile(path.join(folder, row.file), data));
                    row.bytes = data.length;
                    bytes += data.length;
                    downloaded++;
                    failed--;
                } catch (error) {
                    row.error = error.message;
                }

                tell(progress, 'update', key, { done: settled, failed, bytes, phase: 'downloading' });
            }
        };
        await Promise.all(Array.from({ length: Math.min(concurrency, retryable.length) }, retryWorker));
    }

    const elapsedSeconds = +((performance.now() - startedAt) / 1000).toFixed(2);

    tell(progress, 'update', key, {
        ...(ctx.bridge ? {} : { phase: 'finalizing' }),
        done: rows.length,
        failed,
        bytes,
    });

    const manifest = {
        source: target,
        title: book.name,
        publication: book.publication,
        code: book.code,
        fileId: book.fileId,
        direction: book.direction,
        version: book.version,
        imageTypes: book.imageTypes,
        chapters: book.chapters,
        totalPages: book.totalPages,
        concurrency,

        descrambled: descramble,
        elapsedSeconds,
        bytes,
        pages: rows,
    };

    await fsp.writeFile(path.join(folder, MANIFEST_FILE), JSON.stringify(manifest, null, 2));
    await writeVolumeMarker(folder, {
        store: 'ebookjapan',
        id,
        title: book.name || task?.title || String(target),
    });

    if (!downloaded && !skipped) {
        throw new Error(`ebookjapan: every one of the ${rows.length} pages of ` +
            `"${book.name}" failed to download`);
    }

    if (downloaded) await stampPageTimes(folder, rows.map((row) => row.file));

    return {
        store: 'ebookjapan',
        id: book.publication || book.code || book.fileId || String(target),
        title: book.name || task?.title || String(target),
        folder,
        totalPages: rows.length,
        downloaded,
        skipped,
        failed,
        bytes,
        failures: rows.filter((row) => row.error).map((row) => ({ file: row.file, error: row.error })),
    };
}

export async function resolveEbookjapanSeries(det, input, ctx = {}) {
    const titleId = det.titleId || (/\/books\/(\d+)/.exec(det.url || input) || [])[1] || null;
    if (!titleId) {
        return reject(input, 'an ebookjapan series needs a /books/<title>/ URL; a bare code does not name its series');
    }

    let seeds = det.publication ? [det.publication] : [];
    if (!seeds.length) {
        seeds = parseEbookjapanSeriesPage(await fetchText(`${EBJ_ORIGIN}/books/${titleId}/`, ctx))
            .slice(0, EBJ_MAX_SEEDS);
        if (!seeds.length) {
            return reject(input, `ebookjapan title ${titleId}: its page listed no publications to resolve from`);
        }
    }

    for (const seed of seeds) {
        const body = await fetchEbookjapanDetail(titleId, seed, ctx);
        if (!body || String(body.detail.title?.id) !== String(titleId)) continue;

        const free = parseEbookjapanFreeVolumes(body);
        const samplers = ctx.samplers ? parseEbookjapanSamplerVolumes(body) : [];
        const total = ebookjapanVolumes(body).length;
        if (!free.length && !samplers.length) {
            const tail = ctx.samplers ? ', and it offers no 試し読み samplers either' : ' right now';
            return reject(input, `ebookjapan title ${titleId} has ${total} editions and none of them are free${tail}`);
        }

        const make = (entry, sample) => ({
            input,
            kind: 'ebookjapan',
            target: sample ? `${EBJ_ORIGIN}/viewer/trial/${entry.code}/` : entry.code,
            url: `${EBJ_ORIGIN}/books/${titleId}/${entry.publication}/`,
            title: entry.name,
            order: entry.order,
            fromSeries: true,
            ...(sample ? { sample: true } : {}),
        });
        const tasks = free.map((entry) => make(entry, false)).concat(samplers.map((entry) => make(entry, true)));
        const note = `ebookjapan title ${titleId}: ${free.length} of ${total} volumes are free`
            + (samplers.length ? `, plus ${samplers.length} 試し読み samplers` : '');
        return { tasks, rejected: [], notes: [note] };
    }

    return reject(input, `ebookjapan title ${titleId}: no edition of it could be resolved`);
}

export const platform = {
    name: 'ebookjapan',
    id: 'ebookjapan',
    label: 'EBJ',
    lane: 'net',
    patterns: [
        { re: /ebookjapan\.yahoo\.co\.jp\/books\/(\d+)\/([A-Za-z0-9]+)/i, kind: 'ebookjapan',
            build: (m, raw) => ({ kind: 'ebookjapan', titleId: m[1], publication: m[2], url: raw }) },
        { re: /ebookjapan\.yahoo\.co\.jp\/books\/(\d+)\/?(?:[?#]|$)/i, kind: 'ebookjapan-title',
            build: (m, raw) => ({ kind: 'ebookjapan-title', titleId: m[1], url: raw }) },
        { re: /ebookjapan\.yahoo\.co\.jp/i, kind: 'ebookjapan',
            build: (m, raw) => ({ kind: 'ebookjapan', url: raw }) },
        { re: /^(B\d{6,})$/, kind: 'ebookjapan',
            build: (m, raw) => ({ kind: 'ebookjapan', code: m[1], url: raw }) },
        { re: /^(A\d{6,})$/, kind: 'unknown',
            build: (m, raw) => ({
                kind: 'unknown',
                url: raw,
                reason: `${raw} is an ebookjapan publication code, and a publication does not name `
                    + 'its own title, so its reading code cannot be resolved from it alone; '
                    + `paste the https://ebookjapan.yahoo.co.jp/books/<title>/${raw}/ URL instead`,
            }) },
    ],
    volumeId: (det) => det.code ?? null,
    expand: () => false,
    series: resolveEbookjapanSeries,
    download: downloadEbookjapan,
};
