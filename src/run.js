
import path from 'node:path';
import fsp from 'node:fs/promises';

import {
    detectSource,
    isSeriesPage,
    KINDLE_UNLIMITED_LABEL,
    PLATFORMS,
    platformFor,
} from './platforms/index.js';
import { callAdapter, laneOf, resolveSeries, rowLabel, USER_AGENT } from './platforms/index.js';
import { LiveProgress } from './live-progress.js';
import { createPhaseTimer, readPhases } from './phase-timer.js';
import { normalizeStoreResult } from './store-result.js';
import { allocateCpu } from './cpu-budget.js';
import { DEFAULTS } from './options.js';
import { defaultJobCount } from '../vendor/cmoa/src/render_pool.js';
import { createBookwalkerCarrier, prewarmBookwalker } from './download/bookwalker.js';
import { platform as bookwalkerPlatform } from './download/bookwalker.js';
import { platform as kindlePlatform } from './download/kindle.js';
import { connectBridge, finalizeWithProgress, pushToBridge } from './bridge.js';
import { createPool } from './serial.js';
import { resolveDestination, describeDestinations } from '../vendor/ebookjapan/bridge.mjs';

export async function buildTasks(positionals, config, { onRejected = () => {}, onNote = () => {}, onTask, fetchImpl, bwCarrier, kindleSession } = {}) {
    const tasks = [];
    const rejected = [];

    const publish = (task) => {
        task.key = `${task.kind}:${task.target}`;
        tasks.push(task);
        onTask?.(task);
    };

    if (bwCarrier && !config.dryRun && config.series) {
        for (const input of positionals) {
            const det = detectSource(input);
            if (det.kind === 'bookwalker' && det.cid) {
                prewarmBookwalker(bwCarrier, det.cid, config);
                break;
            }
        }
    }

    if (config.series) {
        const entries = positionals.map((input) => ({ input, det: detectSource(input) }));
        for (const entry of entries) {
            if (entry.det.kind === 'unknown') rejected.push({ input: entry.input, error: entry.det.reason });
        }
        const resolvable = entries.filter((entry) => entry.det.kind !== 'unknown');
        const resolveAt = async (entry) => {
            try {
                return await resolveSeries(entry.det, entry.input, { fetchImpl, config, kindleSession, onNote, onTask });
            } catch (error) {

                return { tasks: [], rejected: [{ input: entry.input, error: error.message }], notes: [] };
            }
        };
        const settled = new Array(resolvable.length);
        await Promise.all(resolvable
            .map((entry, index) => ({ entry, index }))
            .filter(({ entry }) => entry.det.kind !== 'kindle')
            .map(async ({ entry, index }) => { settled[index] = await resolveAt(entry); }));
        for (const [index, entry] of resolvable.entries()) {
            if (entry.det.kind === 'kindle') settled[index] = await resolveAt(entry);
        }

        for (const resolved of settled) {

            if (!resolved.streamed) {
                for (const task of resolved.tasks) publish(task);
                for (const note of resolved.notes || []) onNote(note);
            }
            rejected.push(...resolved.rejected);
        }

        for (const r of rejected) onRejected(r);
        return { tasks, rejected };
    }

    for (const input of positionals) {
        const det = detectSource(input);
        if (det.kind === 'unknown') {
            rejected.push({ input, error: det.reason });
            continue;
        }

        const platform = platformFor(det.kind);
        if (isSeriesPage(det) && !platform.expand(det)) {
            rejected.push({ input, error: 'that is a series page; add --series to download its free volumes' });
            continue;
        }

        // A store that can turn a title or launcher URL into a concrete list of
        // volumes says so with `expand`; the rest publish the one volume the input
        // named. `platform.resolve` is only ever called on the strength of that.
        if (platform.expand(det)) {
            const resolved = await platform.resolve(det, config, input, { fetchImpl, userAgent: USER_AGENT });
            for (const note of resolved.notes || []) onNote(note);
            for (const task of resolved.tasks) publish(task);
            rejected.push(...resolved.rejected);
            continue;
        }

        publish({
            input,
            kind: det.kind,
            target: platform.volumeId(det) ?? det.url,
            cid: det.cid,
            asin: det.asin,
            url: det.url,
        });
    }

    for (const r of rejected) onRejected(r);
    return { tasks, rejected };
}

/**
 * Stage one: fetch one volume and leave its pages on disk.
 *
 * Returns the record *and* the per-volume context scope, because stage two needs
 * the same scope's phase timer and the same inherited getters (`jobs`,
 * `normalizeWorkers` are lazy for a reason -- see below).
 */
async function downloadTask(task, ctx) {
    const started = performance.now();
    const record = { input: task.input, kind: task.kind, target: task.target, ok: false, key: task.key };

    // Per-task phase timing. `Object.create` rather than a spread: the context
    // carries lazy getters (`jobs`, `normalizeWorkers`) that must stay live,
    // because the counts they divide by are still growing while a series is
    // being discovered. A spread would freeze them at whatever they were when
    // this volume started.
    const scoped = Object.create(ctx);
    scoped.timer = createPhaseTimer();

    try {
        Object.assign(record, normalizeStoreResult(await ctx.callAdapter(task, scoped), task));
    } catch (error) {
        if (error?.code === 'KINDLE_KU_UNAVAILABLE' && task.kuCandidate) {
            record.skipped = true;
            record.ok = true;
            record.error = '';
            record.seconds = (performance.now() - started) / 1000;
            record.phases = readPhases(scoped.timer);
            record.note = `skipped ${task.target}: ${String(error.message).split('\n')[0]}`;
            scoped.progress?.note?.(record.note);
            return { record, scoped };
        }
        throw error;
    }

    record.seconds = (performance.now() - started) / 1000;
    // Read here, before the bridge: the five phases describe the store download
    // and say nothing about OCR, so attributing bridge time to them would make
    // `phases` disagree with every other store's meaning for the same key.
    record.phases = readPhases(scoped.timer);
    record.ok = !record.failed;
    if (record.title) scoped.progress?.update(task.key, { label: record.title });
    return { record, scoped };
}

/**
 * Stage two: hand a finished volume to mokuro-bridge.
 *
 * Split out of the download on purpose. A volume waiting on OCR -- or uploading a
 * `.mokuro` to MEGA, which can take minutes -- used to hold the lane slot it had
 * downloaded in, so the network sat idle while a later volume waited for a free
 * worker. The two stages now have independent workers and a queue between them, so
 * a volume leaves the download pool as soon as its pages are on disk.
 *
 * Never throws: a bridge failure is a failed volume, not a failed run.
 */
async function bridgeStage(record, ctx) {
    if (!ctx.bridge) return record;

    if (record.mokuro?.deferredFinalize) {
        try {

            const final = await finalizeWithProgress(
                ctx.bridge.client,
                record.mokuro.sessionId,
                record.key,
                ctx.bridge.destInfo,
                {
                    overwrite: ctx.config.overwrite,
                    progress: ctx.progress,
                    ocrWaitMs: ctx.config.ocrWaitSeconds * 1000,
                },
            );
            Object.assign(record.mokuro, {
                deferredFinalize: false,
                outputDir: final?.output_dir || final?.outputDir || null,
            });
        } catch (error) {
            record.mokuro = { ...record.mokuro, deferredFinalize: false, error: error.message };
            record.ok = false;
        }
        return record;
    }

    if (!record.ok) return record;
    try {
        // pushToBridge reports per-page upload failures in the record rather than
        // throwing, so a volume whose pushes mostly failed used to finish ok and
        // exit 0 with a .mokuro built from whatever happened to arrive.
        record.mokuro = await pushToBridge(ctx.bridge.client, ctx.bridge.destInfo, record, {
            pushConcurrency: ctx.config.pushConcurrency,
            ocrWaitMs: ctx.config.ocrWaitSeconds * 1000,
            overwrite: ctx.config.overwrite,
            progress: ctx.progress,
            folderIngest: ctx.config.folderIngest,
        });
        if (record.mokuro?.pagesFailed > 0) record.ok = false;
    } catch (error) {
        record.mokuro = {
            error: error.message,

            stack: String(error.stack || '').split('\n').slice(0, 6).join(' | '),
        };
        record.ok = false;
    }
    return record;
}

export async function run(positionals, config, io = {}) {
    const out = io.out || process.stdout;
    const err = io.err || process.stderr;

    if (!positionals.length) {
        err.write('no URLs given\n\n');
        return { code: 2, summary: null };
    }

    const outDir = path.resolve(config.out);
    const say = (line) => {
        if (!config.quiet && !config.json) err.write(line.endsWith('\n') ? line : `${line}\n`);
    };

    const bwCarrier = createBookwalkerCarrier();

    const wantsPlatform = (id) => positionals.some((input) => platformFor(detectSource(input).kind)?.id === id);
    const kindleSession = wantsPlatform('kindle') ? await kindlePlatform.session.load(config) : null;

    const streaming = !config.dryRun && !config.flat;

    const tasks = [];
    const cpuLane = [];
    const netLane = [];
    const lanes = [cpuLane, netLane];
    const cursors = [0, 0];
    const waiting = [];

    let rejected = [];
    let buildDone = false;
    let buildError = null;

    const notify = () => { while (waiting.length) waiting.shift()(); };
    const waitForWork = () => new Promise((resolve) => waiting.push(resolve));

    let progress = null;
    if (!config.dryRun && !config.quiet && !config.json) {
        progress = new LiveProgress({ quiet: config.quiet, plain: config.noProgress, stream: err });
        progress.startTicker();
    }

    const addTask = (task) => {

        if (!task.key) task.key = `${task.kind}:${task.target}`;
        tasks.push(task);
        (laneOf(task) === 'cpu' ? cpuLane : netLane).push(tasks.length - 1);
        progress?.add(task.key, {

            tag: task.kuCandidate ? KINDLE_UNLIMITED_LABEL : (platformFor(task.kind)?.label || '?'),
            label: rowLabel(task),
        });
        notify();
    };

    if (kindleSession && !kindleSession.cookie) {
        err.write('Kindle needs signed-in read.amazon.co.jp cookies, and none were found.\n');
        err.write(`  ${kindlePlatform.session.hint(kindleSession)}\n`);
        return { code: 2, summary: null };
    }

    if (config.downloadSamplers && !config.series) {
        say('note: --download-samplers only applies with --series; ignoring it');
    }

    if (config.zip && positionals.some((input) => {
        const det = detectSource(input);
        return det.kind !== 'bookwalker' && det.kind !== 'bookwalker-series';
    })) {
        say('note: --zip only applies to BookWalker; other stores write their pages unchanged');
    }

    if (!config.dryRun) await fsp.mkdir(outDir, { recursive: true });

    const build = buildTasks(positionals, config, { onNote: say, onTask: addTask, bwCarrier, kindleSession })
        .then((built) => { rejected = built.rejected; })
        .catch((error) => { buildError = error; })
        .finally(() => { buildDone = true; notify(); });

    if (!streaming) await build;
    if (buildError) throw buildError;

    for (const r of rejected) say(`  skipped ${r.input}: ${r.error}`);

    if (config.dryRun) {

        const kindOf = (t) => (t.kuCandidate ? 'kindle unlimited' : t.kind);
        const width = Math.max(11, ...tasks.map((t) => kindOf(t).length));
        for (const t of tasks) out.write(`${kindOf(t).padEnd(width)}  ${t.target}\n`);
        for (const r of rejected) out.write(`${'unsupported'.padEnd(width)}  ${r.input}  (${r.error})\n`);
        return { code: 0, summary: null };
    }

    if (!streaming && !tasks.length) {
        err.write('no supported volume URLs given\n');
        for (const r of rejected) err.write(`  ${r.input}: ${r.error}\n`);
        return { code: 2, summary: null };
    }

    if (config.flat && tasks.length > 1) {
        throw new Error(`--flat writes every volume into ${outDir}, but page filenames `
            + `restart at 1 in each volume, so ${tasks.length} volumes would overwrite `
            + 'each other. Drop --flat to get one folder per volume.');
    }

    const cores = defaultJobCount();
    // Starting every volume at once was measured worse than running them one after
    // another -- 219 s against 190 s on a mixed ten-volume batch -- because a dozen
    // stores contending for the same disk and the same cores is slower than a few.
    // The default is therefore bounded rather than "all of them": some overlap for
    // the network while others render, without thrashing. An explicit `--parallel`
    // still means exactly what it says.
    const parallel = config.parallel ?? Math.max(1, Math.min(DEFAULTS.parallelCap, Math.floor(cores / 4)));

    // The bridge stage gets its own worker pool. Defaulting to the same width keeps
    // the bridge as loaded as it was when a download slot was spent on OCR, while the
    // download pool carries on -- which is the entire point of the split. The floor of
    // one matters: with no bridge worker the queue fills and every download worker
    // waits on it forever.
    const bridgeParallel = Math.max(1, config.bridgeParallel ?? parallel);

    // Counts every task discovered for that store, whichever lane it landed in and
    // whether or not it has finished -- `tasks` is only ever appended to, so a store
    // that has finished a volume still holds the share it was counted for. Which
    // stores are counted at all is decided by `workerKey`, not by lane: BookWalker
    // runs on the net lane and still takes normalize threads, and the three stores
    // with no workerKey are left out of `active` entirely.
    const kindCount = (kind) => tasks.reduce((n, task) => n + (task.kind === kind ? 1 : 0), 0);
    const sizing = () => allocateCpu({
        cores,
        active: Object.fromEntries(PLATFORMS
            .filter((entry) => entry.workerKey)
            .map((entry) => [entry.workerKey, kindCount(entry.id)])),
        renderJobs: config.jobs ?? null,
    });

    let bridge = null;
    if (config.mokuro) {
        try {
            bridge = await (io.connectBridge || connectBridge)(config, { resolveDestination, describeDestinations });
            say(`bridge ${bridge.baseUrl} (mokuro ${bridge.health.mokuro_installed ? 'ready' : 'MISSING'})`);
            say(`destination ${bridge.destInfo.method}`);
        } catch (error) {
            err.write(`${error.message}\n`);
            progress?.stop?.();
            return { code: 1, summary: null };
        }
    }

    const ctx = {
        out: outDir,
        titleDir: config.titleDir,
        progress,
        bridge,
        config,
        bwCarrier,
        userAgent: USER_AGENT,

        concurrency: config.ebConcurrency,
        cmoaConcurrency: config.cmConcurrency,
        ebConcurrency: config.ebConcurrency,
        bwConcurrency: config.bwConcurrency,

        get jobs() { return sizing().renderJobs; },
        get normalizeWorkers() { return sizing().normalizeWorkers; },
        force: config.force,
        format: config.format,
        quality: config.quality,
        jpegQuality: config.jpegQuality,

        descramble: config.descramble,
        zip: config.zip,

        flat: config.flat,

        retries: config.retries,

        kindleSession,
        kdlConcurrency: config.kdlConcurrency,

        kindleUnlimited: { available: null, csrf: null, offers: new Map() },
        // The store dispatch, injectable so the two-stage scheduler can be tested
        // without a store. `io.callAdapter` is a test seam, not a user-facing knob.
        callAdapter: io.callAdapter || callAdapter,
        // The largest render window the CDN has accepted so far. An object rather
        // than a number because `downloadTask` hands each volume an `Object.create(ctx)`
        // scope: a field written onto that scope is lost when the volume ends, while
        // a mutation of a shared object survives. Kindle's walk seeds itself from it
        // so the shrink ladder runs once per run instead of once per volume.
        kindleBatch: { size: 0 },
        kmConcurrency: config.kmConcurrency,
    };

    const started = performance.now();
    const results = [];

    const finish = (index, task, record) => {
        results[index] = record;
        progress?.finish(task.key, {
            error: record.ok
                ? ''
                : (record.error || record.mokuro?.error || `${record.failed} page(s) failed`),
            bytes: record.bytes || 0,
            returned: record.returned === true,

            tag: record.unlimited === true ? KINDLE_UNLIMITED_LABEL : undefined,
        });
    };

    // The queue between the two stages. Bounded so a fast network cannot run the
    // whole library onto disk while one OCR worker catches up; a download worker
    // that finds it full waits for a bridge worker to take a job.
    const bridgeQueue = [];
    const bridgeWaiting = [];
    let downloadsDone = false;
    let bridgeQueuePeak = 0;
    const bridgeQueueMax = Math.max(1, parallel * 2);

    const notifyBridge = () => { while (bridgeWaiting.length) bridgeWaiting.shift()(); };
    const waitForBridge = () => new Promise((resolve) => bridgeWaiting.push(resolve));

    // Both lanes draw from one gate, so --parallel N really is N volumes in
    // flight. Per-lane pools of `parallel` each meant 2N once two stores were
    // mixed, which is what the help text and the reported summary both deny.
    const inFlight = createPool(parallel);

    const laneWorker = async (laneIndex) => {
        const lane = lanes[laneIndex];
        for (;;) {
            const position = cursors[laneIndex];

            if (position >= lane.length) {
                if (buildDone) return;
                await waitForWork();
                continue;
            }
            cursors[laneIndex] = position + 1;
            const index = lane[position];
            const task = tasks[index];

            let record;
            try {
                ({ record } = await inFlight(() => downloadTask(task, ctx)));
            } catch (error) {
                finish(index, task, {
                    input: task.input,
                    kind: task.kind,
                    target: task.target,
                    key: task.key,
                    ok: false,
                    error: error.message,
                });
                continue;
            }

            if (!ctx.bridge) {
                finish(index, task, record);
                continue;
            }

            while (bridgeQueue.length >= bridgeQueueMax) await waitForBridge();
            bridgeQueue.push({ index, task, record });
            bridgeQueuePeak = Math.max(bridgeQueuePeak, bridgeQueue.length);
            notifyBridge();
        }
    };

    const bridgeWorker = async () => {
        for (;;) {
            const job = bridgeQueue.shift();
            if (job) {
                notifyBridge();
                let record = job.record;
                try {
                    record = await bridgeStage(record, ctx);
                } catch (error) {
                    record = { ...record, ok: false, mokuro: { error: error.message } };
                }
                finish(job.index, job.task, record);
                continue;
            }
            if (downloadsDone) return;
            await waitForBridge();
        }
    };

    const laneWork = Promise.all(lanes.flatMap((lane, laneIndex) => (
        Array.from({ length: parallel }, () => laneWorker(laneIndex))
    ))).then(() => {
        downloadsDone = true;
        notifyBridge();
    });

    const bridgeWork = ctx.bridge
        ? Promise.all(Array.from({ length: bridgeParallel }, () => bridgeWorker()))
        : Promise.resolve();

    try {
        await Promise.all([build, laneWork, bridgeWork]);
    } finally {
        progress?.done();
    }

    if (buildError) throw buildError;

    if (streaming && !tasks.length) {
        err.write('no supported volume URLs given\n');
        for (const r of rejected) err.write(`  ${r.input}: ${r.error}\n`);
        return { code: 2, summary: null };
    }

    const seconds = (performance.now() - started) / 1000;
    const summary = {
        volumes: tasks.length,
        succeeded: results.filter((r) => r?.ok).length,
        failed: results.filter((r) => r && !r.ok).length,
        unsupported: rejected,
        pages: results.reduce((a, r) => a + (r?.downloaded || 0), 0),
        bytes: results.reduce((a, r) => a + (r?.bytes || 0), 0),
        elapsedSeconds: +seconds.toFixed(2),
        outDir,
        parallel,
        mokuro: config.mokuro
            ? {
                bridge: bridge?.baseUrl ?? null,
                destination: bridge?.destInfo.method ?? null,
                volumes: results.filter((r) => r?.mokuro).length,
                parallel: bridgeParallel,
                queuePeak: bridgeQueuePeak,
                ingestedFromFolder: results.filter((r) => r?.mokuro?.ingest === 'folder').length,
            }
            : null,
        results: results.map((r) => r || { ok: false, error: 'not attempted' }),
    };

    if (config.json) {
        out.write(`${JSON.stringify(summary, null, 2)}\n`);
    } else if (!config.quiet) {
        for (const r of summary.results) {
            if (!r.ok) err.write(`  FAILED ${r.title || r.target}: ${r.error || `${r.failed} page(s) failed`}\n`);
        }
        err.write(`\n${summary.succeeded}/${summary.volumes} volumes, ${summary.pages} pages, ${seconds.toFixed(1)}s\n`);
    }

    return { code: summary.failed ? 1 : 0, summary };
}
