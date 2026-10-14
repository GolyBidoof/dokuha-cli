
import fsp from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';

import { USER_AGENT } from '../user-agent.js';
import { timed } from '../phase-timer.js';
import { RETRY_STATUS, RESTRICTED_STATUS, defaultBackoff as backoff, describeError, retry } from '../retry.js';
import { writeFailureLog } from '../failure-log.js';
import { volumeFolder, writeVolumeMarker } from './volume-folder.js';
import { existingVolume } from './existing-volume.js';
import { adoptLegacyPage, isCompleteImageFile, legacyPageNames, pageFileName, stampPageTimes } from './page-files.js';
import {
    KINDLE_MAX_WINDOWS,
    KINDLE_ORIGIN,
    KINDLE_RENDER_BATCH_MAX,
    KINDLE_RENDER_BATCH_MIN,
    KINDLE_STORE_ORIGIN,
    kindleBorrowPayload,
    kindleBorrowResult,
    kindleContentType,
    kindleDecodePage,
    kindleGraphQLError,
    kindleIsVolumeInfo,
    kindleLibraryCursor,
    kindleLibraryQuery,
    kindleLoansFromLibrary,
    kindleManifestResources,
    kindlePageKey,
    kindleParseBookInfo,
    kindleReadTar,
    kindleReaderApiToken,
    kindleRenderUrl,
    kindleResourceUrl,
    kindleReturnMutation,
    kindleSeriesDescriptor,
    kindleTokenOf,
    kindleUnlimitedOffer,
    kindleWindowAtEnd,
    kindleWindowMeta,
    kindleWindowPages,
    kindleWindowViewCount,
} from './kindle-protocol.js';

const require = createRequire(import.meta.url);
let cookieReader = null;
function loadCookieReader() {
    if (!cookieReader) {
        const freeVolume = require('../../vendor/bookwalker/free-volume.js');
        cookieReader = { readCookieArgument: freeVolume.readCookieArgument, mergeCookies: freeVolume.mergeCookies };
    }
    return cookieReader;
}

const DEFAULT_CONCURRENCY = 12;
const MAX_CONCURRENCY = 32;
const FETCH_TIMEOUT_MS = 45_000;

const FETCH_TIMEOUT_STEP_MS = 30_000;

const MAX_SERIES_VOLUMES = 200;

const KINDLE_MAX_OPEN_LOANS = 6;

const KINDLE_RETURN_SETTLE_MS = 200;

const KINDLE_RETURN_BATCH_MAX = 8;

const KINDLE_TRANSIENT_REFUSAL = new Set(['KLU_CONCURRENT_LIMIT_REACHED']);

const KINDLE_BORROW_URL = `${KINDLE_STORE_ORIGIN}/kindle-dbs/hz/ajax/returnAndBorrow?ref=dbs_p_ebk_r00_pbcb_cvbru0`;

const KINDLE_READER_API_URL = `${KINDLE_STORE_ORIGIN}/kindle-reader-api`;

const KINDLE_LIBRARY_URL = `${KINDLE_STORE_ORIGIN}/your-books`;

function defaultStateFile() {
    const home = process.env.HOME || process.env.USERPROFILE || '.';
    return path.join(home, '.bwdd-cli', 'kindle-session.json');
}

function stateFilePath(config) {
    if (config?.kindleNoState) return null;
    if (config?.kindleState) return path.resolve(config.kindleState);
    return defaultStateFile();
}

export async function loadKindleSession(config = {}) {
    const file = stateFilePath(config);
    const supplied = Array.isArray(config.kindleCookies) ? config.kindleCookies : [];
    if (supplied.length) {
        const { mergeCookies, readCookieArgument } = loadCookieReader();
        const cookie = mergeCookies(supplied.map((argument) => readCookieArgument(argument)));
        if (!cookie) throw new Error('--kindle-cookie was given, but no usable name=value pair was found in it');
        if (file) await saveKindleSession(file, cookie).catch(() => {});
        return { cookie, source: 'argument', stateFile: file };
    }
    if (file) {
        const saved = await fsp.readFile(file, 'utf8').catch(() => null);
        if (saved) {
            try {
                const parsed = JSON.parse(saved);
                const cookie = String(parsed?.cookie || '').trim();
                if (cookie) return { cookie, source: 'state', stateFile: file };
            } catch {

            }
        }
    }
    return { cookie: '', source: 'none', stateFile: file };
}

export async function saveKindleSession(file, cookie) {
    await fsp.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    await fsp.writeFile(file, `${JSON.stringify({ cookie, savedAt: new Date().toISOString() }, null, 2)}\n`, { mode: 0o600 });
    await fsp.chmod(file, 0o600).catch(() => {});
}

/** Shown once when no session is present at all, and in `--help` terms. */
export const KINDLE_COOKIE_HELP = [
    'Kindle has no anonymous route: every Amazon volume needs your read.amazon.co.jp cookies.',
    '  1. Sign in at https://read.amazon.co.jp/manga/ in your normal browser.',
    '  2. Open DevTools (F12) -> Network, click any request to read.amazon.co.jp,',
    '     right-click it -> Copy -> Copy as cURL.',
    '  3. Paste that into the flag:  dokuha ... --kindle-cookie "$(pbpaste)"',
    '  Only read.amazon.co.jp, and only the Japan store, is spoken to.',
].join('\n');

export function kindleSessionHint(session) {
    if (session?.source === 'argument') {
        return 'The cookies you passed may have expired. Sign in at read.amazon.co.jp again and copy fresh ones.';
    }
    if (session?.source === 'state') {
        return `The saved session at ${session.stateFile} may have expired. `
            + 'Pass fresh cookies with --kindle-cookie, or remove that file to start over.';
    }
    return 'Pass your read.amazon.co.jp cookies with --kindle-cookie (see docs/auth.md).';
}

/**
 * Amazon rotates `at-acbjp` and `sess-at-acbjp` and reports the replacements in
 * `Set-Cookie`. A client that ignores them keeps sending a value the server has
 * already retired, which comes back as Unauthorized on the library query even
 * though the sign-in itself is fine. Absorb the new values and persist them.
 */
function absorbKindleCookies(session, response) {
    if (!session || !response?.headers) return;
    let lines = [];
    try {
        lines = typeof response.headers.getSetCookie === 'function'
            ? response.headers.getSetCookie()
            : [response.headers.get('set-cookie')].filter(Boolean);
    } catch {
        return;
    }
    if (!lines.length) return;
    const jar = new Map();
    for (const part of String(session.cookie || '').split(';')) {
        const at = part.indexOf('=');
        if (at > 0) jar.set(part.slice(0, at).trim(), part.slice(at + 1).trim());
    }
    let changed = false;
    for (const line of lines) {
        const pair = String(line).split(';')[0];
        const at = pair.indexOf('=');
        if (at <= 0) continue;
        const name = pair.slice(0, at).trim();
        const value = pair.slice(at + 1).trim();
        if (!value || jar.get(name) === value) continue;
        jar.set(name, value);
        changed = true;
    }
    if (!changed) return;
    session.cookie = [...jar].map(([key, value]) => `${key}=${value}`).join('; ');
    if (session.stateFile) saveKindleSession(session.stateFile, session.cookie).catch(() => {});
}

async function kindleFetch(url, session, extraHeaders = {}, { method = 'GET', body, attempts = 3 } = {}) {
    const tries = method === 'GET' ? Math.max(1, attempts) : 1;
    try {
        const response = await retry(() => fetch(url, {
            method,
            redirect: 'follow',
            ...(body === undefined ? {} : { body }),
            signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
            headers: {
                'User-Agent': USER_AGENT,
                'Accept-Language': 'ja-JP,ja;q=0.9,en-US;q=0.8',
                'Accept': '*/*',
                ...(session?.cookie ? { Cookie: session.cookie } : {}),
                'Referer': `${KINDLE_ORIGIN}/`,
                ...extraHeaders,
            },
        }), { attempts: tries, wait: backoff });
        absorbKindleCookies(session, response);
        return response;
    } catch (error) {
        throw new Error(`the Kindle reader did not answer ${new URL(url).pathname} (${describeError(error)})`);
    }
}

/**
 * The collection ASIN that groups a series, read from the Kindle product page.
 *
 * The series list endpoint requires it, and it cannot be derived from the volume ASIN:
 * it is a distinct value the page carries in the markup of its follow/collection widget.
 * A page without the widget has no collection, and the caller then falls back to the
 * volume ASIN, which is what the captured request used for a single-edition series.
 */
async function kindleProductCollection(asin, session) {
    const response = await kindleFetch(
        `${KINDLE_STORE_ORIGIN}/kindle-dbs/product/${encodeURIComponent(asin)}`,
        session,
        { Accept: 'text/html,*/*', Referer: `${KINDLE_STORE_ORIGIN}/dp/${asin}` },
    ).catch(() => null);
    if (!response?.ok) return null;
    const html = await response.text();
    const match = /data-asin="([A-Z0-9]{10})"\s+data-entity-type="collection"/.exec(html);
    return match ? match[1] : null;
}

/**
 * The collection ASIN that groups a series.
 *
 * The Kindle product page carries it in the markup of its follow widget, but that page
 * does not exist for every volume: a Kindle Unlimited only title answers 404, and the
 * series list endpoint cannot be called without a collection. The store page for the same
 * volume does exist and lists related ASINs, and at least one of them is a volume whose
 * Kindle page is served and carries the same collection. So a missing page is hopped
 * around rather than treated as a series with no volumes.
 */
export async function kindleCollectionAsin(asin, session) {
    const direct = await kindleProductCollection(asin, session);
    if (direct) return { collection: direct, via: asin };
    const page = await kindleFetch(`${KINDLE_STORE_ORIGIN}/dp/${encodeURIComponent(asin)}`, session, {
        Accept: 'text/html',
        Referer: `${KINDLE_STORE_ORIGIN}/`,
    }).catch(() => null);
    if (!page?.ok) return null;
    const html = await page.text();
    const related = [...new Set(html.match(/\bB0[0-9A-Z]{8}\b/g) || [])].filter((id) => id !== asin);
    // Tried together, not in turn. Each candidate is a page fetch, and walking them one
    // at a time cost several seconds before the first title could be listed.
    const candidates = related.slice(0, 12);
    // Taken as they arrive rather than after all of them: the first candidate whose page
    // is served has the collection, and waiting for the slowest of twelve wasted the
    // seconds before any title could be listed.
    try {
        return await Promise.any(candidates.map(async (id) => {
            const collection = await kindleProductCollection(id, session);
            if (!collection) throw new Error('that volume has no collection');
            return { collection, via: id };
        }));
    } catch {
        return null;
    }
}

/**
 * Every volume of a series in one request.
 *
 * The store's seriesAsinList endpoint takes a page size, and 100 covers a full series:
 * a 72-volume series answers with 74 ids in a single 1.2 MB fragment. That replaces the
 * walk, which needed one reader round trip per volume because each answer named the next
 * volume. The fragment is markup rather than JSON, so the ids are read out of it, and
 * the caller treats an empty or unusable answer as "no list" rather than as an empty
 * series.
 */
export async function kindleSeriesVolumeList(asin, session) {
    const found = await kindleCollectionAsin(asin, session).catch(() => null);
    const params = new URLSearchParams({
        // The list endpoint wants a volume whose Kindle page is served, and for a
        // Kindle Unlimited only title that is not the volume the user pasted, so the
        // one that carried the collection is used instead.
        asin: found?.via || asin,
        pageNumber: '1',
        pageSize: '100',
        binding: 'kindle_edition',
        includePagination: 'true',
        ...(found?.collection ? { substituteCollectionAsin: found.collection } : {}),
    });
    const response = await kindleFetch(
        `${KINDLE_STORE_ORIGIN}/kindle-dbs/productPage/ajax/seriesAsinList?${params}`,
        session,
        {
            Accept: 'text/html,*/*',
            'x-requested-with': 'XMLHttpRequest',
            Referer: `${KINDLE_STORE_ORIGIN}/kindle-dbs/product/${asin}`,
        },
    );
    if (!response.ok) return null;
    const html = await response.text();
    const ids = [...new Set(html.match(/\bB0[0-9A-Z]{8}\b/g) || [])];
    return ids.length ? ids : null;
}

export async function kindleSeriesInfo(asin, session) {
    if (!asin) return null;
    try {
        const response = await kindleFetch(
            `${KINDLE_ORIGIN}/api/manga/get-series-data/${encodeURIComponent(asin)}`,
            session,
            { Referer: `${KINDLE_ORIGIN}/`, 'x-requested-with': 'XMLHttpRequest' },
        );
        if (!response.ok) return null;
        const payload = JSON.parse(await response.text());
        const entry = Array.isArray(payload) ? payload[0] : payload;
        return entry && entry.asin ? entry : null;
    } catch {
        return null;
    }
}

export async function kindleSampleInfo(asin, session) {
    const id = String(asin || '').toUpperCase();
    if (!/^B0[0-9A-Z]{8}$/.test(id) || !session?.cookie) return null;
    try {
        const response = await kindleFetch(`${KINDLE_ORIGIN}/manga/${id}?sample=1`, session);
        if (!response.ok) return null;
        const info = kindleParseBookInfo(await response.text());
        return info && kindleIsVolumeInfo(info) ? info : null;
    } catch {
        return null;
    }
}

export async function openKindleVolume(asin, session, { sample = false } = {}) {
    const id = String(asin || '').toUpperCase();
    if (!/^B0[0-9A-Z]{8}$/.test(id)) throw new Error(`"${asin}" is not a Kindle ASIN`);

    if (!session?.cookie) {
        throw new Error(`a signed-in session is required to open ${id}.\n  ${kindleSessionHint(session)}`);
    }

    const readPage = async (query) => {
        const response = await kindleFetch(`${KINDLE_ORIGIN}/manga/${id}${query}`, session);
        const body = await response.text();
        if (!response.ok) {
            const hint = response.status === 401 || response.status === 403 || response.status === 404
                ? `\n  ${kindleSessionHint(session)}`
                : '';
            throw new Error(`the Kindle reader answered HTTP ${response.status} for ${id}${hint}`);
        }
        return kindleParseBookInfo(body);
    };

    let info;
    const sampled = sample;
    if (sample) {

        info = await readPage('?sample=1');
    } else {

        info = await readPage('');
    }
    if (!info) {
        throw new Error(`the Kindle reader served no book information for ${id}. `
            + 'That page is not a Kindle manga volume — a physical book, an audiobook and a '
            + `different marketplace all look like this from here.\n  ${kindleSessionHint(session)}`);
    }

    if (!kindleIsVolumeInfo(info)) {

        const series = await kindleSeriesInfo(id, session);
        if (kindleSeriesDescriptor(series)) {
            throw new Error(`"${series.title || info.title || id}" is a Kindle series page, not a `
                + 'volume, so there is nothing to render. Paste one of its volume URLs instead '
                + '(on a volume page, `…/dp/<ASIN>`, the ASIN is the one that is not the series), '
                + 'and add --series to walk the whole series from it.');
        }
        const noToken = new Error(`the Kindle reader published no reading token for ${id} `
            + `("${String(info.title || '').slice(0, 60)}"). Either this account cannot open that `
            + 'volume — it may be region-locked, withdrawn, or a sample that has ended — or it is '
            + `not a manga volume at all.\n  ${kindleSessionHint(session)}`);

        noToken.code = 'KINDLE_NO_TOKEN';

        noToken.info = {
            asin: String(info.asin || id).toUpperCase(),
            title: String(info.title || ''),
            seriesAsin: String(info.seriesAsin || ''),
            accessMethod: String(info.bookAccessMethod || ''),
        };
        throw noToken;
    }

    const { token, expiresAt } = kindleTokenOf(info);
    const accessMethod = String(info.bookAccessMethod || '');
    return {
        asin: String(info.asin || id).toUpperCase(),
        revision: String(info.contentGuid),
        title: String(info.title || ''),
        seriesAsin: String(info.seriesAsin || ''),
        author: String(info.sellerOfRecord || ''),
        accessMethod,
        isSample: sampled || info.isSample === true || /^SAMPLE$/i.test(accessMethod),

        sample: sampled,
        isFree: kindleIsFree(info),
        contentType: kindleContentType(info),
        token,
        expiresAt,
        prefetch: String(info.cdnPrefetchInfo || ''),

        startPosition: 1,
        batch: 0,
    };
}

export function kindleIsFree(info) {

    const method = String(info?.bookAccessMethod || info?.accessMethod || '');
    if (/^SAMPLE$/i.test(method)) return false;
    if (/LIMITED_TIME_FREE|FREE_TRIAL|FREE_READ/i.test(method)) return true;
    return info?.isLimitedFreeTrialReadNow === true || info?.isFree === true;
}

export function kindleIsReadable(info) {
    if (kindleIsFree(info)) return true;
    const method = String(info?.bookAccessMethod || info?.accessMethod || '');
    return /^FULL_BOOK$/i.test(method);
}

/**
 * One volume's access state, without opening its reader page.
 *
 * The walk got this for the next volume as a side effect of asking for it, which is why
 * it needed one round trip per volume. Asked directly, the same endpoint reports the
 * volume's own state: FULL_BOOK when the account can read it, SAMPLE when it cannot, and
 * 204 when there is nothing to say. That is cheap enough to run for every volume of a
 * series at once, and it does not throw for volumes this account cannot open.
 */
export async function kindleVolumeAccess(asin, session) {
    const url = `${KINDLE_ORIGIN}/api/manga/open-book?asin=${encodeURIComponent(asin)}`;
    const response = await kindleFetch(url, session, {
        Referer: `${KINDLE_ORIGIN}/manga/${asin}`,
        'x-requested-with': 'XMLHttpRequest',
    });
    if (response.status === 204 || response.status === 404) return null;
    if (!response.ok) return null;
    let payload;
    try {
        payload = JSON.parse(await response.text());
    } catch {
        return null;
    }
    const method = String(payload?.bookAccessMethod || '');
    return {
        asin,
        title: '',
        accessMethod: method,
        bookAccessMethod: method,
        isFree: kindleIsFree(payload),
        revision: revisionFromPrefetch(payload.cdnPrefetchInfo),
    };
}

export function revisionFromPrefetch(prefetch) {
    try {
        const parsed = typeof prefetch === 'string' ? JSON.parse(prefetch) : prefetch;
        const base = String(parsed?.cdn?.baseUrl || '');
        const segments = base.split('/').filter(Boolean);

        const revision = segments.length >= 2 ? segments[segments.length - 2] : '';
        return /^[0-9a-f]{6,}$/i.test(revision) ? revision : '';
    } catch {
        return '';
    }
}

export async function kindleSeriesSize(seriesAsin, session) {
    if (!seriesAsin) return 0;
    try {
        const response = await kindleFetch(
            `${KINDLE_ORIGIN}/api/manga/get-series-data/${encodeURIComponent(seriesAsin)}`,
            session,
            { Referer: `${KINDLE_ORIGIN}/`, 'x-requested-with': 'XMLHttpRequest' },
        );
        if (!response.ok) return 0;
        const payload = JSON.parse(await response.text());
        const entry = Array.isArray(payload) ? payload[0] : payload;
        return Number(entry?.seriesSize) || 0;
    } catch {
        return 0;
    }
}

function windowDescriptors(files) {
    return kindleManifestResources(files).map((resource) => ({ ...resource }));
}

export async function kindleVolumeOffer(asin, session) {
    const id = String(asin || '').toUpperCase();
    if (!/^B0[0-9A-Z]{8}$/.test(id)) return null;
    try {
        const response = await kindleFetch(`${KINDLE_STORE_ORIGIN}/dp/${id}`, session, {
            Referer: `${KINDLE_STORE_ORIGIN}/`,
        });
        if (!response.ok) return null;
        return kindleUnlimitedOffer(await response.text());
    } catch {
        return null;
    }
}

export async function kindleBorrow(asin, offer, session) {
    const id = String(asin || '').toUpperCase();
    const response = await kindleFetch(KINDLE_BORROW_URL, session, {
        'Accept': 'application/json, text/javascript, */*; q=0.01',
        'Content-Type': 'application/json',
        'x-csrftoken': String(offer?.csrfToken || ''),
        Referer: `${KINDLE_STORE_ORIGIN}/dp/${id}`,
    }, { method: 'POST', body: kindleBorrowPayload(id, offer) });

    const body = await response.text();
    if (!response.ok) {
        const error = new Error(`the Kindle borrow service answered HTTP ${response.status}`
            + `${body ? ` — ${body.slice(0, 200)}` : ''}`);
        error.status = response.status;
        throw error;
    }
    return kindleBorrowResult(body);
}

async function kindleReaderToken(session, { force = false } = {}) {
    if (!force && session?.kindleReaderToken) return session.kindleReaderToken;
    const response = await kindleFetch(KINDLE_LIBRARY_URL, session, { Referer: `${KINDLE_ORIGIN}/` });
    if (!response.ok) {
        throw new Error(`the Kindle library page answered HTTP ${response.status}`
            + `\n  ${kindleSessionHint(session)}`);
    }
    const token = kindleReaderApiToken(await response.text());
    if (!token) {
        throw new Error('the Kindle library page carried no anti-csrftoken-a2z token, '
            + `so the library cannot be read.\n  ${kindleSessionHint(session)}`);
    }
    if (session) session.kindleReaderToken = token;
    return token;
}

async function kindleReaderApi(session, body, { force = false } = {}) {
    let token = await kindleReaderToken(session, { force });
    for (let attempt = 0; ; attempt += 1) {
        const response = await kindleFetch(KINDLE_READER_API_URL, session, {
            'Accept': '*/*',
            'Content-Type': 'application/json',
            'anti-csrftoken-a2z': token,
            // The store host validates the anti-CSRF token against the request's
            // origin, so this call has to look like the site's own: the same Origin
            // and a /your-books referer. Without Origin the library query answers
            // Unauthorized in the GraphQL body, while the borrow calls keep working
            // because those are expected from the reader host instead.
            'Origin': KINDLE_STORE_ORIGIN,
            Referer: KINDLE_LIBRARY_URL,
        }, { method: 'POST', body: JSON.stringify(body) });

        const text = await response.text();
        // A rejected token can arrive as HTTP 200 with an Unauthorized error in the
        // GraphQL body, which the status check alone never notices: the query then
        // reads as an empty library rather than as unauthenticated, and every return
        // reports that the library does not list the loan. Treat it like a CSRF
        // refusal, so the token is refreshed once and the call is retried.
        const unauthorized = /unauthorized/i.test(text);
        const refused = response.status === 403 || /csrf/i.test(text) || unauthorized;
        if (response.ok && !refused) return text;
        if (attempt >= 1 || !refused) {
            if (unauthorized) {
                // The stored session can still render pages, which is why the token
                // scrapes fine, but Amazon rejects the library query itself. That is a
                // stale or superseded sign-in rather than a book missing from the
                // library, and naming it is the difference between a five second fix
                // and a day spent changing request headers that were already correct.
                const error = new Error('Amazon rejected the Kindle library query as Unauthorized: '
                    + 'the stored session is stale or has been superseded by a newer sign-in. '
                    + 'Copy the cookies again from a signed-in browser and re-run with --kindle-cookie.'
                    + `\n  ${kindleSessionHint(session)}`);
                error.code = 'KINDLE_SESSION_EXPIRED';
                error.status = response.status;
                throw error;
            }
            const error = new Error(`the Kindle reader API answered HTTP ${response.status}`
                + `${text ? ` — ${text.slice(0, 200)}` : ''}`);
            error.status = response.status;
            throw error;
        }
        token = await kindleReaderToken(session, { force: true });
    }
}

export async function kindleLibraryLoans(session, { force = false } = {}) {
    const loans = new Map();
    let after = '';
    // The library is paginated at thirty a page, so reading one page leaves every
    // loan past the first thirty looking absent, which is exactly the shape of the
    // "the library does not list it" report. Follow the cursor, capped so a cursor
    // that never advances cannot spin forever.
    for (let page = 0; page < 20; page += 1) {
        const text = await kindleReaderApi(session, kindleLibraryQuery(after), { force });
        const rejected = kindleGraphQLError(text);
        if (rejected) {
            throw new Error(`the Kindle library query was rejected: ${rejected}`);
        }
        for (const loan of kindleLoansFromLibrary(text)) {
            // `activeBorrow` is the field that says whether a loan is still out: a
            // borrow the CLI is about to return reads true, and one that has already
            // gone back reads false while staying in the listing. Requiring it keeps
            // the lookup to loans that are genuinely returnable, and the retry loop
            // covers the moment right after a borrow when the listing has not caught
            // up yet. Ignoring it would attempt returns for loans that are already
            // back, and the service answers those with a refusal the run treats as
            // fatal, so a re-run would fail a volume that had nothing left to return.
            if (loan.active && loan.unlimited) loans.set(loan.asin, loan.loanId);
        }
        const cursor = kindleLibraryCursor(text);
        if (!cursor || cursor === after) break;
        after = cursor;
    }
    return loans;
}

export async function kindleReturnLoans(items, session) {
    const batch = (Array.isArray(items) ? items : []).filter((item) => item && item.asin && item.loanId);
    if (!batch.length) return true;
    const text = await kindleReaderApi(session, kindleReturnMutation(batch));
    const rejected = kindleGraphQLError(text);
    if (rejected) {
        throw new Error(`the Kindle return was rejected: ${rejected}`);
    }
    let payload = null;
    try {
        payload = JSON.parse(text);
    } catch {
        return false;
    }
    return payload?.data?.mycdBulkReturnBorrow?.success === true;
}

async function fetchWindow(state, session, { skip, numPage }) {
    const url = kindleRenderUrl({
        asin: state.asin,
        revision: state.revision,
        contentType: state.contentType,
        numPage,
        skipPageCount: skip,
        startPosition: state.startPosition,
    });
    const response = await kindleFetch(url, session, {
        Referer: `${KINDLE_ORIGIN}/manga/${state.asin}`,
        'x-amz-rendering-token': state.token || '',
    });
    if (response.ok) {
        const buffer = Buffer.from(await response.arrayBuffer());
        return kindleReadTar(buffer);
    }
    const body = await response.text().catch(() => '');
    const error = new Error(`the Kindle render service answered HTTP ${response.status}`
        + `${body ? ` — ${body.slice(0, 200)}` : ''}`);
    error.status = response.status;
    error.body = body;
    throw error;
}

/**
 * How many windows ahead the walk may have in flight.
 *
 * Each window is one request, and a 244-page volume needs twenty-one of them at the
 * six views the CDN allows. Issued one at a time that is twenty-one round trips
 * end to end, which is where Kindle's handshake time goes.
 *
 * A live sweep over one 220-page volume (nineteen windows, `scripts/probes/probe-kindle.mjs`)
 * shows the walk is pure latency and divides almost exactly by the depth, with a knee
 * at eight:
 *
 *   depth    3      6      8      9     12
 *   walk   7.42s  4.08s  4.06s  3.61s  3.33s
 *
 * Past eight the gain is under 20 % while each extra step abandons one more
 * speculative request when the walk reaches the end (measured unawaited windows:
 * two at depth 3, seven at depth 8, eleven at depth 12), so eight is where the
 * round trips stop being worth it. A wrong prediction still costs a request and
 * never a page: the cursor consumes a speculative reply only when the offset it was
 * asked for is the offset the cursor wants.
 */
const KINDLE_PREFETCH_DEPTH = 8;

async function fetchWindowOrShrink(state, session, skip, startBatch) {
    let size = Math.max(KINDLE_RENDER_BATCH_MIN, Number(startBatch) || KINDLE_RENDER_BATCH_MIN);
    let flipped = false;
    for (;;) {
        try {
            const files = await fetchWindow(state, session, { skip, numPage: size });
            state.batch = size;
            return { files, batch: size };
        } catch (error) {
            if (error?.status === 400 && !flipped && /rendering token is not matching/i.test(error.body || '')) {
                flipped = true;
                state.contentType = state.contentType === 'Sample' ? 'FullBook' : 'Sample';
                continue;
            }
            if (error?.status === 400 && size > KINDLE_RENDER_BATCH_MIN) {
                size = Math.max(KINDLE_RENDER_BATCH_MIN, size >> 1);
                continue;
            }
            throw error;
        }
    }
}

export async function walkKindleWindows(state, session, onWindow) {
    if (state.startPosition === undefined) state.startPosition = 1;
    let batch = state.batch || KINDLE_RENDER_BATCH_MAX;
    let skip = 0;
    let windows = 0;

    // Windows already being fetched, keyed by the offset they were asked for.
    //
    // The walk is a cursor whose stride is the view count of the window it just
    // read, so in general the next offset is not known until the previous reply
    // lands. In practice it is: across every window of a 244-page volume the view
    // count came back equal to the requested batch, so `skip + k * batch` predicts
    // the next windows exactly. Speculating on that prediction turns twenty-one
    // serial round trips into about a third as many.
    //
    // A wrong prediction is harmless as long as it is never trusted: the loop still
    // walks its own cursor and consumes a speculative reply only when the offset it
    // was asked for is the offset the cursor wants. The speculative calls run against
    // a copy of `state`, because `fetchWindowOrShrink` shrinks the batch and may flip
    // the content type, and a discarded request must not leave those changes behind
    // for the real walk to inherit.
    const inFlight = new Map();
    const speculate = (at, size) => {
        if (inFlight.has(at)) return;
        const promise = fetchWindowOrShrink({ ...state }, session, at, size);
        // If the walk ends, or a prediction misses, this is never awaited; an
        // unhandled rejection must not take the process down.
        promise.catch(() => {});
        inFlight.set(at, promise);
    };
    let pageCount = 0;
    let lastPositionId = 0;
    let title = state.title;
    let direction = '';

    while (windows < KINDLE_MAX_WINDOWS) {
        const speculative = inFlight.get(skip);
        if (speculative) inFlight.delete(skip);
        let got;
        try {
            got = speculative ? await speculative : await fetchWindowOrShrink(state, session, skip, batch);
        } catch (error) {
            // A prediction that failed is not a failure of the walk: the cursor has
            // not moved, so ask for this offset properly and keep the real errors.
            if (!speculative) throw error;
            got = await fetchWindowOrShrink(state, session, skip, batch);
        }
        const files = got.files;
        batch = got.batch;
        windows += 1;

        const meta = kindleWindowMeta(files);
        const pages = kindleWindowPages(files);
        const views = kindleWindowViewCount(files);
        if (meta.lastPositionId) lastPositionId = meta.lastPositionId;
        if (meta.pageCount) pageCount = meta.pageCount;
        if (meta.title) title = meta.title;
        if (meta.direction) direction = meta.direction;

        if (!views) {

            if (windows === 1 && state.startPosition != null) {
                state.startPosition = null;
                windows = 0;
                continue;
            }
            break;
        }

        await onWindow({ files, skip, batch, pages, views, meta });
        if (kindleWindowAtEnd(pages, lastPositionId)) break;

        skip += views;

        if (views < batch) batch = Math.max(KINDLE_RENDER_BATCH_MIN, views);

        for (let ahead = 0; ahead < KINDLE_PREFETCH_DEPTH; ahead += 1) {
            speculate(skip + ahead * batch, batch);
        }
    }

    if (windows >= KINDLE_MAX_WINDOWS) {

        throw new Error(`the Kindle render walk did not reach the end of ${state.asin} `
            + `within ${KINDLE_MAX_WINDOWS} windows; the book may be longer than this tool handles`);
    }
    return { windows, pageCount, title, direction, batch };
}

/**
 * The largest render window the CDN has accepted, remembered across volumes.
 *
 * The render service refuses a `numPage` above a book-specific ceiling -- measured
 * live at exactly 6 for the audit title, which answers HTTP 400 to 7 -- and the walk
 * discovers it by halving from `KINDLE_RENDER_BATCH_MAX`, so the first volume pays two
 * refused round trips before it can ask for a real page. The ceiling is a property of
 * the content, not of the volume, so the second volume of a run can start where the
 * first one settled: measured 4.06 s against 2.99 s for the same 220-page walk.
 *
 * A stale guess is safe by construction. A seed that is too large is refused and
 * shrinks exactly as an unseeded walk would; one that is too small returns fewer
 * views per window and the walk simply takes more of them. Neither can lose a page.
 */
function kindleBatchState(ctx) {
    if (!ctx) return { size: 0 };
    if (!ctx.kindleBatch || typeof ctx.kindleBatch !== 'object') ctx.kindleBatch = { size: 0 };
    return ctx.kindleBatch;
}

async function isCompleteJpeg(file) {
    return isCompleteImageFile(file);
}

export async function downloadKindle(task, ctx = {}) {
    const asin = String(task?.asin || task?.target || '').toUpperCase();
    if (!asin) throw new Error('kindle: no ASIN given');
    const out = ctx.out;
    if (!out) throw new Error('kindle: ctx.out is required');

    const session = ctx.kindleSession || await loadKindleSession(ctx.config || {});
    const key = task.key || `kindle:${asin}`;

    const concurrency = Math.max(1, Math.min(MAX_CONCURRENCY,
        Number(ctx.kdlConcurrency ?? ctx.kindleConcurrency) || DEFAULT_CONCURRENCY));
    const attempts = Number.isFinite(Number(ctx.retries)) ? Math.max(0, Number(ctx.retries)) : 4;
    const options = { asin, key, concurrency, attempts };

    let state;
    try {

        state = await timed(ctx.timer, 'handshake', () => openKindleVolume(asin, session, { sample: task.sample === true }));
    } catch (error) {
        if (error?.code !== 'KINDLE_NO_TOKEN') throw error;
        return await borrowAndDownloadKindle(task, ctx, session, error, options);
    }
    const record = await downloadOpenedKindle(state, task, ctx, session, options);

    try {
        if (await returnLeftoverLoan(task, ctx, session, record)) {
            record.returned = true;

            record.unlimited = true;
        }
    } catch (error) {

        record.returnError = error.message;
    }
    return record;
}

async function downloadOpenedKindle(state, task, ctx, session, { asin, key, concurrency, attempts }) {
    const out = ctx.out;
    const batchState = kindleBatchState(ctx);
    // Start the walk where the last volume of this run left off, so the shrink ladder
    // is paid once per run instead of once per volume. `openKindleVolume` deliberately
    // reports `batch: 0`, which is what "not learned yet" looks like.
    if (!state.batch) state.batch = batchState.size || 0;
    const tell = (method, ...args) => {
        if (typeof ctx.progress?.[method] !== 'function') return;
        try {
            ctx.progress[method](...args);
        } catch {

        }
    };

    const title = state.title || task.title || asin;
    const folder = await volumeFolder(ctx, { title, id: asin, sample: task.sample === true });
    const existing = await existingVolume(ctx, {
        store: 'kindle', title, id: asin, sample: task.sample === true,
        expectedPages: state.pageCount || state.expectedPages || 0, folder,
        checkRemote: !task.title,
    });
    if (existing) return existing;
    await fsp.mkdir(folder, { recursive: true });

    tell('update', key, { label: title, phase: 'downloading', done: 0, failed: 0, bytes: 0, total: 0 });

    const timer = ctx.timer || null;

    const queue = [];
    const resources = new Map();
    const waiters = [];
    let walkDone = false;
    let walkError = null;
    let walkResult = null;
    let total = 0;

    const notify = () => { while (waiters.length) waiters.shift()(); };
    const waitForWork = () => new Promise((resolve) => waiters.push(resolve));

    const recordWindow = ({ files, skip, batch, pages, meta }) => {
        for (const descriptor of windowDescriptors(files)) {

            if (!resources.has(descriptor.path)) resources.set(descriptor.path, descriptor);
        }
        for (const page of pages) {
            const resource = resources.get(page.imageReference);
            queue.push({
                index: queue.length + 1,
                ref: page.imageReference,
                resource,
                skip,
                batch,
                sectionId: page.sectionId,
            });
        }
        if (meta.pageCount) total = meta.pageCount;
        tell('update', key, { total });
    };

    const walk = (async () => {
        try {
            // The walk is preparation, not a handshake: the session is already open, and
            // this is the store's render service being asked what the volume contains.
            // It used to be reported as `handshake`, which made Kindle look like it spent
            // 19 s shaking hands when almost all of that was building the page list.
            walkResult = await timed(timer, 'prework', () => walkKindleWindows(state, session, async (window) => {
                recordWindow(window);
                notify();
            }));
            if (walkResult?.batch) batchState.size = walkResult.batch;
        } catch (error) {
            walkError = error;
        } finally {
            walkDone = true;
            notify();
        }
    })();

    const refresh = async (descriptor) => {
        const files = await fetchWindow(state, session, { skip: descriptor.skip, numPage: descriptor.batch });
        for (const fresh of windowDescriptors(files)) resources.set(fresh.path, fresh);
        const updated = resources.get(descriptor.ref);
        return updated && updated.authParameter !== descriptor.resource?.authParameter ? updated : null;
    };

    const fetchPage = async (descriptor) => {
        let resource = descriptor.resource || resources.get(descriptor.ref);
        if (!resource) throw new Error(`the render manifest carried no signature for ${descriptor.ref}`);
        let lastError = null;
        for (let attempt = 0; attempt <= attempts; attempt += 1) {
            const url = kindleResourceUrl({
                baseUrl: resource.baseUrl,
                path: resource.path,
                authParameter: resource.authParameter,
                token: state.token,
                expiresAt: state.expiresAt,
            });
            let response;
            try {
                response = await timed(timer, 'fetch', () => fetch(url, {
                    redirect: 'follow',

                    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS + attempt * FETCH_TIMEOUT_STEP_MS),

                    headers: { 'User-Agent': USER_AGENT, 'Accept': '*/*' },
                }));
            } catch (error) {
                lastError = error;
                if (attempt < attempts) await backoff(attempt);
                continue;
            }
            if (response.ok) {
                const bytes = Buffer.from(await response.arrayBuffer());

                return timed(timer, 'rebuild', () => kindleDecodePage(bytes, {
                    isEncrypted: resource.isEncrypted,
                    token: state.token,
                    expiresAt: state.expiresAt,
                }));
            }
            lastError = new Error(`the Kindle CDN answered HTTP ${response.status} for ${resource.path}`);
            if (RESTRICTED_STATUS.has(response.status)) {
                const fresh = await refresh(descriptor).catch(() => null);
                if (!fresh) break;
                resource = fresh;
                continue;
            }
            if (!RETRY_STATUS.has(response.status)) break;
            if (attempt < attempts) await backoff(attempt);
        }
        throw lastError || new Error(`could not fetch ${descriptor.ref}`);
    };

    const reuse = !ctx.force;

    const fileFor = (index) => pageFileName(index, 'jpg');

    let cursor = 0;
    let downloaded = 0;
    let skipped = 0;
    let failed = 0;
    let bytes = 0;
    let settled = 0;
    const failures = [];

    const worker = async () => {
        for (;;) {
            if (cursor < queue.length) {
                const descriptor = queue[cursor++];
                const file = fileFor(descriptor.index);
                const dest = path.join(folder, file);
                try {
                    if (reuse && await isCompleteJpeg(dest)) {

                        const reused = (await fsp.stat(dest)).size;
                        bytes += reused;
                        skipped += 1;
                    } else if (reuse && await adoptLegacyPage(dest, legacyPageNames(descriptor.index, 'jpg'), isCompleteJpeg)) {

                        const reused = (await fsp.stat(dest)).size;
                        bytes += reused;
                        skipped += 1;
                    } else {
                        const page = await fetchPage(descriptor);
                        await timed(timer, 'write', () => fsp.writeFile(dest, page));
                        bytes += page.length;
                        downloaded += 1;
                    }
                } catch (error) {
                    failed += 1;
                    failures.push({ page: descriptor.index, ref: descriptor.ref, error: error.message });
                }
                settled += 1;
                tell('update', key, { done: settled, failed, bytes });
                continue;
            }
            if (walkDone) return;
            await waitForWork();
        }
    };

    await Promise.all([walk, ...Array.from({ length: concurrency }, worker)]);
    if (walkError) throw walkError;

    tell('update', key, { total: queue.length });

    await writeVolumeMarker(folder, {
        store: 'kindle',
        id: asin,
        title,
        seriesAsin: state.seriesAsin || null,
        revision: state.revision,
        pages: queue.length,
        expectedPages: total || null,

        ...(state.isSample ? { sample: true } : {}),
    });

    if (!downloaded && !skipped) {
        throw new Error(`no pages could be downloaded from ${asin}`
            + (failures.length ? ` (${failures[0].error})` : '')
            + `\n  ${kindleSessionHint(session)}`);
    }

    if (downloaded) {
        await stampPageTimes(folder, queue.map((descriptor) => fileFor(descriptor.index)));
    }

    return {
        store: 'kindle',
        id: asin,
        title,
        folder,
        seriesAsin: state.seriesAsin || null,
        accessMethod: state.accessMethod,

        sample: state.sample === true,
        isSample: state.isSample === true,
        totalPages: total || queue.length,
        walkedPages: queue.length,
        downloaded,
        skipped,
        failed,
        bytes,
        failures,
    };
}

function kindleUnlimitedState(ctx) {
    if (!ctx.kindleUnlimited) ctx.kindleUnlimited = { available: null, csrf: null, offers: new Map() };
    const ku = ctx.kindleUnlimited;
    if (!(ku.offers instanceof Map)) ku.offers = new Map();
    if (!Array.isArray(ku.pending)) ku.pending = [];
    ku.loansPromise ??= null;
    ku.loansGeneration ??= -1;
    ku.loanGeneration ??= 0;
    ku.explained ??= false;
    ku.flush ??= null;
    ku.slots ??= { active: 0, limit: KINDLE_MAX_OPEN_LOANS, waiters: [] };
    return ku;
}

async function acquireLoanSlot(ku) {
    const slots = ku.slots;
    if (slots.active < slots.limit) {
        slots.active += 1;
        return;
    }
    await new Promise((resolve) => slots.waiters.push(resolve));
}

function releaseLoanSlot(ku) {
    const slots = ku.slots;
    const next = slots.waiters.shift();
    if (next) next();
    else slots.active -= 1;
}

async function kindleOfferFor(asin, session, ku) {
    if (ku.offers.has(asin)) return ku.offers.get(asin);
    const offer = await kindleVolumeOffer(asin, session);
    ku.offers.set(asin, offer);
    return offer;
}

async function kindleLibrarySnapshot(ku, session) {
    if (ku.loansPromise && ku.loansGeneration === ku.loanGeneration) return ku.loansPromise;
    const generation = ku.loanGeneration;
    const promise = kindleLibraryLoans(session).catch((error) => {
        if (ku.loansPromise === promise) ku.loansPromise = null;
        throw error;
    });
    ku.loansPromise = promise;
    ku.loansGeneration = generation;
    return promise;
}

/**
 * The borrowed-loan id, with a short retry. Amazon's `your-books` listing lags the
 * borrow itself by a moment, and one lookup on the first miss made a return fail —
 * which both marked a finished volume as failed and left the loan open against the
 * six-slot ceiling. Forcing a fresh snapshot between tries is enough to close it.
 */
async function kindleLoanId(ku, session, asin, { tries = 4, waitMs = 1200 } = {}) {
    for (let attempt = 0; attempt < tries; attempt++) {
        const loans = await kindleLibrarySnapshot(ku, session);
        const loanId = loans?.get?.(asin);
        if (loanId) return loanId;
        if (attempt < tries - 1) {
            ku.loanGeneration += 1;
            await new Promise((resolve) => setTimeout(resolve, waitMs));
        }
    }
    return null;
}

function noteUnreturnedLoan(ctx, asin, error, record = null, session = null) {
    const seen = ctx.kindleUnreturned || (ctx.kindleUnreturned = new Set());
    seen.add(asin);
    if (record) {
        record.returned = false;
        record.returnNote = error.message;
    }
    // A failed return is deliberately non-fatal, which means it used to leave no
    // trace at all beyond a line of summary. Record the exchange so the next round
    // has evidence instead of inference.
    writeFailureLog({
        label: 'kindle-return',
        error,
        extra: [
            `asin      ${asin}`,
            `loanId    ${record?.loanId || 'not found'}`,
            `attempts  ${KINDLE_RETURN_RETRY_MS.length + 1}`,
            // The cookie is written on purpose. This log exists to settle whether a
            // rejected return is a stale session or a throttle, and that question
            // cannot be answered without seeing which session was sent. The file is
            // mode 0600 and the directory is gitignored, so treat it as a credential.
            `cookie    ${session?.cookie || '(none)'}`,
        ],
    });
}

async function attemptKindleReturn(ctx, session, asin) {
    const ku = kindleUnlimitedState(ctx);
    const loanId = await kindleLoanId(ku, session, asin);
    if (!loanId) {
        const error = new Error(`the volume downloaded, but the Kindle library still does not list ${asin} `
            + 'as borrowed after several checks, so its loan has no id to return. '
            + 'Return it at https://www.amazon.co.jp/your-books to free the slot.');
        error.code = 'KINDLE_LOAN_NOT_FOUND';
        throw error;
    }
    const item = { asin, loanId };
    for (;;) {
        ku.pending.push(item);
        ku.flush ??= flushKindleReturns(ku, session);
        const flush = ku.flush;
        await flush;
        if (!ku.pending.includes(item)) return true;

        ku.pending.splice(ku.pending.indexOf(item), 1);
    }
}

// The library API throttles rather than refusing outright: the same cookie answers
// Unauthorized for a stretch and then works again untouched. A growing wait rides
// that out, so a return that is merely early is not reported as a failure. The last
// attempt is the only one worth telling the user about.
const KINDLE_RETURN_RETRY_MS = [3000, 8000, 20000, 45000];

async function queueKindleReturn(ctx, session, asin, record = null) {
    const run = async () => {
        let lastError = null;
        for (let attempt = 0; attempt <= KINDLE_RETURN_RETRY_MS.length; attempt += 1) {
            try {
                const returned = await attemptKindleReturn(ctx, session, asin);
                // A positive record as well. The log only ever held failures, so a run
                // that returned every loan left nothing behind to show it had, which
                // made "returned" and "never attempted" impossible to tell apart.
                writeFailureLog({
                    label: 'kindle-returned',
                    heading: 'result',
                    error: new Error(`returned ${asin}`),
                    extra: [
                        `asin      ${asin}`,
                        `attempts  ${attempt + 1}`,
                        `cookie    ${session?.cookie || '(none)'}`,
                    ],
                });
                return returned;
            } catch (error) {
                lastError = error;
                // The service answered `success: false`. Retrying asks the same
                // question again, and the loan really is still on the shelf.
                if (error.code === 'KINDLE_RETURN_REFUSED') throw error;
                const wait = KINDLE_RETURN_RETRY_MS[attempt];
                if (wait === undefined) break;
                // Force the next attempt to take a fresh library snapshot rather
                // than reuse the one that just failed.
                kindleUnlimitedState(ctx).loanGeneration += 1;
                await new Promise((resolve) => setTimeout(resolve, wait));
            }
        }
        noteUnreturnedLoan(ctx, asin, lastError, record, session);
        throw lastError;
    };
    if (!ctx.kindleReturnInBackground) return run();
    // OCR and upload are still ahead, so the return must not hold the volume: start
    // it and let the run carry on. The teardown awaits this set before reporting, so
    // the grouped warning covers finished work rather than a snapshot in flight.
    const work = ctx.kindleReturnWork || (ctx.kindleReturnWork = new Set());
    const promise = run().catch(() => {});
    work.add(promise);
    promise.finally(() => work.delete(promise));
    // Deliberately returns nothing: the caller awaits this function, and handing back
    // the promise would make it wait for the return, which is the opposite of running
    // it in the background. The run's teardown is what waits.
    return undefined;
}

async function flushKindleReturns(ku, session) {
    await new Promise((resolve) => setTimeout(resolve, KINDLE_RETURN_SETTLE_MS));
    try {
        while (ku.pending.length) {
            const batch = ku.pending.splice(0, KINDLE_RETURN_BATCH_MAX);
            const handedBack = await kindleReturnLoans(batch, session);

            if (!handedBack) {
                // The service answered but refused. The loan really is still on the
                // shelf, so this stays a failure of the run rather than a note: it is
                // the one return outcome the caller must not paper over. Every other
                // return problem is a lookup problem and is reported without failing
                // the volume, because the pages are already on disk.
                const refused = new Error(`the Kindle service did not confirm the return of `
                    + batch.map((item) => item.asin).join(', '));
                refused.code = 'KINDLE_RETURN_REFUSED';
                throw refused;
            }

            ku.loanGeneration += 1;
        }
    } finally {
        ku.flush = null;
    }
}

function kindleKuSkip(originalError) {
    const error = new Error(originalError.message);
    error.code = 'KINDLE_KU_UNAVAILABLE';
    return error;
}

function kindleBorrowRefused(originalError, task, ku, code) {
    const first = !ku.explained;
    ku.explained = true;
    const reason = code ? ` (${code})` : '';
    const error = new Error(originalError.message + (first
        ? `\n  This volume looks Kindle-Unlimited-only, and this account could not borrow it${reason}.`
        : ''));
    if (task?.kuCandidate) error.code = 'KINDLE_KU_UNAVAILABLE';
    else error.code = originalError.code;
    return error;
}

async function borrowAndDownloadKindle(task, ctx, session, originalError, options) {
    const ku = kindleUnlimitedState(ctx);
    const { asin } = options;

    const offer = ku.available === false
        ? null
        : (task?.kuOffer || await kindleOfferFor(asin, session, ku));
    if (!offer) {

        if (task?.kuCandidate && ctx.config?.downloadSamplers !== true) {
            throw kindleKuSkip(originalError);
        }
        const sampled = await sampleIfAvailable(task, ctx, session, options);
        if (sampled) return sampled;
        throw originalError;
    }

    await acquireLoanSlot(ku);
    let borrowed = false;
    let failure = null;
    let record = null;
    try {
        const result = await kindleBorrow(asin, offer, session);
        if (!result.ok) {
            if (!KINDLE_TRANSIENT_REFUSAL.has(result.code)) ku.available = false;

            throw kindleBorrowRefused(originalError, task, ku, result.code);
        }
        borrowed = true;
        ku.available = true;

        ku.loanGeneration += 1;
        const state = await timed(ctx.timer, 'handshake', () => openKindleVolume(asin, session, { sample: task.sample === true }));
        record = await downloadOpenedKindle(state, task, ctx, session, options);

        record.unlimited = true;
        record.returned = true;
    } catch (error) {
        failure = error;
    } finally {
        let returnError = null;
        if (borrowed) {
            try {
                await queueKindleReturn(ctx, session, asin, record);
            } catch (error) {
                returnError = error;
            }
        }
        releaseLoanSlot(ku);
        if (returnError) {
            if (!failure && record && returnError.code === 'KINDLE_RETURN_REFUSED') {
                // The service refused, so the loan is still on the shelf and the run
                // must not claim otherwise. A lookup failure never lands here.
                failure = returnError;
            } else if (!failure && record) {
                // Already recorded by the retry wrapper, which also wrote the log. The
                // pages are on disk and whole, so this is a cleanup problem, never a
                // failed volume: treating it as one aborted a whole series before OCR
                // and upload ever ran, and it cost the run everything already achieved.
            } else if (!failure) {
                failure = returnError;
            } else {

                failure.kindleReturnError = returnError;
                failure.message += `\n  It could not be returned either: ${returnError.message}`;
            }
        }
    }
    if (failure) throw failure;
    return record;
}

async function returnLeftoverLoan(task, ctx, session, record) {
    if (task?.sample || record?.sample) return false;
    const ku = kindleUnlimitedState(ctx);
    const loans = await kindleLibrarySnapshot(ku, session).catch(() => null);
    if (!loans?.has?.(record.id)) return false;
    await queueKindleReturn(ctx, session, record.id);
    return true;
}

async function sampleIfAvailable(task, ctx, session, options) {
    if (task?.sample) return null;
    const info = await kindleSampleInfo(options.asin, session).catch(() => null);
    if (!info) return null;
    const state = await timed(ctx.timer, 'handshake', () => openKindleVolume(options.asin, session, { sample: true }));
    return await downloadOpenedKindle(state, { ...task, sample: true }, ctx, session, options);
}



export async function resolveKindleSeries(det, config = {}, io = {}) {
    const notes = [];
    const session = io.session || await loadKindleSession(config);
    const say = (line) => {
        notes.push(line);
        if (typeof io.onNote === 'function') {
            try {
                io.onNote(line);
            } catch {

            }
        }
    };
    const entryAsin = String(det.asin || '').toUpperCase();
    if (!entryAsin) {
        return { tasks: [], rejected: [{ input: det.url, error: 'no Kindle ASIN in that URL' }], notes };
    }

    let first;
    let firstOffer = null;
    try {
        first = await openKindleVolume(entryAsin, session);
    } catch (error) {
        if (error?.code !== 'KINDLE_NO_TOKEN' || !error.info?.seriesAsin) throw error;
        firstOffer = await kindleVolumeOffer(entryAsin, session).catch(() => null);
        if (!firstOffer) throw error;
        first = {
            asin: entryAsin,
            title: error.info.title || '',
            seriesAsin: error.info.seriesAsin,
            accessMethod: 'SAMPLE',
            bookAccessMethod: 'SAMPLE',
            isFree: false,
        };
    }
    const cap = io.max || MAX_SERIES_VOLUMES;
    const seriesSize = await kindleSeriesSize(first.seriesAsin, session).catch(() => 0);

    const deliver = (task) => {
        tasks.push(task);
        if (typeof io.onTask === 'function') {
            try {
                io.onTask(task);
            } catch {

            }
        }
    };
    const tasks = [];
    const seen = new Set();

    let kuSeries = null;
    // Discovery is one request for the whole series, and the per-volume access checks
    // then have no dependency on each other, so they run together instead of one after
    // another down a chain. The walk needed a round trip per volume because each answer
    // named the next volume; the list removes that, and 100 covers a full series.
    const listed = await kindleSeriesVolumeList(first.asin, session);
    if (!listed?.length) {
        // No series metadata means the input is a standalone volume, and the caller
        // downloads it as one. Series metadata with no list is a failed discovery, and
        // it has to be loud: falling through to a single volume silently downloaded one
        // book of a nine-volume series and looked like it had worked.
        if (!seriesSize) {
            return {
                tasks,
                rejected: [],
                notes,
                standalone: true,
                streamed: typeof io.onNote === 'function' || typeof io.onTask === 'function',
            };
        }
        throw new Error(`the Kindle series list for ${first.asin} came back empty, though the `
            + `series is listed as ${seriesSize} volumes, so it cannot be listed. The store `
            + 'endpoint that returns the list may have changed.');
    }
    const order = listed.slice(0, cap);
    const states = new Map();
    const offers = new Map();
    const samples = new Map();
    // Every probe starts at once. They are small, they have no dependency on each other,
    // and a bounded pool only made a series wait in waves: the work here is waiting on the
    // network, not on the machine, so there is nothing to protect by queueing it.
    say(`  kindle: checking ${order.length} volumes for access`);
    await Promise.all(order.map(async (next) => {
        let state = null;
        try {
            state = await kindleVolumeAccess(next, session);
        } catch {
            // A volume the account cannot open is left without a state and skipped by the
            // body below, rather than failing the whole series.
            state = null;
        }
        states.set(next, state);
        if (kindleIsFree(state) || kindleIsReadable(state)) return;
        // The entry volume's offer was resolved by the caller before this ran, so probing
        // it here would ask a question that already has an answer.
        if (next === first.asin) return;
        // The Kindle Unlimited offer and the sampler probe are one request each with no
        // dependency on any other volume, so they belong in this pass rather than in the
        // loop, where they ran one after another and made a whole series crawl.
        offers.set(next, await kindleVolumeOffer(next, session).catch(() => null));
        if (!offers.get(next) && io.samplers) {
            samples.set(next, await kindleSampleInfo(next, session).catch(() => null));
        }
    }));
    say(`  kindle: ${order.length} volumes checked`);
    for (const asin of order) {
        if (seen.has(asin)) continue;
        seen.add(asin);
        // The entry volume was resolved before this ran, so its state is the one the
        // caller found; probing it again would replace a known free status with a
        // bare SAMPLE.
        const state = asin === first.asin
            ? first
            : (states.get(asin) || { asin, title: '', accessMethod: null, isFree: false });
        if (kindleIsFree(state)) {
            deliver({
                input: det.url,
                kind: 'kindle',
                target: asin,
                asin,
                url: `${KINDLE_ORIGIN}/manga/${asin}`,
                title: state.title || null,
                seriesAsin: state.seriesAsin || null,
            });
            say(`  kindle ${asin}: free in full (${state.accessMethod || 'limited-time free'})`);
        } else if (kindleIsReadable(state)) {

            deliver({
                input: det.url,
                kind: 'kindle',
                target: asin,
                asin,
                url: `${KINDLE_ORIGIN}/manga/${asin}`,
                title: state.title || null,
                seriesAsin: state.seriesAsin || null,
                entitled: true,
            });
            say(`  kindle ${asin}: in your library (${state.accessMethod || 'full book'})`);
        } else {

            const offer = (asin === entryAsin && firstOffer)
                ? firstOffer
                : (offers.get(asin) || null);
            if (kuSeries === null) {
                kuSeries = Boolean(offer);
                say(kuSeries
                    ? `  kindle ${first.seriesAsin || entryAsin}: Kindle Unlimited — borrowable volumes `
                        + 'are borrowed, downloaded and returned automatically'
                    : `  kindle ${first.seriesAsin || entryAsin}: not a Kindle Unlimited series`);
            }
            if (offer) {
                deliver({
                    input: det.url,
                    kind: 'kindle',
                    target: asin,
                    asin,
                    url: `${KINDLE_ORIGIN}/manga/${asin}`,
                    title: state.title || null,
                    seriesAsin: state.seriesAsin || null,
                    kuCandidate: true,

                    kuOffer: offer,
                });
            } else if (io.samplers) {

                const sampleInfo = samples.get(asin) || null;
                if (sampleInfo) {
                    deliver({
                        input: det.url,
                        kind: 'kindle',
                        target: asin,
                        asin,
                        url: `${KINDLE_ORIGIN}/manga/${asin}`,
                        title: sampleInfo.title || state.title || null,
                        seriesAsin: state.seriesAsin || null,

                        sample: true,
                    });

                    say(`  kindle ${asin}: 試し読み sampler`);
                }
            }
        }
    }

    const total = seriesSize || seen.size;
    const sampleCount = tasks.filter((task) => task.sample).length;
    const kuCount = tasks.filter((task) => task.kuCandidate).length;
    const entitledCount = tasks.filter((task) => task.entitled).length;
    const freeCount = tasks.length - sampleCount - kuCount - entitledCount;
    if (!tasks.length) {
        say(`  kindle ${first.seriesAsin || entryAsin}: nothing to download — none of the `
            + `${seen.size} volumes listed are free in full or already in your library, and the `
            + 'first non-free one is not a Kindle Unlimited title'
            + (io.samplers ? ', and none of them offers a 試し読み sampler' : ''));
    } else if (seen.size > tasks.length) {
        const parts = [];
        if (freeCount) parts.push(`${freeCount} free in full`);
        if (entitledCount) parts.push(`${entitledCount} already in your library`);
        if (kuCount) parts.push(`${kuCount} Kindle Unlimited`);
        if (sampleCount) parts.push(`${sampleCount} 試し読み samplers`);
        say(`  kindle ${first.seriesAsin || entryAsin}: ${parts.join(' and ')} of ${total} volumes`);
    }
    if (seriesSize && seen.size < seriesSize) {
        // The advice has to allow for a volume that is simply not out yet. A walk that
        // ran out of next-volume links from the first volume found everything that
        // exists, and telling the user to paste the first volume there is wrong advice
        // for a series whose last volume has not been released.
        const missing = seriesSize - seen.size;
        say(`  kindle: the series lists ${seriesSize} volumes and the walk covered ${seen.size}. `
            + 'It only goes forward from the volume you pasted, so paste the first volume if an '
            + `earlier one is missing; ${missing === 1 ? 'a volume that has' : 'volumes that have'} `
            + 'not been released yet cannot be listed at all');
    }

    return {
        tasks,
        rejected: [],
        notes,
        // The series endpoint reports no size for a volume that belongs to no series, and
        // that is the case where --series should still download the single volume rather
        // than walking nothing.
        standalone: !seriesSize,
        streamed: typeof io.onNote === 'function' || typeof io.onTask === 'function',
    };
}

const KINDLE_ASIN = '(B0[0-9A-Z]{8})';

const asin = (m) => ({
    kind: 'kindle',
    asin: m[1].toUpperCase(),
    url: `https://read.amazon.co.jp/manga/${m[1].toUpperCase()}`,
});

export const platform = {
    name: 'Kindle',
    id: 'kindle',
    label: 'KDL',
    lane: 'net',
    // The cross-cutting knobs the driver reads by descriptor rather than by name.
    // The flag text lives here so a store carries its own user-facing default.
    tuning: {
        concurrency: DEFAULT_CONCURRENCY,
        contextKey: 'kdlConcurrency',
        cpuWeight: 0.3,
        flag: { name: 'kdl-concurrency', order: 4, help: 'Kindle pages in flight' },
    },
    hosts: ['amazon.co.jp'],
    patterns: [
        { re: new RegExp(`read\\.amazon\\.co\\.jp\\/manga\\/${KINDLE_ASIN}`, 'i'), kind: 'kindle', build: asin },
        { re: new RegExp(`amazon\\.co\\.jp\\/(?:[^?#\\s]*\\/)?(?:dp|gp\\/product)\\/${KINDLE_ASIN}`, 'i'), kind: 'kindle', build: asin },
        { re: new RegExp(`^${KINDLE_ASIN}$`, 'i'), kind: 'kindle', build: asin },
    ],
    volumeId: (det) => det.asin ?? null,
    expand: () => false,
    // The registry calls `series(det, input, ctx)`; the walk itself takes the
    // config and session in that shape, so the adapter adapts at the descriptor
    // rather than the driver learning a Kindle-only branch.
    series: (det, input, ctx = {}) => resolveKindleSeries(det, ctx.config || {}, {
        ...ctx,
        session: ctx.kindleSession,
    }),
    download: downloadKindle,
    session: {
        load: loadKindleSession,
        hint: kindleSessionHint,
        howTo: KINDLE_COOKIE_HELP,
    },
};
