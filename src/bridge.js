/**
 * Talking to a local mokuro-bridge.
 *
 * mokuro-bridge runs OCR over a volume and can then hand the result to a
 * destination (a local folder, MEGA, Drive). Every store feeds it the same way:
 * pages go up, OCR is polled, then the session is finalized.
 */

import path from 'node:path';
import fsp from 'node:fs/promises';

import { discoverBridge, BridgeClient } from '../vendor/ebookjapan/bridge.mjs';

/** MIME type per page extension. */
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

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Start a bridge session, falling back to a fresh one when reuse is refused.
 *
 * Reuse is always attempted first because it is what makes the OCR cache work: a
 * re-run resumes instead of re-OCRing everything. But the bridge refuses reuse
 * once a session is finalized, and it can also leave a title permanently
 * un-reusable by setting its `ingesting` flag on a reuse attempt that then fails,
 * after which every reuse of that title answers
 * `400 Session is finalizing or already finalized`. Retrying without reuse gets a
 * genuinely new session.
 */
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

/**
 * Page files in the order they should be OCR'd.
 *
 * Every store writes zero-padded names, so a plain numeric sort is page order.
 * The name is normalised to `page_NNNN.<ext>` because the bridge names its output
 * from the filenames it is handed.
 */
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
 * Poll a session until OCR stops making progress.
 *
 * The bridge OCRs as pages arrive but only reports it when asked, and the OCR
 * wait is where most of a run's wall time goes, so without polling the display
 * would sit on "uploading" for the whole of it.
 *
 * The interval backs off while nothing changes, up to four seconds, so a long
 * volume does not cost thousands of status calls.
 */
export async function waitForOcr(client, sessionId, key, pageTotal, deadlineMs, progress) {
    const deadline = Date.now() + deadlineMs;
    let interval = 1000;
    let lastKey = '';
    let last = null;

    for (;;) {
        try {
            const status = await client.status(sessionId);
            last = status;
            progress?.update(key, {
                phase: 'ocr',
                ocr: status.pages_ocr_done || 0,
                ocrTotal: status.pages_received || pageTotal,
                ocrPending: status.pages_ocr_pending || 0,
                failed: status.pages_ocr_failed || 0,
            });
            const pending = status.pages_ocr_pending || 0;
            if (pending === 0 && ((status.pages_ocr_done || 0) > 0 || (status.pages_ocr_failed || 0) > 0)) {
                return status;
            }
            const changeKey = `${status.pages_ocr_done}/${status.pages_received}`;
            interval = changeKey === lastKey ? Math.min(4000, Math.round(interval * 1.5)) : 1000;
            lastKey = changeKey;
        } catch {
            // A transient status failure must not abort an in-flight OCR run.
        }
        if (Date.now() > deadline) return last;
        await sleep(interval);
    }
}

/**
 * Push one volume's pages, wait for OCR, then finalize.
 *
 * @param {object} client bridge client
 * @param {object} destInfo resolved destination (`{ method, params }`)
 * @param {object} target `{ key, title?, id?, folder }`
 * @param {object} ctx `{ pushConcurrency, ocrWaitMs, overwrite, progress }`
 * @returns {Promise<object>} a mokuro record for the store result
 */
export async function pushToBridge(client, destInfo, target, ctx) {
    const key = target.key;
    const files = await pageFiles(target.folder);
    if (!files.length) throw new Error(`no page images found in ${target.folder}`);

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
                // Re-pushing an already-OCR'd page is an idempotent no-op.
                if (error.alreadyOcr) cached++;
                else failures.push({ file: file.name, error: error.message });
            }
            ctx.progress?.update(key, { upload: uploaded, uploadCached: cached, failed: failures.length });
        }));
    }

    ctx.progress?.update(key, { phase: 'ocr' });
    const status = await waitForOcr(client, session.session_id, key, files.length, ctx.ocrWaitMs, ctx.progress);

    ctx.progress?.update(key, { phase: 'finalizing' });
    const final = await client.finalize(session.session_id, {
        ...destInfo.params,
        // A remote destination owns the file itself, so the bridge should not
        // leave a second copy behind on disk.
        deleteAfterUpload: destInfo.method !== 'local',
        ...(ctx.overwrite ? { overwrite: ctx.overwrite } : {}),
    });

    return {
        bridge: client.baseUrl,
        destination: destInfo.method,
        sessionId: session.session_id,
        pagesUploaded: uploaded,
        pagesAlreadyOcr: cached,
        pagesFailed: failures.length,
        ocrDone: status?.pages_ocr_done ?? null,
        ocrFailed: status?.pages_ocr_failed ?? null,
        outputDir: final?.output_dir || final?.outputDir || null,
        outputFiles: final?.files || null,
        failures,
    };
}

/**
 * Find the bridge and resolve where its output should go.
 *
 * @returns {Promise<{client: object, baseUrl: string, health: object, destInfo: object}>}
 *   throws with an actionable message when no bridge answers.
 */
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
