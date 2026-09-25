#!/usr/bin/env node
'use strict';

// Browserless BookWalker free-volume (`?sample=2`) downloader.
//
// Reproduces the native viewer's own anonymous handshake with plain HTTP:
//
//   GET  bookwalker.jp/de<cid>/?sample=2      -> 302
//   GET  viewer.bookwalker.jp/browserWebApi/03/view?cid=<cid>   -> 302 (+ SESSION)
//   GET  viewer.bookwalker.jp/03/30/viewer.html?cid=<cid>&cty=1
//   GET  viewer.bookwalker.jp/browserWebApi/03/getLoader   (defines c9P())
//   GET  viewer.bookwalker.jp/browserWebApi/c?cid=<cid>[&u1=<uuid>]&BID=<id>&cr=<c9P()>
//        u1 is added whenever the session carries a u1 cookie. Every signed-in
//        request in the captured HARs sends cid + u1 + BID + cr, and u1 is an
//        HttpOnly UUID cookie - which is why a console paste of document.cookie
//        cannot produce a usable signed-in session on its own.
//        -> { status:"200", url, cti, auth_info:{ hti,cfg,bid,uuid,pfCd,Policy,Signature,Key-Pair-Id } }
//   GET  <url>configuration_pack.json?<auth>   -> encrypted manifest
//   GET  <url><derived page name>?<auth>       -> page jpeg
//
// ---------------------------------------------------------------------------
// SIGNING IN - only for titles you own. Free volumes need none of this.
// ---------------------------------------------------------------------------
// With no session flags this script runs the anonymous handshake above and never
// touches a browser. An owned title needs cookies that no single request carries,
// because they live on different hosts:
//
//   viewer.bookwalker.jp    SESSION, u1, bid     (all three are HttpOnly)
//   member.bookwalker.jp    JSESSIONID, AWSALB   (the member site's own login)
//
// The member session is the one that unlocks a purchase. Its cooperation hand-off
// redirects to id.bookwalker.jp passing kpid=<JSESSIONID>; id logs that session in
// and bounces to viewer.bookwalker.jp/browserWebApi/03/auth?cid=..., which grants
// the title. Without it the hand-off lands on the member login form and every
// route ends in 403, however good the shop cookies are. A header copied from the
// viewer alone is therefore never enough for a purchased title.
//
//   # 1. open the book in the reader with DevTools -> Network -> Preserve log on
//   # 2. right-click the getLoader request  (viewer.bookwalker.jp) -> Copy as cURL
//   pbpaste > /tmp/viewer.txt
//   # 3. right-click the cooperation request (member.bookwalker.jp) -> Copy as cURL
//   pbpaste > /tmp/member.txt
//   # 4. both at once: --cookie may be repeated and the pastes are merged
//   node cli/free-volume.js <url...> --cookie @/tmp/viewer.txt --cookie @/tmp/member.txt
//
// One pair covers every title in the run, and a working session is stored in the
// state file, so later runs need no flags until the cookies expire. Add --verbose
// to see the full handshake, the hop chains and the cookie names.
//
// `cr` is not derived from BID, cid or the clock: the loader defines a global
// c9P() and the viewer sends whatever it returns, so the value is read out of
// the loader response rather than computed here (see extractCrFromLoader).
//
// Usage:
//   node cli/free-volume.js 'https://bookwalker.jp/de<uuid>/?sample=2'
//   node cli/free-volume.js 'https://viewer.bookwalker.jp/03/30/viewer.html?cid=<uuid>&cty=1'
//   node cli/free-volume.js <uuid> --out ./out --probe-only

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { runPublicTrialJob } = require('./public-trial');

// Cookies that mean "this jar belongs to a signed-in account".
const SIGNED_IN_COOKIE = /^(bwmember|bwlogin|lbwsid|cm_kp_login_account)$/i;
const USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36';
const AUTH_PARAM_KEYS = ['hti', 'cfg', 'bid', 'uuid', 'pfCd', 'Policy', 'Signature', 'Key-Pair-Id'];
const MAX_REDIRECTS = 6;

// --- tiny cookie jar -------------------------------------------------------
// Only needs to round-trip Set-Cookie -> Cookie across two hosts. Domain/path
// scoping is deliberately not modelled; the probe sends every stored cookie to
// both bookwalker.jp and viewer.bookwalker.jp, which is what the browser does
// for this handshake anyway.
class CookieJar {
    constructor() { this.jar = new Map(); }
    absorb(response) {
        const lines = typeof response.headers.getSetCookie === 'function'
            ? response.headers.getSetCookie()
            : [];
        for (const line of lines) {
            const pair = String(line).split(';')[0];
            const eq = pair.indexOf('=');
            if (eq < 1) continue;
            this.jar.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
        }
    }
    header() {
        return [...this.jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
    }
    get(name) { return this.jar.get(name) || ''; }
    names() { return [...this.jar.keys()]; }
    delete(name) { this.jar.delete(name); }
    set(name, value) { this.jar.set(name, value); }
}

async function request(url, jar, referer) {
    const headers = {
        'User-Agent': USER_AGENT,
        'Accept': '*/*',
        'Accept-Language': 'ja-JP,ja;q=0.9,en-US;q=0.8,en;q=0.7'
    };
    const cookie = jar.header();
    if (cookie) headers.Cookie = cookie;
    if (referer) headers.Referer = referer;
    const response = await fetch(url, { headers, redirect: 'manual' });
    jar.absorb(response);
    return response;
}

async function follow(url, jar, referer) {
    let current = url;
    let ref = referer;
    const hops = [];
    for (let i = 0; i < MAX_REDIRECTS; i++) {
        const response = await request(current, jar, ref);
        hops.push({ url: current, status: response.status, location: response.headers.get('location') || null });
        if (response.status >= 300 && response.status < 400 && hops[i].location) {
            ref = current;
            current = new URL(hops[i].location, current).toString();
            continue;
        }
        return { url: current, response, hops };
    }
    return { url: current, response: await request(current, jar, ref), hops };
}

function resolveCid(input) {
    const text = String(input || '').trim();
    if (/^[0-9a-f-]{36}$/i.test(text)) return text;
    try {
        const url = new URL(text);
        const byQuery = url.searchParams.get('cid');
        if (byQuery) return byQuery;
        const match = url.pathname.match(/\/de([0-9a-f-]{36})\/?$/i);
        if (match) return match[1];
    } catch (_) { /* not a URL */ }
    return null;
}

function generatedBid() {
    return `${Date.now()}${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}NFBR`;
}

// The real cr is defined by the loader (see extractCrFromLoader); this is only
// a last-resort stand-in for a loader that could not be read.
function generatedCr() {
    return String(Math.floor(Math.random() * Number.MAX_SAFE_INTEGER));
}

// --- cr: the request token the loader hands out -----------------------------
// The script served by /browserWebApi/03/getLoader defines c9P(), and the
// viewer sends its return value as `cr`. The value therefore only exists in the
// loader a session actually fetched, which is why it is read rather than
// computed: it is not a digest of BID, cid or the current time.
const LOADER_PATH = '/browserWebApi/03/getLoader';
// A sample (試し読み) is served by its own viewer on its own host, with its own
// licence endpoint. That endpoint wants only cid + BID - no cr, no u1 and no
// session - which is why the free /browserWebApi route answers 403 for a sample
// of a paid title.
const TRIAL_HOST = 'https://viewer-trial.bookwalker.jp';
const TRIAL_VIEWER_PATH = '/03/21/viewer.html';
const TRIAL_LICENCE_PATH = '/trial-page/c';

// The trial licence names a base URL, and the manifest sits either directly in it
// or one level down inside the quality directory's normal_default/. Both shapes
// are real: .../<n>_normal/<cid>/1/configuration_pack.json and
// .../<n>_normal/<cid>/1/SVGA/normal_default/configuration_pack.json.
function trialManifestRelPaths() {
    return ['normal_default/configuration_pack.json', 'configuration_pack.json'];
}

// Every Math call a loader has been seen to emit. The expression is a constant
// dressed up as arithmetic, so anything containing other syntax is refused
// rather than evaluated.
const MATH_CALL = /Math\.(?:sqrt|log|exp|sin|cos|tan|asin|acos|atan|abs|cbrt|log2|log10|sinh|cosh|tanh|pow|round|floor|ceil)\s*\(\s*\d+(?:\.\d+)?\s*(?:,\s*\d+(?:\.\d+)?\s*)?\)/g;

function evaluateLoaderConstant(expression) {
    // Once the Math calls are blanked out only numbers, parentheses and the
    // arithmetic operators may remain. This is what stops server-supplied text
    // from ever being executed as code.
    if (!/^[\s()+\-*\d.]*$/.test(expression.replace(MATH_CALL, '0'))) return null;
    try {
        const value = vm.runInNewContext(`(${expression})`, { Math }, { timeout: 1000 });
        return typeof value === 'number' && Number.isFinite(value) ? value : null;
    } catch (_) {
        return null;
    }
}

// The loader hides the token behind a constant: it formats the value to 15
// decimal places, keeps the fractional digits but drops the last one, then
// appends a short suffix. Repeating those steps yields exactly what the viewer
// would have sent.
function extractCrFromLoader(body) {
    if (typeof body !== 'string' || !body) return null;
    const start = body.indexOf('c9P=function(){');
    if (start < 0) return null;
    const end = body.indexOf('};', start);
    if (end < 0) return null;
    const source = body.slice(start, end + 2);

    const expression = source.match(/let\s+r\s*=\s*([\s\S]*?);\s*let\s+s\s*=/);
    const suffixes = [...source.matchAll(/[+]\s*['"](\d+)['"]/g)];
    if (!expression || !suffixes.length) return null;

    const value = evaluateLoaderConstant(expression[1]);
    if (value === null) return null;

    const text = String(value.toFixed(15));
    const dot = text.indexOf('.');
    if (dot < 0) return null;
    const cr = text.substring(dot + 1, text.length - 1) + suffixes[suffixes.length - 1][1];
    return /^\d+$/.test(cr) ? cr : null;
}

async function fetchLoaderCr(jar, referer) {
    const response = await request(`https://viewer.bookwalker.jp${LOADER_PATH}`, jar, referer);
    const body = response.ok ? await response.text() : '';
    return { status: response.status, bytes: body.length, cr: extractCrFromLoader(body) };
}

// Decides what to send as `cr`: the loader's own value by default, a caller
// override via --cr, or nothing at all via --no-cr.
// Mirrors the query string the viewer itself builds: cid, then u1 when the
// session has one, then BID and cr. Dropping u1 is what turns a signed-in licence
// request into a CloudFront 403.
function contentCheckUrl(cid, { u1, bid, cr } = {}) {
    return `https://viewer.bookwalker.jp/browserWebApi/c?cid=${encodeURIComponent(cid)}`
        + (u1 ? `&u1=${encodeURIComponent(u1)}` : '')
        + `&BID=${encodeURIComponent(bid)}`
        + (cr ? `&cr=${encodeURIComponent(cr)}` : '');
}

async function resolveCr(jar, viewerUrl, options, log) {
    if (options.cr === null) {
        log.push({ step: 'cr', url: 'omitted (--no-cr)' });
        return { value: null, source: 'omitted' };
    }
    if (options.cr) {
        log.push({ step: 'cr', url: `${options.cr} (--cr)` });
        return { value: String(options.cr), source: 'caller' };
    }
    // Every /c gets its own loader fetch. Reusing one across titles was measured
    // to fail: the second title's /c answered 401 while a freshly fetched cr
    // answered 200, so the value is tied to the session state at fetch time.
    try {
        const loader = await fetchLoaderCr(jar, viewerUrl);
        if (loader.cr) {
            log.push({ step: 'getLoader', url: `cr ${loader.cr}  (HTTP ${loader.status}, ${loader.bytes} bytes)` });
            return { value: loader.cr, source: 'getLoader' };
        }
        log.push({ step: `getLoader (HTTP ${loader.status})`, url: 'no c9P() in the response; falling back to a random cr' });
    } catch (error) {
        log.push({ step: 'getLoader failed', url: `${error && error.message ? error.message : error}` });
    }
    return { value: generatedCr(), source: 'random-fallback' };
}

function seedJar(cookieHeader) {
    const jar = new CookieJar();
    for (const part of String(cookieHeader || '').split(';')) {
        const piece = part.trim();
        if (!piece) continue;
        const eq = piece.indexOf('=');
        if (eq < 1) continue;
        jar.jar.set(piece.slice(0, eq).trim(), piece.slice(eq + 1).trim());
    }
    return jar;
}

// --- accepting a session from a browser -------------------------------------
// Cookies arrive in whatever shape the browser was copied from, so all of these
// are accepted and normalised into a single Cookie header:
//   bwmember=x; SESSION=y          a raw Cookie header
//   cookie: bwmember=x; ...        the DevTools request-headers pane
//   curl ... -H 'cookie: ...'      "Copy as cURL" (-b/--cookie works too)
//   bwmember=x\nSESSION=y          a document.cookie paste
// Set-Cookie attributes are dropped, so pasting a response line works too.
const COOKIE_ATTRIBUTE = /^(path|domain|expires|max-age|secure|httponly|samesite)=/i;

function normalizeCookieHeader(raw) {
    let text = String(raw == null ? '' : raw).trim();
    if (!text) return '';
    if (/\bcurl\b/i.test(text)) {
        const values = [...text.matchAll(/(?:-H|--header|-b|--cookie)\s+\$?(['"])([\s\S]*?)\1/gi)]
            .map(match => match[2]);
        text = values.find(value => /^\s*cookie\s*:/i.test(value))
            || values.find(value => value.includes('='))
            || '';
    }
    text = text.replace(/^\s*cookie\s*:/i, '').trim();
    if (!text.includes(';')) text = text.replace(/[\r\n]+/g, ';');
    return text
        .split(/[;\r\n]+/)
        .map(pair => pair.trim())
        .filter(pair => /^[^\s=;]+=/.test(pair))
        .filter(pair => !COOKIE_ATTRIBUTE.test(pair))
        .join('; ');
}

// Drops just the viewer SESSION, keeping the sign-in cookies beside it.
function withoutSession(cookieHeader) {
    return String(cookieHeader || '')
        .split(';')
        .map(pair => pair.trim())
        .filter(pair => pair && !/^SESSION=/i.test(pair))
        .join('; ');
}

function existingFile(candidate) {
    try { return fs.statSync(candidate).isFile() ? candidate : null; } catch (_) { return null; }
}

// --cookie takes the header itself, "@file" or a path to read it from, or "-"
// for stdin (useful with pbpaste/xclip).
function readCookieArgument(argument) {
    const text = String(argument == null ? '' : argument);
    if (text === '-') return normalizeCookieHeader(fs.readFileSync(0, 'utf8'));
    // Say which file is wrong rather than reporting an empty cookie: a mistyped
    // redirect leaves a zero-byte file, and "no usable name=value pair" hides that.
    const file = text.startsWith('@') ? text.slice(1) : existingFile(text);
    if (file) {
        if (!fs.existsSync(file)) throw new Error(`no such file: ${file}`);
        const raw = fs.readFileSync(file, 'utf8');
        if (!raw.trim()) throw new Error(`file is empty: ${file}`);
        return normalizeCookieHeader(raw);
    }
    return normalizeCookieHeader(text);
}

// Merges cookie headers, the first occurrence of a name winning so the order the
// caller pasted them decides. Repeating --cookie is necessary because the two
// halves of an owned title live on different hosts and no single request carries
// both: viewer.bookwalker.jp holds SESSION/u1/bid, member.bookwalker.jp holds the
// JSESSIONID that its cooperation hand-off passes to id.bookwalker.jp as `kpid`.
function mergeCookies(headers) {
    const seen = new Map();
    for (const header of headers || []) {
        for (const pair of String(header || '').split(';')) {
            const piece = pair.trim();
            if (!piece || !piece.includes('=')) continue;
            const name = piece.split('=')[0].trim();
            if (name && !seen.has(name)) seen.set(name, piece);
        }
    }
    return [...seen.values()].join('; ');
}

// Cookie names that only a signed-in browser session carries.
function signedInNames(jar) {
    return jar.names().filter(name => SIGNED_IN_COOKIE.test(name));
}

// The snippet to paste into the console of a signed-in bookwalker.jp tab. It is
// kept as a standalone file so it can be read straight from the CLI or opened in
// an editor; it never runs in Node.
function consoleSnippet() {
    return fs.readFileSync(path.join(__dirname, 'console-session.js'), 'utf8');
}

function stateFile(options) {
    if (options.stateFile === null) return null;
    if (options.stateFile) return path.resolve(options.stateFile);
    const home = process.env.HOME || process.env.USERPROFILE || '.';
    return path.join(home, '.bwdd-cli', 'free-session.json');
}

// A licence is valid until the signed CloudFront policy expires (usually ~10
// minutes). While it lasts, a repeat run needs no browser at all.
function licenceExpiry(auth) {
    try {
        const padded = String(auth.Policy).replace(/-/g, '+').replace(/_/g, '/');
        const policy = Buffer.from(padded, 'base64').toString('utf8');
        const match = policy.match(/"AWS:EpochTime"\s*:\s*(\d+)/);
        if (match) return Number(match[1]) * 1000;
    } catch (_) { /* not a decodable policy */ }
    return 0;
}

function licenceFile(cid, options) {
    const base = stateFile(options);
    return base ? path.join(path.dirname(base), `licence-${cid}.json`) : null;
}

function readLicence(cid, options) {
    const file = licenceFile(cid, options);
    if (!file) return null;
    try {
        const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
        const licence = saved && saved.licence;
        if (!licence || !licence.auth_info || !licence.url) return null;
        if (!saved.expiresAt || saved.expiresAt - 30000 < Date.now()) return null;
        return licence;
    } catch (_) {
        return null;
    }
}

function writeLicence(cid, licence, options) {
    const file = licenceFile(cid, options);
    if (!file) return;
    try {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, JSON.stringify({
            savedAt: new Date().toISOString(),
            expiresAt: licenceExpiry(licence.auth_info || {}),
            licence
        }, null, 1));
    } catch (_) { /* best effort */ }
}

function loadJar(file) {
    if (!file) return null;
    try {
        const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (!saved || !Array.isArray(saved.cookies) || !saved.cookies.length) return null;
        const jar = new CookieJar();
        for (const [name, value] of saved.cookies) jar.jar.set(name, value);
        return jar;
    } catch (_) {
        return null;
    }
}

function saveJar(jar, file) {
    if (!file) return;
    try {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, JSON.stringify({ savedAt: new Date().toISOString(), cookies: [...jar.jar.entries()] }, null, 1));
    } catch (_) { /* best effort */ }
}

// The anonymous handshake, in the order the viewer performs it: the store
// product page issues bwsess, ?sample=2 bounces to the viewer, and /view is what
// grants the SESSION cookie the licence endpoint is checked against.
async function establishSession(jar, cid, log) {
    const productUrl = `https://bookwalker.jp/de${cid}/?sample=2`;
    const product = await request(`https://bookwalker.jp/de${cid}/`, jar);
    log.push({ step: 'product page (issues bwsess)', status: product.status });

    const entry = await follow(productUrl, jar);
    log.push({ step: 'product ?sample=2', hops: entry.hops });

    // If the server did not already bounce us through /view, do it explicitly.
    if (!entry.url.includes('/viewer.html') && !entry.url.includes('/browserWebApi/03/view')) {
        const view = await follow(`https://viewer.bookwalker.jp/browserWebApi/03/view?cid=${cid}`, jar, productUrl);
        log.push({ step: 'browserWebApi/03/view', hops: view.hops });
        entry.url = view.url;
    }

    const viewerUrl = entry.url.includes('/viewer.html')
        ? entry.url
        : `https://viewer.bookwalker.jp/03/30/viewer.html?cid=${cid}&cty=1`;
    log.push({ step: 'viewer', url: viewerUrl });
    log.push({ step: 'SESSION issued by /view', url: (jar.get('SESSION') || '(none)').slice(0, 8) });
}

// Opening a book in the browser calls /browserWebApi/03/view?cid=<cid>, and that
// call is what authorises the viewer session for that particular title. A pasted
// SESSION skips it, which leaves the session bound to whatever book the browser
// last opened - every other title then answers 401 even with perfect cookies. So
// repeat the bind for the cid we actually want, with the sign-in cookies riding
// along. The anonymous handshake already proves the call does the binding.
async function bindSession(jar, cid, log) {
    const referer = `https://bookwalker.jp/de${cid}/`;
    try {
        const view = await follow(`https://viewer.bookwalker.jp/browserWebApi/03/view?cid=${cid}`, jar, referer);
        log.push({ step: 'browserWebApi/03/view (bound to this cid)', hops: view.hops });
        return true;
    } catch (error) {
        // A failed bind is not fatal: /c still gets its chance.
        log.push({ step: 'binding this cid failed', url: error && error.message ? error.message : error });
        return false;
    }
}

// An owned title renders a cooperation link carrying BROWSER_VIEWER on its product
// page; a free one does not. The entry has to match, because the wrong one is not
// harmless: `?sample=2` lands an owned title on a preview and /c then answers 403,
// while the cooperation route answers "not yet purchased" for a title you do not
// own. So ask the product page which this is, the way the viewer's own `読む`
// button does.
async function titleIsOwned(jar, cid, log) {
    try {
        const res = await request(`https://bookwalker.jp/de${cid}/`, jar);
        const html = await res.text();
        const owned = /BROWSER_VIEWER/.test(html);
        log.push({ step: `product page says ${owned ? 'owned' : 'free / preview'}`, status: res.status });
        // The page carries the very link the `読む` button uses, so take that rather
        // than rebuilding it: it may carry a store code or token we cannot guess.
        const link = html.match(
            /https:\/\/member\.bookwalker\.jp\/app\/03\/webstore\/cooperation\?[^"'\s<>\\]*BROWSER_VIEWER[^"'\s<>\\]*/
        );
        if (link) {
            const entry = link[0].replace(/&amp;/g, '&');
            log.push({ step: 'cooperation link taken from the page', url: entry.slice(0, 140) });
            return { owned: true, entry };
        }
        return { owned, entry: null };
    } catch (error) {
        log.push({ step: 'could not read the product page', url: error && error.message ? error.message : error });
        return { owned: false, entry: null };
    }
}

// The member cooperation hand-off, i.e. what the `読む` button links to.
async function enterOwned(jar, cid, store, log, link) {
    const cooperation = link || ('https://member.bookwalker.jp/app/03/webstore/cooperation'
        + `?r=BROWSER_VIEWER/${cid}/${encodeURIComponent(store)}`);
    const entry = await follow(cooperation, jar, store);
    // member.bookwalker.jp keeps its own login, separate from the shop: with no
    // session for it the hand-off lands on its Spring Security login form, and the
    // title is never granted no matter what the shop cookies say.
    const bounced = /member\.bookwalker\.jp\/app\/03\/login/.test(entry.url);
    log.push({
        step: bounced
            ? 'cooperation hand-off bounced to the member login (no member.bookwalker.jp session in the cookie)'
            : 'cooperation hand-off (owned title)',
        hops: entry.hops
    });
    if (!bounced && !entry.url.includes('/viewer.html') && !entry.url.includes('/browserWebApi/03/view')) {
        await bindSession(jar, cid, log);
    }
    return !bounced;
}

async function openTrialSession(cid, options = {}) {
    // The sample flow, reproduced from the viewer-trial HAR: open the trial
    // viewer, ask /trial-page/c for the licence, then read the manifest out of
    // the base URL it returns. Nothing here needs a session or a signed-in
    // cookie, and the cr dance does not exist on this route at all.
    const jar = new CookieJar();
    const log = [];
    const store = `https://bookwalker.jp/de${cid}/`;
    const bid = options.bid || generatedBid();
    const viewerUrl = `${TRIAL_HOST}${TRIAL_VIEWER_PATH}?cid=${cid}&cty=0`;
    const opened = await follow(viewerUrl, jar, store);
    log.push({ step: 'trial viewer (sample: no session, no cr, no u1)', hops: opened.hops });

    const licenceUrl = `${TRIAL_HOST}${TRIAL_LICENCE_PATH}?cid=${cid}&BID=${bid}`;
    const licenceRes = await request(licenceUrl, jar, opened.url || viewerUrl);
    const licenceRaw = await licenceRes.text();
    let licence = null;
    try { licence = JSON.parse(licenceRaw); } catch (_) { /* non-JSON */ }
    log.push({ step: `trial licence -> ${licenceRaw.slice(0, 200)}` });

    let payload = { status: licence && licence.status ? licence.status : null };
    if (licence && licence.status === '200' && licence.url && licence.auth_info) {
        const auth = new URLSearchParams();
        for (const key of AUTH_PARAM_KEYS) {
            if (licence.auth_info[key] != null) auth.set(key, String(licence.auth_info[key]));
        }
        const licenceBase = String(licence.url).replace(/\/*$/, '/');
        for (const rel of trialManifestRelPaths()) {
            const manifestRes = await request(`${licenceBase}${rel}?${auth.toString()}`, jar, `${TRIAL_HOST}/`);
            await manifestRes.text();
            log.push({ step: `trial manifest ${rel}`, status: manifestRes.status });
            if (manifestRes.status !== 200) continue;
            // Hand the manifest's own directory back as baseUrl so the shared
            // downloader resolves its relative page paths exactly as the viewer
            // does - one of the two shapes needs that extra directory level.
            payload = {
                status: '200',
                url: `${licenceBase}${rel}`.replace(/[^/]*$/, ''),
                cti: licence.cti || null,
                cty: licence.cty,
                auth_info: licence.auth_info
            };
            break;
        }
    }

    return {
        cid,
        jar,
        bid,
        cr: null,
        crSource: 'sample route: no cr',
        requestUrl: licenceUrl,
        httpStatus: licenceRes.status,
        payload,
        storedTo: null,
        cookies: jar.names(),
        log
    };
}

async function openFreeSession(cid, options = {}) {
    // A sample is a separate viewer and licence endpoint, not a variation of the
    // viewer handshake, so it is dispatched before any of the session work below.
    if (options.route === 'sample') return openTrialSession(cid, options);
    // A session taken from a browser you are already signed in to can be handed
    // in directly; that is the only way to reach purchased titles, and it needs
    // no browser in this process. With nothing supplied the anonymous handshake
    // below runs, which is all a free ?sample=2 volume needs.
    const supplied = options.cookie || (options.session ? `SESSION=${options.session}` : null);
    const file = stateFile(options);
    // Reuse the stored viewer session when there is one. A browser keeps a
    // single SESSION alive across many /c calls and many titles; minting a new
    // one for every run is the one behaviour this client never matched.
    const stored = supplied ? null : loadJar(file);
    const jar = supplied ? seedJar(supplied) : (stored || new CookieJar());
    const log = [];
    const signedIn = signedInNames(jar);

    if (supplied) {
        log.push({ step: 'session supplied', url: `${jar.names().length} cookie(s): ${jar.names().join(', ')}` });
    } else if (stored) {
        log.push({ step: 'reusing stored session', url: `${jar.names().length} cookie(s): ${jar.names().join(', ')}` });
    }
    if (options.fresh && jar.get('SESSION')) {
        // The stored SESSION was refused. Drop just that cookie and re-handshake,
        // keeping the login cookies, instead of replaying a session the server
        // has already rejected.
        jar.delete('SESSION');
        log.push({ step: 'discarded the refused SESSION' });
    }
    const store = `https://bookwalker.jp/de${cid}/`;
    // Which entry grants this title cannot be read off the product page: the `読む`
    // link is built client-side, so an owned title's raw HTML is indistinguishable
    // from a free one's. The route is therefore chosen by the caller and confirmed
    // by /c, which is the only thing that actually knows the grant.
    switch (options.route) {
        case 'entry':
            if (options.entry) {
                const entry = await follow(options.entry, jar, store);
                log.push({ step: 'entry from --entry', hops: entry.hops });
            }
            break;
        case 'cooperation': {
            // The hand-off the `読む` button uses. Take the link out of the page when
            // it is there, so any store code or token in it survives.
            const page = await titleIsOwned(jar, cid, log);
            await enterOwned(jar, cid, store, log, page.entry);
            break;
        }
        case 'bind':
            await bindSession(jar, cid, log);
            break;
        case 'asis':
            // Just use the session as it was handed over: when it is already bound
            // to this book this is exactly what the browser sends.
            log.push({ step: 'session used as supplied (no re-entry)' });
            break;
        default:
            // The free / preview route, which doubles as the anonymous handshake.
            await establishSession(jar, cid, log);
            break;
    }

    const viewerUrl = `https://viewer.bookwalker.jp/03/30/viewer.html?cid=${cid}&cty=1`;
    const bid = options.bid || generatedBid();
    // Read the token out of the loader this session has just fetched, so the
    // value matches what the viewer would have sent from that same response.
    const cr = await resolveCr(jar, viewerUrl, options, log);
    // The viewer reads u1 from its own cookie; --u1 is for supplying it by hand.
    const u1 = options.u1 || jar.get('u1');
    const cUrl = contentCheckUrl(cid, { u1, bid, cr: cr.value });
    const cRes = await request(cUrl, jar, viewerUrl);
    const raw = await cRes.text();
    let payload = null;
    try { payload = JSON.parse(raw); } catch (_) { /* non-JSON */ }

    // A supplied session is stored once it works, so a browser only ever has to
    // be read from once and later runs need no flags at all.
    let storedTo = null;
    if (file) {
        if (payload && payload.status === '200') {
            saveJar(jar, file);
            storedTo = file;
        } else if (!supplied) {
            // A refused handshake must not overwrite a SESSION that worked with
            // a dead one. Login cookies are refreshed, but the previous SESSION
            // is carried forward so the next run still has something to reuse.
            const prior = loadJar(file);
            const kept = prior && prior.get('SESSION');
            if (kept && !jar.get('SESSION')) jar.set('SESSION', kept);
            saveJar(jar, file);
            storedTo = file;
        }
    }

    return {
        cid,
        jar,
        bid,
        cr: cr.value,
        crSource: cr.source,
        requestUrl: cUrl,
        httpStatus: cRes.status,
        payload,
        raw,
        cookies: jar.names(),
        signedIn,
        storedTo,
        log
    };
}

// A counting semaphore bounding concurrent licence negotiations. This used to be
// a hard lock because /c was believed to refuse concurrent callers, but that was
// an artefact of the fabricated cr: with the real cr from getLoader, /c answers
// 200 to parallel callers, both on one session and on many independent ones.
function makeSemaphore(width) {
    let active = 0;
    const waiting = [];
    const pump = () => {
        while (active < width && waiting.length) {
            active++;
            waiting.shift()(() => { active--; pump(); });
        }
    };
    return () => new Promise(resolve => { waiting.push(resolve); pump(); });
}

// Flags that consume the argument after them.
const VALUE_FLAGS = new Set([
    '--out', '--session', '--cookie', '--bid', '--cr', '--state', '--entry',
    '--concurrency', '--retries', '--retry-delay', '--titles', '--licence-concurrency'
]);

// Every positional argument is a title, so `url1 url2 url3` queues three. A
// flag's value is skipped, so `--out dir url` is one title rather than two.
function collectInputs(argv) {
    const inputs = [];
    for (let i = 0; i < argv.length; i++) {
        if (VALUE_FLAGS.has(argv[i])) { i++; continue; }
        if (argv[i].startsWith('--')) continue;
        inputs.push(argv[i]);
    }
    return inputs;
}

const USAGE = [
            'Usage: node cli/free-volume.js <url|cid> [<url|cid> ...] [options]',
            '',
            'Runs entirely in Node: no browser, no headless Chrome, no extension. With no',
            'session flags it uses BookWalker\'s own anonymous handshake, which is all a',
            'free ?sample=2 volume needs. Nothing is launched in the background.',
            '',
            'Signing in (only for titles you own; free volumes need no cookies at all)',
            '  With no session flags the anonymous handshake is used. An owned title',
            '  needs two pastes, because its cookies live on two hosts and no single',
            '  request carries both:',
            '    viewer.bookwalker.jp   SESSION, u1, bid',
            '    member.bookwalker.jp   JSESSIONID, AWSALB',
            '  The member hand-off sends JSESSIONID to id.bookwalker.jp as kpid=, which',
            '  logs the session in and redirects to viewer .../03/auth?cid=..., granting',
            '  the book. Without it the hand-off hits the member login and every route',
            '  ends in 403, however good the shop cookies are.',
            '  1. open the book in the reader, DevTools -> Network -> Preserve log on',
            '  2. getLoader request (viewer.bookwalker.jp) -> Copy as cURL:',
            '       pbpaste > /tmp/viewer.txt',
            '  3. cooperation request (member.bookwalker.jp) -> Copy as cURL:',
            '       pbpaste > /tmp/member.txt',
            '  4. node cli/free-volume.js <title url> --cookie @/tmp/viewer.txt',
            '                                          --cookie @/tmp/member.txt',
            '  --cookie may be repeated and the pastes are merged; it also takes a raw',
            '  header, a cURL command, or - to read stdin. One pair covers every title',
            '  in the run, and a working session is stored, so later runs need no flags.',
            '',
            '  --out DIR        output directory (default: ./output)',
            '  --probe-only     stop after the licence call and print the reply',
            '  --sample         force the trial route (試し読み), skipping the free one',
            '  --json           machine-readable summary',
            '  --verbose        print the full handshake, hop chains and cookie names',
            '',
            'OCR handoff (same flags as the rest of the CLI)',
            '  --ocr            hand the downloaded pages to a mokuro-bridge',
            '  --bridge URL     mokuro-bridge base URL; also read from BWDD_BRIDGE_URL',
            '                   or MOKURO_BRIDGE_URL',
            '  --reuse-session  reuse an existing bridge session instead of a new one',
            '',
            'Signed-in sessions (only needed for titles you own; still no browser)',
            '  --cookie TEXT    a Cookie header, a "Copy as cURL" command, "-" to read',
            '                   stdin, or "@FILE"/an existing path to read a file. May be',
            '                   repeated and the pastes are merged: an owned title needs',
            '                   the viewer cookies (SESSION, u1, bid) AND the member',
            '                   session (JSESSIONID, AWSALB) from the cooperation call',
            '  --snippet        print a console snippet for the cookies a page can see.',
            '                   It reads only non-HttpOnly cookies, so it cannot reach',
            '                   SESSION/u1/bid or the member JSESSIONID - use the two',
            '                   Copy-as-cURL pastes above for an owned title',
            '                   for titles you own (see Signing in above)',
            '  --session UUID   reuse just the viewer SESSION cookie. Rarely useful:',
            '                   SESSION alone cannot grant an owned title, which also',
            '                   needs the member session (JSESSIONID)',
            '  --entry URL      open through this URL instead of choosing between the',
            '                   cooperation hand-off and ?sample=2 (paste the one the',
            '                   browser used if a title still refuses)',
            '  --u1 UUID        the u1 cookie value, sent as &u1=. It is HttpOnly, so',
            '                   it normally arrives inside --cookie. u1 is not what',
            '                   grants a purchased title: the member JSESSIONID is, and',
            '                   without it /c answers 403 however good u1 is',
            '  --bid BID        reuse a BrowserId (<epoch-ms><8 digits>NFBR)',
            '  --state FILE     session store (default ~/.bwdd-cli/free-session.json)',
            '  --no-state       do not persist or reuse a stored session',
            '  --no-cache       ignore the stored session and licence, negotiate fresh',
            '',
            'Tuning',
            '  --cr N           send a specific cr instead of reading it from getLoader',
            '  --no-cr          omit cr from the /c request entirely',
            '  --concurrency N  total parallel page downloads (default 128)',
            '  --titles N       titles downloaded at once (default 3, or 1 for one title)',
            '  --licence-concurrency N',
            '                   titles negotiating /c at once (default 4)',

            '  --retries N      attempts at /c before giving up (default 6)',
            '  --retry-delay MS first retry delay, grows 1.5x (default 2000)',
            '',
            'Several titles may be given at once; the first one to establish a session',
            'shares it with the rest, so a batch negotiates once and the page fetches',
            'run in parallel.',
            '',
            'The anonymous handshake is:',
            '  GET /browserWebApi/03/view?cid=<cid>   (creates the viewer session)',
            '  GET /browserWebApi/03/getLoader        (issues SESSION, defines c9P())',
            'cr is read from that c9P(), so the value the viewer would have sent is',
            'reproduced exactly; --cr overrides it and --no-cr omits it.'
].join('\n') + '\n';

async function downloadOne(input, ctx) {
    const { flag, value, say, sleep, quiet, carrier, bar = true, pageConcurrency } = ctx;
    const url = input;

    const cid = resolveCid(url);
    if (!cid) {
        process.stderr.write(`Could not find a book CID in: ${url}\n`);
        if (/--cookie$/.test(url) || (/=/.test(url) && /;/.test(url))) {
            process.stderr.write(
                'That looks like a flag glued to a URL, or a cookie header passed as a\n'
                + 'title. A flag needs a space before it: <url> --cookie \'<header>\'\n'
            );
        }
        return 2;
    }

    // /browserWebApi/c intermittently answers {"status":"503"} for a session it
    // will accept seconds later, so a fresh handshake is retried with backoff
    // until a license is granted. Only this one endpoint is rate limited; once
    // it returns 200 every page downloads normally.
    const retries = Math.max(1, Number(value('--retries') != null ? value('--retries') : 6));
    let retryDelay = Number(value('--retry-delay') != null ? value('--retry-delay') : 2000);
    say(`cid: ${cid}`);

    let session = null;
    const signedInRun = /(?:^|;\s*)(?:bwmember|bwlogin|lbwsid|cm_kp_login_account)=/i
        .test(carrier.supplied || '');
    // Counts real attempts. Declared out here because the reporting below runs
    // after the try/finally that guards the licence slot.
    let attemptsMade = 0;

    // Licence negotiation is bounded rather than serialized: titles wait for a
    // slot, then negotiate in parallel. Page transfers below are outside this and
    // stay fully parallel, bounded only by --concurrency.
    const release = await carrier.acquire();
    try {

    // Prints the handshake once per title, whichever path established it.
    let shown = false;
    // The handshake, the hop chains and the BID only matter when something is
    // wrong, so --verbose is what asks for them.
    const show = info => {
        if (shown || !info || !info.log || !flag('--verbose')) return;
        shown = true;
        for (const step of info.log) {
            if (step.hops) {
                // Label the hop chain, so the route taken is readable: the entry
                // choice is what decides whether an owned title is granted.
                say(`  ${step.step || 'redirects'}:`);
                for (const h of step.hops) say(`    ${h.status}  ${h.url}`);
            } else {
                say(`  ${step.status || ''}  ${step.url || step.step}`.trimEnd());
            }
        }
        const names = info.cookies || (info.jar ? info.jar.names() : []) || [];
        say(`cookies: ${names.join(', ') || '(none)'}`);
        say(`BID: ${info.bid}`);
        say('');
        say(`GET ${info.requestUrl}`);
    };

    const sessionOptions = extra => Object.assign({
        entry: value('--entry'),
        u1: value('--u1'),
        bid: value('--bid'),
        // null = send no cr at all; undefined = read it from getLoader.
        cr: flag('--no-cr') ? null : value('--cr'),
        stateFile: flag('--no-state') ? null : value('--state')
    }, extra);

    // One session serves the whole run. The first title to get here establishes
    // it, seeded with the caller's cookies when there are any, and every other
    // title awaits that same handshake. Re-seeding each title from the original
    // paste would replay a session the server has already rotated, which reads as
    // a 401 - and a batch of owned titles hits that immediately.
    if (!session && !flag('--no-cache')) {
        if (!carrier.establish) {
            carrier.establish = openFreeSession(cid, sessionOptions({
                cookie: carrier.supplied || undefined
            }));
            // A failed establishment must not poison every other title; clearing it
            // lets the next one try afresh.
            carrier.establish.catch(() => { carrier.establish = null; });
        }
        try {
            const established = await carrier.establish;
            const live = established && established.jar ? established.jar.header() : '';
            if (established.cid === cid && established.payload && established.payload.status === '200') {
                session = established;
                show(established);
                if (established.storedTo) say(`  stored for later runs: ${established.storedTo}`);
            } else if (live) {
                // This title still negotiates its own licence, but on the session the
                // run has established rather than on the original paste.
                const own = await openFreeSession(cid, sessionOptions({ cookie: live }));
                if (own.payload && own.payload.status === '200') {
                    say('  reusing this run\'s session');
                    session = own;
                    show(own);
                }
            }
        } catch (_) { /* fall through to the retry loop */ }
    }

    // 3) A licence from the last few minutes is still inside its signed policy
    //    window. Reusing it skips /c, the only rate-limited call in the flow.
    if (!session && !carrier.supplied && !flag('--no-cache') && !flag('--no-state')) {
        const cached = readLicence(cid, { stateFile: value('--state') });
        if (cached) {
            say('  reusing a licence from this machine (no /c call)');
            session = {
                cid,
                jar: null,
                bid: (cached.auth_info && cached.auth_info.bid) || null,
                cr: null,
                crSource: 'cached licence',
                payload: cached,
                cookies: [],
                httpStatus: 200,
                requestUrl: '(cached licence)'
            };
        }
    }

    // The entry route decides the grant, so a 401/403 is not proof the cookies are
    // bad. Walk the routes the browser could have used, in the order most likely to
    // grant an owned title, and let /c settle it: the cooperation hand-off, the
    // session exactly as supplied, the free ?sample=2 route, and finally the bare
    // /view?cid= bind. Anonymous runs have exactly one route.
    const routeList = value('--entry') ? ['entry']
        : flag('--sample') ? ['sample']
            : signedInRun ? ['cooperation', 'asis', 'free', 'sample', 'bind']
                : ['free', 'sample'];
    let last = null;
    for (let attempt = 1; !session && attempt <= retries; attempt++) {
        attemptsMade += 1;
        const route = routeList[Math.min(attempt - 1, routeList.length - 1)];
        let candidate;
        try {
            candidate = await openFreeSession(cid, {
                cookie: carrier.cookie || carrier.supplied || undefined,
                route,
                entry: value('--entry'),
                u1: value('--u1'),
                bid: value('--bid'),
                // null = send no cr at all; undefined = read it from getLoader.
                cr: flag('--no-cr') ? null : value('--cr'),
                // Once a stored SESSION has been refused, stop trusting it and
                // re-handshake rather than replaying a session the server wants
                // nothing to do with.
                fresh: attempt > 1 && !carrier.supplied,
                stateFile: flag('--no-state') ? null : value('--state')
            });
        } catch (error) {
            // Transient socket/TLS failures are as recoverable as a 503 here.
            say(`   network error: ${error && error.message ? error.message : error}`);
            if (attempt < retries) {
                say(`   retrying in ${Math.round(retryDelay / 1000)}s`);
                await sleep(retryDelay);
                retryDelay = Math.min(Math.round(retryDelay * 1.5), 15000);
                continue;
            }
            throw error;
        }

        if (attempt === 1) show(candidate);
        const status = candidate.payload ? candidate.payload.status : null;
        say(`-> HTTP ${candidate.httpStatus}${status ? ` (bookwalker status ${status})` : ''}`
            + (routeList.length > 1 ? `  [route ${route}, attempt ${attempt}]`
                : (attempt > 1 ? `  [attempt ${attempt}/${retries}]` : '')));

        if (candidate.payload && status === '200') {
            session = candidate;
            break;
        }
        last = candidate;
        if (!candidate.payload) break;

        // A different route is a genuinely different attempt, so take the next one
        // rather than replaying the one the server just refused.
        if (attempt < retries && routeList[Math.min(attempt, routeList.length - 1)] !== route) {
            say(`   refused on this route; trying ${routeList[attempt]}`);
            continue;
        }

        if (carrier.supplied) {
            // Dropping SESSION and re-handshaking only helps an anonymous session.
            // With sign-in cookies the handshake mints a session that carries no
            // purchase grant, which turns one 401 into a row of 403s, so stop and
            // say what to do instead.
            const signedIn = /(?:^|;\s*)(?:bwmember|bwlogin|lbwsid|cm_kp_login_account)=/i
                .test(carrier.supplied);
            if (!signedIn && attempt === 1 && /(?:^|;\s*)SESSION=/i.test(carrier.supplied)) {
                carrier.supplied = withoutSession(carrier.supplied);
                carrier.cookie = null;
                say('   the supplied SESSION was refused; re-handshaking with the rest of the cookie');
                continue;
            }
            break;
        }
        if (attempt === 1 && carrier.cookie) {
            // The session this run shared was refused for this title. Leave it for
            // the others and let this one negotiate its own straight away rather
            // than replaying a session the server has just rejected here.
            carrier.cookie = null;
            say('   the shared session was refused; negotiating a fresh one for this title');
            continue;
        }
        if (attempt < retries) {
            say(`   refused; retrying with a fresh session in ${Math.round(retryDelay / 1000)}s`);
            await sleep(retryDelay);
            retryDelay = Math.min(Math.round(retryDelay * 1.5), 15000);
        }
    }
    if (!session) session = last;

    } finally {
        release();
    }

    if (session.payload && session.payload.status === '200' && session.payload.auth_info
        && !flag('--no-cache') && !flag('--no-state')) {
        writeLicence(cid, session.payload, { stateFile: value('--state') });
    }

    if (!carrier.cookie && session.payload && session.payload.status === '200' && session.jar) {
        try { carrier.cookie = session.jar.header() || null; } catch (_) { /* no header */ }
    }

    if (!session.payload) {
        say(`   non-JSON body: ${session.raw ? session.raw.slice(0, 300) : '(none)'}`);
    } else if (session.payload.status === '401') {
        say('   401 = "authorization is invalid or expired, please sign in again."');
        if (carrier.supplied) {
            say('   the cookies you supplied were refused for this title, after binding');
            say('   the session to its cid. So either the session is stale (copy fresh');
            say('   cookies from a signed-in tab) or this account does not own it. A');
            say('   browser session is minted per book, so re-copying while the book you');
            say('   want is open in the reader is the safest form.');
        } else {
            say('   The /c exchange did not happen on a session that carries the free grant.');
        }
    } else if (session.payload.status === '403' && !session.requestUrl.includes('&u1=')) {
        say('   403, and the request carried no u1. /c needs cid + u1 + BID + cr, and u1');
        say('   is HttpOnly and scoped to viewer.bookwalker.jp - copy it from the reader:');
        say('   open the book, then Network -> any viewer.bookwalker.jp request -> right-');
        say('   click -> Copy as cURL, and pass that to --cookie. Or pass --u1 <uuid>.');
    } else if (session.payload.status === '403') {
        const bounced = (session.log || [])
            .some(step => /bounced to the member login/.test(step.step || ''));
        say('   403 = CloudFront refused the licence on every route tried.');
        if (bounced) {
            say('   The cooperation hand-off bounced to member.bookwalker.jp/app/03/login,');
            say('   so the cookie carries no session for the member site - it keeps its own');
            say('   login, separate from the shop. Copy the header from a');
            say('   member.bookwalker.jp request instead: open the book, and in Network take');
            say('   the cooperation request (the first document row) -> Copy as cURL. That');
            say('   one header holds both the member session and the shop cookies.');
        } else {
            say('   For a title you own that means no route matched the browser: pass the');
            say('   URL it opened the book with, --entry "<url>" (first Network request ->');
            say('   Copy URL), or re-copy the cookies with the book open in the reader.');
        }
    } else if (session.payload.status !== '200') {
        say(`   gave up after ${attemptsMade} attempt(s); /browserWebApi/c refused them`);
        say('   (throttling, or a session this title does not accept). Wait a few');
        say('   minutes, or pass a fresh Cookie header from a signed-in tab.');
    } else {
        say(`   url: ${session.payload.url}`);
        say(`   cti: ${session.payload.cti}`);
        say(`   cty: ${session.payload.cty}`);
        if (flag('--verbose')) {
            say(`   auth_info keys: ${Object.keys(session.payload.auth_info || {}).join(', ')}`);
        }
    }

    const payload = session.payload;
    if (flag('--probe-only') || !payload || payload.status !== '200' || !payload.auth_info || !payload.url) {
        if (flag('--json')) {
            process.stdout.write(JSON.stringify({
                cid,
                httpStatus: session.httpStatus,
                bookwalkerStatus: payload && payload.status,
                bid: session.bid,
                cr: session.cr,
                crSource: session.crSource,
                signedIn: Boolean(session.signedIn && session.signedIn.length),
                storedTo: session.storedTo || null,
                cookies: session.cookies,
                requestUrl: session.requestUrl
            }, null, 2) + '\n');
        }
        return payload && payload.status === '200' ? 0 : 1;
    }

    // The mokuro-bridge handoff is opt-in and mirrors the flags the rest of this
    // CLI already uses (--ocr / --bridge / --reuse-session), so a combined script
    // needs no new plumbing.
    const wantOcr = flag('--ocr') && !flag('--no-ocr');
    const bridgeUrl = value('--bridge')
        || process.env.BWDD_BRIDGE_URL
        || process.env.MOKURO_BRIDGE_URL
        || null;
    const reuseExisting = flag('--reuse-session');

    const baseUrl = String(payload.url).replace(/\/*$/, '/');
    const auth = new URLSearchParams();
    for (const key of AUTH_PARAM_KEYS) {
        if (payload.auth_info[key] != null) auth.set(key, String(payload.auth_info[key]));
    }

    // Fetch the manifest ourselves so the encrypted layout is read directly from
    // the authenticated base URL rather than probing quality buckets.
    const manifestUrl = `${baseUrl}configuration_pack.json?${auth.toString()}`;
    say('');
    say(`GET ${manifestUrl.split('?')[0]}`);
    const manifestRes = await fetch(manifestUrl, { headers: { 'User-Agent': USER_AGENT } });
    if (!manifestRes.ok) {
        say(`-> HTTP ${manifestRes.status} (manifest unavailable)`);
        return 1;
    }
    const configBody = await manifestRes.text();
    say(`-> HTTP ${manifestRes.status} (${configBody.length} bytes)`);

    let lastBar = -1;
    const downloadStartedAt = Date.now();
    const outputDir = path.resolve(value('--out') || 'output');
    fs.mkdirSync(outputDir, { recursive: true });
    say('');
    say(`downloading every page -> ${outputDir}`);

    const result = await runPublicTrialJob({
        url,
        session: {
            cid,
            apiHost: 'https://viewer.bookwalker.jp',
            auth: payload.auth_info,
            baseUrl,
            cti: payload.cti || null,
            isTrial: false
        },
        configBody,
        outputDir,
        ocr: wantOcr,
        bridgeUrl,
        reuseExisting,
        pageConcurrency,
        onProgress: (event) => {
            if (quiet) return;
            if (event.type === 'book-total') {
                say(`  title: ${event.title} | pages: ${event.total}`);
            } else if (event.type === 'fetch-lanes') {
                say(`  parallel page fetches: ${event.lanes} (via ${event.ports} bridge lane(s))`);
            } else if (event.type === 'download-progress') {
                if (!bar) return; // parallel titles would interleave bars
                // Redraw only when the bar actually changes, so a piped log is
                // not flooded with one line per page.
                const width = 28;
                const filled = Math.round((event.pageCount / Math.max(1, event.total)) * width);
                if (filled !== lastBar || event.pageCount === event.total) {
                    lastBar = filled;
                    const bar = '#'.repeat(filled) + '-'.repeat(width - filled);
                    process.stdout.write(`\r  [${bar}] ${event.pageCount}/${event.total}`);
                }
            } else if (event.type === 'download-error') {
                process.stdout.write('\r' + ' '.repeat(60) + '\r');
                say(`  page ${event.index} failed: ${event.message}`);
            } else if (event.type === 'bridge-session') {
                say(`  mokuro-bridge session: ${event.sessionId || '(started)'}`);
            } else if (event.type === 'ocr-progress') {
                const done = event.completed != null ? event.completed : event.pageCount;
                if (done != null) process.stdout.write(`\r  OCR ${done}/${event.total || '?'}          `);
            } else if (event.type === 'download-unlicensed') {
                // Manifest entries beyond what this edition licenses; not failures.
            } else if (event.type === 'zip-start') {
                process.stdout.write('\r' + ' '.repeat(60) + '\r');
                say(`  packaging ${event.total} pages...`);
            } else if (event.type === 'zip-complete') {
                say(`  zip: ${event.outputPath}`);
            }
        }
    });

    say('');
    const elapsed = (Date.now() - downloadStartedAt) / 1000;
    const pages = Number(result.total || result.pageCount) || 0;
    say('');
    say(`DONE pages=${pages} in ${elapsed.toFixed(1)}s`
        + (pages && elapsed ? ` (${(pages / elapsed).toFixed(0)} pages/s)` : '')
        + ` zip=${result.outputPath}`);
    if (result.unlicensed) say(`pages beyond this edition (not licensed): ${result.unlicensed}`);
    if (result.failures && result.failures.length) say(`failures: ${result.failures.length}`);
    if (flag('--json')) {
        process.stdout.write(JSON.stringify({
            cid,
            status: result.status,
            pages: result.total || result.pageCount,
            outputPath: result.outputPath,
            failures: result.failures || []
        }, null, 2) + '\n');
    }
    return 0;
}

async function main() {
    const argv = process.argv.slice(2);
    const flag = name => argv.includes(name);
    // Returns undefined (never null) when the flag is absent, so `!== undefined`
    // can distinguish "flag not given" from an explicit `--no-...` null.
    const value = name => {
        const i = argv.indexOf(name);
        return i >= 0 && argv[i + 1] ? argv[i + 1] : undefined;
    };

    const inputs = collectInputs(argv);

    if (flag('--snippet')) {
        // stdout stays exactly the pasteable file, so copying the output cannot
        // pick up any of this guidance.
        process.stdout.write(consoleSnippet());
        if (inputs.length) {
            const titles = inputs.map(input => `'${input}'`).join(' ');
            process.stderr.write(
                '\nPaste the code above into the console of a signed-in bookwalker.jp tab.'
                + '\nThen run the command it copies, adding your titles:'
                + `\n  node cli/free-volume.js ${titles} --cookie "$(pbpaste)"`
                + '\n(Purchased titles also need the HttpOnly u1 cookie, so if a 403 comes'
                + '\n back, take the header from Network -> Copy as cURL instead.)\n\n'
            );
        }
        return 0;
    }

    if (!inputs.length || flag('--help')) {
        process.stdout.write(USAGE);
        return inputs.length ? 0 : 2;
    }

    const quiet = flag('--json');
    const say = (...a) => { if (!quiet) process.stdout.write(a.join(' ') + '\n'); };
    const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

    // --cookie accepts a pasted header, a cURL command, a file or stdin. Read it
    // once here so a multi-title batch cannot consume stdin twice.
    // Every --cookie is honoured, not just the first: an owned title needs the
    // viewer's cookies and the member site's session together.
    const cookieArgs = argv.reduce((acc, arg, i) => {
        if (arg === '--cookie' && argv[i + 1] !== undefined) acc.push(argv[i + 1]);
        return acc;
    }, []);
    let supplied = null;
    if (cookieArgs.length) {
        try {
            supplied = mergeCookies(cookieArgs.map(readCookieArgument));
        } catch (error) {
            process.stderr.write(`Could not read --cookie: ${error && error.message ? error.message : error}\n`);
            return 2;
        }
        if (!supplied) {
            const sources = cookieArgs
                .map(arg => (arg.startsWith('@') ? arg : '(inline text)'))
                .join(', ');
            process.stderr.write(`--cookie did not contain a usable name=value pair (from ${sources})\n`);
            return 2;
        }
    }
    if (!supplied && value('--session')) supplied = `SESSION=${String(value('--session')).trim()}`;
    if (supplied) {
        const names = supplied.split(';').map(pair => pair.split('=')[0].trim()).filter(Boolean);
        say(`session: ${names.length} cookie(s) supplied`
            + (flag('--verbose') ? `: ${names.join(', ')}` : ''));
        const signedInCookie = names.some(name => SIGNED_IN_COOKIE.test(name));
        const hasU1 = names.includes('u1');
        const hasMember = names.includes('JSESSIONID');
        if (signedInCookie && hasU1 && hasMember) {
            say('  signed in: u1 and a member.bookwalker.jp session are both present');
        } else if (signedInCookie && !hasU1) {
            say('  signed in, but u1 is MISSING. /c wants cid + u1 + BID + cr, and u1 is');
            say('  HttpOnly AND only ever sent to viewer.bookwalker.jp, so neither a console');
            say('  paste nor a shop-page request can carry it. Open the book in the reader,');
            say('  then Network -> any viewer.bookwalker.jp request -> Copy as cURL. Free');
            say('  samples work without it; a purchased title answers 403.');
        } else if (signedInCookie && !hasMember) {
            say('  signed in, but there is no JSESSIONID: member.bookwalker.jp keeps its own');
            say('  login, separate from the shop, and without it the cooperation hand-off -');
            say('  the route that grants a title you own - lands on its login form. Copy the');
            say('  header from a member.bookwalker.jp request instead (the cooperation row');
            say('  when the book opens); that one carries the member session and the shop');
            say('  cookies together.');
        } else {
            say('  no sign-in cookie found; only public samples will be reachable');
        }
    } else {
        say('anonymous: no session supplied, no browser involved');
    }

    // How many titles may negotiate a licence at the same time. The old client
    // serialized this because /c refused concurrent callers; with the real cr it
    // does not, so a small width is enough to stay polite.
    const licenceSlots = Math.max(1, Math.min(Number(value('--licence-concurrency')) || 4, 16));

    // Shared across the whole run. The first title to establish a session hands
    // its cookies to every later title, so the handshake happens once.
    const carrier = { supplied, cookie: null, acquire: makeSemaphore(licenceSlots) };

    // Titles run concurrently; pages within a title also run concurrently, so
    // the page budget is split between them rather than multiplied.
    const titles = Math.max(1, Math.min(
        Number(value('--titles')) || (inputs.length > 1 ? 3 : 1),
        inputs.length
    ));
    const totalPages = Math.max(4, Number(value('--concurrency')) || 128);
    const perTitle = Math.max(4, Math.round(totalPages / titles));
    if (inputs.length > 1) {
        say(`batch: ${inputs.length} title(s), ${titles} at a time, ${perTitle} fetches each,`
            + ` ${licenceSlots} negotiating at once`);
    }

    const queue = inputs.map((input, index) => ({ input, index }));
    const codes = new Array(inputs.length).fill(0);

    await Promise.all(Array.from({ length: Math.min(titles, queue.length) }, async () => {
        while (queue.length) {
            const job = queue.shift();
            if (inputs.length > 1) say(`\n=== [${job.index + 1}/${inputs.length}] ${job.input} ===`);
            try {
                codes[job.index] = await downloadOne(job.input, {
                    flag, value, say, sleep, quiet, carrier,
                    bar: titles === 1,
                    pageConcurrency: perTitle
                });
            } catch (error) {
                // One bad title must not abandon the rest of the batch.
                say(`  failed: ${error && error.message ? error.message : error}`);
                codes[job.index] = 1;
            }
        }
    }));

    const worst = Math.max(0, ...codes);
    if (inputs.length > 1) say(`\nbatch: ${inputs.length} title(s) processed`);
    return worst;
}

module.exports = {
    USAGE,
    openFreeSession,
    openTrialSession,
    trialManifestRelPaths,
    resolveCid,
    CookieJar,
    extractCrFromLoader,
    contentCheckUrl,
    mergeCookies,
    normalizeCookieHeader,
    readCookieArgument,
    consoleSnippet,
    withoutSession
};

if (require.main === module) {
    main().then(code => { process.exitCode = code; }).catch(error => {
        process.stderr.write(`Fatal: ${error && error.stack ? error.stack : error}\n`);
        process.exitCode = 1;
    });
}
