/**
 * The driver: turn a list of URLs into downloaded volumes.
 *
 * Everything here is plain function state, never import-time state, so `run` can
 * be called more than once in one process and tested directly.
 */

import path from 'node:path';
import fsp from 'node:fs/promises';

import { detectSource, STORE_LABELS } from './detect.js';
import { LiveProgress } from './display.js';
import { resolveCmoaInput, downloadCmoa } from './download/cmoa.js';
import { downloadEbookjapan } from './download/ebookjapan.js';
import { downloadBookwalker } from './download/bookwalker.js';
import { connectBridge, pushToBridge } from './bridge.js';
import { resolveDestination, describeDestinations } from '../vendor/ebookjapan/bridge.mjs';

/**
 * A User-Agent that the three stores' CDNs accept.
 *
 * Kept current deliberately: a stale version string is a common cause of
 * otherwise inexplicable refusals, and the four stores drift at different times.
 * Overridable so a breakage can be worked around without a release.
 */
const USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36';

/**
 * Build the task list from positional arguments.
 *
 * Detection is offline; only a CMOA title page needs the network, because the
 * volume list is not published anywhere and has to be probed.
 */
export async function buildTasks(positionals, config, { onRejected = () => {} } = {}) {
    const tasks = [];
    const rejected = [];

    for (const input of positionals) {
        const det = detectSource(input);
        if (det.kind === 'unknown') {
            rejected.push({ input, error: det.reason });
            continue;
        }

        if (det.kind === 'cmoa-title') {
            const resolved = await resolveCmoaInput(det, config, input);
            tasks.push(...resolved.tasks);
            rejected.push(...resolved.rejected);
            continue;
        }

        // A CMOA volume and a BookWalker volume are addressed by a cid; an
        // ebookjapan volume is addressed by its URL or code.
        const target = det.kind === 'cmoa' || det.kind === 'bookwalker' ? det.cid : det.url;
        tasks.push({ input, kind: det.kind, target, cid: det.cid, url: det.url });
    }

    // The key travels with the task because the bridge push and the display both
    // need a stable per-volume identity.
    for (const task of tasks) task.key = `${task.kind}:${task.target}`;

    for (const r of rejected) onRejected(r);
    return { tasks, rejected };
}

/** Abbreviate a URL for a one-line display row. */
function rowLabel(task) {
    if (task.kind === 'cmoa') return task.target;
    if (task.kind === 'bookwalker') return task.cid || task.target;
    return task.target.replace(/^https?:\/\/[^/]+/, '');
}

/**
 * Download one task, dispatching to its store, then hand it to the bridge.
 *
 * Store adapters return a uniform record; the OCR step is applied here so the
 * three stores do not each reimplement it.
 */
async function runTask(task, ctx) {
    const started = performance.now();
    const record = { input: task.input, kind: task.kind, target: task.target, ok: false, key: task.key };

    if (task.kind === 'cmoa') {
        Object.assign(record, await downloadCmoa(task, ctx));
    } else if (task.kind === 'ebookjapan') {
        Object.assign(record, await downloadEbookjapan(task, ctx));
    } else {
        Object.assign(record, await downloadBookwalker(task, ctx));
    }

    record.seconds = (performance.now() - started) / 1000;
    record.ok = !record.failed;
    if (record.title) ctx.progress?.update(task.key, { label: record.title });

    if (!ctx.bridge) return record;

    // BookWalker streams its pages to the bridge itself and deliberately does not
    // finalize, so only the assembly is left; the other two need their pages sent.
    if (record.mokuro?.deferredFinalize) {
        try {
            const final = await ctx.bridge.client.finalize(record.mokuro.sessionId, {
                ...ctx.bridge.destInfo.params,
                deleteAfterUpload: ctx.bridge.destInfo.method !== 'local',
                ...(ctx.config.overwrite ? { overwrite: ctx.config.overwrite } : {}),
            });
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
        record.mokuro = await pushToBridge(ctx.bridge.client, ctx.bridge.destInfo, record, {
            pushConcurrency: ctx.config.pushConcurrency,
            ocrWaitMs: ctx.config.ocrWaitSeconds * 1000,
            overwrite: ctx.config.overwrite,
            progress: ctx.progress,
        });
    } catch (error) {
        record.mokuro = {
            error: error.message,
            // The stack is kept so a failure inside the bridge client is
            // attributable rather than a bare message.
            stack: String(error.stack || '').split('\n').slice(0, 6).join(' | '),
        };
        record.ok = false;
    }
    return record;
}

/**
 * Run a whole batch.
 *
 * @param {string[]} positionals URLs as typed by the user
 * @param {object} config parsed options
 * @param {object} [io] `{ out, err }` streams, for tests
 * @returns {Promise<{code: number, summary: object}>}
 */
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

    const { tasks, rejected } = await buildTasks(positionals, config);
    for (const r of rejected) say(`  skipped ${r.input}: ${r.error}`);

    if (config.dryRun) {
        const width = Math.max(11, ...tasks.map((t) => t.kind.length));
        for (const t of tasks) out.write(`${t.kind.padEnd(width)}  ${t.target}\n`);
        for (const r of rejected) out.write(`${'unsupported'.padEnd(width)}  ${r.input}  (${r.error})\n`);
        return { code: 0, summary: null };
    }

    if (!tasks.length) {
        err.write('no supported volume URLs given\n');
        for (const r of rejected) err.write(`  ${r.input}: ${r.error}\n`);
        return { code: 2, summary: null };
    }

    await fsp.mkdir(outDir, { recursive: true });

    // The display is created before the bridge is discovered so every later line
    // is written through it and lands outside the redrawn block. Volumes are
    // registered up front so the whole batch is visible as queued from the start.
    let progress = null;
    if (!config.quiet && !config.json) {
        progress = new LiveProgress({ quiet: config.quiet, plain: config.noProgress, stream: err });
        for (const task of tasks) {
            progress.add(task.key, { tag: STORE_LABELS[task.kind] || '?', label: rowLabel(task) });
        }
        progress.startTicker();
    }

    // Each CMOA volume runs its own render pool, so the budget is divided by how
    // many run at once to keep the total near core count rather than
    // series x cores. ebookjapan and BookWalker render nothing, so they are not
    // part of this calculation.
    const cmoaCount = tasks.filter((t) => t.kind === 'cmoa').length;
    const jobs = config.jobs ?? undefined;
    const series = config.series ?? Math.min(tasks.length, 16);
    const concurrentCmoa = Math.max(1, Math.min(series, cmoaCount));

    let bridge = null;
    if (config.mokuro) {
        try {
            bridge = await connectBridge(config, { resolveDestination, describeDestinations });
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
        userAgent: USER_AGENT,
        concurrency: config.cmConcurrency,
        jobs: jobs ?? undefined,
        force: config.force,
        format: config.format,
        quality: config.quality,
    };

    const started = performance.now();
    const results = new Array(tasks.length);
    let next = 0;

    const worker = async () => {
        for (;;) {
            const index = next++;
            if (index >= tasks.length) return;
            const task = tasks[index];
            try {
                const record = await runTask(task, ctx);
                results[index] = record;
                progress?.finish(task.key, {
                    error: record.ok
                        ? ''
                        : (record.error || record.mokuro?.error || `${record.failed} page(s) failed`),
                    bytes: record.bytes || 0,
                });
            } catch (error) {
                results[index] = {
                    input: task.input,
                    kind: task.kind,
                    target: task.target,
                    key: task.key,
                    ok: false,
                    error: error.message,
                };
                progress?.finish(task.key, { error: error.message });
            }
        }
    };

    try {
        await Promise.all(Array.from({ length: Math.min(series, tasks.length) }, worker));
    } finally {
        progress?.done();
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
        series,
        mokuro: config.mokuro
            ? {
                bridge: bridge?.baseUrl ?? null,
                destination: bridge?.destInfo.method ?? null,
                volumes: results.filter((r) => r?.mokuro).length,
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
