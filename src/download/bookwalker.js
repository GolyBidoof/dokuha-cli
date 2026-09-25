/**
 * BookWalker support, driving the vendored browserless licence sampler.
 *
 * Two routes exist and they are chosen by the sampler, not by us:
 *
 *   free   the anonymous handshake, which is what a "free to read" or `?sample=2`
 *          volume needs. No account, no cookies, no browser.
 *   trial  the separate trial viewer and licence endpoint.
 *
 * A signed-in session is only required for titles already in a library. It is
 * supplied either as a saved session or as explicit cookies.
 */

import path from 'node:path';
import fsp from 'node:fs/promises';
import { createRequire } from 'node:module';

import { startBridgeSession } from '../bridge.js';
import { safeFolderName } from './cmoa.js';
import { BwNormalizePool, defaultNormalizeWorkers } from './bw-normalize-pool.js';

// The sampler is CommonJS, so it is loaded through require rather than imported.
const require = createRequire(import.meta.url);

/** The auth parameters the CDN licence expects, in the sampler's own order. */
const AUTH_PARAM_KEYS = ['hti', 'cfg', 'bid', 'uuid', 'pfCd', 'Policy', 'Signature', 'Key-Pair-Id'];

let sampler = null;

/** Load the vendored sampler once. */
function loadSampler() {
    if (!sampler) {
        const freeVolume = require('../../vendor/bookwalker/free-volume.js');
        const publicTrial = require('../../vendor/bookwalker/public-trial.js');
        const bridgeClient = require('../../vendor/bookwalker/bridge-client.js');
        sampler = {
            openFreeSession: freeVolume.openFreeSession,
            mergeCookies: freeVolume.mergeCookies,
            readCookieArgument: freeVolume.readCookieArgument,
            runPublicTrialJob: publicTrial.runPublicTrialJob,
            BridgeClient: bridgeClient.BridgeClient,
        };
    }
    return sampler;
}

/**
 * Check that `sharp` is available before a BookWalker page is attempted.
 *
 * BookWalker's public pages are encrypted and need `sharp` to decode. It is an
 * optional dependency, because the other two stores never touch it, so the failure
 * has to be explained here rather than surfacing as a decode error per page. The
 * sampler's own message ("Encrypted public pages require the optional sharp image
 * dependency") does not say how to fix it, which is the gap this closes.
 */
export function assertSharpAvailable() {
    try {
        require('sharp');
    } catch {
        throw new Error(
            'BookWalker pages are encrypted and need the optional "sharp" dependency, which is not installed.\n'
            + '  Install it with:  npm install sharp\n'
            + '  The other two stores (CMOA and ebookjapan) work without it, so you can also drop any\n'
            + '  BookWalker URLs and re-run.',
        );
    }
}

/**
 * Build the cookie argument the sampler expects, if any were given.
 *
 * Parsing is delegated to the sampler so every shape keeps working: a raw
 * `Cookie:` header, a `Copy as cURL` command, `@FILE`, a bare path, or `-` for
 * stdin. Each argument becomes one header, merged last-wins by name. Done at call
 * time because `-` reads stdin, which must not happen during argument parsing.
 */
function cookieArgument(config) {
    if (!config.bwCookies.length) return undefined;
    const { mergeCookies, readCookieArgument } = loadSampler();
    return mergeCookies(config.bwCookies.map((arg) => readCookieArgument(arg)));
}

/**
 * Explain a refused licence in terms of what the user can do about it.
 *
 * A bare "status 400" is the least useful outcome of the three routes, and it is
 * the one users hit most often when a saved session has simply gone stale.
 */
function licenceError(payload, config) {
    const status = payload?.status ? ` (BookWalker status ${payload.status})` : '';
    const signedIn = config.bwCookies.length > 0 || !config.bwNoState;
    const hints = [];
    if (status && signedIn) {
        hints.push('The session may have expired. Sign in again on bookwalker.jp and copy fresh cookies.');
    }
    if (!config.bwNoState) {
        hints.push('Try clearing the saved session with --no-state.');
    }
    hints.push('Free volumes need no session at all; drop --bw-cookie and --bw-state to test that.');
    return `BookWalker did not grant a licence${status}.\n  ${hints.join('\n  ')}`;
}

/**
 * Download one BookWalker volume.
 *
 * @param {object} task `{ cid, target, key, title? }`
 * @param {object} ctx `{ out, titleDir, config, progress, bridge }` where
 *   `bridge` is `{ baseUrl, client, destInfo }` when OCR was requested.
 * @returns {Promise<object>} a uniform store record
 */
export async function downloadBookwalker(task, ctx) {
    assertSharpAvailable();
    const { openFreeSession, runPublicTrialJob, BridgeClient: BwBridgeClient } = loadSampler();
    const { config, progress } = ctx;
    const wantOcr = Boolean(ctx.bridge);

    // The handshake also resolves the title, so the folder is created under a
    // provisional name and renamed once the real title is known.
    const stage = path.join(ctx.out, config.titleDir ? 'pending' : task.cid);
    await fsp.mkdir(stage, { recursive: true });

    const session = await openFreeSession(task.cid, {
        cookie: cookieArgument(config),
        cr: config.bwNoCr ? null : (config.bwCr || undefined),
        bid: undefined,
        u1: config.bwU1 || undefined,
        route: config.bwSample ? 'sample' : undefined,
        entry: config.bwEntry || undefined,
        stateFile: config.bwNoState ? null : (config.bwState || undefined),
    });

    const payload = session.payload;
    if (!payload || payload.status !== '200' || !payload.auth_info || !payload.url) {
        throw new Error(licenceError(payload, config));
    }

    const title = String(payload.cti || task.cid);
    const folder = config.titleDir ? path.join(ctx.out, safeFolderName(title, task.cid)) : stage;
    if (folder !== stage) {
        await fsp.rename(stage, folder).catch(() => {});
        await fsp.mkdir(folder, { recursive: true });
    }

    // The manifest sits directly under the licence base URL. The viewer's quality
    // buckets (`normal_default/`, `large_default/`, `x-large_default/`) are probed
    // first by the sampler and all answer 403 on this route, which reads exactly
    // like a licence problem; only the bare path works.
    const baseUrl = String(payload.url).replace(/\/*$/, '/');
    const auth = payload.auth_info;
    const authParams = new URLSearchParams();
    for (const key of AUTH_PARAM_KEYS) {
        if (auth[key] != null) authParams.set(key, String(auth[key]));
    }
    const manifestRes = await fetch(`${baseUrl}configuration_pack.json?${authParams.toString()}`, {
        headers: { 'User-Agent': ctx.userAgent },
    });
    if (!manifestRes.ok) throw new Error(`BookWalker manifest HTTP ${manifestRes.status}`);
    const configBody = await manifestRes.text();

    // The sampler builds its own client; wrap it so pages it considers already
    // OCR'd are counted as cache hits rather than uploads.
    const tolerant = wantOcr ? new TolerantBridge(new BwBridgeClient({ baseUrl: ctx.bridge.baseUrl })) : null;

    // Encrypted pages are un-permuted and re-encoded in worker threads instead
    // of on the event loop that drives the fetches. The guard is deliberately
    // the same one the inline path uses: a plaintext manifest, or a page with no
    // seeds, must be handed straight back rather than decoded and re-encoded --
    // otherwise the pool would cost more than it saves on unencrypted books.
    const normalizer = new BwNormalizePool(
        Number(ctx.normalizeWorkers) > 0 ? Number(ctx.normalizeWorkers) : defaultNormalizeWorkers(),
    );
    const normalizePage = (data, job, manifest) => {
        if (manifest.decoded.plaintext || !job.seeds) return data;
        return normalizer.normalize(data, job.seeds);
    };

    let result;
    try {
        result = await runPublicTrialJob({
            url: task.target,
            bridge: tolerant || undefined,
            session: {
                cid: task.cid,
                apiHost: 'https://viewer.bookwalker.jp',
                auth,
                baseUrl,
                cti: payload.cti || null,
                isTrial: false,
            },
            configBody,
            outputDir: folder,
            ocr: wantOcr,
            bridgeUrl: wantOcr ? ctx.bridge.baseUrl : null,
            reuseExisting: true,
            pageConcurrency: ctx.bwConcurrency ?? config.bwConcurrency,
            pageUploadConcurrency: config.pushConcurrency,
            normalizePage,
            onProgress: (event) => reportBookwalker(event, task, progress),
        });
    } finally {
        // Never leave workers behind on a failed or cancelled volume.
        await normalizer.close();
    }

    const record = {
        store: 'bookwalker',
        id: task.cid,
        title,
        folder,
        totalPages: result.total,
        downloaded: result.pageCount,
        skipped: 0,
        failed: (result.failures || []).length,
        bytes: 0,
        failures: result.failures || [],
        route: result.publicRoute || null,
        mode: result.mode,
    };

    if (wantOcr) {
        // The sampler handed the pages to the bridge but deliberately did not
        // finalize; assembling the .mokuro is this driver's job, exactly as for
        // the other two stores.
        if (!result.bridgeSessionId) throw new Error('BookWalker returned no bridge session to finalize');
        const cached = tolerant ? tolerant.cached : 0;
        record.mokuro = {
            bridge: ctx.bridge.baseUrl,
            sessionId: result.bridgeSessionId,
            // The sampler reports every page it sent; the ones the bridge refused
            // as already-OCR'd were cache hits, not uploads.
            pagesUploaded: Math.max(0, result.pageCount - cached),
            pagesAlreadyOcr: cached,
            pagesFailed: (result.failures || []).length,
            deferredFinalize: true,
        };
    } else if (result.outputPath) {
        record.archive = result.outputPath;
        record.bytes = (await fsp.stat(result.outputPath).catch(() => ({ size: 0 }))).size;
    }

    return record;
}

/** Translate the sampler's progress events into display updates. */
function reportBookwalker(event, task, progress) {
    const key = task.key;
    switch (event.type) {
        case 'book-total':
            progress?.update(key, { total: event.total, label: event.title || task.title });
            break;
        case 'download-progress':
            progress?.update(key, { phase: 'downloading', done: event.pageCount, total: event.total });
            break;
        case 'download-error':
            progress?.update(key, { failed: (progress.get(key)?.failed || 0) + 1 });
            break;
        case 'bridge-session':
            progress?.update(key, { phase: 'uploading', uploadTotal: event.total || 0 });
            break;
        case 'upload-progress':
            progress?.update(key, { phase: 'uploading', upload: event.uploaded || event.pageCount });
            break;
        case 'ocr-progress':
            progress?.update(key, {
                phase: 'ocr',
                ocr: event.completed != null ? event.completed : (event.pageCount ?? 0),
                ocrTotal: event.total || 0,
            });
            break;
        case 'zip-start':
        case 'zip-complete':
            progress?.update(key, { phase: 'finalizing' });
            break;
        default:
            // Unknown event types are ignored on purpose: the sampler may add
            // more, and a new one should not break a run.
            break;
    }
}

/**
 * Wrap a bridge client so an already-OCR'd page counts as a cache hit.
 *
 * The bridge answers 409 "Page already has completed OCR" when a page is pushed
 * twice. That is the mechanism that makes a re-run resume, so it is a success, not
 * an error. Everything else is forwarded unchanged rather than reimplemented.
 */
class TolerantBridge {
    constructor(inner) {
        this.inner = inner;
        this.cached = 0;
        return new Proxy(this, {
            get: (target, prop) => {
                if (prop in target) return target[prop];
                const value = target.inner[prop];
                return typeof value === 'function' ? value.bind(target.inner) : value;
            },
        });
    }

    async pushPageBuffer(sessionId, data, filename, pageNumber, options) {
        try {
            return await this.inner.pushPageBuffer(sessionId, data, filename, pageNumber, options);
        } catch (error) {
            if (error?.status === 409 && /already has completed OCR|already queued or present/i.test(error.message || '')) {
                this.cached++;
                return { ok: true, cached: true, page: pageNumber };
            }
            throw error;
        }
    }

    /** Route the sampler's session start through the shared reuse fallback. */
    startSession(title, options) {
        return startBridgeSession(this.inner, title, options);
    }
}
