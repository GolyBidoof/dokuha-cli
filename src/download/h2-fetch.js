/**
 * Opt-in HTTP/2 page transport for dokuha adapters.
 *
 * Node's global `fetch` speaks HTTP/1.1 only (undici does not do h2), while the
 * DMM CDNs (book.dmm.com, ebook04.dmm.com, trial.book.dmm.co.jp) serve HTTP/2.
 * On a high-RTT link a page download is latency bound because each h1 request
 * pays a TLS handshake and slow start; multiplexing all page requests over one
 * reused h2 session removes both. Measured on a ~300 ms RTT link, eight
 * concurrent page requests went from ~68% to ~99% of the link.
 *
 * This module is deliberately NOT wired into an adapter here. It is a
 * fetch-compatible GET transport an adapter opts into, e.g.:
 *
 *   import { fetchH2, resetH2Fetch } from './h2-fetch.js';
 *
 *   const response = await fetchH2(url, {
 *       headers: { Cookie: cookie, Referer: referer },
 *       timeoutMs: 45_000,
 *       signal: AbortSignal.timeout(60_000),
 *   });
 *   if (!response.ok) throw new Error(`HTTP ${response.status}`);
 *   const bytes = Buffer.from(await response.arrayBuffer());
 *
 *   // Optional: close pooled sessions when the command finishes. When idle the
 *   // underlying sockets are unref'd, so they will not hold the process open.
 *   resetH2Fetch();
 *
 * Contract and caveats:
 * - Fetch-like subset: `{ ok, status, statusText, url, redirected, headers,
 *   text(), json(), arrayBuffer() }`. `headers` has `get()`, `has()`,
 *   `getSetCookie()`, `entries()`, `forEach()` and is case-insensitive.
 * - One TLS session per origin, multiplexed streams. Idle sessions close after
 *   ~20 s; at most 24 origins are pooled and the least recently used idle
 *   session is evicted beyond that.
 * - Redirects are followed (up to 5) for both transports. Authorization and
 *   Cookie headers are dropped when a redirect crosses origins, matching fetch.
 * - If ALPN negotiates http/1.1, or the h2 connection/request fails before
 *   response headers, the request is retried through global `fetch` and the
 *   origin is remembered as h1 for the rest of the process (see resetH2Fetch).
 * - TLS verification stays on by default (SNI from the URL, rejectUnauthorized
 *   true). No cookie jar: callers pass `Cookie` per request and receive
 *   `Set-Cookie` through `headers.getSetCookie()`.
 * - NO automatic decompression, unlike global fetch which decodes gzip/br.
 *   Send `Accept-Encoding: identity` (or accept raw compressed bytes). This is
 *   the one behavioural difference between the two transports; the h1 fallback
 *   still decodes because it goes through global fetch.
 * - `timeoutMs` defaults to 45 s and covers the whole redirect chain; callers
 *   may also pass their own AbortSignal. The method is GET by default; request
 *   bodies are not supported.
 */

import http2 from 'node:http2';
import tls from 'node:tls';

const IDLE_CLOSE_MS = 20_000;
const CONNECT_TIMEOUT_MS = 10_000;
const DEFAULT_TIMEOUT_MS = 45_000;
const MAX_REDIRECTS = 5;
const MAX_SESSIONS = 24;

const REDIRECT_STATUS = new Set([301, 302, 303, 307, 308]);
const CREDENTIAL_HEADERS = new Set(['cookie', 'authorization', 'proxy-authorization']);
const FORBIDDEN_H2_HEADERS = new Set([
    'connection',
    'keep-alive',
    'proxy-connection',
    'transfer-encoding',
    'upgrade',
    'host',
    'http2-settings',
    'te',
    'content-length',
]);

/** Sessions keyed by origin. */
const sessions = new Map();
/** Origins known to be http/1.1-only (or where h2 already failed). */
const h1Origins = new Set();
/** In-flight connection attempts, so concurrent first requests share one session. */
const pendingSessions = new Map();

let stats = emptyStats();

function emptyStats() {
    return {
        sessionsOpened: 0,
        sessionsClosed: 0,
        h2Requests: 0,
        h1Requests: 0,
        fallbacks: 0,
        redirects: 0,
    };
}

class H1FallbackError extends Error {
    constructor(origin) {
        super(`HTTP/2 is not available for ${origin}`);
        this.name = 'H1FallbackError';
        this.origin = origin;
    }
}

class TransportError extends Error {
    constructor(message, { cause, afterResponse = false } = {}) {
        super(message);
        this.name = 'TransportError';
        this.cause = cause;
        this.afterResponse = afterResponse;
    }
}

function abortError(signal) {
    const reason = signal?.reason;
    if (reason instanceof Error) return reason;
    const error = new Error('The operation was aborted');
    error.name = 'AbortError';
    return error;
}

function timeoutError(timeoutMs) {
    const error = new Error(`fetchH2 timed out after ${timeoutMs} ms`);
    error.name = 'TimeoutError';
    return error;
}

function throwIfAborted(signal) {
    if (signal?.aborted) throw abortError(signal);
}

/** Race a promise against a signal without aborting the underlying work. */
function withSignal(promise, signal) {
    if (!signal) return promise;
    throwIfAborted(signal);
    return new Promise((resolve, reject) => {
        const onAbort = () => reject(abortError(signal));
        signal.addEventListener('abort', onAbort, { once: true });
        promise.then(
            (value) => { signal.removeEventListener('abort', onAbort); resolve(value); },
            (error) => { signal.removeEventListener('abort', onAbort); reject(error); },
        );
    });
}

// ---- headers ---------------------------------------------------------------

/**
 * Normalize a caller's headers (plain object, array of pairs or Headers) into
 * lowercase `[name, value]` pairs. Duplicates are kept as separate pairs so the
 * h2 path can join cookie values with `; ` and the fetch path can decide.
 */
function headerEntries(input) {
    if (!input) return [];
    let entries;
    if (typeof input.entries === 'function') entries = [...input.entries()];
    else if (Array.isArray(input)) entries = input;
    else entries = Object.entries(input);
    return entries
        .filter(([, value]) => value != null)
        .map(([name, value]) => [String(name).toLowerCase(), String(value)]);
}

/** Plain object for global fetch: names lowercase, duplicates comma-joined. */
function plainHeaders(entries) {
    const out = {};
    for (const [name, value] of entries) {
        if (!name || name.startsWith(':') || FORBIDDEN_H2_HEADERS.has(name)) continue;
        if (out[name] === undefined) out[name] = value;
        else out[name] += (name === 'cookie' ? '; ' : ', ') + value;
    }
    return out;
}

/** HTTP/2 request headers: pseudo-headers first, cookie values combined. */
function h2RequestHeaders(entries, url, method) {
    const headers = {
        ':method': method,
        ':scheme': url.protocol === 'http:' ? 'http' : 'https',
        ':authority': url.host,
        ':path': `${url.pathname}${url.search}`,
    };
    const cookies = [];
    for (const [name, value] of entries) {
        if (!name || name.startsWith(':') || FORBIDDEN_H2_HEADERS.has(name)) continue;
        if (name === 'cookie') {
            cookies.push(value);
            continue;
        }
        if (headers[name] === undefined) headers[name] = value;
        else headers[name] += (name === 'cookie' ? '; ' : ', ') + value;
    }
    if (cookies.length) headers.cookie = cookies.join('; ');
    return headers;
}

/** Case-insensitive read-only view over h2/fetch response headers. */
class FetchHeaders {
    constructor(map) {
        this._map = map;
    }

    get(name) {
        const value = this._map.get(String(name).toLowerCase());
        if (value == null) return null;
        return Array.isArray(value) ? value.join(', ') : value;
    }

    has(name) {
        return this._map.has(String(name).toLowerCase());
    }

    getSetCookie() {
        const value = this._map.get('set-cookie');
        if (value == null) return [];
        return Array.isArray(value) ? [...value] : [value];
    }

    entries() {
        return [...this._map.entries()].map(([name, value]) => [
            name,
            Array.isArray(value) ? value.join(', ') : value,
        ])[Symbol.iterator]();
    }

    keys() {
        return this._map.keys();
    }

    values() {
        return [...this.entries()].map(([, value]) => value)[Symbol.iterator]();
    }

    forEach(callback, thisArg) {
        for (const [name, value] of this.entries()) callback.call(thisArg, value, name, this);
    }

    [Symbol.iterator]() {
        return this.entries();
    }
}

function makeHeaders(map) {
    return new FetchHeaders(map);
}

function h2ResponseHeaders(raw) {
    const map = new Map();
    for (const [name, value] of Object.entries(raw || {})) {
        if (name.startsWith(':') || value == null) continue;
        map.set(name, value);
    }
    return makeHeaders(map);
}

function fetchResponseHeaders(headers) {
    const map = new Map();
    try {
        if (typeof headers.getSetCookie === 'function') {
            const cookies = headers.getSetCookie();
            if (cookies.length) map.set('set-cookie', cookies.length === 1 ? cookies[0] : cookies);
        }
    } catch {
        // older fetch implementations only expose the combined header
    }
    for (const [name, value] of headers.entries()) {
        const key = name.toLowerCase();
        if (key === 'set-cookie' && map.has(key)) continue;
        map.set(key, value);
    }
    return makeHeaders(map);
}

// ---- responses -------------------------------------------------------------

function makeResponse({ status, body, headers, url, redirected = false }) {
    const bytes = Buffer.isBuffer(body) ? body : Buffer.from(body || '');
    return {
        ok: status >= 200 && status < 300,
        status,
        statusText: '',
        url,
        redirected,
        headers,
        async arrayBuffer() {
            return new Uint8Array(bytes).buffer;
        },
        async text() {
            return bytes.toString('utf8');
        },
        async json() {
            return JSON.parse(bytes.toString('utf8'));
        },
    };
}

// ---- session pool ----------------------------------------------------------

function servernameFor(hostname) {
    const bare = hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname;
    if (basicIpv4(bare) || bare.includes(':')) return undefined;
    return bare;
}

function basicIpv4(host) {
    return /^\d{1,3}(?:\.\d{1,3}){3}$/.test(host);
}

function connectTimeoutError(origin) {
    return new TransportError(`fetchH2: timed out connecting to ${origin}`);
}

function onceConnected(session) {
    return new Promise((resolve, reject) => {
        const cleanup = () => {
            session.off('connect', onConnect);
            session.off('error', onError);
        };
        const onConnect = () => { cleanup(); resolve(); };
        const onError = (error) => { cleanup(); reject(error); };
        session.once('connect', onConnect);
        session.once('error', onError);
    });
}

/** Open a TLS socket, verify ALPN and upgrade it to an h2 session. */
async function connectSession(origin, url) {
    if (url.protocol === 'http:') {
        const session = http2.connect(origin);
        session.on('error', () => {});
        try {
            await onceConnected(session);
        } catch (error) {
            session.destroy();
            throw new TransportError(`fetchH2: h2c connection to ${origin} failed`, { cause: error });
        }
        return session;
    }
    if (url.protocol !== 'https:') {
        throw new TransportError(`fetchH2: unsupported URL protocol ${url.protocol}`);
    }

    const host = url.hostname.startsWith('[') ? url.hostname.slice(1, -1) : url.hostname;
    const socket = await new Promise((resolve, reject) => {
        const options = {
            host,
            port: Number(url.port) || 443,
            ALPNProtocols: ['h2', 'http/1.1'],
            rejectUnauthorized: true,
        };
        const servername = servernameFor(url.hostname);
        if (servername) options.servername = servername;

        const socket = tls.connect(options);
        let settled = false;
        const fail = (error) => {
            if (settled) return;
            settled = true;
            socket.destroy();
            reject(new TransportError(`fetchH2: TLS connection to ${origin} failed: ${error.message}`, { cause: error }));
        };
        socket.once('error', fail);
        socket.setTimeout(CONNECT_TIMEOUT_MS, () => fail(connectTimeoutError(origin)));
        socket.once('secureConnect', () => {
            if (settled) return;
            settled = true;
            socket.removeListener('error', fail);
            socket.setTimeout(0);
            resolve(socket);
        });
    });

    // ALPN h1 (or no ALPN at all) means this origin cannot do h2. Release the
    // socket rather than reusing it: global fetch will open its own h1 socket.
    if (socket.alpnProtocol !== 'h2') {
        socket.destroy();
        throw new H1FallbackError(origin);
    }

    const session = http2.connect(origin, { createConnection: () => socket });
    session.on('error', () => {});
    try {
        await onceConnected(session);
    } catch (error) {
        socket.destroy();
        throw new TransportError(`fetchH2: HTTP/2 session to ${origin} failed`, { cause: error });
    }
    return session;
}

function refSession(entry) {
    try { entry.session.socket?.ref?.(); } catch { /* already gone */ }
}

function unrefSession(entry) {
    try { entry.session.socket?.unref?.(); } catch { /* already gone */ }
}

function clearIdle(entry) {
    if (entry.idleTimer) {
        clearTimeout(entry.idleTimer);
        entry.idleTimer = null;
    }
}

function scheduleIdle(entry) {
    if (entry.closed || entry.active > 0) return;
    clearIdle(entry);
    // An idle pooled session must not keep a short-lived CLI process alive.
    unrefSession(entry);
    entry.idleTimer = setTimeout(() => closeEntry(entry), IDLE_CLOSE_MS);
    entry.idleTimer.unref?.();
}

function finishEntry(entry) {
    clearIdle(entry);
    if (!entry.closed) {
        entry.closed = true;
        stats.sessionsClosed++;
    }
    if (sessions.get(entry.origin) === entry) sessions.delete(entry.origin);
}

function closeEntry(entry) {
    if (entry.closed) {
        if (sessions.get(entry.origin) === entry) sessions.delete(entry.origin);
        return;
    }
    entry.closed = true;
    clearIdle(entry);
    stats.sessionsClosed++;
    if (sessions.get(entry.origin) === entry) sessions.delete(entry.origin);
    try { entry.session.close(); } catch { /* already gone */ }
}

function evictIdleSession() {
    if (sessions.size < MAX_SESSIONS) return;
    let victim = null;
    for (const entry of sessions.values()) {
        if (entry.active > 0 || entry.closed) continue;
        if (!victim || entry.lastUsed < victim.lastUsed) victim = entry;
    }
    if (victim) closeEntry(victim);
}

async function openSession(origin, url) {
    evictIdleSession();
    const session = await connectSession(origin, url);
    const entry = {
        origin,
        session,
        active: 0,
        idleTimer: null,
        closed: false,
        lastUsed: Date.now(),
    };
    sessions.set(origin, entry);
    stats.sessionsOpened++;
    session.on('close', () => finishEntry(entry));
    session.on('goaway', () => {
        // Keep already-open streams alive, but stop handing this session out.
        if (sessions.get(entry.origin) === entry) sessions.delete(entry.origin);
        try { session.close(); } catch { /* already gone */ }
    });
    scheduleIdle(entry);
    return entry;
}

async function getSession(url) {
    const origin = url.origin;
    const existing = sessions.get(origin);
    if (existing && !existing.closed && !existing.session.closed && !existing.session.destroyed) {
        return existing;
    }
    if (existing) closeEntry(existing);

    let pending = pendingSessions.get(origin);
    if (!pending) {
        pending = openSession(origin, url).finally(() => pendingSessions.delete(origin));
        pendingSessions.set(origin, pending);
    }
    return pending;
}

// ---- requests --------------------------------------------------------------

function sendRequest(entry, url, opts, signal) {
    return new Promise((resolve, reject) => {
        entry.active++;
        entry.lastUsed = Date.now();
        clearIdle(entry);
        refSession(entry);

        let settled = false;
        let gotHeaders = false;
        let status = 0;
        let headers = null;
        const chunks = [];

        const finish = (fn, value) => {
            if (settled) return;
            settled = true;
            signal?.removeEventListener('abort', onAbort);
            entry.active = Math.max(0, entry.active - 1);
            scheduleIdle(entry);
            fn(value);
        };

        let stream;
        const onAbort = () => {
            try { stream?.close(http2.constants.NGHTTP2_CANCEL); } catch { /* already gone */ }
            finish(reject, abortError(signal));
        };

        try {
            stream = entry.session.request(h2RequestHeaders(opts.headers, url, opts.method), { endStream: true });
        } catch (error) {
            finish(reject, new TransportError(`fetchH2: could not open a stream to ${url.origin}`, { cause: error }));
            return;
        }
        stats.h2Requests++;

        signal?.addEventListener('abort', onAbort, { once: true });
        if (signal?.aborted) {
            onAbort();
            return;
        }

        stream.on('response', (responseHeaders) => {
            gotHeaders = true;
            status = Number(responseHeaders[':status']) || 0;
            headers = responseHeaders;
        });
        stream.on('data', (chunk) => { chunks.push(chunk); });
        stream.on('end', () => {
            if (settled) return;
            if (!status) {
                finish(reject, new TransportError(`fetchH2: stream to ${url.origin} ended without a status`));
                return;
            }
            finish(resolve, makeResponse({
                status,
                headers: h2ResponseHeaders(headers),
                body: Buffer.concat(chunks),
                url: url.toString(),
            }));
        });
        stream.on('error', (error) => {
            finish(reject, new TransportError(
                `fetchH2: ${url.origin}${url.pathname} failed over HTTP/2`,
                { cause: error, afterResponse: gotHeaders },
            ));
        });
        stream.on('aborted', () => {
            finish(reject, new TransportError(
                `fetchH2: ${url.origin}${url.pathname} was aborted by the peer`,
                { afterResponse: gotHeaders },
            ));
        });
        stream.on('close', () => {
            if (settled || stream.readableEnded) return;
            finish(reject, new TransportError(
                `fetchH2: ${url.origin}${url.pathname} closed before the response completed`,
                { afterResponse: gotHeaders },
            ));
        });
    });
}

/** Global-fetch fallback for an origin that cannot do h2. */
async function fetchViaH1(url, opts, signal, h2Error) {
    stats.h1Requests++;
    const init = {
        method: opts.method,
        headers: plainHeaders(opts.headers),
        redirect: 'manual',
        signal,
    };
    let response;
    try {
        response = await globalThis.fetch(url, init);
    } catch (error) {
        if (signal?.aborted) throw abortError(signal);
        if (h2Error) error.h2Error = h2Error;
        throw error;
    }
    try {
        const body = Buffer.from(await response.arrayBuffer());
        return makeResponse({
            status: response.status,
            headers: fetchResponseHeaders(response.headers),
            body,
            url: response.url || url.toString(),
            redirected: response.redirected === true,
        });
    } catch (error) {
        if (signal?.aborted) throw abortError(signal);
        throw error;
    }
}

async function fallbackToFetch(url, opts, signal, h2Error) {
    stats.fallbacks++;
    h1Origins.add(url.origin);
    return fetchViaH1(url, opts, signal, h2Error);
}

async function oneHop(url, opts, signal) {
    throwIfAborted(signal);
    if (h1Origins.has(url.origin)) {
        return fetchViaH1(url, opts, signal, null);
    }

    let entry;
    try {
        entry = await withSignal(getSession(url), signal);
    } catch (error) {
        if (signal?.aborted) throw abortError(signal);
        if (!(error instanceof H1FallbackError) && !(error instanceof TransportError)) throw error;
        return fallbackToFetch(url, opts, signal, error);
    }

    try {
        return await sendRequest(entry, url, opts, signal);
    } catch (error) {
        if (signal?.aborted) throw abortError(signal);
        if (error instanceof TransportError && error.afterResponse) throw error;
        if (!(error instanceof TransportError) && !(error instanceof H1FallbackError)) throw error;
        return fallbackToFetch(url, opts, signal, error);
    }
}

function redirectMethod(method, status) {
    if (status === 303 && method !== 'GET' && method !== 'HEAD') return 'GET';
    if ((status === 301 || status === 302) && method === 'POST') return 'GET';
    return method;
}

function stripCredentials(entries) {
    return entries.filter(([name]) => !CREDENTIAL_HEADERS.has(name));
}

async function follow(url, opts, signal, depth, redirected = false) {
    throwIfAborted(signal);
    const response = await oneHop(url, opts, signal);
    if (depth > 0 || redirected) response.redirected = true;

    if (!REDIRECT_STATUS.has(response.status) || opts.redirect === 'manual') return response;
    const location = response.headers.get('location');
    if (!location) return response;
    if (opts.redirect === 'error') {
        throw new TypeError(`fetchH2: redirect to ${location} was not allowed`);
    }
    if (depth >= MAX_REDIRECTS) {
        throw new Error(`fetchH2: too many redirects (> ${MAX_REDIRECTS})`);
    }

    await response.arrayBuffer().catch(() => {});
    let next;
    try {
        next = new URL(location, url);
    } catch {
        throw new Error(`fetchH2: invalid redirect location ${location}`);
    }
    const crossOrigin = next.origin !== url.origin;
    const nextOpts = {
        ...opts,
        method: redirectMethod(opts.method, response.status),
        headers: crossOrigin ? stripCredentials(opts.headers) : opts.headers,
    };
    stats.redirects++;
    const final = await follow(next, nextOpts, signal, depth + 1, true);
    final.redirected = true;
    return final;
}

function normalizeOptions(options) {
    const input = options || {};
    if (input.body != null) {
        throw new TypeError('fetchH2 does not support request bodies');
    }
    const redirect = input.redirect || 'follow';
    if (!['follow', 'manual', 'error'].includes(redirect)) {
        throw new TypeError(`fetchH2: unsupported redirect mode ${redirect}`);
    }
    return {
        method: String(input.method || 'GET').toUpperCase(),
        headers: headerEntries(input.headers),
        timeoutMs: Number.isFinite(input.timeoutMs) ? Math.max(0, input.timeoutMs) : DEFAULT_TIMEOUT_MS,
        redirect,
        signal: input.signal || null,
    };
}

/**
 * Fetch a URL over HTTP/2, falling back to global fetch when h2 is not usable.
 *
 * @param {string|URL} input
 * @param {{method?: string, headers?: object|Headers|Array, timeoutMs?: number,
 *          signal?: AbortSignal, redirect?: 'follow'|'manual'|'error'}} [options]
 * @returns {Promise<object>} fetch-like response
 */
export async function fetchH2(input, options = {}) {
    const url = new URL(String(input));
    const opts = normalizeOptions(options);

    const controller = new AbortController();
    const external = opts.signal;
    const forwardAbort = () => controller.abort(abortError(external));
    if (external) {
        if (external.aborted) throw abortError(external);
        external.addEventListener('abort', forwardAbort, { once: true });
    }
    let timer = null;
    if (opts.timeoutMs > 0) {
        timer = setTimeout(() => controller.abort(timeoutError(opts.timeoutMs)), opts.timeoutMs);
        timer.unref?.();
    }
    try {
        return await follow(url, opts, controller.signal, 0);
    } finally {
        clearTimeout(timer);
        external?.removeEventListener('abort', forwardAbort);
    }
}

/** Close every pooled session and forget known h1 origins. Mainly for tests. */
export function resetH2Fetch() {
    for (const entry of [...sessions.values()]) closeEntry(entry);
    sessions.clear();
    h1Origins.clear();
    stats = emptyStats();
}

/** Snapshot of transport counters, for tests and diagnostics. */
export function getH2FetchStats() {
    return {
        ...stats,
        pooledSessions: sessions.size,
        h1Origins: [...h1Origins],
    };
}
