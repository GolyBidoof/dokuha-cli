
import os from 'node:os';
import path from 'node:path';
import fsp from 'node:fs/promises';

import { discoverBridge, BridgeClient } from '../vendor/ebookjapan/bridge.mjs';
import { zipEntryNumber } from './download/page-files.js';

const CONTENT_TYPES = {
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.png': 'image/png',
    '.webp': 'image/webp',
    '.gif': 'image/gif',
    '.avif': 'image/avif',
};

export function contentTypeFor(name) {
    return CONTENT_TYPES[path.extname(String(name)).toLowerCase()] || 'application/octet-stream';
}

/**
 * Collect a resumed-session notice instead of printing it.
 *
 * Every volume of a series produces the same notice, so one line each buries the run's
 * real output. The kinds are what the bridge said about the session it already had:
 * `processing` still working on it, `finished` already done and cleaned up, `unknown`
 * nothing to check.
 */
function noteResume(ctx, kind, title) {
    if (!ctx) return;
    const bag = ctx.bridgeResume || (ctx.bridgeResume = new Map());
    const titles = bag.get(kind) || [];
    if (title && !titles.includes(title)) titles.push(title);
    bag.set(kind, titles);
}

async function inspectExistingSession(client, title, ctx = {}, key = null) {
    const [listed, queue] = await Promise.all([client.sessions(), client.queue()]);
    const match = (listed?.sessions || []).find((item) =>
        sameBridgeTitle(item.title, title) || sameBridgeTitle(item.safe_title, title));
    if (!match) {
        const state = 'bridge has no live session for this title; completion status unavailable';
        noteResume(ctx, 'unknown', title);
        return { alreadyHandled: true, existingSession: null, queue, state };
    }
    const counts = (queue?.per_session || []).find((item) => item.session_id === match.session_id);
    const state = existingSessionState(match, queue);
    if (key) {
        ctx.progress?.update?.(key, {
            phase: 'ocr',
            ocr: Number(match.pages_ocr_done) || 0,
            ocrTotal: Number(match.pages_received) || 0,
            ocrPending: Number(match.pages_ocr_pending) || 0,
            failed: Number(match.pages_ocr_failed) || 0,
            bridgeState: state,
            bridgeOcrDone: Number(match.pages_ocr_done) || 0,
            bridgeOcrTotal: Number(match.pages_received) || 0,
            bridgeOcrPending: Number(match.pages_ocr_pending) || 0,
            bridgeOcrProcessing: Number(counts?.processing) || 0,
            bridgeWorker: queue?.worker?.state || 'unknown',
            bridgeQueueDepth: Number(queue?.queue_depth) || 0,
            bridgeProcessingDepth: Number(queue?.processing_depth) || 0,
        });
    }
    noteResume(ctx, 'processing', title);
    return { alreadyHandled: true, existingSession: match, queue, state };
}

export async function startBridgeSession(client, title, { reuseExisting = true, progress, key } = {}) {
    try {
        return await client.startSession(title, { reuseExisting });
    } catch (error) {
        const existingSession = (error?.status === 400 || error?.status === 409)
            && /finalizing or already finalized|concurrently/i.test(error.message || '');
        if (!existingSession) throw error;
        try {
            const state = await inspectExistingSession(client, title, { progress }, key);
            if (state) return state;
        } catch (statusError) {
            noteResume(ctx, 'unknown', null);
            return {
                alreadyHandled: true,
                existingSession: null,
                queue: null,
                state: 'bridge status unavailable; duplicate transfer skipped',
            };
        }
        throw new Error(`${error.message}; bridge session status could not be confirmed`);
    }
}

export async function pageFiles(folder) {
    const entries = await fsp.readdir(folder, { withFileTypes: true });
    const pad = (n) => String(n).padStart(4, '0');
    return entries
        .filter((e) => e.isFile() && CONTENT_TYPES[path.extname(e.name).toLowerCase()])
        .map((e) => e.name)
        // Sort by the ordinal each store encoded in the name rather than by the
        // whole string, so `0001 source.jpg` and a leftover `page-0002.jpg`
        // interleave in reading order instead of by scheme.
        .sort((a, b) => (zipEntryNumber(a) - zipEntryNumber(b)) || a.localeCompare(b, 'en', { numeric: true }))
        .map((name, i) => ({
            path: path.join(folder, name),
            name: `page_${pad(i + 1)}${path.extname(name).toLowerCase()}`,
            index: i,
        }));
}

/**
 * Finalize a session, reporting OCR and upload progress from the stream itself.
 *
 * `finalize` is the only streaming route the bridge has. It emits a fresh
 * `wait_ocr` frame at least every 0.75 s while the OCR queue drains, and an
 * `upload_progress` frame per file while a remote destination uploads -- the exact
 * information this used to collect by polling `GET /session/<id>/status` on a
 * 1–4 s interval *alongside* the request. No dokuha code path polls that route
 * any more, on either hand-off: the vendored client still exposes `status()` and
 * `waitForOcr()`, but nothing under `src/` calls them, because the folder-ingest
 * path and the per-page path both end up here.
 *
 * Calling finalize early is also what makes the bridge stop waiting: it
 * force-flushes the pending OCR queue on admission, so the last few pages do not
 * sit out the `OCR_CHUNK_SIZE`/`OCR_IDLE_FLUSH_S` window.
 *
 * `--ocr-wait` still bounds the OCR phase alone: the abort timer only fires while
 * the stream is still in `wait_ocr`, so a slow *upload* is not mistaken for a slow
 * model.
 */
export async function finalizeWithProgress(client, sessionId, key, destInfo, ctx = {}) {
    const params = {
        ...destInfo.params,

        deleteAfterUpload: destInfo.method !== 'local',
        ...(ctx.overwrite ? { overwrite: ctx.overwrite } : {}),
    };

    const controller = new AbortController();
    let stage = 'starting';
    let lastOcr = null;
    let expired = false;

    // The bridge uploads a cover, the archive and a mokuro file. The archive carries
    // nearly all the bytes, so it alone drives the percentage and it alone decides when
    // the volume is finishing rather than still transferring.
    const UPLOAD_ARCHIVE = /\.cbz$/i;
    let uploadPercent = 0;
    let archiveUploaded = false;

    const ocrWaitMs = Number(ctx.ocrWaitMs);
    const timer = Number.isFinite(ocrWaitMs) && ocrWaitMs > 0
        ? setTimeout(() => {
            if (stage === 'wait_ocr') {
                expired = true;
                controller.abort();
            }
        }, ocrWaitMs)
        : null;

    const onEvent = (event) => {
        const name = String(event?.stage || '');
        if (name === 'wait_ocr') {
            stage = name;
            lastOcr = event;
            ctx.progress?.update(key, {
                phase: 'ocr',
                ocr: event.pages_ocr_done || 0,
                ocrTotal: event.pages_received || 0,
                ocrPending: event.pages_ocr_pending || 0,
                failed: event.pages_ocr_failed || 0,
            });
            return;
        }
        stage = name;
        if (name === 'upload_progress' && event.upload) {
            const upload = event.upload;
            const file = upload.file || null;
            // The archive is the upload. The cover and the mokuro file are small
            // sidecars, and averaging them in held the bar at a third and then at two
            // thirds while the real transfer was still running, which read as a stall
            // beside a speed that kept updating. Track the archive's own percentage and
            // leave it untouched for the sidecars, which finish long before it does.
            const fileFraction = typeof upload.percent === 'number'
                ? Math.min(1, Math.max(0, upload.percent / 100))
                : 0;
            if (UPLOAD_ARCHIVE.test(file || '')) {
                uploadPercent = fileFraction * 100;
                if (uploadPercent >= 100) archiveUploaded = true;
            }
            ctx.progress?.update(key, {
                phase: 'finalizing',
                uploadFile: file,
                uploadPercent,
                // Latched once the archive itself is up, so the row can say it is
                // finishing without the cover's own counters claiming that first: the
                // cover and the mokuro file complete long before the archive starts.
                archiveUploaded,
                uploadBytes: upload.current_bytes ?? 0,
                uploadBytesTotal: upload.total_bytes ?? 0,
                uploadSpeed: upload.speed_human || null,
            });
            return;
        }
        if (name === 'assemble' || name === 'pack' || name === 'upload' || name === 'cleanup') {
            ctx.progress?.update(key, { phase: 'finalizing' });
        }
    };

    try {
        const final = await client.finalize(sessionId, {
            ...params,
            onEvent,
            signal: controller.signal,
            ...(Number.isFinite(Number(ctx.finalizeTimeoutMs))
                ? { timeoutMs: Number(ctx.finalizeTimeoutMs) }
                : {}),
        });
        ctx.progress?.update?.(key, { bridgeState: '' });
        // The `done` frame carries `pages_ocr_done` but not `pages_ocr_failed`, so
        // the last `wait_ocr` frame is the only place the failure count exists.
        // Hand it back beside the final record rather than reporting `null`.
        return lastOcr ? { ...final, ocr: lastOcr } : final;
    } catch (error) {
        if (!expired) throw error;
        throw new Error(`OCR did not finish within --ocr-wait (${Math.round(ocrWaitMs / 1000)}s)`
            + (lastOcr
                ? ` — ${lastOcr.pages_ocr_done || 0}/${lastOcr.pages_received || 0} page(s) done`
                : ''));
    } finally {
        if (timer) clearTimeout(timer);
    }
}

/** Is the bridge on this machine? A local path only means something to a local one. */
function isLoopback(baseUrl) {
    try {
        const host = new URL(baseUrl).hostname.replace(/^\[|\]$/g, '');
        return host === '127.0.0.1' || host === 'localhost' || host === '::1';
    } catch {
        return false;
    }
}

function sameBridgeTitle(a, b) {
    const normalize = (value) => String(value || '').normalize('NFKC').trim().toLocaleLowerCase();
    return normalize(a) !== '' && normalize(a) === normalize(b);
}

function existingSessionState(session, queue) {
    if (session.source_ingesting || session.pages_ingesting?.length) return 'bridge ingesting';
    if (session.upload?.active) return 'bridge uploading';
    const counts = (queue?.per_session || []).find((item) => item.session_id === session.session_id);
    const pending = Number(session.pages_ocr_pending ?? counts?.pending) || 0;
    const processing = Number(counts?.processing) || 0;
    if (processing) return `bridge OCR processing ${processing} page(s), ${pending} pending`;
    if (pending) return `bridge OCR queued ${pending} page(s)`;
    const done = Number(session.pages_ocr_done) || 0;
    if (session.finalizing) return done
        ? `bridge assembling/uploading after OCR (${done} pages)`
        : 'bridge finalizing';
    if (done > 0) return `bridge OCR complete (${done} pages); upload status unavailable`;
    return 'bridge session active; no OCR queued';
}

/**
 * The roots the bridge will read a local path from.
 *
 * Mirrors `_LOCAL_INGEST_ROOTS` in the bridge's `config.py`. Checked here so a
 * library on an external volume takes the upload path directly instead of earning a
 * 403 and a warning on every volume.
 */
function ingestRoots() {
    return [os.homedir(), os.tmpdir(), '/tmp', '/private/tmp', '/var/folders', '/private/var/folders'];
}

export function isIngestableFolder(folder) {
    const resolved = path.resolve(String(folder));
    return ingestRoots().some((root) => {
        const base = path.resolve(root);
        return resolved === base || resolved.startsWith(base + path.sep);
    });
}

/**
 * Try to hand the whole folder to the bridge in one request.
 *
 * Returns the bridge's session snapshot, or `null` when the per-page path should be
 * used instead: a remote bridge, a library outside the ingest roots, a bridge with no
 * usable `session/resume` route (403/404/405), a bridge whose resume handler threw
 * (5xx), or `--no-folder-ingest`. If the bridge rejects this title because an
 * existing session owns it, its live session and OCR queue state are queried before
 * skipping a duplicate upload.
 */
export async function ingestFolder(client, target, ctx = {}) {
    if (ctx.folderIngest === false) return null;
    if (!isLoopback(client.baseUrl)) return null;
    if (!isIngestableFolder(target.folder)) return null;
    try {
        return await client.resumeSession(target.title || target.id, target.folder);
    } catch (error) {
        // 403 is the ingest-root refusal and 404/405 mean the route is not there.
        // The bridge uses this response when the same title is already ingesting,
        // finalizing, or finalized. A concurrent session-creation response likewise
        // means another worker may own this title. Confirm it through /sessions
        // before deciding whether to skip; never guess from the error alone.
        // A 5xx means the bridge's own resume handler threw, which is a bridge bug
        // rather than a reason to lose the volume -- mokuro-bridge 0.6.0 shipped one
        // that answered 500 on every folder while its per-page route was fine.
        // Either way the pages can still be uploaded, so fall back and say so.
        const status = Number(error?.status) || 0;
        const unsupported = status === 403 || status === 404 || status === 405;
        const existingSession = (status === 400 || status === 409)
            && /session is finalizing or already finalized|session for this title was created concurrently/i
                .test(error.message || '');
        if (existingSession) {
            try {
                const state = await inspectExistingSession(client, target.title || target.id, ctx, target.key);
                if (state) return state;
            } catch (statusError) {
                noteResume(ctx, 'unknown', null);
                return {
                    alreadyHandled: true,
                    existingSession: null,
                    queue: null,
                    state: 'bridge status unavailable; duplicate transfer skipped',
                };
            }
            return {
                alreadyHandled: true,
                existingSession: null,
                queue: null,
                state: 'bridge has no live session for this title; completion status unavailable',
            };
        }
        if (status === 409 && /page is currently being OCR'd/i.test(error.message || '')) {
            const existing = await inspectExistingSession(client, target.title || target.id, ctx, target.key);
            const sessionId = existing.existingSession?.session_id;
            if (sessionId) {
                ctx.progress?.note?.(`  ${target.title || target.id}: waiting for the bridge's current OCR page before retrying the resume`);
                const waitDeadline = Date.now() + (Number(ctx?.ocrWaitMs) > 0 ? Number(ctx.ocrWaitMs) : 3600_000);
                for (;;) {
                    let latest;
                    let queue;
                    try {
                        [latest, queue] = await Promise.all([
                            client.status(sessionId),
                            client.queue().catch(() => null),
                        ]);
                    } catch (statusError) {
                        if (statusError?.status === 404) {
                            return {
                                alreadyHandled: true,
                                existingSession: null,
                                queue: null,
                                completionObserved: false,
                                state: 'bridge session finished while waiting to retry',
                            };
                        }
                        throw statusError;
                    }
                    const row = (queue?.per_session || []).find((item) => item.session_id === sessionId);
                    if (!latest.ingesting && !latest.source_ingesting && !(Number(row?.processing) || 0)) {
                        return await client.resumeSession(target.title || target.id, target.folder);
                    }
                    ctx.progress?.update?.(target.key, {
                        phase: 'ocr',
                        ocr: Number(latest.pages_ocr_done) || 0,
                        ocrTotal: Number(latest.pages_received) || 0,
                        ocrPending: Number(latest.pages_ocr_pending) || 0,
                        bridgeState: `waiting for bridge OCR (${Number(row?.processing) || 0} processing)`,
                        bridgeOcrDone: Number(latest.pages_ocr_done) || 0,
                        bridgeOcrTotal: Number(latest.pages_received) || 0,
                        bridgeOcrPending: Number(latest.pages_ocr_pending) || 0,
                        bridgeOcrProcessing: Number(row?.processing) || 0,
                    });
                    if (Date.now() > waitDeadline) {
                        throw new Error('bridge was still OCR\'ing a page when the wait expired; '
                            + 'raise --ocr-wait or check the bridge, then run again to resume it');
                    }
                    await new Promise((resolve) => setTimeout(resolve, 1000));
                }
            }
        }
        if (unsupported || status >= 500) {
            ctx.progress?.note?.(`  folder ingest unavailable (${String(error.message).split('\n')[0]}); `
                + 'uploading pages one at a time instead');
            return null;
        }
        throw error;
    }
}

export async function pushToBridge(client, destInfo, target, ctx) {
    const key = target.key;
    const files = await pageFiles(target.folder);
    if (!files.length) throw new Error(`no page images found in ${target.folder}`);

    const completion = await readCompletion(target.folder);
    if (completion && completion.destination === destinationKey(destInfo)
        && await samePageSet(files, completion.signature)) {
        const pages = completion.signature.count;
        ctx.progress?.update?.(key, {
            phase: 'done',
            ocr: pages,
            ocrTotal: pages,
            bridgeState: 'already completed and uploaded in an earlier run',
        });
        return {
            bridge: client.baseUrl,
            destination: destInfo.method,
            sessionId: completion.sessionId || null,
            ingest: 'already-completed',
            alreadyHandled: true,
            pagesIngested: pages,
            pagesQueued: 0,
            pagesUploaded: 0,
            pagesAlreadyOcr: pages,
            pagesFailed: 0,
            ocrDone: pages,
            ocrFailed: 0,
            outputDir: null,
            outputFiles: null,
            failures: [],
        };
    }

    const ingested = await ingestFolder(client, target, ctx);
    if (ingested?.alreadyHandled) {
        const result = await resumeExistingSession(client, destInfo, target, files, ingested, ctx);
        await rememberCompletion(target, files, destInfo, result);
        return result;
    }
    if (ingested) {
        const result = await finishIngested(client, ingested, files, key, destInfo, ctx);
        await rememberCompletion(target, files, destInfo, result);
        return result;
    }

    const session = await startBridgeSession(client, target.title || target.id, {
        progress: ctx.progress,
        key,
    });
    if (session?.alreadyHandled) {
        const result = await resumeExistingSession(client, destInfo, target, files, session, ctx);
        await rememberCompletion(target, files, destInfo, result);
        return result;
    }
    ctx.progress?.update(key, { phase: 'uploading', uploadTotal: files.length });

    let uploaded = 0;
    let cached = 0;
    const failures = [];

    for (let i = 0; i < files.length; i += ctx.pushConcurrency) {
        const batch = files.slice(i, i + ctx.pushConcurrency);
        await Promise.all(batch.map(async (file) => {
            try {
                await client.pushPage(
                    session.session_id,
                    await fsp.readFile(file.path),
                    file.name,
                    file.index,
                    { contentType: contentTypeFor(file.name) },
                );
                uploaded++;
            } catch (error) {

                if (error.alreadyOcr) cached++;
                else failures.push({ file: file.name, error: error.message });
            }
            ctx.progress?.update(key, { upload: uploaded, uploadCached: cached, failed: failures.length });
        }));
    }

    ctx.progress?.update(key, { phase: 'ocr' });
    const final = await finalizeWithProgress(client, session.session_id, key, destInfo, {
        overwrite: ctx.overwrite,
        progress: ctx.progress,
        ocrWaitMs: ctx.ocrWaitMs,
        finalizeTimeoutMs: ctx.finalizeTimeoutMs,
    });

    const result = {
        bridge: client.baseUrl,
        destination: destInfo.method,
        sessionId: session.session_id,
        ingest: 'pages',
        pagesUploaded: uploaded,
        pagesAlreadyOcr: cached,
        pagesFailed: failures.length,
        ocrDone: final?.pages_ocr_done ?? final?.ocr?.pages_ocr_done ?? null,
        ocrFailed: final?.pages_ocr_failed ?? final?.ocr?.pages_ocr_failed ?? null,
        outputDir: final?.output_dir || final?.outputDir || null,
        outputFiles: final?.uploads || null,
        failures,
        completed: final?.status === 'success',
    };
    await rememberCompletion(target, files, destInfo, result);
    return result;
}

export async function resumeExistingSession(client, destInfo, target, files, existing, ctx) {
    const sessionId = existing.existingSession?.session_id;
    if (!sessionId) {
        return {
            bridge: client.baseUrl,
            destination: destInfo.method,
            sessionId: null,
            ingest: existing.completionObserved ? 'already-completed' : 'existing-session-unconfirmed',
            alreadyHandled: true,
            completed: Boolean(existing.completionObserved),
            existingState: existing.state,
            pagesIngested: 0,
            pagesQueued: 0,
            pagesUploaded: 0,
            pagesAlreadyOcr: 0,
            pagesFailed: 0,
            ocrDone: null,
            ocrFailed: null,
            outputDir: null,
            outputFiles: null,
            failures: [],
        };
    }

    let latest = existing.existingSession;
    const startedAt = Date.now();
    const deadline = startedAt + (Number(ctx?.ocrWaitMs) > 0 ? Number(ctx.ocrWaitMs) : 3600_000);
    for (;;) {
        try {
            latest = await client.status(sessionId);
        } catch (error) {
            if (error?.status === 404) {
                noteResume(ctx, 'finished', target.title || target.id);
                return {
                    bridge: client.baseUrl,
                    destination: destInfo.method,
                    sessionId,
                    ingest: 'resumed-existing',
                    alreadyHandled: true,
                    completed: false,
                    completionObserved: false,
                    existingState: 'bridge session finished',
                    pagesIngested: Number(latest.pages_received) || files.length,
                    pagesQueued: 0,
                    pagesUploaded: 0,
                    pagesAlreadyOcr: Number(latest.pages_ocr_done) || 0,
                    pagesFailed: Number(latest.pages_ocr_failed) || 0,
                    ocrDone: Number(latest.pages_ocr_done) || null,
                    ocrFailed: Number(latest.pages_ocr_failed) || null,
                    outputDir: null,
                    outputFiles: null,
                    failures: [],
                };
            }
            throw error;
        }

        if (latest.finalized) {
            return {
                bridge: client.baseUrl,
                destination: destInfo.method,
                sessionId,
                ingest: 'already-completed',
                alreadyHandled: true,
                completed: false,
                existingState: 'bridge session was already finalized',
                pagesIngested: Number(latest.pages_received) || files.length,
                pagesQueued: 0,
                pagesUploaded: 0,
                pagesAlreadyOcr: Number(latest.pages_ocr_done) || 0,
                pagesFailed: 0,
                ocrDone: Number(latest.pages_ocr_done) || null,
                ocrFailed: Number(latest.pages_ocr_failed) || 0,
                outputDir: null,
                outputFiles: null,
                failures: [],
            };
        }

        const queue = await client.queue().catch(() => null);
        const queueEntry = (queue?.per_session || []).find((item) => item.session_id === sessionId);
        const pending = Number(latest.pages_ocr_pending) || 0;
        const processing = Number(queueEntry?.processing) || 0;
        const upload = latest.upload;
        const state = upload?.active
            ? `bridge uploading ${upload.file || ''}`.trim()
            : latest.source_ingesting || latest.ingesting
                ? 'bridge ingesting pages'
                : processing
                    ? `bridge OCR processing ${processing}, ${pending} pending`
                    : pending
                        ? `bridge OCR queued ${pending}`
                        : latest.finalizing
                            ? 'bridge assembling .mokuro'
                            : 'bridge session ready to finalize';

        ctx.progress?.update?.(target.key, {
            phase: upload?.active ? 'finalizing' : 'ocr',
            ocr: Number(latest.pages_ocr_done) || 0,
            ocrTotal: Number(latest.pages_received) || files.length,
            ocrPending: pending,
            failed: Number(latest.pages_ocr_failed) || 0,
            bridgeState: state,
            bridgeOcrDone: Number(latest.pages_ocr_done) || 0,
            bridgeOcrTotal: Number(latest.pages_received) || files.length,
            bridgeOcrPending: pending,
            bridgeOcrProcessing: processing,
            bridgeWorker: queue?.worker?.state || 'unknown',
            bridgeQueueDepth: Number(queue?.queue_depth) || 0,
            bridgeProcessingDepth: Number(queue?.processing_depth) || 0,
            ...(upload?.active ? {
                uploadFile: upload.file || null,
                uploadPercent: upload.percent ?? null,
                uploadBytes: upload.current_bytes ?? 0,
                uploadBytesTotal: upload.total_bytes ?? 0,
                uploadSpeed: upload.speed_human || null,
            } : {}),
        });

        if (!latest.finalizing && !latest.ingesting && !latest.source_ingesting) {
            try {
                const final = await finalizeWithProgress(client, sessionId, target.key, destInfo, {
                    overwrite: ctx.overwrite,
                    progress: ctx.progress,
                    ocrWaitMs: ctx.ocrWaitMs,
                    finalizeTimeoutMs: ctx.finalizeTimeoutMs,
                });
                const result = {
                    bridge: client.baseUrl,
                    destination: destInfo.method,
                    sessionId,
                    ingest: 'resumed-existing',
                    alreadyHandled: true,
                    existingState: 'existing session resumed through finalization',
                    pagesIngested: Number(latest.pages_received) || files.length,
                    pagesQueued: pending,
                    pagesUploaded: 0,
                    pagesAlreadyOcr: Number(latest.pages_ocr_done) || 0,
                    pagesFailed: Number(final?.pages_ocr_failed) || 0,
                    ocrDone: final?.pages_ocr_done ?? final?.ocr?.pages_ocr_done ?? null,
                    ocrFailed: final?.pages_ocr_failed ?? final?.ocr?.pages_ocr_failed ?? null,
                    outputDir: final?.output_dir || final?.outputDir || null,
                    outputFiles: final?.uploads || null,
                    failures: [],
                    completed: final?.status === 'success',
                };
                return result;
            } catch (error) {
                if (!/finalize 409/.test(error.message || '')) throw error;
            }
        }
        if (Date.now() > deadline) {
            throw new Error(`bridge session ${sessionId} was still busy after ${Math.round((deadline - startedAt) / 1000)}s; `
                + 'raise --ocr-wait or check the bridge, then run again to resume it');
        }
        await new Promise((resolve) => setTimeout(resolve, 1000));
    }
}

/**
 * The folder-ingest half of `pushToBridge`.
 *
 * One `session/resume` and one `finalize`, whatever the page count -- the bridge
 * does the copying and the cache bookkeeping itself. The numbers it reports are its
 * own: `synced_from_source` is how many images it took from the folder,
 * `queued_for_ocr` how many needed OCR, and `ocr_cached` how many it skipped.
 */
async function finishIngested(client, session, files, key, destInfo, ctx) {
    const queued = Number(session.queued_for_ocr) || 0;
    const cached = Number(session.ocr_cached) || 0;
    ctx.progress?.update(key, {
        phase: 'uploading',
        uploadTotal: files.length,
        upload: Number(session.synced_from_source) || files.length,
        uploadCached: cached,
    });

    ctx.progress?.update(key, { phase: 'ocr' });
    const final = await finalizeWithProgress(client, session.session_id, key, destInfo, {
        overwrite: ctx.overwrite,
        progress: ctx.progress,
        ocrWaitMs: ctx.ocrWaitMs,
        finalizeTimeoutMs: ctx.finalizeTimeoutMs,
    });

    return {
        bridge: client.baseUrl,
        destination: destInfo.method,
        sessionId: session.session_id,
        ingest: 'folder',
        pagesIngested: Number(session.synced_from_source) || files.length,
        pagesQueued: queued,
        // Nothing crossed HTTP, so the upload counters stay zero rather than
        // claiming the pages were pushed.
        pagesUploaded: 0,
        pagesAlreadyOcr: cached,
        pagesFailed: 0,
        ocrDone: final?.pages_ocr_done ?? final?.ocr?.pages_ocr_done ?? null,
        ocrFailed: final?.pages_ocr_failed ?? final?.ocr?.pages_ocr_failed ?? null,
        outputDir: final?.output_dir || final?.outputDir || null,
        outputFiles: final?.uploads || null,
        failures: [],
        completed: final?.status === 'success',
    };
}

function destinationKey(destInfo) {
    return `${destInfo.method}|${destInfo.params?.localDir || ''}`;
}

/**
 * A cheap identity for a page set: how many files, how many bytes, and the newest
 * modification time. Hashing every byte made a resumed run read the whole volume
 * back off disk before deciding to skip it, which is the opposite of resuming.
 */
async function pageSignature(files) {
    let bytes = 0;
    let newest = 0;
    for (const file of files) {
        const stat = await fsp.stat(file.path);
        bytes += stat.size;
        newest = Math.max(newest, stat.mtimeMs);
    }
    return { count: files.length, bytes, newest: Math.round(newest) };
}

async function readCompletion(folder) {
    try {
        const value = JSON.parse(await fsp.readFile(path.join(folder, '.dokuha-bridge-completion.json'), 'utf8'));
        const signature = value?.signature;
        if (value?.version !== 2 || !signature
            || !Number.isInteger(signature.count) || !Number.isFinite(signature.bytes)) return null;
        return value;
    } catch {
        return null;
    }
}

async function samePageSet(files, stored) {
    if (!stored || files.length !== stored.count) return false;
    const current = await pageSignature(files);
    return current.count === stored.count
        && current.bytes === stored.bytes
        && current.newest === stored.newest;
}

async function rememberCompletion(target, files, destInfo, result) {
    if (!result?.completed || result.pagesFailed > 0 || !target.folder) return;
    const marker = {
        version: 2,
        destination: destinationKey(destInfo),
        sessionId: result.sessionId || null,
        completedAt: new Date().toISOString(),
        signature: await pageSignature(files),
    };
    const markerPath = path.join(target.folder, '.dokuha-bridge-completion.json');
    const temporary = `${markerPath}.${process.pid}.tmp`;
    try {
        await fsp.writeFile(temporary, JSON.stringify(marker), { encoding: 'utf8', mode: 0o600 });
        await fsp.rename(temporary, markerPath);
    } catch {
        await fsp.rm(temporary, { force: true }).catch(() => {});
    }
}

export async function connectBridge(config, { resolveDestination, describeDestinations } = {}) {
    const found = await discoverBridge(config.bridge);
    if (!found) {
        throw new Error(
            `no mokuro-bridge found on ${config.bridge || 'the default ports (:62642)'}`
            + '. Start it, or point at it with --bridge URL.',
        );
    }
    const client = new BridgeClient(found.baseUrl);
    const method = config.dest ? config.dest : null;
    // Resolve here, not on the bridge: a relative --dest-folder silently landed in
    // the bridge's own working directory, so the user's `./out` was not their ./out.
    const folder = config.destFolder ? path.resolve(config.destFolder) : null;
    const destInfo = await resolveDestination(client, { dest: method, folder });
    return { client, baseUrl: found.baseUrl, health: found.health, destInfo, describeDestinations };
}
