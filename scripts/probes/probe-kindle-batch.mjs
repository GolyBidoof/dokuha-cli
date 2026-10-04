// What is the Kindle render service's real per-request page limit, and what does it
// say when you exceed it? Also tests bundleImages.
//
//   node scripts/probes/probe-kindle-batch.mjs <ASIN>
import { USER_AGENT } from '../../src/user-agent.js';
import { KINDLE_ORIGIN, kindleRenderUrl, kindleReadTar, kindleWindowViewCount, kindleWindowMeta } from '../../src/download/kindle-protocol.js';
import { openKindleVolume, loadKindleSession } from '../../src/download/kindle.js';

const asin = (process.argv[2] || 'B0SAMPLE02').toUpperCase();
const session = await loadKindleSession({});
const state = await openKindleVolume(asin, session);
console.error(`opened ${asin} revision=${state.revision} contentType=${state.contentType}`);

async function one(numPage, { bundle = false, skip = 0 } = {}) {
    const url = kindleRenderUrl({
        asin: state.asin, revision: state.revision, contentType: state.contentType,
        numPage, skipPageCount: skip, startPosition: state.startPosition,
    }) + (bundle ? '&bundleImages=true' : '');
    const t0 = performance.now();
    const response = await fetch(url, {
        redirect: 'follow', signal: AbortSignal.timeout(45_000),
        headers: {
            'User-Agent': USER_AGENT, Accept: '*/*', 'Accept-Language': 'ja-JP,ja;q=0.9',
            Cookie: session.cookie, Referer: `${KINDLE_ORIGIN}/`,
            'x-amz-rendering-token': state.token || '',
        },
    });
    const ms = performance.now() - t0;
    if (!response.ok) {
        const body = await response.text().catch(() => '');
        return { status: response.status, ms, body: body.replace(/\s+/g, ' ').slice(0, 300) };
    }
    const buf = Buffer.from(await response.arrayBuffer());
    if (bundle) {
        return { status: 200, ms, bytes: buf.length, magic: buf.toString('latin1', 0, 8), head: buf.toString('latin1', 0, 120).replace(/[^\x20-\x7e]/g, '.') };
    }
    const files = kindleReadTar(buf);
    const meta = kindleWindowMeta(files);
    return { status: 200, ms, bytes: buf.length, views: kindleWindowViewCount(files), members: files.size, pageCount: meta.pageCount };
}

console.log('--- numPage sweep, skip=0 ---');
for (const n of [2, 4, 6, 7, 8, 10, 12, 16, 24, 32, 48]) {
    const r = await one(n).catch((e) => ({ error: e.message }));
    console.log(`numPage=${String(n).padStart(3)} ${JSON.stringify(r)}`);
}

console.log('--- skip far in, numPage sweep (is the limit positional?) ---');
for (const n of [6, 12, 24]) {
    const r = await one(n, { skip: 120 }).catch((e) => ({ error: e.message }));
    console.log(`skip=120 numPage=${String(n).padStart(3)} ${JSON.stringify(r)}`);
}

console.log('--- bundleImages ---');
for (const n of [2, 6]) {
    const r = await one(n, { bundle: true }).catch((e) => ({ error: e.message }));
    console.log(`bundle numPage=${n} ${JSON.stringify(r)}`);
}
