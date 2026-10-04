
import os from 'node:os';
import path from 'node:path';
import fsp from 'node:fs/promises';

import { discoverBridge, BridgeClient } from '../vendor/ebookjapan/bridge.mjs';

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

export async function startBridgeSession(client, title, { reuseExisting = true } = {}) {
    try {
        return await client.startSession(title, { reuseExisting });
    } catch (error) {
        const refused = error?.status === 400
            && /finalizing or already finalized|concurrently/i.test(error.message || '');
        if (!reuseExisting || !refused) throw error;
        return client.startSession(title, { reuseExisting: false });
    }
}

export async function pageFiles(folder) {
    const entries = await fsp.readdir(folder, { withFileTypes: true });
    const pad = (n) => String(n).padStart(4, '0');
    return entries
        .filter((e) => e.isFile() && CONTENT_TYPES[path.extname(e.name).toLowerCase()])
        .map((e) => e.name)
        .sort((a, b) => a.localeCompare(b, 'en', { numeric: true }))
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
            ctx.progress?.update(key, {
                phase: 'finalizing',
                uploadFile: upload.file || null,
                uploadPercent: typeof upload.percent === 'number' ? upload.percent : null,
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
 * (5xx), or `--no-folder-ingest`.
 */
export async function ingestFolder(client, target, ctx = {}) {
    if (ctx.folderIngest === false) return null;
    if (!isLoopback(client.baseUrl)) return null;
    if (!isIngestableFolder(target.folder)) return null;
    try {
        return await client.resumeSession(target.title || target.id, target.folder);
    } catch (error) {
        // 403 is the ingest-root refusal and 404/405 mean the route is not there.
        // A 5xx means the bridge's own resume handler threw, which is a bridge bug
        // rather than a reason to lose the volume -- mokuro-bridge 0.6.0 shipped one
        // that answered 500 on every folder while its per-page route was fine.
        // Either way the pages can still be uploaded, so fall back and say so.
        const status = Number(error?.status) || 0;
        const unsupported = status === 403 || status === 404 || status === 405;
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

    const ingested = await ingestFolder(client, target, ctx);
    if (ingested) return finishIngested(client, ingested, files, key, destInfo, ctx);

    const session = await startBridgeSession(client, target.title || target.id);
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

    return {
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
    };
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
    };
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
    const method = config.dest || config.localDir ? (config.dest || 'local') : null;
    const folder = config.destFolder || config.localDir || null;
    const destInfo = await resolveDestination(client, { dest: method, folder });
    return { client, baseUrl: found.baseUrl, health: found.health, destInfo, describeDestinations };
}
