// Live k-manga transport probe.
//
//   node scripts/probes/probe-kmanga.mjs [--sockets N] [--depth D] [--vol N] [--no-header]
//
// Measures the viewer-socket transport of one free volume, with the page bytes
// counted but not written and not descrambled, so what is timed is the store's own
// pacing. Reuses the shipped `drainPages` so the scheduling under test is the real
// one; only the number of sockets and the pipeline depth change.
import { connectWebSocket } from '../../src/download/kmanga-ws.js';
import {
    KM_WS_URL, KM_PROFILES, buildHeaderRequest, parseFrame,
} from '../../src/download/kmanga-protocol.js';
import { KM_ORIGIN, drainPages, fetchKmangaIndex, openKmangaSession, resolveKmangaInput } from '../../src/download/kmanga.js';

const argv = process.argv.slice(2);
const flag = (name, fallback) => {
    const i = argv.indexOf(name);
    return i >= 0 ? Number(argv[i + 1]) : fallback;
};
const SOCKETS = flag('--sockets', 1);
const DEPTH = flag('--depth', 16);
const VOL = flag('--vol', 0);
const PAGES = flag('--pages', 0);
const NO_HEADER = argv.includes('--no-header');

const det = { kind: 'kmanga-title', bookId: '167001' };
const resolved = await resolveKmangaInput(det, { series: true, samplers: false }, 'probe', {});
const free = resolved.tasks.filter((t) => !t.sample);
const task = free[VOL];
if (!task) throw new Error(`no free volume at index ${VOL} (${free.length} available)`);
console.error(`volume ${task.volume}: ${task.title}\n  ${task.launcher}`);

const t0 = performance.now();
const { cookies, session } = await openKmangaSession(task.launcher, {});
const sessionMs = performance.now() - t0;
console.error(`session: ${sessionMs.toFixed(0)}ms ticket=${session.ticket?.slice(0, 12)}…`);

const ti = performance.now();
const index = await fetchKmangaIndex(session, cookies, {});
const indexMs = performance.now() - ti;
console.error(`index: ${indexMs.toFixed(0)}ms chapters=${index?.chapters?.length ?? '-'} (used only for the volume marker)`);

const manifold = async (socket, doHeader) => {
    const hello = await socket.next(30_000);
    if (!parseFrame(hello.payload).hello) throw new Error('no hello');
    if (!doHeader) return null;
    socket.send(buildHeaderRequest({ ticket: session.ticket, obfuid: session.obfuid, profile: KM_PROFILES[0] }));
    const reply = await socket.next(30_000);
    const frame = parseFrame(reply.payload);
    if (frame.chunks !== null) throw new Error('header reply carried image data');
    return frame.body;
};

const tsock = performance.now();
const socket0 = await connectWebSocket(KM_WS_URL, { origin: KM_ORIGIN });
const manifest = await manifold(socket0, true);
console.error(`socket 0 + manifest: ${(performance.now() - tsock).toFixed(0)}ms pages=${manifest.contentInfos.length} dk=${manifest.dk ? 'yes' : 'no'}`);

const pages = manifest.contentInfos.slice().sort((a, b) => Number(a.startSceneNo) - Number(b.startSceneNo)).slice(0, PAGES || undefined);
const work = pages.map((entry, i) => ({ index: i, entry, sceneNo: Number(entry.startSceneNo) }));

const sockets = [socket0];
const extraT0 = performance.now();
for (let k = 1; k < SOCKETS; k += 1) {
    const s = await connectWebSocket(KM_WS_URL, { origin: KM_ORIGIN });
    const m = await manifold(s, !NO_HEADER);
    if (m && m.dk && m.dk !== manifest.dk) console.error(`  !! socket ${k} returned a different dk`);
    sockets.push(s);
}
if (SOCKETS > 1) console.error(`extra sockets: ${(performance.now() - extraT0).toFixed(0)}ms for ${SOCKETS - 1}`);

// Warm the manifest so every socket has it, then shard the page list.
const shards = Array.from({ length: SOCKETS }, () => []);
work.forEach((item, i) => shards[i % SOCKETS].push(item));

let bytes = 0;
let pagesDone = 0;
const started = performance.now();
const results = await Promise.all(shards.map((shard, k) => drainPages({
    socket: sockets[k],
    session,
    manifest,
    work: shard,
    depth: DEPTH,
    processLimit: 4,
    onPage: async (item, frame) => {
        const chunk = frame.chunks?.[0];
        bytes += chunk?.length || 0;
        pagesDone += 1;
    },
})));
const ms = performance.now() - started;

for (const s of sockets) s.close();
const errors = results.flat();
console.error(`\nARM ${JSON.stringify({
    sockets: SOCKETS, depth: DEPTH, header: !NO_HEADER, vol: task.volume,
    pages: pagesDone, of: work.length, mib: +(bytes / 1048576).toFixed(1),
    wall: +(ms / 1000).toFixed(2), perPage: Math.round(ms / Math.max(1, pagesDone)),
    sessionMs: Math.round(sessionMs), indexMs: Math.round(indexMs), errors: errors.length,
})}`);
if (errors.length) console.error(`  first error: ${errors[0].error.message}`);
