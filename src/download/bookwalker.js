
import path from 'node:path';
import fsp from 'node:fs/promises';
import { createRequire } from 'node:module';

import { startBridgeSession } from '../bridge.js';
import { timed } from '../phase-timer.js';
import { volumeFolder, writeVolumeMarker } from './volume-folder.js';
import { BwNormalizePool, defaultNormalizeWorkers } from './bw-normalize-pool.js';
import { pageFileName, stampPageTimes } from './page-files.js';
import {
    MAX_SERIES_PAGES,
    dedupeBookwalkerVolumes,
    fetchText,
    parseBookwalkerNextPage,
    parseBookwalkerSeriesId,
    parseBookwalkerSeriesList,
    parseVolumeNumber,
    reject,
} from '../series.js';

const require = createRequire(import.meta.url);

const AUTH_PARAM_KEYS = ['hti', 'cfg', 'bid', 'uuid', 'pfCd', 'Policy', 'Signature', 'Key-Pair-Id'];

let sampler = null;

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

            readLicence: freeVolume.readLicence,
            writeLicence: freeVolume.writeLicence,
        };
    }
    return sampler;
}

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

function cookieArgument(config) {
    if (!config.bwCookies.length) return undefined;
    const { mergeCookies, readCookieArgument } = loadSampler();
    return mergeCookies(config.bwCookies.map((arg) => readCookieArgument(arg)));
}

export function createBookwalkerCarrier() {
    return { options: null, session: null, cookie: null, cr: null, prewarm: null };
}

export function allowsSharing(config) {
    return config.bwCookies.length === 0 && !config.bwSample && !config.bwEntry && !config.bwNoCr;
}

function optionsFor(carrier, config) {
    if (carrier && carrier.options) return carrier.options;
    const options = {
        cookie: cookieArgument(config),
        cr: config.bwNoCr ? null : (config.bwCr || undefined),
        bid: undefined,
        u1: config.bwU1 || undefined,
        route: config.bwSample ? 'sample' : undefined,
        entry: config.bwEntry || undefined,
        stateFile: config.bwNoState ? null : (config.bwState || undefined),
    };
    if (carrier) carrier.options = options;
    return options;
}

export function prewarmBookwalker(carrier, cid, config) {

    if (!cid || !carrier || carrier.prewarm || carrier.session || !allowsSharing(config)) return null;
    const { openFreeSession, readLicence } = loadSampler();
    const options = optionsFor(carrier, config);

    if (!config.bwNoState && readLicence(cid, { stateFile: options.stateFile })) return null;
    carrier.prewarm = (async () => {
        const session = await openFreeSession(cid, options);
        if (session?.payload?.status === '200' && session.jar) {
            carrier.session = session;
            carrier.cookie = session.jar.header();
            carrier.cr = session.cr;
        }
        return session;
    })().catch(() => null);
    return carrier.prewarm;
}

const licenceKey = (cid, sample) => (sample ? `${cid}-sample` : cid);

async function negotiateSession(cid, config, carrier, sample = false) {
    const { openFreeSession, readLicence } = loadSampler();

    const anonymous = !sample && allowsSharing(config);
    const base = optionsFor(carrier, config);
    const options = sample ? { ...base, route: 'sample' } : base;
    const key = licenceKey(cid, sample);

    if (!config.bwNoState && (anonymous || sample)) {
        const cached = readLicence(key, { stateFile: options.stateFile });
        if (cached) return { cid, payload: cached, jar: null, cr: null, crSource: 'cached licence', cached: true };
    }

    if (carrier && anonymous) {
        if (carrier.prewarm) {
            await carrier.prewarm;
            carrier.prewarm = null;
        }

        if (carrier.session && carrier.session.cid === cid && carrier.session.payload?.status === '200') {
            return carrier.session;
        }
        if (carrier.cookie) {
            const bound = await openFreeSession(cid, {
                ...options, cookie: carrier.cookie, route: 'bind', cr: carrier.cr || undefined,
            });
            if (bound.payload?.status === '200') return bound;
        }
    }

    const session = await openFreeSession(cid, options);
    if (carrier && anonymous && session.payload?.status === '200' && session.jar) {
        carrier.session = session;
        carrier.cookie = session.jar.header();
        carrier.cr = session.cr;
    }
    return session;
}

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

export async function downloadBookwalker(task, ctx) {
    assertSharpAvailable();
    const { runPublicTrialJob, BridgeClient: BwBridgeClient } = loadSampler();
    const { config, progress } = ctx;
    const wantOcr = Boolean(ctx.bridge);

    const sample = task.sample === true;
    const session = await timed(ctx.timer, 'handshake', () => negotiateSession(task.cid, config, ctx.bwCarrier, sample));

    const payload = session.payload;
    if (!payload || payload.status !== '200' || !payload.auth_info || !payload.url) {
        throw new Error(licenceError(payload, config));
    }

    if (!config.bwNoState && !session.cached && (sample || allowsSharing(config))) {
        try {
            const stateFile = optionsFor(ctx.bwCarrier, config).stateFile;
            loadSampler().writeLicence(licenceKey(task.cid, sample), payload, { stateFile });
        } catch {  }
    }

    const title = String(payload.cti || task.title || task.cid);
    const folder = await volumeFolder(ctx, { title, id: task.cid, sample });
    await fsp.mkdir(folder, { recursive: true });

    const baseUrl = String(payload.url).replace(/\/*$/, '/');
    const auth = payload.auth_info;
    const authParams = new URLSearchParams();
    for (const key of AUTH_PARAM_KEYS) {
        if (auth[key] != null) authParams.set(key, String(auth[key]));
    }
    // Preparation, not a handshake: the licence is already in hand, and this is the
    // volume's page manifest. The engines that own their page loop have no seam here,
    // so BookWalker is one of the stores that can actually separate the two.
    const configBody = await timed(ctx.timer, 'prework', async () => {
        const res = await fetch(`${baseUrl}configuration_pack.json?${authParams.toString()}`, {
            headers: { 'User-Agent': ctx.userAgent },
        });
        if (!res.ok) throw new Error(`BookWalker manifest HTTP ${res.status}`);
        return res.text();
    });

    const tolerant = wantOcr ? new TolerantBridge(new BwBridgeClient({ baseUrl: ctx.bridge.baseUrl })) : null;

    const normalizer = new BwNormalizePool(
        Number(ctx.normalizeWorkers) > 0 ? Number(ctx.normalizeWorkers) : defaultNormalizeWorkers(),
    );
    const normalizePage = (data, job, manifest) => {
        if (manifest.decoded.plaintext || !job.seeds) return data;
        return timed(ctx.timer, 'rebuild', () => normalizer.normalize(data, job.seeds));
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

            safeTitle: title,

            pagesAsFiles: !config.zip,
            ocr: wantOcr,
            bridgeUrl: wantOcr ? ctx.bridge.baseUrl : null,
            reuseExisting: true,
            pageConcurrency: ctx.bwConcurrency ?? config.bwConcurrency,
            pageUploadConcurrency: config.pushConcurrency,
            normalizePage,
            // The engine owns the page loop, so it is the only thing that can say how
            // much of a page was transport and how much was seam-carving.
            onPhase: (name, ms) => ctx.timer?.add(name, ms),
            onProgress: (event) => reportBookwalker(event, task, progress, Boolean(ctx.bridge)),
        });
    } finally {

        await normalizer.close();
    }


    if (!config.zip && result.pageCount) {
        const files = Array.from({ length: result.pageCount }, (_, i) => pageFileName(i + 1, 'jpg'));
        await stampPageTimes(folder, files);
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

    await writeVolumeMarker(folder, { store: 'bookwalker', id: task.cid, title });

    if (wantOcr) {

        if (!result.bridgeSessionId) throw new Error('BookWalker returned no bridge session to finalize');
        const cached = tolerant ? tolerant.cached : 0;
        record.mokuro = {
            bridge: ctx.bridge.baseUrl,
            sessionId: result.bridgeSessionId,

            pagesUploaded: Math.max(0, result.pageCount - cached),
            pagesAlreadyOcr: cached,
            pagesFailed: (result.failures || []).length,
            deferredFinalize: true,
        };
    } else if (result.outputPath) {

        const measured = await measureOutput(result.outputPath);
        record.bytes = measured.bytes;
        if (!measured.directory) record.archive = result.outputPath;
    }

    return record;
}

async function measureOutput(target) {
    const st = await fsp.stat(target).catch(() => null);
    if (!st) return { bytes: 0, directory: false };
    if (!st.isDirectory()) return { bytes: st.size, directory: false };

    const entries = await fsp.readdir(target, { withFileTypes: true }).catch(() => []);
    let bytes = 0;
    for (const entry of entries) {
        if (!entry.isFile()) continue;
        bytes += (await fsp.stat(path.join(target, entry.name)).catch(() => ({ size: 0 }))).size;
    }
    return { bytes, directory: true };
}

function reportBookwalker(event, task, progress, bridged = false) {
    const key = task.key;
    switch (event.type) {
        case 'book-total':
            progress?.update(key, { total: event.total, label: event.title || task.title });
            break;
        case 'download-progress':

            progress?.update(key, {
                phase: 'downloading',
                done: event.pageCount,
                total: event.total,
                ...(event.bytes != null ? { bytes: event.bytes } : {}),
            });
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

            if (!bridged) progress?.update(key, { phase: 'finalizing' });
            break;
        default:

            break;
    }
}

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

    startSession(title, options) {
        return startBridgeSession(this.inner, title, options);
    }
}

const BW_ORIGIN = 'https://bookwalker.jp';

export async function resolveBookwalkerSeries(det, input, ctx = {}) {
    let seriesId = det.seriesId || null;
    if (!seriesId) {
        if (!det.cid) return reject(input, `could not read a BookWalker volume id out of "${input}"`);
        seriesId = parseBookwalkerSeriesId(await fetchText(`${BW_ORIGIN}/de${det.cid}/`, ctx));
        if (!seriesId) return reject(input, `BookWalker volume ${det.cid} does not link to a series`);
    }

    let html = await fetchText(`${BW_ORIGIN}/series/${seriesId}/list/`, ctx);
    const items = parseBookwalkerSeriesList(html);
    let next = parseBookwalkerNextPage(html);
    for (let pages = 1; next && pages < MAX_SERIES_PAGES; pages++) {
        html = await fetchText(new URL(next, `${BW_ORIGIN}/series/${seriesId}/list/`).toString(), ctx);
        items.push(...parseBookwalkerSeriesList(html));
        next = parseBookwalkerNextPage(html);
    }

    if (!items.length) return reject(input, `BookWalker series ${seriesId} listed no volumes`);

    const free = dedupeBookwalkerVolumes(items.filter((item) => item.free));
    const freeVolumes = new Set(free.map((item) => parseVolumeNumber(item.title)).filter((v) => v != null));
    const samplers = ctx.samplers
        ? dedupeBookwalkerVolumes(items.filter((item) => !item.free && item.sample
            && !freeVolumes.has(parseVolumeNumber(item.title))))
        : [];
    if (!free.length && !samplers.length) {
        const tail = ctx.samplers ? ', and it offers no 試し読み samplers either' : ' right now';
        return reject(input, `BookWalker series ${seriesId} has ${items.length} volumes and none of them are free${tail}`);
    }

    const make = (item, sample) => ({
        input,
        kind: 'bookwalker',
        cid: item.uuid,
        target: item.uuid,
        url: `${BW_ORIGIN}/de${item.uuid}/`,
        title: item.title,
        fromSeries: true,
        ...(sample ? { sample: true } : {}),
    });
    const tasks = free.map((item) => make(item, false)).concat(samplers.map((item) => make(item, true)));
    const note = `BookWalker series ${seriesId}: ${free.length} of ${items.length} volumes are free`
        + (samplers.length ? `, plus ${samplers.length} 試し読み samplers` : '');
    return { tasks, rejected: [], notes: [note] };
}

const BW_UUID = '(?:de)?([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})';

const volumePattern = {
    kind: 'bookwalker',
    re: new RegExp(`bookwalker\\.jp\\/${BW_UUID}`, 'i'),
    build: (m, raw) => ({
        kind: 'bookwalker',
        cid: m[1].toLowerCase(),
        url: `https://bookwalker.jp/de${m[1].toLowerCase()}/`,
    }),
};

export const platform = {
    name: 'BookWalker',
    id: 'bookwalker',
    label: 'BW',
    lane: 'net',
    workerKey: 'bookwalker',
    patterns: [
        { re: /bookwalker\.jp\/series\/(\d+)/i, kind: 'bookwalker-series',
            build: (m, raw) => ({ kind: 'bookwalker-series', seriesId: m[1], url: raw }) },
        volumePattern,
        { re: new RegExp(`^${BW_UUID}$`, 'i'), kind: 'bookwalker', build: volumePattern.build },
    ],
    volumeId: (det) => det.cid ?? null,
    expand: () => false,
    series: resolveBookwalkerSeries,
    download: downloadBookwalker,
};
