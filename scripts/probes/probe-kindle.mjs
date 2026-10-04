// Live Kindle walk probe.
//
//   node scripts/probes/probe-kindle.mjs <ASIN> [--depth N] [--batch N] [--bundle]
//
// Reimplements `walkKindleWindows` with a tunable prefetch depth so the effect of
// pipelining can be measured instead of assumed. Read-only: it fetches render
// windows (the walk) and never touches the page CDN, so it is cheap and safe.
import { USER_AGENT } from '../../src/user-agent.js';
import { KINDLE_ORIGIN, kindleRenderUrl, kindleReadTar, kindleWindowAtEnd, kindleWindowMeta, kindleWindowPages, kindleWindowViewCount, KINDLE_RENDER_BATCH_MAX, KINDLE_RENDER_BATCH_MIN, KINDLE_MAX_WINDOWS } from '../../src/download/kindle-protocol.js';
import { openKindleVolume, loadKindleSession } from '../../src/download/kindle.js';

const argv = process.argv.slice(2);
const asin = (argv.find((a) => !a.startsWith('--')) || 'B0SAMPLE02').toUpperCase();
const flag = (name, fallback) => {
    const i = argv.indexOf(name);
    return i >= 0 ? Number(argv[i + 1]) : fallback;
};
const DEPTH = flag('--depth', 3);
const BATCH = flag('--batch', 0);
const BUNDLE = argv.includes('--bundle');
const SAMPLE = argv.includes('--sample');

const session = await loadKindleSession({});
if (!session.cookie) throw new Error('no kindle session');

const fetchWindow = async (state, { skip, numPage }) => {
    const url = kindleRenderUrl({
        asin: state.asin, revision: state.revision, contentType: state.contentType,
        numPage, skipPageCount: skip, startPosition: state.startPosition,
    }) + (BUNDLE ? '&bundleImages=true' : '');
    const response = await fetch(url, {
        redirect: 'follow',
        signal: AbortSignal.timeout(45_000),
        headers: {
            'User-Agent': USER_AGENT,
            'Accept-Language': 'ja-JP,ja;q=0.9,en-US;q=0.8',
            Accept: '*/*',
            ...(session.cookie ? { Cookie: session.cookie } : {}),
            Referer: `${KINDLE_ORIGIN}/`,
            'x-amz-rendering-token': state.token || '',
        },
    });
    if (response.ok) {
        const buffer = Buffer.from(await response.arrayBuffer());
        return { files: kindleReadTar(buffer), bytes: buffer.length };
    }
    const body = await response.text().catch(() => '');
    const error = new Error(`HTTP ${response.status} ${body.slice(0, 120)}`);
    error.status = response.status;
    error.body = body;
    throw error;
};

async function fetchWindowOrShrink(state, skip, startBatch) {
    let size = Math.max(KINDLE_RENDER_BATCH_MIN, Number(startBatch) || KINDLE_RENDER_BATCH_MIN);
    let flipped = false;
    for (;;) {
        const started = performance.now();
        try {
            const { files, bytes } = await fetchWindow(state, { skip, numPage: size });
            state.batch = size;
            return { files, batch: size, ms: performance.now() - started, bytes };
        } catch (error) {
            const ms = performance.now() - started;
            if (error?.status === 400 && !flipped && /rendering token is not matching/i.test(error.body || '')) {
                flipped = true;
                state.contentType = state.contentType === 'Sample' ? 'FullBook' : 'Sample';
                console.error(`  [flip contentType -> ${state.contentType}]`);
                continue;
            }
            if (error?.status === 400 && size > KINDLE_RENDER_BATCH_MIN) {
                console.error(`  [shrink batch ${size} -> ${size >> 1} after ${ms.toFixed(0)}ms]`);
                size = Math.max(KINDLE_RENDER_BATCH_MIN, size >> 1);
                continue;
            }
            throw error;
        }
    }
}

async function walk(state, depth, onWindow) {
    if (state.startPosition === undefined) state.startPosition = 1;
    let batch = state.batch || KINDLE_RENDER_BATCH_MAX;
    let skip = 0;
    let windows = 0;
    const inFlight = new Map();
    let wasted = 0;
    const speculate = (at, size) => {
        if (inFlight.has(at)) return;
        const promise = fetchWindowOrShrink({ ...state }, at, size);
        promise.catch(() => {});
        inFlight.set(at, promise);
    };
    let pageCount = 0;
    let lastPositionId = 0;
    const t0 = performance.now();
    while (windows < KINDLE_MAX_WINDOWS) {
        const speculative = inFlight.get(skip);
        if (speculative) inFlight.delete(skip);
        const t1 = performance.now();
        const got = speculative ? await speculative : await fetchWindowOrShrink(state, skip, batch);
        const waitMs = performance.now() - t1;
        const files = got.files;
        batch = got.batch;
        windows += 1;
        const meta = kindleWindowMeta(files);
        const pages = kindleWindowPages(files);
        const views = kindleWindowViewCount(files);
        if (meta.lastPositionId) lastPositionId = meta.lastPositionId;
        if (meta.pageCount) pageCount = meta.pageCount;
        onWindow({ windows, skip, batch, views, pages: pages.length, ms: got.ms, waitMs, bytes: got.bytes, speculative: Boolean(speculative), t: performance.now() - t0 });
        if (!views) {
            if (windows === 1 && state.startPosition != null) { state.startPosition = null; windows = 0; continue; }
            break;
        }
        if (kindleWindowAtEnd(pages, lastPositionId)) break;
        skip += views;
        if (views < batch) batch = Math.max(KINDLE_RENDER_BATCH_MIN, views);
        for (let ahead = 0; ahead < depth; ahead += 1) speculate(skip + ahead * batch, batch);
    }
    wasted = inFlight.size;
    return { windows, pageCount, ms: performance.now() - t0, wasted, batch };
}

console.error(`opening ${asin}${SAMPLE ? ' (sample)' : ''}...`);
const openT0 = performance.now();
const state = await openKindleVolume(asin, session, { sample: SAMPLE });
console.error(`open: ${(performance.now() - openT0).toFixed(0)}ms title="${state.title}" pages=${state.title ? '' : ''} access=${state.accessMethod} contentType=${state.contentType} revision=${state.revision}`);

if (BATCH) state.batch = BATCH;

const rows = [];
const result = await walk(state, DEPTH, (w) => rows.push(w));
for (const r of rows) {
    console.log(`win ${String(r.windows).padStart(3)} skip=${String(r.skip).padStart(4)} batch=${String(r.batch).padStart(2)} views=${String(r.views).padStart(2)} pages=${String(r.pages).padStart(2)} ${r.speculative ? 'spec' : 'REAL'} fetch=${r.ms.toFixed(0)}ms wait=${r.waitMs.toFixed(0)}ms bytes=${(r.bytes / 1024).toFixed(0)}KiB t=${(r.t / 1000).toFixed(2)}s`);
}
console.error(`\nSUMMARY asin=${asin} depth=${DEPTH} bundle=${BUNDLE} batch=${BATCH || 'auto'} windows=${result.windows} pages=${result.pageCount} wall=${(result.ms / 1000).toFixed(2)}s unawaited=${result.wasted} finalBatch=${result.batch}`);
