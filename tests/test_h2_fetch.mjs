/**
 * Hermetic tests for the opt-in HTTP/2 transport (`src/download/h2-fetch.js`).
 *
 * Everything runs against two throwaway TLS servers on 127.0.0.1: an
 * `http2.createSecureServer` that counts sessions and concurrent streams, and a
 * plain `https.createServer` whose only ALPN protocol is http/1.1, which is what
 * exercises the global-fetch fallback. No live network is touched.
 *
 * The test certificate is generated with openssl into a temporary directory.
 * Because Node reads `NODE_EXTRA_CA_CERTS` only at process start, the file
 * re-execs itself once with that variable set, so TLS verification stays on in
 * both transports and both the h2 client and the global-fetch fallback trust the
 * throwaway CA. The parent process removes the temporary directory afterwards.
 */

import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import http2 from 'node:http2';
import https from 'node:https';

import { fetchH2, getH2FetchStats, resetH2Fetch } from '../src/download/h2-fetch.js';
import { check, checkEqual, finish } from './_harness.mjs';

const SELF = fileURLToPath(import.meta.url);
const FIXTURE_DIR = process.env.DOKUHA_H2_FIXTURE_DIR || '';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Generate a throwaway localhost certificate and run this file again with it in
 * the trust store. `spawn` inherits stdio, so the child's `ALL n CHECKS PASSED`
 * line reaches the suite runner unchanged.
 */
function bootstrapWithTestCertificate() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dokuha-h2-'));
    const keyPath = path.join(dir, 'key.pem');
    const certPath = path.join(dir, 'cert.pem');
    const generated = spawnSync('openssl', [
        'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
        '-keyout', keyPath, '-out', certPath,
        '-days', '1',
        '-subj', '/CN=127.0.0.1',
        '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1',
    ], { encoding: 'utf8' });
    if (generated.error || generated.status !== 0 || !fs.existsSync(certPath)) {
        fs.rmSync(dir, { recursive: true, force: true });
        process.stderr.write(`FAIL  could not generate the test certificate with openssl: ${
            generated.error?.message || generated.stderr || `exit ${generated.status}`}\n`);
        process.exit(1);
    }

    const child = spawn(process.execPath, [SELF], {
        stdio: 'inherit',
        env: {
            ...process.env,
            DOKUHA_H2_FIXTURE_DIR: dir,
            NODE_EXTRA_CA_CERTS: certPath,
        },
    });
    const cleanup = () => fs.rmSync(dir, { recursive: true, force: true });
    child.on('error', (error) => {
        cleanup();
        process.stderr.write(`FAIL  could not start the h2 test child: ${error.message}\n`);
        process.exit(1);
    });
    child.on('exit', (code, signal) => {
        cleanup();
        process.exit(signal ? 1 : (code ?? 1));
    });
}

async function waitFor(predicate, timeoutMs = 2000) {
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
        if (predicate()) return true;
        await sleep(10);
    }
    return predicate();
}

async function rejection(promise) {
    try {
        await promise;
        return null;
    } catch (error) {
        return error;
    }
}

async function listen(server) {
    await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
    });
    const { port } = server.address();
    return { server, origin: `https://127.0.0.1:${port}` };
}

/** h2 origin: records sessions, streams, and the paths that were requested. */
async function startH2Server(key, cert) {
    const state = {
        sessions: 0,
        closedSessions: 0,
        requests: 0,
        active: 0,
        maxActive: 0,
        paths: [],
        sessionList: [],
    };
    const server = http2.createSecureServer({ key, cert });
    server.on('error', () => {});
    server.on('session', (session) => {
        state.sessions++;
        state.sessionList.push(session);
        session.on('error', () => {});
        session.on('close', () => { state.closedSessions++; });
    });
    server.on('stream', (stream, headers) => {
        state.requests++;
        state.active++;
        state.maxActive = Math.max(state.maxActive, state.active);
        const requestPath = headers[':path'] || '/';
        state.paths.push(requestPath);
        let ended = false;
        stream.on('close', () => {
            if (ended) return;
            ended = true;
            state.active--;
        });
        stream.on('error', () => {});

        const url = new URL(requestPath, 'https://localhost');
        const respond = (status, responseHeaders, body) => {
            if (stream.destroyed || stream.closed) return;
            stream.respond({ ':status': status, ...responseHeaders });
            stream.end(body);
        };

        switch (url.pathname) {
            case '/hello':
                respond(200, {
                    'content-type': 'text/plain; charset=utf-8',
                    'x-transport': 'h2',
                    'set-cookie': ['a=1; Path=/', 'b=2; Path=/'],
                }, 'hello from h2');
                break;
            case '/json':
                respond(200, { 'content-type': 'application/json' },
                    JSON.stringify({ transport: 'h2', path: requestPath }));
                break;
            case '/bytes':
                respond(200, { 'content-type': 'application/octet-stream' },
                    Buffer.from([0, 1, 2, 255]));
                break;
            case '/echo':
                respond(200, { 'content-type': 'application/json' }, JSON.stringify({
                    cookie: headers.cookie || null,
                    authorization: headers.authorization || null,
                    accept: headers.accept || null,
                    acceptEncoding: headers['accept-encoding'] || null,
                    method: headers[':method'] || null,
                }));
                break;
            case '/redirect':
                respond(302, { location: '/hello' }, '');
                break;
            case '/redirect-chain':
                respond(301, { location: '/redirect' }, '');
                break;
            case '/notfound':
                respond(404, { 'content-type': 'text/plain' }, 'missing');
                break;
            case '/slow': {
                const ms = Number(url.searchParams.get('ms')) || 300;
                const timer = setTimeout(() => {
                    respond(200, { 'content-type': 'text/plain' }, `slow ${ms}`);
                }, ms);
                stream.on('close', () => clearTimeout(timer));
                break;
            }
            default:
                respond(404, { 'content-type': 'text/plain' }, 'unknown');
                break;
        }
    });
    const handle = await listen(server);
    return { ...handle, state };
}

/** h1-only origin: an https server that never negotiates h2. */
async function startH1Server(key, cert) {
    const state = { requests: 0, tlsConnections: 0, lastAlpn: null, paths: [] };
    const server = https.createServer({ key, cert }, (req, res) => {
        state.requests++;
        state.paths.push(req.url);
        res.writeHead(200, {
            'content-type': 'text/plain; charset=utf-8',
            'x-transport': 'h1',
            'set-cookie': ['h1=yes; Path=/'],
        });
        res.end('hello from h1');
    });
    server.on('error', () => {});
    server.on('secureConnection', (socket) => {
        state.tlsConnections++;
        state.lastAlpn = socket.alpnProtocol;
    });
    const handle = await listen(server);
    return { ...handle, state };
}

async function closeH2(handle) {
    for (const session of handle.state.sessionList) {
        try { session.destroy(); } catch { /* already closed */ }
    }
    await Promise.race([
        new Promise((resolve) => handle.server.close(resolve)),
        sleep(1500),
    ]);
}

async function closeH1(handle) {
    handle.server.closeAllConnections?.();
    await Promise.race([
        new Promise((resolve) => handle.server.close(resolve)),
        sleep(1500),
    ]);
}

async function runChecks() {
    const key = fs.readFileSync(path.join(FIXTURE_DIR, 'key.pem'));
    const cert = fs.readFileSync(path.join(FIXTURE_DIR, 'cert.pem'));

    const h2 = await startH2Server(key, cert);
    const h1 = await startH1Server(key, cert);
    resetH2Fetch();

    // A stuck stream must not leave the child running past the suite timeout.
    const watchdog = setTimeout(() => {
        process.stderr.write('FAIL  h2-fetch test watchdog fired after 30s\n');
        process.exit(1);
    }, 30_000);
    watchdog.unref?.();

    let crashed = null;
    try {
        // ---- status, body, headers -------------------------------------
        {
            const before = getH2FetchStats();
            const response = await fetchH2(`${h2.origin}/hello`, {
                timeoutMs: 5000,
                headers: {
                    Cookie: 'session=abc',
                    Accept: 'text/plain',
                    'Accept-Encoding': 'identity',
                },
            });
            checkEqual('h2: status is 200', response.status, 200);
            check('h2: response is ok', response.ok === true);
            checkEqual('h2: text() returns the body', await response.text(), 'hello from h2');
            checkEqual('h2: headers.get() reads a response header', response.headers.get('x-transport'), 'h2');
            checkEqual('h2: headers.get() is case-insensitive', response.headers.get('Content-Type'), 'text/plain; charset=utf-8');
            checkEqual('h2: getSetCookie() keeps each line', response.headers.getSetCookie(), ['a=1; Path=/', 'b=2; Path=/']);
            check('h2: a combined set-cookie header is readable', response.headers.get('set-cookie') !== null);
            const after = getH2FetchStats();
            checkEqual('h2: the first request opens one session', after.sessionsOpened - before.sessionsOpened, 1);
            checkEqual('h2: the request is counted as h2', after.h2Requests - before.h2Requests, 1);
            checkEqual('h2: the server saw exactly one session', h2.state.sessions, 1);
            checkEqual('h2: the server saw the requested path', h2.state.paths[0], '/hello');
        }

        // ---- request header pass-through -------------------------------
        {
            const echo = await (await fetchH2(`${h2.origin}/echo`, {
                headers: {
                    Cookie: 'sid=xyz',
                    Authorization: 'Bearer token-123',
                    Accept: 'application/json',
                    'Accept-Encoding': 'identity',
                },
            })).json();
            checkEqual('headers: Cookie is passed through', echo.cookie, 'sid=xyz');
            checkEqual('headers: Authorization is passed through', echo.authorization, 'Bearer token-123');
            checkEqual('headers: arbitrary headers are passed through', echo.accept, 'application/json');
            checkEqual('headers: content-encoding is left to the caller', echo.acceptEncoding, 'identity');
            checkEqual('headers: the method is GET', echo.method, 'GET');
        }

        // ---- sequential requests reuse the session ---------------------
        {
            const before = getH2FetchStats();
            const bodies = [];
            for (let i = 0; i < 3; i++) {
                bodies.push(await (await fetchH2(`${h2.origin}/json?i=${i}`)).json());
            }
            check('h2: sequential requests all answer over h2', bodies.every((body) => body.transport === 'h2'),
                JSON.stringify(bodies));
            checkEqual('h2: sequential requests keep their paths', bodies.map((body) => body.path),
                ['/json?i=0', '/json?i=1', '/json?i=2']);
            const after = getH2FetchStats();
            checkEqual('session: sequential requests reuse one session', after.sessionsOpened - before.sessionsOpened, 0);
            checkEqual('session: sequential requests are counted', after.h2Requests - before.h2Requests, 3);
            checkEqual('session: the server still sees one session', h2.state.sessions, 1);
        }

        // ---- binary body and non-2xx -----------------------------------
        {
            const response = await fetchH2(`${h2.origin}/bytes`);
            const bytes = Buffer.from(await response.arrayBuffer());
            checkEqual('body: arrayBuffer() returns the exact bytes', [...bytes], [0, 1, 2, 255]);
            checkEqual('body: the binary content type is readable', response.headers.get('content-type'),
                'application/octet-stream');

            const missing = await fetchH2(`${h2.origin}/notfound`);
            checkEqual('status: a 404 is a response, not a rejection', missing.status, 404);
            check('status: a 404 is not ok', missing.ok === false);
            checkEqual('status: a 404 body is readable', await missing.text(), 'missing');
        }

        // ---- redirects -------------------------------------------------
        {
            const before = getH2FetchStats();
            const followed = await fetchH2(`${h2.origin}/redirect`);
            checkEqual('redirect: follow returns the final status', followed.status, 200);
            checkEqual('redirect: follow returns the final body', await followed.text(), 'hello from h2');
            checkEqual('redirect: follow resolves a relative Location', followed.url, `${h2.origin}/hello`);
            checkEqual('redirect: follow marks the response redirected', followed.redirected, true);
            checkEqual('redirect: the hop is counted', getH2FetchStats().redirects - before.redirects, 1);
            checkEqual('redirect: follow stays on the pooled session',
                getH2FetchStats().sessionsOpened - before.sessionsOpened, 0);

            const chained = await fetchH2(`${h2.origin}/redirect-chain`);
            checkEqual('redirect: a chain reaches the final page', await chained.text(), 'hello from h2');

            const manual = await fetchH2(`${h2.origin}/redirect`, { redirect: 'manual' });
            checkEqual('redirect: manual returns the 302', manual.status, 302);
            checkEqual('redirect: manual exposes Location', manual.headers.get('location'), '/hello');
            checkEqual('redirect: manual does not follow', manual.redirected, false);

            const refused = await rejection(fetchH2(`${h2.origin}/redirect`, { redirect: 'error' }));
            checkEqual('redirect: redirect=error rejects', refused?.name, 'TypeError');
        }

        // ---- concurrent streams on one session -------------------------
        {
            const before = getH2FetchStats();
            h2.state.maxActive = 0;
            const results = await Promise.all(Array.from({ length: 8 }, (_, index) => (
                fetchH2(`${h2.origin}/slow?ms=120&i=${index}`)
                    .then(async (response) => ({ status: response.status, body: await response.text() }))
            )));
            check('h2: all concurrent requests succeed',
                results.every((result) => result.status === 200 && result.body === 'slow 120'),
                JSON.stringify(results.map((result) => result.status)));
            check('h2: concurrent requests are multiplexed', h2.state.maxActive >= 4,
                `max concurrent streams ${h2.state.maxActive}`);
            const after = getH2FetchStats();
            checkEqual('h2: concurrent requests do not open extra sessions',
                after.sessionsOpened - before.sessionsOpened, 0);
            checkEqual('h2: concurrent requests are counted', after.h2Requests - before.h2Requests, 8);
            checkEqual('session: the whole run still has one pooled session', after.pooledSessions, 1);
        }

        // ---- timeout ---------------------------------------------------
        {
            const startedAt = Date.now();
            const error = await rejection(fetchH2(`${h2.origin}/slow?ms=1500`, { timeoutMs: 150 }));
            const elapsed = Date.now() - startedAt;
            check('timeout: a slow response rejects', error !== null);
            checkEqual('timeout: the rejection is a TimeoutError', error?.name, 'TimeoutError');
            check('timeout: it fires near the requested budget', elapsed < 1200, `${elapsed} ms`);
            const afterTimeout = await fetchH2(`${h2.origin}/hello`, { timeoutMs: 5000 });
            checkEqual('timeout: the pooled session survives a cancelled stream', afterTimeout.status, 200);
        }

        // ---- caller abort ----------------------------------------------
        {
            const controller = new AbortController();
            const pending = fetchH2(`${h2.origin}/slow?ms=1500`, { signal: controller.signal });
            const timer = setTimeout(() => controller.abort(), 80);
            const error = await rejection(pending);
            clearTimeout(timer);
            check('abort: a caller abort rejects the request', error !== null);
            checkEqual('abort: the rejection is an AbortError', error?.name, 'AbortError');
            const afterAbort = await fetchH2(`${h2.origin}/hello`);
            checkEqual('abort: the pooled session survives an abort', afterAbort.status, 200);
        }

        // ---- h1 fallback, remembered per origin ------------------------
        {
            const before = getH2FetchStats();
            const first = await fetchH2(`${h1.origin}/page/1`);
            checkEqual('fallback: the h1 response is served', first.status, 200);
            checkEqual('fallback: the body comes from the h1 server', await first.text(), 'hello from h1');
            checkEqual('fallback: the h1 server identified itself', first.headers.get('x-transport'), 'h1');
            const afterFirst = getH2FetchStats();
            checkEqual('fallback: one fallback is counted', afterFirst.fallbacks - before.fallbacks, 1);
            checkEqual('fallback: the request is counted as h1', afterFirst.h1Requests - before.h1Requests, 1);
            checkEqual('fallback: no h2 session is kept for an h1 origin',
                afterFirst.sessionsOpened - before.sessionsOpened, 0);
            check('fallback: the origin is remembered as h1', afterFirst.h1Origins.includes(h1.origin),
                JSON.stringify(afterFirst.h1Origins));
            checkEqual('fallback: the h1 server served the request', h1.state.requests, 1);
            check('fallback: ALPN did not negotiate h2', h1.state.lastAlpn !== 'h2',
                String(h1.state.lastAlpn));

            const second = await fetchH2(`${h1.origin}/page/2`);
            const afterSecond = getH2FetchStats();
            checkEqual('fallback: the second response is served', second.status, 200);
            checkEqual('fallback: the second request does not retry h2',
                afterSecond.h2Requests - afterFirst.h2Requests, 0);
            checkEqual('fallback: the second request goes straight to fetch',
                afterSecond.h1Requests - afterFirst.h1Requests, 1);
            checkEqual('fallback: the second request is not a new fallback',
                afterSecond.fallbacks - afterFirst.fallbacks, 0);
            checkEqual('fallback: the h1 server served both requests', h1.state.requests, 2);
        }

        // ---- reset hook ------------------------------------------------
        {
            const closedBefore = h2.state.closedSessions;
            resetH2Fetch();
            checkEqual('reset: counters are cleared', getH2FetchStats().sessionsOpened, 0);
            checkEqual('reset: h1 memory is cleared', getH2FetchStats().h1Origins.length, 0);
            check('reset: the pooled h2 session is closed',
                await waitFor(() => h2.state.closedSessions > closedBefore, 2000),
                `${h2.state.closedSessions - closedBefore} session(s) closed`);
            const fresh = await fetchH2(`${h2.origin}/hello`);
            checkEqual('reset: a fresh h2 session is used afterwards', fresh.status, 200);
            checkEqual('reset: exactly one new session is opened', getH2FetchStats().sessionsOpened, 1);

            const reprobe = await fetchH2(`${h1.origin}/page/3`);
            checkEqual('reset: the h1 origin is probed for h2 again', getH2FetchStats().fallbacks, 1);
            checkEqual('reset: the re-probed request still answers', await reprobe.text(), 'hello from h1');
        }
    } catch (error) {
        crashed = error;
    }

    resetH2Fetch();
    await closeH2(h2);
    await closeH1(h1);

    if (crashed) {
        process.stderr.write(`FAIL  the h2-fetch test aborted: ${crashed?.stack || crashed}\n`);
        process.exit(1);
    }
    finish();
}

if (!FIXTURE_DIR) {
    bootstrapWithTestCertificate();
} else {
    await runChecks();
}
