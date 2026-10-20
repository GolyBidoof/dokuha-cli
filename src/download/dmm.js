import fsp from 'node:fs/promises';
import path from 'node:path';

import { USER_AGENT } from '../user-agent.js';
import { timed } from '../phase-timer.js';
import { defaultBackoff as backoff, describeError, retry } from '../retry.js';
import { SAMPLE_SUFFIX, readVolumeMarker, volumeFolder, writeVolumeMarker } from './volume-folder.js';
import { existingVolume } from './existing-volume.js';
import { isCompleteImageFile, pageFileName, stampPageTimes } from './page-files.js';
import { dedupeBy, mapLimit, parseVolumeNumber, reject } from '../series.js';
import { fetchH2 } from './h2-fetch.js';
import {
    assertSharpAvailable,
    descrambleDmmPage,
    dmmPattern,
} from './dmm-descramble.js';

/**
 * DMMブックス (book.dmm.com), the store the sixth adapter covers.
 *
 * The viewer (`publus-controller.js`) asks `/viewerapi/auth/` for a `cid`,
 * receives a content base URL and either CloudFront cookies (a free/campaign
 * volume) or an `auth_info` object with signed query parameters (a 試し読み
 * sample), then fetches `configuration_pack.json` and one JPEG per page.
 *
 * The JPEG is not a finished page: its pixels are a 64×64 tile shuffle, keyed
 * by the page's own path, and `publus-viewer.js` rearranges them in a canvas
 * before display. `dmm-descramble.js` ports that routine; there is no cipher
 * and no per-page key beyond the path, but the shuffle is mandatory.
 *
 * The free full volume and the sample use different hosts:
 *   - free_streaming: auth sets CloudFront-* cookies for ebook04.dmm.com
 *   - tachiyomi:      auth returns Policy/Signature/Key-Pair-Id for
 *                     trial.book.dmm.co.jp
 * Both are handled here; the cookies are captured from Set-Cookie and the
 * query parameters are appended to every manifest/page URL.
 */

export const DMM_ORIGIN = 'https://book.dmm.com';
export const DMM_CONTENT_API = `${DMM_ORIGIN}/ajax/bff/contents_book/`;
export const DMM_VOLUME_API = `${DMM_ORIGIN}/ajax/bff/viewer/lastpage/volume/`;
export const DMM_AUTH_API = `${DMM_ORIGIN}/viewerapi/auth/`;

export const DMM_DEFAULT_CONCURRENCY = 16;
export const DMM_MAX_CONCURRENCY = 32;

const DMM_PER_PAGE = 100;
const DMM_MAX_SERIES_PAGES = 50;
const DMM_FETCH_TIMEOUT_MS = 45_000;

const PAGE_NAME = (index) => pageFileName(index, 'jpg');

function dmmHeaders(ctx, extra = {}) {
    return {
        'User-Agent': ctx?.userAgent || USER_AGENT,
        'Accept-Language': 'ja-JP,ja;q=0.9,en-US;q=0.8',
        // fetchH2 does not decompress (global fetch does), so ask the CDN for
        // the bytes as stored. JPEG pages are not compressed anyway.
        'Accept-Encoding': 'identity',
        ...extra,
    };
}

function dmmReferer(ctx, referer = `${DMM_ORIGIN}/`) {
    return referer || `${DMM_ORIGIN}/`;
}

/**
 * The page CDNs speak HTTP/2, and Node's global fetch is HTTP/1.1 only. At a
 * high round-trip time that difference is the page stage: one multiplexed h2
 * session keeps every stream busy instead of paying a TLS handshake and slow
 * start per h1 connection. fetchH2 falls back to global fetch on an h1 origin
 * or a failed h2 connection, so an injected fetchImpl (the test/CLI seam) and
 * `ctx.http2 === false` keep the ordinary transport available.
 */
function dmmFetchImpl(ctx) {
    if (typeof ctx?.fetchImpl === 'function') return ctx.fetchImpl;
    if (ctx?.http2 === false) return fetch;
    return fetchH2;
}

/** Cookie lines from an auth answer, whatever the fetch implementation exposes. */
export function dmmSetCookieLines(response) {
    if (!response?.headers) return [];
    try {
        if (typeof response.headers.getSetCookie === 'function') {
            const lines = response.headers.getSetCookie();
            if (Array.isArray(lines) && lines.length) return lines;
        }
    } catch {
        // fall through to the single-header form
    }
    const one = response.headers.get?.('set-cookie');
    return one ? [one] : [];
}

export function dmmAbsorbCookies(jar, lines) {
    for (const line of lines || []) {
        const pair = String(line).split(';')[0];
        const at = pair.indexOf('=');
        if (at <= 0) continue;
        const name = pair.slice(0, at).trim();
        const value = pair.slice(at + 1).trim();
        if (name) jar.set(name, value);
    }
    return jar;
}

export function dmmCookieHeader(jar) {
    if (!jar) return '';
    return [...jar].map(([name, value]) => `${name}=${value}`).join('; ');
}

/** A viewer URL names its opaque cid and the preview flag (`lin`). */
export function parseDmmViewerUrl(raw) {
    let url;
    try {
        url = new URL(String(raw), DMM_ORIGIN);
    } catch {
        return null;
    }
    if (!/(^|\.)book\.dmm\.com$/i.test(url.hostname)) return null;
    const viewer = /^\/product\/(\d+)\/([a-z0-9]+)\/(free_streaming|tachiyomi)\/?$/i.exec(url.pathname);
    if (!viewer) return null;
    return {
        url: url.toString(),
        seriesId: viewer[1],
        contentId: viewer[2],
        viewer: viewer[3].toLowerCase(),
        cid: url.searchParams.get('cid') || '',
        lin: url.searchParams.get('lin') || (viewer[3].toLowerCase() === 'tachiyomi' ? '1' : '0'),
    };
}

export function dmmContentsBookUrl(seriesId, page = 1, perPage = DMM_PER_PAGE) {
    const query = new URLSearchParams({
        shop_name: 'general',
        series_id: String(seriesId),
        page: String(page),
        per_page: String(perPage),
        read_position: 'latest',
        order: 'asc',
        purchased_status: 'all',
    });
    return `${DMM_CONTENT_API}?${query.toString()}`;
}

export function dmmVolumeInfoUrl(seriesId, contentId) {
    const query = new URLSearchParams({
        shop_name: 'general',
        content_id: String(contentId),
        series_id: String(seriesId),
    });
    return `${DMM_VOLUME_API}?${query.toString()}`;
}

function dmmFreeUrl(entry) {
    const list = entry?.free_streaming_url;
    if (Array.isArray(list)) return list.find((url) => typeof url === 'string' && url) || null;
    return typeof list === 'string' && list ? list : null;
}

function dmmSampleUrl(entry) {
    return typeof entry?.tachiyomi_url === 'string' && entry.tachiyomi_url ? entry.tachiyomi_url : null;
}

/**
 * The series listing. `volume_books` is the only field the adapter trusts for
 * volume identity; the free and sample markers are the two URL fields the store
 * itself uses for its own buttons.
 */
export function parseDmmContentsBook(body) {
    const list = Array.isArray(body?.volume_books) ? body.volume_books : [];
    const volumes = list.map((entry) => {
        const freeStreamingUrl = dmmFreeUrl(entry);
        const sampleUrl = dmmSampleUrl(entry);
        return {
            contentId: entry?.content_id ? String(entry.content_id) : null,
            title: entry?.title ? String(entry.title) : '',
            volume: Number.isInteger(entry?.volume_number) ? entry.volume_number : null,
            freeStreamingUrl,
            sampleUrl,
            free: !!freeStreamingUrl,
            sample: !freeStreamingUrl && !!sampleUrl,
            freeStatus: entry?.sell?.free_status || null,
            limitedFreeEnd: entry?.limited_free?.end || null,
            price: Number.isFinite(entry?.sell?.campaign_price) ? entry.sell.campaign_price
                : (Number.isFinite(entry?.sell?.fixed_price) ? entry.sell.fixed_price : null),
        };
    }).filter((entry) => entry.contentId);
    return {
        volumes: dedupeBy(volumes, (entry) => entry.contentId),
        pager: body?.pager || null,
        totalFree: Number(body?.total_free_count) || 0,
    };
}

/**
 * `configuration_pack.json` is plain JSON. `configuration.contents` is the
 * reading order, and each named item carries the page list. The viewer builds
 * `<base><file>/<Page.No>.<type>` and maps `bmp` to `jpeg`.
 */
export function parseDmmConfiguration(config) {
    const contents = Array.isArray(config?.configuration?.contents)
        ? config.configuration.contents
        : [];
    const pages = [];
    for (const entry of contents) {
        if (!entry || typeof entry.file !== 'string') continue;
        const item = config[entry.file];
        if (!item || item.Linear === 0) continue;
        const type = entry.type === 'bmp' ? 'jpeg' : String(entry.type || 'jpeg').toLowerCase();
        if (type !== 'jpeg' && type !== 'jpg') continue;
        const links = item?.FileLinkInfo?.PageLinkInfoList;
        const list = Array.isArray(links) ? links : [{ Page: { No: 0 } }];
        for (const link of list) {
            const page = link?.Page || {};
            const no = Number.isInteger(page.No) ? page.No : 0;
            const dummyWidth = Number.isFinite(page.DummyWidth) ? page.DummyWidth : null;
            const dummyHeight = Number.isFinite(page.DummyHeight) ? page.DummyHeight : null;
            pages.push({
                file: entry.file,
                no,
                type: type === 'jpg' ? 'jpeg' : type,
                width: Number(page.Size?.Width) || 0,
                height: Number(page.Size?.Height) || 0,
                dummyWidth,
                dummyHeight,
                // The viewer only installs the shuffle when both fields are
                // numbers. A zero is meaningful: it still shuffles full 64px
                // tiles, with nothing cropped off the right/bottom edge.
                scrambled: typeof dummyWidth === 'number' && typeof dummyHeight === 'number',
                pattern: dmmPattern(entry.file, no),
            });
        }
    }
    return pages;
}

function dmmAbsolute(base, rel) {
    const root = base.endsWith('/') ? base : `${base}/`;
    return new URL(String(rel).replace(/^\//, ''), root).toString();
}

export function dmmPagePath(page) {
    return `${page.file}/${page.no}.${page.type}`;
}

/** Append the sample's signed query, when the auth answer supplied one. */
export function dmmSignedUrl(url, authInfo) {
    if (!authInfo || typeof authInfo !== 'object') return url;
    const out = new URL(url);
    for (const [key, value] of Object.entries(authInfo)) {
        if (value != null) out.searchParams.set(key, String(value));
    }
    return out.toString();
}

function dmmBaseUrl(auth) {
    const base = String(auth?.url || '');
    if (!base) throw new Error('DMM auth answer carried no content URL');
    return base.endsWith('/') ? base : `${base}/`;
}

async function dmmFetchJson(url, ctx, { referer, cookie, headers } = {}) {
    const doFetch = dmmFetchImpl(ctx);
    const attempt = async (n) => {
        const response = await doFetch(url, {
            redirect: 'follow',
            signal: AbortSignal.timeout(DMM_FETCH_TIMEOUT_MS + n * 15_000),
            headers: dmmHeaders(ctx, {
                Accept: 'application/json,text/plain,*/*',
                Referer: dmmReferer(ctx, referer),
                ...(cookie ? { Cookie: cookie } : {}),
                ...(headers || {}),
            }),
        });
        if (!response.ok) {
            const error = new Error(`DMM answered HTTP ${response.status} for ${new URL(url).pathname}`);
            error.status = response.status;
            throw error;
        }
        return response.json();
    };
    return retry(attempt, {
        attempts: Math.max(2, 1 + (Number(ctx?.retries) || 0)),
        wait: backoff,
        isRetryable: (error) => error.status == null || error.status === 429 || error.status >= 500,
    });
}

/**
 * The viewer's authorization call. It is same-origin and anonymous for free
 * volumes; signed-in callers get their own purchase checks from the same call.
 */
export async function authorizeDmm(viewerUrl, ctx = {}, jar = new Map()) {
    const viewer = parseDmmViewerUrl(viewerUrl);
    if (!viewer || !viewer.cid) throw new Error(`DMM viewer URL is missing its cid: ${viewerUrl}`);
    const query = new URLSearchParams({ cid: viewer.cid, lin: viewer.lin });
    const url = `${DMM_AUTH_API}?${query.toString()}`;
    const doFetch = dmmFetchImpl(ctx);
    const attempt = async (n) => {
        const response = await doFetch(url, {
            redirect: 'follow',
            signal: AbortSignal.timeout(DMM_FETCH_TIMEOUT_MS + n * 15_000),
            headers: dmmHeaders(ctx, {
                Accept: '*/*',
                Referer: viewerUrl,
                ...(jar.size ? { Cookie: dmmCookieHeader(jar) } : {}),
            }),
        });
        if (response.headers) dmmAbsorbCookies(jar, dmmSetCookieLines(response));
        if (!response.ok) {
            const error = new Error(`DMM viewer authorization answered HTTP ${response.status}`);
            error.status = response.status;
            throw error;
        }
        const body = await response.json();
        if (String(body?.status) !== '200' || !body?.url) {
            const error = new Error(`DMM viewer authorization refused this volume: ${body?.status || 'no status'}`);
            error.status = Number(body?.status) || 0;
            throw error;
        }
        return body;
    };
    const auth = await retry(attempt, {
        attempts: Math.max(2, 1 + (Number(ctx?.retries) || 0)),
        wait: backoff,
        isRetryable: (error) => error.status == null || error.status === 429 || error.status >= 500,
    });
    const authInfo = auth.auth_info && typeof auth.auth_info === 'object' ? { ...auth.auth_info } : null;
    if (authInfo) {
        // CloudFront query values may be percent-encoded. URLSearchParams will
        // encode them once more, so decode them here to keep the signature
        // intact.
        for (const key of Object.keys(authInfo)) {
            if (typeof authInfo[key] !== 'string') continue;
            try { authInfo[key] = decodeURIComponent(authInfo[key]); } catch { /* leave it */ }
        }
    }
    const cookie = dmmCookieHeader(jar);
    if (!authInfo && !/CloudFront-(?:Policy|Signature|Key-Pair-Id)=/.test(cookie)) {
        throw new Error('DMM authorization returned neither auth_info nor CloudFront cookies. '
            + 'Reload the viewer and try again.');
    }
    return {
        auth,
        base: dmmBaseUrl(auth),
        authInfo,
        cookie,
        viewer,
    };
}

async function dmmFetchManifest(session, ctx) {
    const url = dmmSignedUrl(dmmAbsolute(session.base, 'configuration_pack.json'), session.authInfo);
    const doFetch = dmmFetchImpl(ctx);
    const attempt = async (n) => {
        const response = await doFetch(url, {
            redirect: 'follow',
            signal: AbortSignal.timeout(DMM_FETCH_TIMEOUT_MS + n * 15_000),
            headers: dmmHeaders(ctx, {
                Accept: '*/*',
                Referer: `${DMM_ORIGIN}/`,
                ...(session.cookie ? { Cookie: session.cookie } : {}),
            }),
        });
        if (!response.ok) {
            const error = new Error(`DMM manifest answered HTTP ${response.status}`);
            error.status = response.status;
            throw error;
        }
        return response.json();
    };
    const body = await retry(attempt, {
        attempts: Math.max(2, 1 + (Number(ctx?.retries) || 0)),
        wait: backoff,
        isRetryable: (error) => error.status == null || error.status === 429 || error.status >= 500,
    });
    const pages = parseDmmConfiguration(body);
    if (!pages.length) throw new Error('DMM configuration_pack.json listed no JPEG pages');
    return { body, pages };
}

async function dmmFetchPage(session, page, ctx) {
    const url = dmmSignedUrl(dmmAbsolute(session.base, dmmPagePath(page)), session.authInfo);
    const doFetch = dmmFetchImpl(ctx);
    const response = await doFetch(url, {
        redirect: 'follow',
        signal: AbortSignal.timeout(DMM_FETCH_TIMEOUT_MS),
        timeoutMs: 0,
        headers: dmmHeaders(ctx, {
            Accept: 'image/jpeg,image/*,*/*',
            Referer: `${DMM_ORIGIN}/`,
            ...(session.cookie ? { Cookie: session.cookie } : {}),
        }),
    });
    if (!response.ok) {
        const error = new Error(`DMM page ${page.file}/${page.no} answered HTTP ${response.status}`);
        error.status = response.status;
        throw error;
    }
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes[2] !== 0xff) {
        throw new Error(`DMM page ${page.file}/${page.no} is not a JPEG (${bytes.length} bytes)`);
    }
    return bytes;
}

async function dmmReadSeries(seriesId, ctx) {
    const seen = new Map();
    let pager = null;
    let total = null;
    let walkError = null;
    for (let page = 1; page <= DMM_MAX_SERIES_PAGES; page++) {
        let body;
        try {
            body = await dmmFetchJson(dmmContentsBookUrl(seriesId, page), ctx, {
                referer: `${DMM_ORIGIN}/product/${seriesId}/volumes/`,
            });
        } catch (error) {
            if (!seen.size) throw error;
            walkError = error;
            break;
        }
        const parsed = parseDmmContentsBook(body);
        let added = 0;
        for (const entry of parsed.volumes) {
            if (!seen.has(entry.contentId)) {
                seen.set(entry.contentId, entry);
                added += 1;
            }
        }
        pager = parsed.pager || pager;
        if (total == null) total = Number(pager?.total_count) || null;
        const more = parsed.pager?.next_page
            ?? parsed.pager?.nextPage
            ?? parsed.pager?.next;
        if (more === false || more === null) break;
        // The BFF states the whole run in `pager.total_count` (the live shape is
        // {page, per_page, total_count}, not a next-page flag). A short page is
        // not proof of the end because the server may cap per_page, so the walk
        // stops when the whole count is seen, and an empty page stops it too.
        if (total != null && seen.size >= total) break;
        if (!added) break;
    }
    // A walk that stopped early must say so: silently returning page one for a
    // 150-volume series makes a broken series look like a short one.
    if (total != null && seen.size < total) {
        const reason = walkError ? ` (${walkError.message})` : '';
        throw new Error(`DMM series ${seriesId} listed ${seen.size} of ${total} volumes${reason}`);
    }
    if (walkError) throw walkError;
    return {
        volumes: [...seen.values()].sort((a, b) => (a.volume ?? 0) - (b.volume ?? 0)),
        pager,
    };
}

async function dmmReadVolumeInfo(seriesId, contentId, ctx) {
    const body = await dmmFetchJson(dmmVolumeInfoUrl(seriesId, contentId), ctx, {
        referer: `${DMM_ORIGIN}/product/${seriesId}/${contentId}/`,
    });
    return {
        contentId: String(body?.content_id || contentId),
        seriesId: String(body?.series_id || seriesId),
        title: String(body?.title || ''),
        volume: Number.isInteger(body?.volume_number) ? body.volume_number : null,
        freeStreamingUrl: dmmFreeUrl(body),
        sampleUrl: dmmSampleUrl(body),
        freeStatus: body?.sell?.free_status || null,
        limitedFreeEnd: body?.limited_free?.end || null,
    };
}

function dmmTaskFor(input, seriesId, entry, { viewerUrl, sample, title, volume }) {
    const cleanTitle = title || entry?.title || `DMM ${entry?.contentId || ''}`.trim();
    return {
        input,
        kind: 'dmm',
        id: `${entry.contentId}${sample ? 'sample' : ''}`,
        contentId: entry.contentId,
        seriesId,
        volume: volume ?? entry.volume ?? null,
        title: cleanTitle,
        target: sample ? `${cleanTitle}${SAMPLE_SUFFIX}` : cleanTitle,
        viewerUrl,
        sample: sample === true,
    };
}

function dmmEntryTask(input, seriesId, entry, viewer, sample) {
    return dmmTaskFor(input, seriesId, entry, {
        viewerUrl: viewer,
        sample,
        title: entry.title,
        volume: entry.volume,
    });
}

export async function resolveDmmInput(det, config, input, ctx = {}) {
    const series = config?.series === true;
    const seriesId = det.seriesId;

    if (det.kind === 'dmm-volume' && det.viewer && det.cid) {
        if (series) {
            const walked = await dmmReadSeries(seriesId, ctx);
            const chosen = walked.volumes.filter((entry) => entry.free
                || (ctx.samplers === true && entry.sample));
            if (!chosen.length) {
                return reject(input, `DMM series ${seriesId} has no volumes free in full`
                    + (ctx.samplers ? ' and no 試し読み samplers' : ' (--download-samplers takes samplers)'));
            }
            return {
                tasks: chosen.map((entry) => dmmEntryTask(input, seriesId, entry,
                    entry.free ? entry.freeStreamingUrl : entry.sampleUrl, !entry.free)),
                rejected: [],
                notes: [],
                streamed: false,
            };
        }
        // A viewer URL names the volume itself; no BFF call is needed. The title
        // is deliberately empty so downloadDmm reads the auth answer's `cti`
        // instead of a synthetic "DMM <id>" that would win over the real name.
        return {
            tasks: [{
                input,
                kind: 'dmm',
                id: `${det.contentId}${det.viewer === 'tachiyomi' ? 'sample' : ''}`,
                contentId: det.contentId,
                seriesId,
                volume: null,
                title: '',
                target: det.url,
                viewerUrl: det.url,
                sample: det.viewer === 'tachiyomi',
            }],
            rejected: [],
            notes: [],
            streamed: false,
        };
    }

    if (!series && det.kind === 'dmm-series') {
        return reject(input, 'that is a DMM series page; add --series to download its free volumes');
    }

    if (det.kind === 'dmm-series' || det.kind === 'dmm-title' || det.kind === 'dmm-latest' || series) {
        const walked = await dmmReadSeries(seriesId, ctx);
        const wantedLatest = det.kind === 'dmm-latest';
        const available = walked.volumes;
        if (!available.length) return reject(input, `DMM series ${seriesId} listed no volumes`);

        if (wantedLatest && !series) {
            const latest = available[available.length - 1];
            const viewer = latest.free ? latest.freeStreamingUrl
                : (ctx.samplers ? latest.sampleUrl : null);
            if (!viewer) {
                return reject(input, `DMM volume "${latest.title || latest.contentId}" is not free right now`
                    + (ctx.samplers ? ' and has no 試し読み sampler' : ' (add --download-samplers for its 試し読み)'));
            }
            return {
                tasks: [dmmEntryTask(input, seriesId, latest, viewer, !latest.free)],
                rejected: [], notes: [], streamed: false,
            };
        }

        const free = available.filter((entry) => entry.free);
        const samples = ctx.samplers ? available.filter((entry) => entry.sample) : [];
        if (!free.length && !samples.length) {
            return reject(input, `DMM series ${seriesId} has ${available.length} volumes and none are free right now`
                + (ctx.samplers ? ' or have a 試し読み sampler' : ' (--download-samplers takes samplers)'));
        }
        const notes = [];
        if (samples.length) {
            notes.push(`  DMM series ${seriesId}: ${free.length} free volume(s), plus ${samples.length} 試し読み sampler(s)`);
        }
        return {
            tasks: [...free.map((entry) => dmmEntryTask(input, seriesId, entry, entry.freeStreamingUrl, false)),
                ...samples.map((entry) => dmmEntryTask(input, seriesId, entry, entry.sampleUrl, true))],
            rejected: [],
            notes,
            streamed: false,
        };
    }

    // A product page (no viewer URL in the address). Ask the BFF for that one
    // volume's own free/sample links. `lastpage/volume` states a free link but
    // not the sampler link live, so a sampler is resolved from the series
    // listing, which carries `tachiyomi_url` on every volume.
    let info = await dmmReadVolumeInfo(seriesId, det.contentId, ctx);
    if (!info.freeStreamingUrl && !info.sampleUrl) {
        const walked = await dmmReadSeries(seriesId, ctx);
        const row = walked.volumes.find((entry) => entry.contentId === info.contentId);
        if (row) info = { ...info, ...row };
    }
    const viewer = info.freeStreamingUrl || (info.sampleUrl && ctx.samplers ? info.sampleUrl : null);
    if (!viewer) {
        return reject(input, `DMM volume "${info.title || info.contentId}" is not free right now`
            + (ctx.samplers ? ' and has no 試し読み sampler' : ' (add --download-samplers for its 試し読み)'));
    }
    const entry = {
        contentId: info.contentId,
        title: info.title,
        volume: info.volume,
    };
    return {
        tasks: [dmmEntryTask(input, seriesId, entry, viewer, !info.freeStreamingUrl)],
        rejected: [], notes: [], streamed: false,
    };
}

async function dmmResolveViewer(task, ctx) {
    if (task.viewerUrl) return task.viewerUrl;
    let info = await dmmReadVolumeInfo(task.seriesId, task.contentId, ctx);
    // `lastpage/volume` states a free link but not the sampler link live, so a
    // product-page sampler is found in the series listing, which carries
    // `tachiyomi_url` for every volume.
    if (!info.freeStreamingUrl && !info.sampleUrl) {
        const walked = await dmmReadSeries(task.seriesId, ctx);
        const row = walked.volumes.find((entry) => entry.contentId === info.contentId);
        if (row) info = { ...info, ...row };
    }
    const viewer = info.freeStreamingUrl || info.sampleUrl;
    if (!viewer) throw new Error(`DMM volume "${info.title || task.contentId}" is not free right now`);
    return viewer;
}

/**
 * Whether a finished folder's descramble state is what this run wants. A run
 * without --no-descramble wants rebuilt pages; --no-descramble wants the raw
 * shuffle. The marker is the only durable record of which one is on disk.
 */
function dmmWantsDescramble(ctx) {
    return ctx?.descramble !== false;
}

function dmmMarkerMatches(marker, want) {
    return Boolean(marker?.descrambled) === Boolean(want)
        && (marker?.descramble || null) === (want ? 'dmm64-v1' : null);
}

function dmmViewerQuery(raw) {
    try {
        const url = new URL(raw);
        return {
            cid: url.searchParams.get('cid') || '',
            lin: url.searchParams.get('lin') || '',
        };
    } catch {
        return { cid: '', lin: '' };
    }
}

export async function downloadDmm(task, ctx = {}) {
    const out = ctx.out;
    if (!out) throw new Error('DMM: ctx.out is required');
    const key = task.key || `dmm:${task.target}`;
    const tell = (event, payload) => {
        if (event === 'update') ctx.progress?.update(key, payload);
        else if (event === 'note') ctx.progress?.note?.(payload);
    };

    const viewerUrl = await timed(ctx.timer, 'prework', () => dmmResolveViewer(task, ctx));
    const parsed = parseDmmViewerUrl(viewerUrl);
    if (!parsed) throw new Error(`DMM viewer URL is not a free_streaming/tachiyomi page: ${viewerUrl}`);

    const jar = new Map();
    let session = await timed(ctx.timer, 'handshake', () => authorizeDmm(viewerUrl, ctx, jar));
    const contentId = task.contentId || parsed.contentId;
    const seriesId = task.seriesId || parsed.seriesId;
    const sample = task.sample === true || parsed.viewer === 'tachiyomi';
    // The direct-viewer path has no BFF volume title. The auth answer carries
    // `cti`, but on a free volume it is "…【無料お試し版】"; strip store labels
    // so the folder matches the BFF/series title.
    const authTitle = String(session.auth.cti || '').replace(/【[^】]*】/g, ' ').replace(/\s+/g, ' ').trim();
    const title = task.title || authTitle || `DMM ${contentId}`;
    const shown = sample && !/試し読み/.test(title) ? `${title}${SAMPLE_SUFFIX}` : title;
    const id = task.id || `${contentId}${sample ? 'sample' : ''}`;

    // One refresh at a time: a 403 means the very short CloudFront signature
    // rolled over, and every request must pick up the same replacement session
    // rather than each spending its own auth round trip. It is shared by the
    // manifest and the page workers because both sit behind the same signature.
    let refreshing = null;
    const refresh = () => {
        if (!refreshing) {
            refreshing = authorizeDmm(viewerUrl, ctx, jar)
                .then((next) => {
                    session = next;
                    return next;
                })
                .finally(() => { refreshing = null; });
        }
        return refreshing;
    };

    // The manifest is behind the same short-lived signature as the pages. A
    // 403 there is the signature rollover, not a permanent refusal, so refresh
    // once and read it again before giving up.
    let manifest = null;
    let manifestRefreshed = false;
    for (;;) {
        try {
            manifest = await timed(ctx.timer, 'prework', () => dmmFetchManifest(session, ctx));
            break;
        } catch (error) {
            if (error?.status === 403 && !manifestRefreshed) {
                manifestRefreshed = true;
                session = await refresh();
                continue;
            }
            throw error;
        }
    }
    const pages = manifest.pages;
    const total = pages.length;
    const volume = task.volume ?? parseVolumeNumber(title);
    const resolution = (() => {
        const first = pages.find((page) => page.width && page.height);
        return first ? `${first.width} × ${first.height}` : '?';
    })();

    // DMM serves a 64×64 tile shuffle, not a finished page. Keeping the wire
    // bytes unless the caller explicitly said --no-descramble is the only
    // honest default: a folder of chessboards looks like a successful run.
    const needsShuffle = pages.some((page) => page.scrambled);
    const descramble = needsShuffle && ctx.descramble !== false;
    if (descramble) assertSharpAvailable();

    // `shown` carries the 試し読み suffix for display and the marker; the folder
    // helper adds that suffix itself, so it gets the bare title or every sampler
    // folder would end up with the suffix twice.
    const folder = await volumeFolder(ctx, { title, id, sample });
    const alreadyPresent = await existingVolume(ctx, {
        store: 'dmm', title, id, sample,
        expectedPages: total, folder, checkRemote: !task.title,
        markerCheck: (marker) => dmmMarkerMatches(marker, descramble),
    });
    if (alreadyPresent) return alreadyPresent;
    // existingVolume already refused a marker whose descramble state differs,
    // but the per-page reuse below still has to know about it: otherwise a
    // --no-descramble folder is "resumed" with zero page fetches and then
    // rewritten as a descrambled volume while the bytes stay shuffled.
    const priorMarker = await readVolumeMarker(folder);
    const rebuildPages = Boolean(priorMarker) && !dmmMarkerMatches(priorMarker, descramble);

    let downloaded = 0;
    let skipped = 0;
    let failed = 0;
    let bytes = 0;
    const failures = [];
    const done = new Set();

    await fsp.mkdir(folder, { recursive: true });
    tell('update', { label: shown, phase: 'downloading', total, done: 0 });

    const work = [];
    for (const [position, page] of pages.entries()) {
        const file = PAGE_NAME(position + 1);
        const full = path.join(folder, file);
        if (!ctx.force && !rebuildPages && await isCompleteImageFile(full)) {
            bytes += (await fsp.stat(full)).size;
            skipped += 1;
            done.add(position);
            continue;
        }
        work.push({ position, page, file, full });
    }
    tell('update', { phase: 'downloading', done: skipped, total, bytes });

    const concurrency = Math.max(1, Math.min(DMM_MAX_CONCURRENCY,
        Number(ctx.dmmConcurrency) || Number(ctx.concurrency) || DMM_DEFAULT_CONCURRENCY));

    await mapLimit(work, concurrency, async (item) => {
        try {
            let buffer;
            let lastError = null;
            // --retries counts attempts after the first, exactly as the help
            // text says; the old fixed 3 ignored it.
            const retryBudget = Number.isFinite(Number(ctx.retries))
                ? Math.max(0, Math.floor(Number(ctx.retries))) : 2;
            const attempts = 1 + Math.min(5, retryBudget);
            let failures = 0;
            let refreshed = false;
            for (;;) {
                try {
                    buffer = await timed(ctx.timer, 'fetch', () => dmmFetchPage(session, item.page, ctx));
                    break;
                } catch (error) {
                    lastError = error;
                    // A 403 refresh replaces the session the request was refused
                    // against, so it does not spend one of the page's retries.
                    if (error.status === 403 && !refreshed) {
                        refreshed = true;
                        await refresh();
                        continue;
                    }
                    failures += 1;
                    if (failures < attempts
                        && (error.status === 429 || error.status >= 500 || error.status == null)) {
                        await backoff(failures);
                        continue;
                    }
                    break;
                }
            }
            if (!buffer) throw lastError || new Error('page fetch failed');
            if (descramble && item.page.scrambled) {
                const rebuilt = await timed(ctx.timer, 'rebuild',
                    () => descrambleDmmPage(buffer, item.page));
                buffer = rebuilt.data;
            }
            await timed(ctx.timer, 'write', () => fsp.writeFile(item.full, buffer));
            downloaded += 1;
            bytes += buffer.length;
            done.add(item.position);
            tell('update', { phase: 'downloading', done: skipped + downloaded, total, bytes });
        } catch (error) {
            failed += 1;
            const message = `page ${item.position + 1}: ${describeError(error)}`;
            failures.push({ file: item.file, error: message });
            tell('update', { phase: 'downloading', failed });
        }
    });

    if (!downloaded && !skipped) {
        throw new Error(`DMM: every one of the ${total} pages of "${shown}" failed to download`
            + (failures.length ? `: ${failures[0].error}` : ''));
    }

    await timed(ctx.timer, 'write', () => writeVolumeMarker(folder, {
        store: 'dmm',
        id,
        contentId,
        seriesId,
        volume,
        title: shown,
        expectedPages: total,
        sample,
        viewer: parsed.viewer,
        pages: total,
        descrambled: descramble,
        descramble: descramble ? 'dmm64-v1' : null,
    }));

    if (downloaded) await stampPageTimes(folder, Array.from({ length: total }, (_, i) => PAGE_NAME(i + 1)));

    return {
        store: 'dmm',
        id,
        title: shown,
        folder,
        sample,
        contentId,
        seriesId,
        volume,
        viewer: parsed.viewer,
        resolution,
        descrambled: descramble,
        totalPages: total,
        downloaded,
        skipped,
        failed,
        bytes,
        failures,
    };
}

export const platform = {
    name: 'DMMブックス',
    id: 'dmm',
    label: 'DMM',
    lane: 'net',
    tuning: {
        concurrency: DMM_DEFAULT_CONCURRENCY,
        contextKey: 'dmmConcurrency',
        cpuWeight: 0.5,
        flag: {
            name: 'dmm-concurrency',
            order: 6,
            max: DMM_MAX_CONCURRENCY,
            help: 'DMM page downloads in flight, 1-32',
            hint: '; DMM signs its CDN URLs for a short window, so a modest number keeps refreshes rare',
        },
    },
    hosts: ['book.dmm.com'],
    patterns: [
        {
            re: /book\.dmm\.com\/product\/(\d+)\/([a-z0-9]+)\/(free_streaming|tachiyomi)\/?/i,
            kind: 'dmm-volume',
            build: (m, raw) => ({
                kind: 'dmm-volume',
                seriesId: m[1],
                contentId: m[2],
                viewer: m[3].toLowerCase(),
                ...dmmViewerQuery(raw),
                url: raw,
            }),
        },
        {
            re: /book\.dmm\.com\/product\/(\d+)\/latest\/?/i,
            kind: 'dmm-latest',
            build: (m, raw) => ({ kind: 'dmm-latest', seriesId: m[1], url: raw }),
        },
        {
            re: /book\.dmm\.com\/product\/(\d+)\/(?:volumes\/?)?(?:\?|#|$)/i,
            kind: 'dmm-series',
            build: (m, raw) => ({ kind: 'dmm-series', seriesId: m[1], url: raw }),
        },
        {
            re: /book\.dmm\.com\/product\/(\d+)\/([a-z0-9]+)\/?/i,
            kind: 'dmm-volume',
            build: (m, raw) => ({
                kind: 'dmm-volume',
                seriesId: m[1],
                contentId: m[2],
                viewer: null,
                url: raw,
            }),
        },
    ],
    volumeId: (det) => det.contentId ?? null,
    // The run pre-check asks the store whether a folder is finished; DMM can
    // hold either the raw shuffle or rebuilt pages under the same .jpg names.
    markerCheck: (marker, ctx) => dmmMarkerMatches(marker, ctx?.descramble !== false),
    // Only a page that names one volume (a viewer URL) or the series' latest
    // can be resolved without --series. A series page must go through the
    // --series guard in run.js instead of quietly downloading the free run.
    expand: (det) => det.kind === 'dmm-latest'
        || (det.kind === 'dmm-volume' && Boolean(det.cid)),
    series: (det, input, ctx = {}) => resolveDmmInput(det, { ...ctx.config, series: true }, input, ctx),
    resolve: (det, config, input, ctx) => resolveDmmInput(det, config, input, ctx),
    download: downloadDmm,
};
