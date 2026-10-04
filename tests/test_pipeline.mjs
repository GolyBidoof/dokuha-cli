/**
 * The two-stage pipeline: downloading and the mokuro-bridge are separate pools.
 *
 * A volume used to hold the lane slot it downloaded in until its OCR had finished
 * and its `.mokuro` had uploaded -- which for a remote destination can be minutes --
 * so the network sat idle while later volumes waited for a free worker. The stages
 * now have their own workers and a bounded queue between them.
 *
 * These checks drive the real `run()` with a fake store and a fake bridge, so what
 * is under test is the scheduler: every volume still lands in `results`, the bridge
 * stage really does overlap the next download, and the queue between them is
 * bounded rather than letting a fast store run away from one OCR worker.
 *
 * `io.callAdapter` and `io.connectBridge` are the seams this needs. Both are test
 * hooks in the same spirit as `ctx.fetchImpl` and `ctx.connectSocket`; neither is a
 * user-facing option.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { parseOptions } from '../src/options.js';
import { run } from '../src/run.js';
import { check, checkEqual, finish } from './_harness.mjs';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const now = () => performance.now();

const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dokuha-pipeline-'));

/** Config with everything the scheduler reads, built from the real parser. */
function makeConfig(extra = []) {
    const { config } = parseOptions([
        '--out', outDir, '--quiet', '--no-folder-ingest',
        '--parallel', '2', '--bridge-parallel', '1',
        ...extra,
    ]);
    config.mokuro = true;
    return config;
}

function fakeBridge({ timeline, onBridge }) {
    const client = {
        baseUrl: 'http://127.0.0.1:1',
        async startSession(title) { return { session_id: `sess-${title}` }; },
        async pushPage() { /* no bytes are stored */ },
        async finalize(sessionId, params) {
            timeline.push({ what: 'bridge-start', id: sessionId, t: now() });
            if (onBridge) await onBridge(sessionId);
            else await sleep(80);
            timeline.push({ what: 'bridge-end', id: sessionId, t: now() });
            params.onEvent?.({ stage: 'wait_ocr', pages_ocr_done: 3, pages_received: 3, pages_ocr_pending: 0 });
            return { status: 'success', output_dir: '/out', pages: 3, pages_ocr_done: 3 };
        },
    };
    return async () => ({
        client,
        baseUrl: client.baseUrl,
        health: { mokuro_installed: true },
        destInfo: { method: 'local', params: {} },
        describeDestinations: () => 'local',
    });
}

/** A store adapter that writes three pages and reports a normal record. */
function fakeStore({ timeline, delay = 30 }) {
    return async (task) => {
        timeline.push({ what: 'download-start', id: task.target, t: now() });
        await sleep(delay);
        const folder = path.join(outDir, task.target);
        await fs.promises.mkdir(folder, { recursive: true });
        for (let i = 1; i <= 3; i += 1) {
            await fs.promises.writeFile(path.join(folder, `page-000${i}.jpg`), `page ${i}`);
        }
        timeline.push({ what: 'download-end', id: task.target, t: now() });
        return {
            store: 'cmoa', id: task.target, title: `volume ${task.target}`, folder,
            totalPages: 3, downloaded: 3, skipped: 0, failed: 0, bytes: 21, failures: [],
        };
    };
}

// ---------------------------------------------------------------------------
// 1. Downloads do not wait for the bridge
// ---------------------------------------------------------------------------
{
    const timeline = [];
    // Real-shaped CMOA ids, because `detectSource` has to recognise the positional
    // as a volume for `buildTasks` to publish a task at all.
    const ids = ['0000249001_jp_0001', '0000249001_jp_0002', '0000249001_jp_0003',
        '0000249001_jp_0004', '0000249001_jp_0005', '0000249001_jp_0006'];

    // How many volumes have finished downloading but not finished their bridge
    // work at any moment: the queue depth, seen from outside.
    let inQueue = 0;
    let maxQueued = 0;

    const config = makeConfig();
    const summaryPromise = run(ids, config, {
        out: { write() {} },
        err: { write() {} },
        callAdapter: async (task, ctx) => {
            const record = await fakeStore({ timeline })(task, ctx);
            inQueue += 1;
            maxQueued = Math.max(maxQueued, inQueue);
            return record;
        },
        connectBridge: fakeBridge({
            timeline,
            async onBridge() {
                await sleep(80);
                inQueue -= 1;
            },
        }),
    });

    const { summary } = await summaryPromise;

    checkEqual('every volume is reported', summary.volumes, 6);
    checkEqual('every volume succeeded', summary.succeeded, 6);
    checkEqual('no volume failed', summary.failed, 0);
    checkEqual('every volume carries its bridge result',
        summary.results.filter((r) => r?.mokuro?.ingest === 'pages').length, 6);
    checkEqual('every volume reports the output directory',
        summary.results.filter((r) => r?.mokuro?.outputDir === '/out').length, 6);
    checkEqual('the summary counts the bridge workers', summary.mokuro.parallel, 1);

    // The claim the split exists for: a download starts while an earlier volume is
    // still in the bridge. With one download worker and one bridge worker that can
    // only happen if the lane was released before the bridge work finished.
    const firstBridgeStart = timeline.findIndex((e) => e.what === 'bridge-start');
    const firstBridgeEnd = timeline.findIndex((e) => e.what === 'bridge-end');
    const downloadsBetween = timeline
        .slice(firstBridgeStart + 1, firstBridgeEnd)
        .filter((e) => e.what === 'download-start').length;
    check('a later volume downloads while an earlier one is in the bridge',
        downloadsBetween > 0, timeline.map((e) => `${e.what}:${e.id}`).join(' '));

    // The queue between the two stages is bounded, so a fast store cannot run the
    // whole library onto disk while one OCR worker catches up. The scheduler reports
    // its own peak rather than making the test infer it from the outside.
    check('the queue between the stages stayed inside its bound',
        summary.mokuro.queuePeak <= 4, `peak ${summary.mokuro.queuePeak}`);
    check('the queue actually filled, so the bound was exercised',
        summary.mokuro.queuePeak >= 2, `peak ${summary.mokuro.queuePeak}`);
    check('only the workers and the queue can be unbridged at once',
        maxQueued <= 6, `max ${maxQueued} unbridged`);
}

// ---------------------------------------------------------------------------
// 2. A deferred finalize is still the bridge stage's job
// ---------------------------------------------------------------------------
{
    const timeline = [];
    let finalized = null;
    const config = makeConfig(['--parallel', '1']);

    const { summary } = await run(['0000249001_jp_0009'], config, {
        out: { write() {} },
        err: { write() {} },
        callAdapter: async (task) => {
            const folder = path.join(outDir, task.target);
            await fs.promises.mkdir(folder, { recursive: true });
            await fs.promises.writeFile(path.join(folder, 'page-0001.jpg'), 'page 1');
            // What BookWalker returns when it has already started a session: the
            // download is done but the finalize is explicitly left to the caller.
            return {
                store: 'bookwalker', id: task.target, title: 'archive', folder,
                totalPages: 1, downloaded: 1, skipped: 0, failed: 0, bytes: 7, failures: [],
                mokuro: { bridge: 'http://127.0.0.1:1', sessionId: 'sess-deferred', deferredFinalize: true },
            };
        },
        connectBridge: fakeBridge({ timeline, onBridge: async (id) => { finalized = id; await sleep(10); } }),
    });

    checkEqual('the deferred volume succeeded', summary.succeeded, 1);
    checkEqual('the deferred session was the one finalized', finalized, 'sess-deferred');
    checkEqual('the deferred flag is cleared after finalizing',
        summary.results[0]?.mokuro?.deferredFinalize, false);
    checkEqual('the deferred volume reports its output directory',
        summary.results[0]?.mokuro?.outputDir, '/out');
}

// ---------------------------------------------------------------------------
// 3. Without a bridge nothing is queued and the lanes behave as before
// ---------------------------------------------------------------------------
{
    const timeline = [];
    const { config } = parseOptions(['--out', outDir, '--quiet', '--parallel', '2']);
    config.mokuro = false;

    const { summary } = await run(['0000249001_jp_0011', '0000249001_jp_0012', '0000249001_jp_0013'], config, {
        out: { write() {} },
        err: { write() {} },
        callAdapter: fakeStore({ timeline, delay: 5 }),
        connectBridge: () => { throw new Error('a bridge must not be connected without --mokuro'); },
    });

    checkEqual('a run without --mokuro still downloads everything', summary.succeeded, 3);
    checkEqual('and reports no bridge section', summary.mokuro, null);
    checkEqual('and does not touch the bridge', timeline.filter((e) => e.what.startsWith('bridge')).length, 0);
}

// ---------------------------------------------------------------------------
// 4. A failing volume is still a failed row, and does not stall the queue
// ---------------------------------------------------------------------------
{
    const timeline = [];
    const config = makeConfig(['--parallel', '1']);

    const { code, summary } = await run(['0000249001_jp_0021', '0000249001_jp_0022', '0000249001_jp_0023'], config, {
        out: { write() {} },
        err: { write() {} },
        callAdapter: async (task, ctx) => {
            if (task.target === '0000249001_jp_0022') throw new Error('store exploded');
            return fakeStore({ timeline, delay: 5 })(task, ctx);
        },
        connectBridge: fakeBridge({ timeline, onBridge: () => sleep(5) }),
    });

    checkEqual('a thrown volume is one failed row', summary.failed, 1);
    checkEqual('the failure carries its message',
        summary.results.find((r) => r?.target === '0000249001_jp_0022')?.error, 'store exploded');
    checkEqual('the other volumes still succeed', summary.succeeded, 2);
    checkEqual('a failure exits non-zero', code, 1);
    check('a failed download is not sent to the bridge',
        timeline.filter((e) => e.what === 'bridge-start').length === 2,
        timeline.map((e) => `${e.what}:${e.id}`).join(' '));
}

fs.rmSync(outDir, { recursive: true, force: true });
finish();
