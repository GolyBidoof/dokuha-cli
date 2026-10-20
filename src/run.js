
import path from 'node:path';
import fsp from 'node:fs/promises';

import {
    concurrencyContext,
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
import { defaultJobCount } from '../vendor/cmoa/src/render_pool.js';
import { describeError } from './retry.js';
import { createBookwalkerCarrier, prewarmBookwalker } from './download/bookwalker.js';
import { platform as bookwalkerPlatform } from './download/bookwalker.js';
import { platform as kindlePlatform } from './download/kindle.js';
import { existingVolume } from './download/existing-volume.js';
import { bridgeSessionState, connectBridge, finalizeWithProgress, normalizeUploads, pageFiles, pushToBridge, resumeExistingSession } from './bridge.js';
import { createPool } from './serial.js';
import { BridgeClient, discoverBridge, resolveDestination, describeDestinations } from '../vendor/ebookjapan/bridge.mjs';

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
                // Held rather than rejected: --series has to tolerate mixed input, and a
                // volume whose series walk fails is still a volume worth downloading. A
                // series page that fails to walk is a real error and is reported below.
                return { tasks: [], rejected: [], notes: [], failed: error.message };
            }
        };
        const settled = new Array(resolvable.length);
        const publishResolved = (index) => {
            const resolved = settled[index];
            const { input, det } = resolvable[index];
            if (!resolved.streamed) {
                for (const task of resolved.tasks) publish(task);
                for (const note of resolved.notes || []) onNote(note);
            }
            // A walk that threw is reported: discovery itself failed, and quietly
            // downloading the one volume hides a nine-volume series behind a single book,
            // which is exactly how a broken batch lookup looked like a working one. A walk
            // that returned a rejection is different, because the resolver looked and said
            // no, and the single-volume path is the authority on that volume.
            if (resolved.failed) {
                rejected.push({ input, error: resolved.failed });
            } else if (!isSeriesPage(det) && !resolved.tasks.length) {
                const platform = platformFor(det.kind);
                publish({
                    input,
                    kind: det.kind,
                    target: platform.volumeId(det) ?? det.url,
                    cid: det.cid,
                    asin: det.asin,
                    url: det.url,
                });
            } else {
                rejected.push(...resolved.rejected);
            }
        };
        const resolveOne = async (index) => {
            settled[index] = await resolveAt(resolvable[index]);
            // Published the moment it is ready. Waiting for every source before publishing
            // anything made a CMOA or BookWalker series, which resolves in one request,
            // look queued behind a Kindle walk that takes one request per volume.
            publishResolved(index);
        };
        const kindleIndexes = [];
        const otherIndexes = [];
        for (const [index, entry] of resolvable.entries()) {
            (entry.det.kind === 'kindle' ? kindleIndexes : otherIndexes).push(index);
        }
        await Promise.all([
            ...otherIndexes.map((index) => resolveOne(index)),
            // Kindle entries run one after another, because they share a single reader
            // session and the walk is a request per volume, but they run alongside the
            // other stores rather than ahead of them.
            (async () => {
                for (const index of kindleIndexes) await resolveOne(index);
            })(),
        ]);

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
            const resolved = await platform.resolve(det, config, input, {
                fetchImpl,
                userAgent: USER_AGENT,
                samplers: config.downloadSamplers === true,
            });
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
        const markerPlatform = platformFor(task.kind);
        const alreadyPresent = await existingVolume(scoped, {
            store: task.kind,
            title: task.title,
            id: task.cid || task.asin || task.id || task.target,
            sample: task.sample === true,
            checkRemote: Boolean(ctx.bridge && task.title),
            checkLocal: !ctx.bridge,
            // A store whose folder can hold either raw or rebuilt bytes states
            // what "finished" means; without this a series task skips a folder
            // the adapter itself would have refused.
            markerCheck: typeof markerPlatform?.markerCheck === 'function'
                ? (marker) => markerPlatform.markerCheck(marker, scoped)
                : null,
        });
        if (alreadyPresent) {
            Object.assign(record, normalizeStoreResult({ ...alreadyPresent, store: task.kind }, task), {
                key: task.key,
                ok: true,
                note: `already present at ${alreadyPresent.existingDestination.method}`,
            });
            scoped.progress?.note?.(`  ${task.title}: ${record.note}; skipping download and OCR`);
            record.seconds = (performance.now() - started) / 1000;
            record.phases = readPhases(scoped.timer);
            return { record, scoped };
        }
        Object.assign(record, normalizeStoreResult(await ctx.callAdapter(task, scoped), task));
        if (record.existingDestination) {
            record.note = `already present at ${record.existingDestination.method}`;
            scoped.progress?.note?.(`  ${record.title}: ${record.note}; skipping download and OCR`);
        }
    } catch (error) {
        if (error?.code === 'KINDLE_KU_UNAVAILABLE' && task.kuCandidate) {
            // `skipped` is a page count everywhere else, so a skip that downloaded
            // nothing reports zero pages and says why under its own key.
            Object.assign(record, normalizeStoreResult({
                ...record,
                skipped: Number(record.totalPages) || 0,
                kuUnavailable: true,
                ok: true,
                error: '',
            }, task));
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
    if (record.existingDestination) return record;
    if (!ctx.bridge) {
        if (!ctx.resumeBridge || !record.ok || !record.title || !record.folder) return record;
        try {
            const { client } = ctx.resumeBridge;
            const listed = await client.sessions();
            const normalize = (value) => String(value || '').normalize('NFKC').trim().toLocaleLowerCase();
            const session = (listed?.sessions || []).find((item) =>
                normalize(item.title) === normalize(record.title)
                || normalize(item.safe_title) === normalize(record.title));
            if (!session) return record;
            const destInfo = await resolveDestination(client, {
                dest: ctx.config.dest || null,
                folder: ctx.config.destFolder || null,
            });
            record.mokuro = await resumeExistingSession(client, destInfo, record, await pageFiles(record.folder), {
                alreadyHandled: true,
                existingSession: session,
                state: 'existing bridge session found (resume-only mode)',
            }, {
                progress: ctx.progress,
                overwrite: ctx.config.overwrite,
                ocrWaitMs: ctx.config.ocrWaitSeconds * 1000,
                // Pass the run's shared map through this fresh options object, or the
                // grouped resume notice lands on the object and is never printed.
                bridgeResume: ctx.bridgeResume,
            });
        } catch (error) {
            record.mokuro = { error: error.message, resumedExisting: true };
            record.ok = false;
        }
        return record;
    }

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
                outputFiles: normalizeUploads(final?.uploads),
                status: final?.status || null,
                message: final?.message || '',
                partial: final?.status === 'partial_upload',
                completed: final?.status === 'success',
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
        if (config.quiet || config.json) return;
        // Route through the progress block so it can move its own anchor. Writing to
        // the stream directly shifts the block down a row without telling it, and the
        // next redraw then lands a row too high: it overwrites the line above and
        // leaves the block's last row stale. That is how one volume came to appear
        // several times with the progress bar drawn on top of the rows.
        if (progress) {
            progress.note(line);
            return;
        }
        err.write(line.endsWith('\n') ? line : `${line}\n`);
    };

    const bwCarrier = createBookwalkerCarrier();

    const wantsPlatform = (id) => positionals.some((input) => platformFor(detectSource(input).kind)?.id === id);
    const kindleSession = wantsPlatform('kindle') ? await kindlePlatform.session.load(config) : null;

    const streaming = !config.dryRun && !config.flat;

    // Every discovered volume starts at once. The promise to the user is "as fast
    // as this machine allows", and the thing that oversubscribing actually hurts --
    // CPU-bound page rebuilding -- is already bounded by `cpu-budget.js`, which
    // divides one budget across the stores that are running. `--parallel N` is the
    // escape hatch for a constrained machine or a store that is throttling.
    // Computed here, before any task can be published: `addTask` needs the resolved
    // width, not the raw flag, or a batch starts no work at all.
    const cores = defaultJobCount();
    const parallel = config.parallel ?? Infinity;
    const bridgeParallel = config.bridgeParallel ?? parallel;

    const tasks = [];
    const cpuLane = [];
    const netLane = [];
    const lanes = [cpuLane, netLane];
    const cursors = [0, 0];
    const waiting = [];
    const unlimitedPending = [];
    let unlimitedDownloadDispatch = null;

    let rejected = [];
    let buildDone = false;
    let buildError = null;

    const notify = () => { while (waiting.length) waiting.shift()(); };
    const waitForWork = () => new Promise((resolve) => waiting.push(resolve));

    let progress = null;
    if (!config.dryRun && !config.quiet && !config.json) {
        // A plain download has no OCR or upload after it, so the block must measure
        // the run by its pages rather than by the mokuro stage weights. --mokuro is
        // known here; a bridge discovered for resume-only mode is handled below.
        progress = new LiveProgress({
            quiet: config.quiet,
            plain: config.noProgress,
            stream: err,
            pipelineExpected: Boolean(config.mokuro),
        });
        progress.startTicker();
    }

    // A repeated URL, or a series URL plus one of its own volume URLs, would otherwise
    // dispatch the same volume twice into one folder: the two downloads race on the
    // same page files and completion marker, and the summary counts it twice.
    const seenTaskKeys = new Set();
    const addTask = (task) => {

        if (!task.key) task.key = `${task.kind}:${task.target}`;
        if (seenTaskKeys.has(task.key)) return;
        seenTaskKeys.add(task.key);
        const index = tasks.length;
        tasks.push(task);
        (laneOf(task) === 'cpu' ? cpuLane : netLane).push(index);
        progress?.add(task.key, {

            tag: task.kuCandidate ? KINDLE_UNLIMITED_LABEL : (platformFor(task.kind)?.label || '?'),
            label: rowLabel(task),
        });
        notify();
        if (parallel === Infinity) {
            if (unlimitedDownloadDispatch) unlimitedDownloadDispatch(index, task);
            else unlimitedPending.push({ index, task });
        }
    };

    if (kindleSession && !kindleSession.cookie) {
        err.write('Kindle needs signed-in read.amazon.co.jp cookies, and none were found.\n\n');
        err.write(`${kindlePlatform.session.howTo}\n`);
        return { code: 2, summary: null };
    }

    if (config.downloadSamplers && !config.series
        && !positionals.some((input) => /^https?:\/\/book\.dmm\.com\/product\//i.test(String(input).trim()))) {
        say('note: --download-samplers only applies with --series or a DMM product URL; ignoring it');
    }

    if (config.zip && positionals.some((input) => {
        const det = detectSource(input);
        return det.kind !== 'bookwalker' && det.kind !== 'bookwalker-series';
    })) {
        say('note: --zip only applies to BookWalker; other stores write their pages unchanged');
    }

    if (!config.dryRun) {
        try {
            await fsp.mkdir(outDir, { recursive: true });
        } catch (error) {
            err.write(`cannot write to ${outDir}\n`);
            err.write(`  ${describeError(error)}\n`);
            err.write('  Pick another folder with --out DIR, or fix its permissions.\n');
            return { code: 2, summary: null };
        }
    }

    const build = buildTasks(positionals, config, {
        onNote: say,
        onTask: addTask,
        fetchImpl: io.fetchImpl || globalThis.fetch,
        bwCarrier,
        kindleSession,
    })
        .then((built) => {
            rejected = built.rejected;
            // Printed here, not after the await below: with the default streaming mode
            // the build promise settles after the scheduler has started, so the loop
            // after `await` ran while `rejected` was still empty and a skipped input
            // never said why. `say` still routes through the progress block when it exists.
            for (const r of rejected) say(`  skipped ${r.input}: ${r.error}`);
        })
        .catch((error) => { buildError = error; })
        .finally(() => { buildDone = true; notify(); });

    if (!streaming) await build;
    if (buildError) throw buildError;

    if (config.dryRun) {

        const kindOf = (t) => (t.kuCandidate ? 'kindle unlimited' : t.kind);
        const width = Math.max(11, ...tasks.map((t) => kindOf(t).length));
        for (const t of tasks) out.write(`${kindOf(t).padEnd(width)}  ${t.target}\n`);
        for (const r of rejected) out.write(`${'unsupported'.padEnd(width)}  ${r.input}  (${r.error})\n`);
        return { code: tasks.length ? 0 : 2, summary: null };
    }

    if (config.flat && tasks.length > 1) {
        throw new Error(`--flat writes every volume into ${outDir}, but page filenames `
            + `restart at 1 in each volume, so ${tasks.length} volumes would overwrite `
            + 'each other. Drop --flat to get one folder per volume.');
    }

    // Counts every task discovered for that store, whichever lane it landed in and
    // whether or not it has finished -- `tasks` is only ever appended to, so a store
    // that has finished a volume still holds the share it was counted for. Which
    // stores are counted at all is decided by the descriptor's `cpuSlot`: BookWalker
    // runs on the net lane and still takes normalize threads, and a store that
    // declares no slot is left out of `active` entirely.
    const kindCount = (kind) => tasks.reduce((n, task) => n + (task.kind === kind ? 1 : 0), 0);
    const sizing = () => allocateCpu({
        cores,
        active: Object.fromEntries(PLATFORMS
            .filter((entry) => entry.tuning?.cpuSlot)
            .map((entry) => [entry.id, kindCount(entry.id)])),
        renderJobs: config.jobs ?? null,
    });

    let bridge = null;
    let resumeBridge = null;
    let bridgeMonitor = null;
    let destinationCheckDisabled = false;
    if (config.mokuro) {
        try {
            bridge = await (io.connectBridge || connectBridge)(config, { resolveDestination, describeDestinations });
            say(`bridge ${bridge.baseUrl} (mokuro ${bridge.health.mokuro_installed ? 'ready' : 'MISSING'})`);
            say(`destination ${bridge.destInfo.method}`);
            // Tell the display whether an upload is part of this run. Without it the
            // bar cannot tell "assembling the archive before sending it" from "no
            // destination at all", which is why the cyan band never appeared while
            // the rows were already showing the volume being assembled.
            if (progress) progress.uploadExpected = bridge.destInfo.method !== 'local';
            if (progress?.tty && bridge.client.sessions && bridge.client.queue) {
                let polling = false;
                const pollBridge = async () => {
                    if (polling) return;
                    polling = true;
                    try {
                        const [sessions, queue] = await Promise.all([
                            bridge.client.sessions(),
                            bridge.client.queue(),
                        ]);
                        progress.updateBridgeStatus({
                            worker: queue?.worker?.state || 'unknown',
                            processing: Number(queue?.processing_depth) || 0,
                            pending: Number(queue?.queue_depth) || 0,
                            // `upload` is per-session state, not activity: the bridge
                            // leaves an `upload` object behind after the early cover
                            // push with `active: false`. Counting the object painted a
                            // busy footer through the whole OCR phase.
                            activeUploads: (sessions?.sessions || [])
                                .filter((session) => session.upload?.active).length,
                        });
                        for (const session of sessions?.sessions || []) {
                            const volume = progress.volumes.find((item) =>
                                String(item.label).normalize('NFKC').trim().toLocaleLowerCase()
                                    === String(session.title).normalize('NFKC').trim().toLocaleLowerCase());
                            if (!volume || volume.phase === 'done' || volume.phase === 'error') continue;
                            const counts = (queue?.per_session || [])
                                .find((entry) => entry.session_id === session.session_id);
                            const pendingCount = Number(session.pages_ocr_pending) || 0;
                            progress.update(volume.key, {
                                bridgeState: bridgeSessionState(session, queue),
                                bridgeOcrDone: Number(session.pages_ocr_done) || 0,
                                bridgeOcrTotal: Number(session.pages_received) || 0,
                                bridgeOcrPending: pendingCount,
                                bridgeOcrProcessing: Number(counts?.processing) || 0,
                            });
                        }
                    } catch { /* bridge status is observational; keep the run alive */ }
                    finally { polling = false; }
                };
                void pollBridge();
                bridgeMonitor = setInterval(() => { void pollBridge(); }, 2000);
                bridgeMonitor.unref?.();
            }
        } catch (error) {
            err.write(`${error.message}\n`);
            progress?.stopTicker();
            return { code: 1, summary: null };
        }
    } else if (!config.dryRun) {
        // `--no-mokuro` prevents new OCR submissions, but a bridge session from
        // an interrupted earlier run may still be active. Keep resume-only mode
        // observational until a matching title is found in bridgeStage.
        try {
            const found = await discoverBridge(config.bridge);
            if (found) {
                const client = new BridgeClient(found.baseUrl);
                const listed = await client.sessions();
                if (Number(listed?.count) > 0) {
                    resumeBridge = { client, baseUrl: found.baseUrl, health: found.health };
                    // Do not switch the footer weights here: a resumed session only
                    // matters if one of this run's titles matches it, and most do not.
                    // The first real bridge phase on a row flips the weights instead
                    // (LiveProgress.pipelineUnderway).
                    say(`bridge ${found.baseUrl} (checking existing sessions only; no new OCR submissions)`);
                }
            }
        } catch { /* no bridge session to resume; local downloads can proceed */ }
    }

    const ctx = {
        out: outDir,
        titleDir: config.titleDir,
        progress,
        bridge,
        resumeBridge,
        // Shared for the same scope reason as the Kindle sets below: `noteResume` fills
        // this from the per-volume child context, so a lazily created Map lived only on
        // that child and the grouped "already had a bridge session" line never printed.
        bridgeResume: new Map(),
        // Created here, not lazily in the Kindle adapter, because `downloadTask` hands
        // each volume an `Object.create(ctx)`. An adapter that assigned this itself
        // would write it onto the per-volume child, and the run's own copy would stay
        // undefined, which is why the grouped return warning never printed.
        kindleUnreturned: new Set(),
        // Same trap as above: the adapter creates this on the per-volume scope, so the
        // run's teardown never saw the background returns and could print the grouped
        // "loan could not be returned" line before they settled, or not at all.
        kindleReturnWork: new Set(),
        // With OCR and upload still to run, a return waits in the background instead of
        // holding the volume. On a plain download there is nothing to overlap with, so
        // it stays in the foreground where its result is known before the volume ends.
        kindleReturnInBackground: Boolean(config.mokuro),
        destinationCheck: bridge?.client?.destinationCheck
            ? async (title) => {
                if (destinationCheckDisabled) return null;
                try {
                    return await bridge.client.destinationCheck(title, {
                        method: bridge.destInfo.method,
                        localDir: bridge.destInfo.params?.localDir || null,
                    });
                } catch (error) {
                    if (error?.status === 404) destinationCheckDisabled = true;
                    if (!destinationCheckDisabled) {
                        say(`  destination check unavailable for ${title}: ${error.message}; continuing`);
                    }
                    return null;
                }
            }
            : null,
        config,
        bwCarrier,
        userAgent: USER_AGENT,

        // The shared --concurrency override, and one field per store that declares
        // a concurrency on its descriptor (`ctx.cmoaConcurrency`, and so on). The
        // adapters read their own field; nothing here is keyed by store name.
        concurrency: config.concurrency,
        ...concurrencyContext(config, PLATFORMS),

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
    };

    const started = performance.now();
    const results = [];

    const finish = (index, task, record) => {
        // `partial_upload` is a terminal bridge result where the volume files arrived
        // but the series index did not. The bridge keeps the working files and treats
        // it as a failure; a folder without series.json is a series the reader cannot
        // build, so the volume must not be reported as a success. Every bridge path
        // (pages, folder ingest, resumed session, deferred finalize) ends here.
        if (record?.ok && record.mokuro?.partial) {
            record.ok = false;
            record.error = 'the destination has the volume files but not series.json, so the '
                + 'series index is incomplete'
                + (record.mokuro.message ? ` (${record.mokuro.message})` : '')
                + '; re-run with --force to replace the stored copies, or fix the destination error it reports';
        }
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

    // Keep ordinary volume batches bounded so a fast network cannot fill the disk
    // while one OCR worker catches up. In --series mode, keep downloading the
    // requested series while OCR lags: the separate download and bridge limits
    // still cap active work, while this queue holds the completed volumes.
    const bridgeQueue = [];
    const bridgeWaiting = [];
    const downloadWaiting = [];
    let downloadsDone = false;
    let bridgeQueuePeak = 0;
    const bridgeQueueMax = config.series || parallel === Infinity
        ? Infinity
        : Math.max(1, parallel * 2);

    const notifyBridge = () => { while (bridgeWaiting.length) bridgeWaiting.shift()(); };
    const waitForBridge = () => new Promise((resolve) => bridgeWaiting.push(resolve));
    const notifyDownload = () => { while (downloadWaiting.length) downloadWaiting.shift()(); };
    const waitForDownload = () => new Promise((resolve) => downloadWaiting.push(resolve));

    // Both lanes draw from one gate, so --parallel N really is N volumes in
    // flight. Per-lane pools of `parallel` each meant 2N once two stores were
    // mixed, which is what the help text and the reported summary both deny.
    const inFlight = createPool(parallel);
    const unlimitedDownloadWork = new Set();
    const unlimitedBridgeWork = new Set();

    const enqueueBridge = async (index, task, record) => {
        if (!ctx.bridge && !ctx.resumeBridge) {
            finish(index, task, record);
            return;
        }
        if (!ctx.bridge && ctx.resumeBridge) {
            try { record = await bridgeStage(record, ctx); }
            catch (error) { record = { ...record, ok: false, mokuro: { error: error.message } }; }
            finish(index, task, record);
            return;
        }
        if (bridgeParallel === Infinity) {
            const work = Promise.resolve().then(async () => {
                try { record = await bridgeStage(record, ctx); }
                catch (error) { record = { ...record, ok: false, mokuro: { error: error.message } }; }
                finish(index, task, record);
            }).finally(() => unlimitedBridgeWork.delete(work));
            unlimitedBridgeWork.add(work);
            return;
        }
        while (bridgeQueue.length >= bridgeQueueMax) {
            await waitForDownload();
            if (downloadsDone) return;
        }
        bridgeQueue.push({ index, task, record });
        bridgeQueuePeak = Math.max(bridgeQueuePeak, bridgeQueue.length);
        notifyBridge();
    };

    const downloadOne = async (index, task) => {
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
            return;
        }
        await enqueueBridge(index, task, record);
    };

    unlimitedDownloadDispatch = (index, task) => {
        const work = Promise.resolve().then(() => downloadOne(index, task))
            .finally(() => unlimitedDownloadWork.delete(work));
        unlimitedDownloadWork.add(work);
    };
    for (const pending of unlimitedPending.splice(0)) unlimitedDownloadDispatch(pending.index, pending.task);

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

            await enqueueBridge(index, task, record);
        }
    };

    const bridgeWorker = async () => {
        for (;;) {
            const job = bridgeQueue.shift();
            if (job) {
                notifyDownload();
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
        parallel === Infinity ? [] : Array.from({ length: parallel }, () => laneWorker(laneIndex))
    ))).then(async () => {
        if (parallel === Infinity) {
            await build;
            while (unlimitedDownloadWork.size) await Promise.all([...unlimitedDownloadWork]);
        }
        downloadsDone = true;
        notifyDownload();
        notifyBridge();
    });

    const bridgeWork = !ctx.bridge
        ? Promise.resolve()
        : bridgeParallel === Infinity
            ? laneWork.then(async () => {
                while (unlimitedBridgeWork.size) await Promise.all([...unlimitedBridgeWork]);
            })
            : Promise.all(Array.from({ length: bridgeParallel }, () => bridgeWorker()));

    try {
        await Promise.all([build, laneWork, bridgeWork]);
    } finally {
        if (bridgeMonitor) clearInterval(bridgeMonitor);
        // Returns that were sent to the background settle before the run reports, so
        // the grouped warning below covers finished work rather than a snapshot of
        // returns still retrying. Nothing else waits on them.
        if (ctx.kindleReturnWork?.size) {
            await Promise.allSettled([...ctx.kindleReturnWork]);
        }
        // Resumed bridge sessions, grouped for the same reason as the returns: every
        // volume of a series repeats the same notice, and one line each buries the run.
        const resumed = ctx.bridgeResume;
        if (resumed?.size) {
            const processing = resumed.get('processing')?.length || 0;
            const finished = resumed.get('finished')?.length || 0;
            const unknown = resumed.get('unknown')?.length || 0;
            const total = processing + finished + unknown;
            const parts = [];
            if (processing) parts.push(`${processing} the bridge is still working on`);
            if (finished) parts.push(`${finished} already finished and cleaned up`);
            if (unknown) parts.push(`${unknown} with no live session left to check`);
            const line = `  ${total} volume${total === 1 ? '' : 's'} already had a bridge session from an earlier run, `
                + `so ${total === 1 ? 'its' : 'their'} pages were not sent again (${parts.join(', ')}). `
                + 'That is the run resuming where it left off, not a failure.';
            if (progress) progress.note(line);
            else err.write(`${line}\n`);
        }
        // One grouped line for the Kindle return path rather than one per volume.
        // The loans are what a user has to act on, so the run names every ASIN in a
        // single place instead of scattering the same paragraph through the output.
        const unreturned = ctx.kindleUnreturned;
        if (unreturned && unreturned.size) {
            const list = [...unreturned].join(', ');
            const line = unreturned.size === 1
                ? `  ${list}: downloaded, but its Kindle loan could not be returned, so it may still be open. Free the slot at https://www.amazon.co.jp/your-books`
                : `  ${unreturned.size} Kindle loans could not be returned: ${list}\n  Free the slots at https://www.amazon.co.jp/your-books`;
            if (progress) progress.note(line);
            else err.write(`${line}\n`);
        }
        progress?.done();
    }

    if (buildError) throw buildError;

    // Nothing resolvable is a usage error whether or not this was a dry run; the
    // exit code must not change because the run was only asked to list its work.
    if (!tasks.length) {
        err.write('no supported volume URLs given\n');
        for (const r of rejected) err.write(`  ${r.input}: ${r.error}\n`);
        return { code: 2, summary: null };
    }

    const seconds = (performance.now() - started) / 1000;
    // The download stage runs in parallel, so its wall time is the slowest single
    // volume, not the sum. With --mokuro the total is usually much larger, and it
    // is OCR and upload that own the difference -- worth saying out loud so a slow
    // run is not mistaken for slow downloading.
    const downloadSeconds = Math.max(0, ...results.map((r) => Number(r?.seconds) || 0));
    const summary = {
        volumes: tasks.length,
        succeeded: results.filter((r) => r?.ok).length,
        // A discovered volume that never produced a result is a failure, not a
        // silent success. Counting only records that exist let a batch that started
        // no work at all report "0/18 volumes" and exit 0.
        failed: tasks.length - results.filter((r) => r?.ok).length,
        unsupported: rejected,
        pages: results.reduce((a, r) => a + (r?.downloaded || 0), 0),
        skippedPages: results.reduce((a, r) => a + (r?.skipped || 0), 0),
        alreadyPresent: results.filter((r) => r?.existingDestination).length,
        bytes: results.reduce((a, r) => a + (r?.bytes || 0), 0),
        elapsedSeconds: +seconds.toFixed(2),
        downloadSeconds: +downloadSeconds.toFixed(2),
        outDir,
        parallel: parallel === Infinity ? 'unlimited' : parallel,
        mokuro: config.mokuro
            ? {
                bridge: bridge?.baseUrl ?? null,
                destination: bridge?.destInfo.method ?? null,
                volumes: results.filter((r) => r?.mokuro).length,
                parallel: bridgeParallel === Infinity ? 'unlimited' : bridgeParallel,
                queuePeak: bridgeQueuePeak,
                ingestedFromFolder: results.filter((r) => r?.mokuro?.ingest === 'folder').length,
            }
            : null,
        results: results.map((r) => r || { ok: false, error: 'did not start' }),
    };

    if (config.json) {
        out.write(`${JSON.stringify(summary, null, 2)}\n`);
    } else if (!config.quiet) {
        for (const r of summary.results) {
            const name = r.title || r.target;
            if (r.ok && r.existingDestination) {
                err.write(`  already downloaded  ${name}\n`);
            }
            if (!r.ok) {
                const reason = r.error || `${r.failed} page(s) could not be downloaded`;
                err.write(`  failed  ${name}\n            ${reason}\n`);
            }
        }

        // Plain-language close: what happened, not a ratio to decode.
        const bits = [`${summary.succeeded} of ${summary.volumes} volume${summary.volumes === 1 ? '' : 's'} downloaded`];
        if (summary.pages) bits.push(`${summary.pages} pages`);
        if (summary.alreadyPresent) bits.push(`${summary.alreadyPresent} already there`);
        if (summary.failed) bits.push(`${summary.failed} failed`);
        if (summary.unsupported.length) {
            bits.push(`${summary.unsupported.length} URL${summary.unsupported.length === 1 ? '' : 's'} not recognised`);
        }
        err.write(`\n${bits.join(', ')} in ${seconds.toFixed(1)}s\n`);
        if (summary.mokuro && summary.succeeded) {
            err.write(`  downloads were finished in ${downloadSeconds.toFixed(0)}s`
                + '; OCR and upload are the rest of the time\n');
        }
        if (!summary.succeeded && summary.volumes) {
            err.write('Nothing was downloaded. The reasons are listed above.\n');
        }
        if (summary.failed) {
            err.write('Re-run the same command: finished pages are kept and only the gaps are fetched.\n');
        }
    }

    return { code: summary.failed ? 1 : 0, summary };
}
