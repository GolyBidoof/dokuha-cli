'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { AutomationError } = require('./errors');
const { archiveDefaultName } = require('./title');
const { BridgeClient } = require('./bridge-client');
// VENDORED DEVIATION (browserless build): the upstream module requires
// ./public-capture, which pulls in a lazily-loaded Puppeteer/Chrome path. This
// project is browserless by policy, so that route is replaced by stubs that fail
// loudly if anything ever reaches for it. Both call sites below are only reached
// when a caller explicitly asks for the capture route.
const captureAccountless = () => {
    throw new Error('The accountless capture route needs a browser and is not available in this build.');
};
const isPublicCaptureUrl = () => false;
// VENDORED DEVIATION (second): `runPublicTrialJob` accepts an optional
// `options.normalizePage`, defaulting to the inline `normalizePage` below. The
// inline version un-permutes a decoded page in plain JavaScript on whichever
// thread called it, which is the main event loop; the manga-dl adapter passes a
// worker-pool implementation instead so a 128-page fetch loop is not serialised
// behind per-page decode/copy/encode. With no override the behaviour here is
// byte-identical to before.

const AUTH_PARAM_KEYS = ['hti', 'cfg', 'bid', 'uuid', 'pfCd', 'Policy', 'Signature', 'Key-Pair-Id'];
const USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36';
const TRIAL_API_HOST = 'https://viewer-trial.bookwalker.jp';
// Quality buckets, in the order the native viewer probes them.
const PUBLIC_CONFIG_QUALITY_DIRS = ['normal_default', 'large_default', 'x-large_default'];
// Direct CDN fetches. The browser viewer is limited to ~6 connections per
// origin over HTTP/1.1, which is the entire reason mokuro-bridge exposes many
// local ports as fetch lanes. Node has no such per-origin cap, so the CLI can
// simply go wide without a bridge. Override with --concurrency.
const PAGE_FETCH_CONCURRENCY = Math.max(1, Number(process.env.BWDD_PAGE_CONCURRENCY) || 128);
const MAX_PROXY_CONCURRENCY = Math.max(1, Number(process.env.BWDD_MAX_FETCH_CONCURRENCY) || 288);

function fetchWithTimeout(url, options = {}, timeoutMs = 15000, signal = null) {
    const controller = new AbortController();
    let timer = null;
    let detached = false;
    const abort = () => {
        if (!detached) controller.abort();
    };
    if (signal) {
        if (signal.aborted) controller.abort();
        else signal.addEventListener('abort', abort, { once: true });
    }
    timer = setTimeout(() => controller.abort(), timeoutMs);
    return fetch(url, Object.assign({}, options, { signal: controller.signal })).finally(() => {
        clearTimeout(timer);
        if (signal) signal.removeEventListener('abort', abort);
    });
}

function productCid(input) {
    let url;
    try { url = new URL(String(input || '')); } catch (_) { return null; }
    const match = url.pathname.match(/^\/de([0-9a-f-]{36})\/?$/i);
    return match ? match[1] : null;
}

function viewerCid(input) {
    try {
        const url = new URL(String(input || ''));
        return url.searchParams.get('cid');
    } catch (_) {
        return null;
    }
}

function isPublicTrialUrl(input) {
    let url;
    try { url = new URL(String(input || '')); } catch (_) { return false; }
    if (url.hostname === 'viewer-trial.bookwalker.jp') return true;
    if (url.hostname === 'bookwalker.jp' && url.searchParams.get('sample') === '1') return true;
    return false;
}

function authQuery(auth) {
    const params = new URLSearchParams();
    for (const key of AUTH_PARAM_KEYS) {
        if (auth && auth[key] != null) params.set(key, String(auth[key]));
    }
    return params.toString();
}

function publicBrowserHeaders(cid) {
    return {
        Accept: '*/*',
        'Accept-Language': 'ja-JP,ja;q=0.9,en-US;q=0.8,en;q=0.7',
        Origin: TRIAL_API_HOST,
        Referer: `${TRIAL_API_HOST}/03/21/viewer.html?cid=${encodeURIComponent(cid)}&cty=1`,
        'Sec-CH-UA': '"Chromium";v="148", "Google Chrome";v="148", "Not-A.Brand";v="99"',
        'Sec-CH-UA-Mobile': '?0',
        'Sec-CH-UA-Platform': '"macOS"',
        'Sec-Fetch-Site': 'same-origin',
        'Sec-Fetch-Mode': 'cors',
        'Sec-Fetch-Dest': 'empty',
        'User-Agent': USER_AGENT
    };
}

function blocked(message, details = {}) {
    return new AutomationError(message, Object.assign({ automationCode: 'PUBLIC_ROUTE_BLOCKED' }, details));
}

async function fetchTrialSession(input, options = {}) {
    const cid = productCid(input) || viewerCid(input);
    if (!cid || !/^[0-9a-f-]{36}$/i.test(cid)) {
        throw blocked('The public trial URL did not contain a valid book CID.', { cid: null });
    }
    const bid = `${Date.now()}${Math.floor(Math.random() * 1e8)}NFBR`;
    const cr = String(Math.floor(Math.random() * 1e18) + 1e18);
    const url = `${TRIAL_API_HOST}/trial-page/c?cid=${encodeURIComponent(cid)}&BID=${encodeURIComponent(bid)}&cr=${cr}`;
    let response;
    try {
        response = await fetchWithTimeout(url, {
            headers: publicBrowserHeaders(cid)
        }, Math.min(Number(options.navigationTimeoutMs) || 15000, 15000), options.signal);
    } catch (error) {
        if (error && error.name === 'AbortError') {
            throw blocked('The public BookWalker trial endpoint timed out.', { cause: 'timeout' });
        }
        throw blocked(`The public BookWalker trial endpoint could not be reached: ${error.message}`);
    }
    let data;
    try { data = await response.json(); } catch (_) { data = {}; }
    if (!response.ok || !data || !data.auth_info || !data.url) {
        const status = data && data.status ? ` (status ${data.status})` : '';
        throw blocked(`The public BookWalker trial is unavailable${status}.`, {
            httpStatus: response.status,
            bookwalkerStatus: data && data.status
        });
    }
    return {
        cid,
        apiHost: TRIAL_API_HOST,
        auth: data.auth_info,
        baseUrl: String(data.url).replace(/\/*$/, '/'),
        cti: data.cti || null,
        isTrial: true
    };
}

function publicRouteFromHtml(html) {
    const text = String(html || '');
    const freeMarker = /sample(?:%3D|=)2(?:[^0-9]|$)/i.test(text);
    return freeMarker ? 'free' : 'trial';
}

async function probePublicRoute(input, options = {}) {
    const fetchImpl = options.fetchImpl || fetch;
    let probeUrl = input;
    try {
        const parsed = new URL(String(input));
        parsed.search = '';
        parsed.hash = '';
        probeUrl = parsed.toString();
    } catch (_) { /* capture will provide the route error */ }
    let response;
    try {
        response = await fetchImpl(probeUrl, {
            headers: {
                Accept: 'text/html,application/xhtml+xml',
                'Accept-Language': 'ja-JP,ja;q=0.9,en-US;q=0.8',
                'User-Agent': USER_AGENT
            },
            signal: options.signal
        });
    } catch (error) {
        if (options.signal && options.signal.aborted) throw error;
        return null;
    }
    if (!response || !response.ok) return null;
    try {
        return publicRouteFromHtml(await response.text());
    } catch (error) {
        if (options.signal && options.signal.aborted) throw error;
        return null;
    }
}

// Public (unencrypted) manifests store page files relative to a quality
// directory. BookWalker writes shared pages as '../shared/...' and
// engine-specific pages as plain relative paths, so the two forms resolve
// against different roots.
function publicPageRel(file, qualityDir, no) {
    const name = `${no}.jpeg`;
    if (typeof file === 'string' && file.startsWith('../')) return `${file.slice(3)}/${name}`;
    return `${qualityDir ? `${qualityDir}/` : ''}${file}/${name}`;
}

function configPageJobs(config, keys, qualityDir) {
    const contents = config && config.configuration && Array.isArray(config.configuration.contents)
        ? config.configuration.contents
        : [];
    const jobs = [];
    let index = 0;
    for (const item of contents) {
        const file = item && item.file;
        const pageConfig = file && config[file];
        const linkInfo = pageConfig && pageConfig.FileLinkInfo ? pageConfig.FileLinkInfo : null;
        const list = linkInfo && Array.isArray(linkInfo.PageLinkInfoList) ? linkInfo.PageLinkInfoList : [];
        // PageCount is the authoritative number of page images. PageLinkInfoList
        // can be longer because it also carries sub-region link entries.
        const declared = linkInfo && Number.isInteger(linkInfo.PageCount) && linkInfo.PageCount > 0
            ? linkInfo.PageCount
            : null;
        const count = declared || Math.max(1, list.length);
        for (let no = 0; no < count; no++) {
            index += 1;
            const seeds = keys ? require('./bw-crypto').pageSeeds(file, pageConfig, keys[0], keys[1], keys[2], no) : null;
            jobs.push({
                index,
                file,
                no,
                seeds,
                rel: keys ? require('./bw-crypto').b8gNo(file, keys[0], keys[1], keys[2], no) : publicPageRel(file, qualityDir, no)
            });
        }
    }
    if (!jobs.length) throw new Error('The public BookWalker configuration contains no pages.');
    return jobs;
}

async function fetchConfig(session, options = {}) {
    let text = options.configBody;
    let qualityDir = options.qualityDir || null;
    if (typeof text !== 'string') {
        // The manifest lives under a quality bucket (normal/large/x-large).
        // Probe them in the viewer's own priority order before giving up.
        const candidates = qualityDir ? [qualityDir] : PUBLIC_CONFIG_QUALITY_DIRS.concat(['']);
        let response = null;
        let lastStatus = null;
        for (const dir of candidates) {
            const url = `${session.baseUrl}${dir ? `${dir}/` : ''}configuration_pack.json?${authQuery(session.auth)}`;
            try {
                response = await fetchWithTimeout(url, { headers: { 'User-Agent': USER_AGENT } }, 60000, options.signal);
            } catch (error) {
                throw new AutomationError(`Could not fetch the public configuration manifest: ${error.message}`);
            }
            if (response.ok) { qualityDir = dir || null; break; }
            lastStatus = response.status;
            response = null;
        }
        if (!response) throw new AutomationError(`Public configuration manifest returned HTTP ${lastStatus}.`);
        text = await response.text();
    }
    let decoded;
    let parsed = null;
    try { parsed = JSON.parse(text); } catch (_) { /* encrypted envelope */ }
    if (parsed && parsed.configuration && Array.isArray(parsed.configuration.contents)) {
        decoded = { config: parsed, plaintext: true, k1: null, k2: null, k3: null };
    } else {
        try { decoded = require('./bw-crypto').decodeConfig(text); }
        catch (error) { throw new AutomationError(`Could not decode the public configuration manifest: ${error.message}`); }
    }
    const keys = decoded.plaintext ? null : [decoded.k1, decoded.k2, decoded.k3];
    const jobs = configPageJobs(decoded.config, keys, qualityDir);
    return { jobs, total: jobs.length, decoded };
}

function safeTitle(value, cid) {
    return archiveDefaultName(value, cid);
}

// CRC-32 over a whole page, once per archive entry.
//
// `zlib.crc32` (Node >= 20.15 / >= 22.2) is the native implementation: measured
// 16 GiB/s here against 110 MiB/s for the bit-at-a-time loop this replaced, on
// identical output. It matters because the loop runs on the main thread after
// every page has downloaded, so on a 244-page (~141 MiB) volume it is ~1.3s of
// dead tail that also blocks every other volume of a `--series` batch.
//
// The fallback is table-driven (550 MiB/s, bit-identical) rather than the old
// per-bit loop, so an older Node is slower but never wrong.
const crc32 = typeof zlib.crc32 === 'function' ? zlib.crc32 : (() => {
    const table = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
        table[n] = c;
    }
    return function crc32Table(buffer) {
        let crc = -1;
        for (let i = 0; i < buffer.length; i++) {
            crc = (crc >>> 8) ^ table[(crc ^ buffer[i]) & 0xff];
        }
        return (crc ^ -1) >>> 0;
    };
})();

function le16(value) {
    const out = Buffer.alloc(2);
    out.writeUInt16LE(value & 0xffff);
    return out;
}
function le32(value) {
    const out = Buffer.alloc(4);
    out.writeUInt32LE(value >>> 0);
    return out;
}
function zipEntry(name, data, date) {
    const nameBytes = Buffer.from(name);
    const time = ((date.getHours() & 31) << 11) | ((date.getMinutes() & 63) << 5) | ((date.getSeconds() / 2) & 31);
    const day = (((date.getFullYear() - 1980) & 127) << 9) | (((date.getMonth() + 1) & 15) << 5) | (date.getDate() & 31);
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(day, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    return { local: Buffer.concat([local, nameBytes]), nameBytes, crc, size: data.length, time, day, data };
}
function buildZip(entries) {
    const parts = [];
    const central = [];
    let offset = 0;
    const date = new Date();
    for (const entry of entries) {
        const e = zipEntry(entry.name, entry.data, date);
        parts.push(e.local, e.data);
        const c = Buffer.alloc(46);
        c.writeUInt32LE(0x02014b50, 0);
        c.writeUInt16LE(20, 4);
        c.writeUInt16LE(20, 6);
        c.writeUInt16LE(0x0800, 8);
        c.writeUInt16LE(e.time, 12);
        c.writeUInt16LE(e.day, 14);
        c.writeUInt32LE(e.crc, 16);
        c.writeUInt32LE(e.size, 20);
        c.writeUInt32LE(e.size, 24);
        c.writeUInt16LE(e.nameBytes.length, 28);
        c.writeUInt32LE(offset, 42);
        central.push(Buffer.concat([c, e.nameBytes]));
        offset += e.local.length + e.data.length;
    }
    const centralBytes = Buffer.concat(central);
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(entries.length, 8);
    end.writeUInt16LE(entries.length, 10);
    end.writeUInt32LE(centralBytes.length, 12);
    end.writeUInt32LE(offset, 16);
    return Buffer.concat([...parts, centralBytes, end]);
}

async function normalizePage(data, job, manifest) {
    if (manifest.decoded.plaintext || !job.seeds) return data;
    let sharp;
    try { sharp = require('sharp'); }
    catch (_) { throw new AutomationError('Encrypted public pages require the optional sharp image dependency.'); }
    const raw = await sharp(data).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    const decoded = require('./bw-crypto').descramblePage(
        new Uint8ClampedArray(raw.data),
        raw.info.width,
        raw.info.height,
        job.seeds
    );
    return sharp(Buffer.from(decoded.data.buffer, decoded.data.byteOffset, decoded.data.byteLength), {
        raw: { width: decoded.width, height: decoded.height, channels: 4 }
    }).jpeg({ quality: 92 }).toBuffer();
}

async function pushBridgePage(bridge, sessionId, page, title, options) {
    if (!bridge || !sessionId) return;
    const name = `page_${String(page.index).padStart(4, '0')}.jpg`;
    const response = await bridge.pushPageBuffer(sessionId, page.data, name, page.index, {
        signal: options.signal,
        timeoutMs: 60000
    });
    if (options.onProgress) options.onProgress({
        type: 'upload-progress',
        pageCount: options.uploaded || page.index,
        total: options.total,
        uploaded: options.uploaded || page.index
    });
    return response;
}

function proxyPageUrl(pageUrl, port) {
    const url = new URL(pageUrl);
    url.protocol = 'http:';
    url.hostname = '127.0.0.1';
    url.port = String(port);
    return url.toString();
}

async function discoverFetchProxyPorts(options) {
    if (Array.isArray(options.fetchProxyPorts)) return options.fetchProxyPorts.filter(Number.isInteger);
    if (!options.bridgeUrl || options.useFetchProxy === false) return [];
    const bridge = options.bridge || new BridgeClient({ baseUrl: options.bridgeUrl, healthTimeoutMs: 1000 });
    try {
        const health = await bridge.health({ timeoutMs: 1000, signal: options.signal });
        return Array.isArray(health && health.fetchProxyPorts)
            ? health.fetchProxyPorts.filter(port => Number.isInteger(port) && port > 0 && port < 65536)
            : [];
    } catch (_) {
        return [];
    }
}

class FetchLaneScheduler {
    constructor(ports = [], options = {}) {
        this.ports = Array.isArray(ports) ? ports.filter(port => Number.isInteger(port) && port > 0 && port < 65536) : [];
        this.maxConcurrency = this.ports.length
            ? Math.min(MAX_PROXY_CONCURRENCY, this.ports.length * 6, Math.max(1, Number(options.maxConcurrency) || MAX_PROXY_CONCURRENCY))
            : Math.max(1, Number(options.maxConcurrency) || PAGE_FETCH_CONCURRENCY);
        this.active = 0;
        this.nextPort = 0;
        this.waiters = [];
    }

    _acquire() {
        if (this.active < this.maxConcurrency) {
            this.active += 1;
            return Promise.resolve();
        }
        return new Promise(resolve => this.waiters.push(resolve));
    }

    _release() {
        const next = this.waiters.shift();
        if (next) next();
        else this.active -= 1;
    }

    async fetch(pageUrl, options = {}) {
        await this._acquire();
        try {
            const parsed = new URL(pageUrl);
            const requestUrl = this.ports.length && parsed.hostname === 'bw-bv-epubs.bookwalker.jp'
                ? proxyPageUrl(pageUrl, this.ports[this.nextPort++ % this.ports.length])
                : pageUrl;
            return await fetchWithTimeout(requestUrl, { headers: { 'User-Agent': USER_AGENT } }, options.timeoutMs || 45000, options.signal);
        } finally {
            this._release();
        }
    }
}

async function fetchPublicPage(pageUrl, proxyPorts, options) {
    const scheduler = options.fetchScheduler;
    const parsed = new URL(pageUrl);
    const hasProxyLanes = Boolean(scheduler && scheduler.ports && scheduler.ports.length && parsed.hostname === 'bw-bv-epubs.bookwalker.jp');
    const attempts = hasProxyLanes ? 3 : 1;
    let lastError = null;
    for (let attempt = 0; attempt < attempts; attempt++) {
        try {
            const response = scheduler
                ? await scheduler.fetch(pageUrl, { signal: options.signal, timeoutMs: 45000 })
                : (() => {
                    const usablePorts = parsed.hostname === 'bw-bv-epubs.bookwalker.jp' ? proxyPorts : [];
                    const requestUrl = usablePorts.length
                        ? proxyPageUrl(pageUrl, usablePorts[(options.pageIndex + attempt) % usablePorts.length])
                        : pageUrl;
                    return fetchWithTimeout(requestUrl, { headers: { 'User-Agent': USER_AGENT } }, 45000, options.signal);
                })();
            if (response.ok) return response;
            const error = new Error(`HTTP ${response.status}`);
            error.status = response.status;
            lastError = error;
            if (response.status !== 403 && response.status !== 429 && response.status < 500) break;
        } catch (error) {
            lastError = error;
        }
    }
    throw lastError || new Error('CDN page request failed');
}

async function runPublicTrialJob(options = {}) {
    const url = options.url;
    const session = options.session || await fetchTrialSession(url, options);
    const manifest = await fetchConfig(session, options);
    const proxyPorts = options.fetchScheduler ? options.fetchScheduler.ports : await discoverFetchProxyPorts(options);
    const fetchScheduler = options.fetchScheduler || new FetchLaneScheduler(proxyPorts, { maxConcurrency: options.pageConcurrency });
    const pageConcurrency = Math.min(fetchScheduler.maxConcurrency, manifest.jobs.length);
    if (fetchScheduler.ports.length && options.onProgress) {
        options.onProgress({ type: 'fetch-lanes', lanes: fetchScheduler.maxConcurrency, ports: fetchScheduler.ports.length });
    }
    const title = safeTitle(options.safeTitle || session.cti, session.cid);
    const total = manifest.total;
    if (options.onProgress) options.onProgress({ type: 'book-total', total, title });
    const outputDir = options.outputDir || path.resolve('.');
    fs.mkdirSync(outputDir, { recursive: true });
    const pages = [];
    let next = 0;
    let completed = 0;
    let failed = [];
    // A manifest can list more pages than an edition actually licenses (a free
    // preview is a prefix of the full book). Those answer 403 and are not
    // failures, so they are counted separately.
    const unlicensed = [];
    const worker = async () => {
        while (true) {
            const index = next++;
            if (index >= manifest.jobs.length) return;
            const job = manifest.jobs[index];
            try {
                const pageUrl = `${session.baseUrl}${job.rel}?${authQuery(session.auth)}`;
                let normalized = null;
                let lastPageError = null;
                for (let attempt = 0; attempt < 3 && !normalized; attempt++) {
                    try {
                        const response = await fetchPublicPage(pageUrl, proxyPorts, Object.assign({}, options, { pageIndex: job.index + attempt, fetchScheduler }));
                        const data = Buffer.from(await response.arrayBuffer());
                        if (!data.length || data[0] !== 0xff || data[1] !== 0xd8) throw new Error('response was not a JPEG');
                        normalized = await (options.normalizePage || normalizePage)(data, job, manifest);
                    } catch (error) {
                        lastPageError = error;
                        if (attempt < 2) await new Promise(resolve => setTimeout(resolve, 250 * (attempt + 1)));
                    }
                }
                if (!normalized) throw lastPageError || new Error('page download failed');
                pages.push({ index: job.index, data: normalized });
                completed += 1;
                if (options.onProgress) options.onProgress({
                    type: 'download-progress',
                    pageCount: completed,
                    total,
                    failed: failed.length
                });
            } catch (error) {
                const detail = { index: job.index, message: error.message };
                if (/\b403\b/.test(error.message)) {
                    unlicensed.push(detail);
                    if (options.onProgress) options.onProgress({ type: 'download-unlicensed', ...detail });
                } else {
                    failed.push(detail);
                    if (options.onProgress) options.onProgress({ type: 'download-error', ...detail });
                }
            }
        }
    };
    await Promise.all(Array.from({ length: Math.min(pageConcurrency, manifest.jobs.length) }, worker));
    pages.sort((a, b) => a.index - b.index);
    if (!pages.length) throw blocked(`No public trial pages could be downloaded (${failed.length} failed).`);

    if (options.ocr) {
        if (!options.bridgeUrl) throw new Error('OCR was requested but no mokuro-bridge URL was configured.');
        const bridge = options.bridge || new BridgeClient({ baseUrl: options.bridgeUrl });
        const reuseExisting = options.reuseExisting === true || /^(?:1|true|yes)$/i.test(String(process.env.BWDD_REUSE_BRIDGE_SESSION || ''));
        const started = await bridge.startSession(title, { reuseExisting, signal: options.signal });
        if (options.onProgress) options.onProgress({
            type: 'bridge-session',
            bridgeSessionId: started.session_id,
            total,
            title: started.safe_title || title
        });
        let uploaded = 0;
        let nextUpload = 0;
        const uploadConcurrency = Math.min(
            pages.length,
            Math.max(1, Number(options.pageUploadConcurrency) || Number(process.env.BWDD_PAGE_UPLOAD_CONCURRENCY) || 8)
        );
        const uploadWorker = async () => {
            while (true) {
                const pageIndex = nextUpload++;
                if (pageIndex >= pages.length) return;
                const page = pages[pageIndex];
                await pushBridgePage(bridge, started.session_id, page, title, {
                    signal: options.signal,
                    total,
                    uploaded: ++uploaded,
                    onProgress: options.onProgress
                });
            }
        };
        await Promise.all(Array.from({ length: uploadConcurrency }, uploadWorker));
        return {
            ok: true,
            publicCapture: true,
            mode: 'ocr',
            status: 'ocr_pending',
            deferredFinalize: true,
            bridgeSessionId: started.session_id,
            safeTitle: started.safe_title || title,
            publicRoute: options.publicRoute || null,
            total: manifest.total,
            pageCount: pages.length,
            failures: failed,
            unlicensed: unlicensed.length
        };
    }

    if (options.onProgress) options.onProgress({ type: 'zip-start', total: pages.length });
    const zip = buildZip(pages.map(page => ({ name: `page-${String(page.index).padStart(4, '0')}.jpg`, data: page.data })));
    const outputPath = path.join(outputDir, `${title}.zip`);
    fs.writeFileSync(outputPath, zip);
    if (options.onProgress) options.onProgress({ type: 'zip-complete', total: pages.length, outputPath });
    return {
        ok: true,
        publicCapture: true,
        mode: 'zip',
        status: 'completed',
        safeTitle: title,
        publicRoute: options.publicRoute || null,
        outputPath,
        total: manifest.total,
        pageCount: pages.length,
        failures: failed,
        unlicensed: unlicensed.length
    };
}

function trialProductUrl(input) {
    try {
        const url = new URL(String(input));
        url.search = '';
        url.hash = '';
        url.searchParams.set('sample', '1');
        return url.toString();
    } catch (_) {
        return input;
    }
}

function isTrialBootstrapFailure(error) {
    const message = String(error && error.message || '');
    return /configuration(?:_pack| manifest| pack)|HTTP\s*403|public configuration/i.test(message);
}

async function runLegacyPublicCaptureJob(options = {}) {
    // Always let the ordinary product-page control resolve sample=2 first.
    // A public sample=1 endpoint can also exist for a product that has a
    // larger free volume, so probing trial first would silently truncate it.
    let captured;
    let route = 'free';
    const capture = options.captureAccountless || captureAccountless;
    const fetchTrial = options.fetchTrialSession || fetchTrialSession;
    const probeRoute = options.probePublicRoute || probePublicRoute;
    const runTrial = options.runPublicTrialJob || runPublicTrialJob;
    const routeHint = await probeRoute(options.url, options);
    if (routeHint === 'trial') {
        captured = await fetchTrial(options.url, options);
        route = 'trial';
    } else {
        try {
            captured = await capture({
                productUrl: options.url,
                executablePath: options.executablePath,
                timeoutMs: options.headless === false
                    ? options.captureTimeoutMs
                    : Math.min(Number(options.captureTimeoutMs) || 30000, 8000),
                headless: options.headless !== false,
                onEvent: options.onEvent,
                signal: options.signal
            });
        } catch (error) {
            if (options.signal && options.signal.aborted) throw error;
            const trialOnly = error && error.details && error.details.automationCode === 'PUBLIC_TRIAL_ONLY';
            const headlessTimeout = options.headless !== false && error && error.details &&
                error.details.automationCode === 'PUBLIC_CAPTURE_TIMEOUT';
            if (headlessTimeout) {
                // A public capture never silently opens a visible browser.
                // Surface the timeout so the queue can classify/fallback it.
                throw error;
            } else if (!trialOnly) {
                // Let the queue's sample=2 -> sample=1 fallback handle a blocked or
                // unavailable free route. Never silently replace a failed free volume
                // with a possibly shorter trial.
                throw error;
            } else {
            // The product-page extension explicitly found no free control, so a
            // direct trial bootstrap is safe and avoids waiting for the viewer
            // capture timeout.
            captured = await fetchTrial(options.url, options);
            route = 'trial';
        }
    }
    }
    if (/^https:\/\/viewer-(?:trial|ptrial|subscription)\.bookwalker\.jp\//i.test(String(captured.baseUrl || ''))) {
        route = 'trial';
    }
    if (options.onProgress) options.onProgress({ type: 'public-route', route });
    const run = () => runTrial(Object.assign({}, options, {
        session: captured,
        configBody: captured.configBody,
        publicRoute: route
    }));
    try {
        return await run();
    } catch (error) {
        if (route !== 'trial' || !isTrialBootstrapFailure(error) || options.headless !== false) throw error;
        // Some public novel/magazine trials return a stale guessed viewer
        // path from the lightweight bootstrap endpoint. An explicitly headed
        // diagnostic may re-open the ordinary product trial control; the
        // default headless path never launches Chrome visibly.
        captured = await capture({
            productUrl: trialProductUrl(options.url),
            executablePath: options.executablePath,
            timeoutMs: options.captureTimeoutMs,
            headless: false,
            onEvent: options.onEvent,
            signal: options.signal
        });
        route = 'trial';
        if (options.onProgress) options.onProgress({ type: 'public-route', route });
        return runTrial(Object.assign({}, options, {
            session: captured,
            configBody: captured.configBody,
            publicRoute: route
        }));
    }
}

async function waitForPublicDownload(outputDir, filename, timeoutMs = 20000) {
    const safeName = path.basename(String(filename || ''));
    if (!safeName) return null;
    const home = process.env.HOME || process.env.USERPROFILE || '';
    const candidates = [
        path.join(path.resolve(outputDir || '.'), safeName),
        ...(home ? [path.join(home, 'Downloads', safeName)] : [])
    ];
    const deadline = Date.now() + Math.max(1000, Number(timeoutMs) || 20000);
    while (Date.now() < deadline) {
        for (const candidate of [...new Set(candidates)]) {
            try {
                const stat = fs.statSync(candidate);
                if (stat.isFile() && stat.size > 0) return candidate;
            } catch (_) { /* keep waiting */ }
        }
        await new Promise(resolve => setTimeout(resolve, 250));
    }
    return null;
}

async function runPublicCaptureJob(options = {}) {
    // The production CLI opts into the extension-backed userscript runner. The
    // legacy branch remains available for library callers and deterministic
    // fixtures, but no public sample uses the duplicated Node crypto path.
    if (options.useUserscript !== true) return runLegacyPublicCaptureJob(options);

    let route = 'free';
    try {
        const parsed = new URL(String(options.url));
        if (parsed.searchParams.get('sample') === '1') route = 'trial';
        // A normalized product URL already carries the requested public
        // selector. Avoid a second product fetch just to classify it; the
        // extension resolves the ordinary control while the viewer loads.
    } catch (_) { /* capture will report an invalid URL */ }
    const mode = options.ocr ? 'ocr' : 'zip';
    const outputDir = path.resolve(options.outputDir || '.');
    fs.mkdirSync(outputDir, { recursive: true });
    const productUrl = route === 'trial' ? trialProductUrl(options.url) : options.url;
    const capture = options.captureAccountless || captureAccountless;
    const relay = event => {
        if (!event || typeof event !== 'object') return;
        if (event.type === 'progress') {
            const value = Object.assign({}, event.event || event);
            if (options.onProgress) options.onProgress(Object.assign({ type: 'download-progress' }, value));
        } else if (event.type === 'download') {
            if (options.onProgress) options.onProgress({ type: 'download-file', filename: event.filename || null });
        } else if (event.type === 'debug' && options.onProgress) {
            options.onProgress({ type: 'status', message: `extension: ${event.kind || ''}` });
        }
    };
    const common = {
        executablePath: options.executablePath,
        userscriptPath: options.userscriptPath,
        automation: true,
        automationMode: mode,
        automationOptions: {
            bridgeUrl: options.bridgeUrl || null
        },
        downloadDir: outputDir,
        onEvent: relay,
        signal: options.signal
    };
    // Public capture is headless by default. A caller can explicitly request a
    // headed diagnostic run with --headed, but there is no automatic timeout
    // fallback that opens a second browser.
    const useHeadless = options.headless !== false && options.forcePublicHeaded !== true;
    const captured = await capture(Object.assign({}, common, {
        productUrl,
        timeoutMs: Math.min(Number(options.captureTimeoutMs) || 30000, 30000),
        headless: useHeadless
    }));
    const result = captured && captured.automationResult;
    if (!result || typeof result !== 'object') {
        throw new AutomationError('The public userscript extension did not return a structured result.', {
            automationCode: 'USERSCRIPT_RESULT_UNAVAILABLE'
        });
    }
    const errors = Array.isArray(result.errors) ? result.errors.slice() : [];
    if (result.ok !== true) {
        throw new AutomationError(errors.join('; ') || 'The userscript could not download the public sample.', {
            automationCode: 'PUBLIC_ROUTE_BLOCKED',
            result: Object.assign({}, result, { errors })
        });
    }
    const title = safeTitle(result.safeTitle || result.title || options.safeTitle || productCid(productUrl), productCid(productUrl));
    if (options.onProgress) options.onProgress({ type: 'public-route', route });
    if (mode === 'ocr') {
        if (typeof result.bridgeSessionId !== 'string' && typeof result.sessionId !== 'string') {
            throw new AutomationError('The userscript OCR run did not return a bridge session ID.', {
                automationCode: 'USERSCRIPT_RESULT_INVALID',
                result
            });
        }
        return Object.assign({}, result, {
            ok: true,
            publicCapture: true,
            mode: 'ocr',
            status: 'ocr_pending',
            deferredFinalize: true,
            bridgeSessionId: result.bridgeSessionId || result.sessionId,
            safeTitle: result.safeTitle || title,
            publicRoute: route,
            failures: errors
        });
    }
    const requestedName = captured.filename || `${title}.zip`;
    const downloaded = await waitForPublicDownload(outputDir, requestedName);
    if (!downloaded) {
        throw new AutomationError(`The userscript ZIP download was not found (${requestedName}).`, {
            automationCode: 'PUBLIC_ZIP_NOT_FOUND'
        });
    }
    const outputPath = path.join(outputDir, path.basename(requestedName));
    if (path.resolve(downloaded) !== path.resolve(outputPath)) fs.copyFileSync(downloaded, outputPath);
    if (options.onProgress) options.onProgress({ type: 'zip-complete', total: result.pageCount || result.total || 0, outputPath });
    return Object.assign({}, result, {
        ok: true,
        publicCapture: true,
        mode: 'zip',
        status: 'completed',
        safeTitle: title,
        publicRoute: route,
        outputPath,
        total: result.total || result.pageCount || 0,
        pageCount: result.pageCount || result.total || 0,
        failures: errors
    });
}

module.exports = {
    isPublicTrialUrl,
    isPublicCaptureUrl,
    productCid,
    viewerCid,
    fetchTrialSession,
    publicRouteFromHtml,
    probePublicRoute,
    fetchConfig,
    buildZip,
    crc32,
    normalizePage,
    runPublicTrialJob,
    runPublicCaptureJob,
    discoverFetchProxyPorts,
    FetchLaneScheduler
};
