/**
 * The Kindle adapter, driven against a synthetic reader.
 *
 * `test_kindle_protocol.mjs` covers the pure protocol; this covers the parts that
 * only exist once bytes move: the window walk and its shrink ladder, the
 * pipelined page queue, reading order on disk, resume, and the byte accounting.
 *
 * The service is a stub `fetch`, so this runs offline and needs no account. The
 * stub answers the same shapes the real reader does, including the two failure
 * modes that shape the walk: a 400 for a window that is too big, and a 200 with no
 * pages for an anchor the service cannot place.
 */

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { check, checkEqual, finish } from './_harness.mjs';
import {
    downloadKindle,
    kindleBorrow,
    kindleIsFree,
    kindleLibraryLoans,
    kindleVolumeOffer,
    loadKindleSession,
    openKindleVolume,
    resolveKindleSeries,
} from '../src/download/kindle.js';

// ---------------------------------------------------------------------------
// The synthetic book: three source images over two views in two windows.
// ---------------------------------------------------------------------------

const ASIN = 'B090000001';
/** Neither owned nor borrowable, but it publishes a 試し読み sampler. */
const SAMPLER_ASIN = 'B090000008';
const SAMPLE_REVISION = 'c1f53b46';
const REVISION = 'c5bd2d88';

/** Distinct sizes, so a wrong byte total cannot coincide with a right one. */
function fakeJpeg(size, marker) {
    const body = Buffer.alloc(size, marker);
    body[0] = 0xFF; body[1] = 0xD8; body[2] = 0xFF;
    body[body.length - 2] = 0xFF; body[body.length - 1] = 0xD9;
    return body;
}
const PAGES = {
    'resource/rsrc1AT': fakeJpeg(40_000, 1),
    'resource/rsrc1AV': fakeJpeg(25_000, 2),
    'resource/rsrc1AX': fakeJpeg(10_000, 3),
};
const PAGE_BYTES = Object.values(PAGES).reduce((a, b) => a + b.length, 0);

const RESOURCES = Object.keys(PAGES).map((url) => ({
    url,
    type: 'IMAGE_PNG',
    authParameter: `Policy=${Buffer.from(JSON.stringify({
        Statement: [{ Resource: `https://cdn.test/${url}`, Condition: { DateLessThan: { 'AWS:EpochTime': 2_000_000_000 } } }],
    })).toString('base64').replace(/=+$/, '')}&Signature=sig&Key-Pair-Id=K1`,
}));

const WINDOWS = [
    {
        skip: 0,
        views: [
            { sectionId: 788, startPositionId: 1, endPositionId: 1, children: [{ type: 'image', imageReference: 'resource/rsrc1AT', rect: { top: 0, left: 0, bottom: 1200, right: 880 } }] },
            {
                sectionId: 789,
                startPositionId: 3,
                endPositionId: 5,
                children: [
                    { type: 'group', rect: { top: 0, left: 0, bottom: 1200, right: 760 } },
                    { type: 'image', imageReference: 'resource/rsrc1AV', rect: { top: 0, left: 0, bottom: 1200, right: 760 } },
                    { type: 'group', rect: { top: 0, left: 0, bottom: 1200, right: 760 } },
                    { type: 'image', imageReference: 'resource/rsrc1AX', rect: { top: 0, left: 0, bottom: 1200, right: 760 } },
                ],
            },
        ],
    },
];

// ---------------------------------------------------------------------------
// A tiny tar writer, matching the reader's own bundle shape.
// ---------------------------------------------------------------------------

function tarMember(name, body) {
    const data = Buffer.isBuffer(body) ? body : Buffer.from(String(body), 'utf8');
    const header = Buffer.alloc(512);
    header.write(name, 0, 'utf8');
    header.write('0000644', 100, 'utf8');
    header.write('0000000', 108, 'utf8');
    header.write('0000000', 116, 'utf8');
    header.write(`${data.length.toString(8).padStart(11, '0')} `, 124, 'utf8');
    header.write('00000000000 ', 136, 'utf8');
    header.write('        ', 148, 'utf8');
    header.write('0', 156, 'utf8');
    header.write('ustar\0', 257, 'utf8');
    header.write('00', 263, 'utf8');
    const padded = Buffer.alloc(Math.ceil(data.length / 512) * 512);
    data.copy(padded);
    return Buffer.concat([header, padded]);
}

function renderBundle(window) {
    const parts = [
        tarMember('./page_data_0_1.json', JSON.stringify(window.views)),
        tarMember('./manifest.json', JSON.stringify({
            revision: REVISION,
            asin: ASIN,
            cdn: { baseUrl: 'https://cdn.test', authParameter: null, isEncrypted: false },
            cdnResources: RESOURCES,
        })),
        tarMember('./metadata.json', JSON.stringify({
            bookTitle: 'テスト漫画 2 (テストコミックス)',
            authors: ['テスト作者'],
            lang: 'ja',
            firstPositionId: 0,
            lastPositionId: 5,
            progressionDirection: 'rtl',
        })),
        tarMember('./location_map.json', JSON.stringify({ locations: [0, 3, 5, 7] })),
        Buffer.alloc(1024),
    ];
    return Buffer.concat(parts);
}

const BOOKINFO = {
    asin: ASIN,
    title: 'テスト漫画 2 (テストコミックス)',
    seriesAsin: 'B090000003',
    contentGuid: REVISION,
    bookAccessMethod: 'LIMITED_TIME_FREE',
    isSample: false,
    karamelToken: { token: 'K'.repeat(1244), expiresAt: 1_790_541_465_015 },
    cdnPrefetchInfo: JSON.stringify({ cdn: { baseUrl: 'https://cdn.test', authParameter: null, isEncrypted: false } }),
};

/** Every render call the stub answered, so the shrink ladder can be asserted. */
const renderCalls = [];
let badAnchorOnce = false;

// ---------------------------------------------------------------------------
// The Kindle Unlimited half of the stub service
//
// The borrow is the only call that changes account state, so the stub keeps that
// state explicitly (`borrowed`/`loans`) and every scenario flips a single knob on
// it. `readerPageFor` is what makes an unborrowed KU volume look like a volume
// this account cannot open -- no content revision, no reading token -- because
// that is exactly how the reader answers, and it is the reason the borrow path
// exists at all.
// ---------------------------------------------------------------------------

const SERIES_ASIN = 'B090000003';
const KU_ASIN = 'B090000007';
const KU2_ASIN = 'B090000006';
const NONKU_ASIN = 'B0NONKU001';
const OWNED_ASIN = 'B0OWNED001';
const KU_REVISION = 'd41d8cd9';
const NEXT_IN_SERIES = { [ASIN]: KU_ASIN, [KU_ASIN]: NONKU_ASIN };

const service = {
    /** Volumes the stub currently has on loan, as `asin -> loanId`. */
    loans: new Map(),
    /** Volumes the stub has borrowed at some point, so the reader page opens them. */
    borrowed: new Set(),
    /** Volumes whose product page carries the KU widget. */
    kuOffers: new Set(),
    /**
     * Volumes that publish a 試し読み sampler. Only *some* do -- a volume with
     * neither a sampler nor KU access is the ordinary unopenable case, and it has
     * to stay distinguishable or the error path can never be tested.
     */
    samplerAsins: new Set(),
    /** Volumes whose borrow the service refuses. */
    borrowRefused: new Set(),
    /**
     * Volumes this account can already read in full: bought, or on a live Kindle
     * Unlimited loan. The reader serves them and the hop reports `FULL_BOOK`.
     */
    ownedAsins: new Set(),
    /** Per-test series chain, overriding NEXT_IN_SERIES when set. */
    nextInSeries: null,
    /** Reader-page requests still to fail with a transport error before succeeding. */
    readerFlakes: 0,
    /** Borrow POSTs still to fail with a transport error before succeeding. */
    borrowFlakes: 0,
    /** Volumes whose render the service fails, to prove the return still happens. */
    downloadFailsFor: new Set(),
    /** When false, the return mutation answers `success: false`. */
    returnSuccess: true,
    offersFetched: [],
    /** Reader pages read, as `asin` strings, so the sample route can be proven. */
    readerPages: [],
    /** Reader-page requests issued, including ones that never got an answer. */
    readerAttempts: 0,
    /** Reader pages read specifically through `?sample=1`. */
    samplePages: [],
    borrowCalls: [],
    returnBatches: [],
    libraryCalls: 0,
    libraryPageCalls: 0,
    nextLoan: 0,
    csrfStaleOnce: false,
};

function kuProductPage(asin) {
    // The widget as `P.declare` receives it: a bare outer key, and a CSRF token
    // whose base64 carries `+`, `/` and `==`, which is what a naive brace scan
    // gets wrong.
    return '<html><body><script>P.declare(\'KU-DP-BottomSheet-Context\', { widgetContext: {'
        + `"ASIN": "${asin}", "PROGRAM": "KINDLE_UNLIMITED", "CHANNEL": "ALL_YOU_CAN_READ", `
        + `"BORROW_SUB_TYPE": "KINDLE_UNLIMITED", "CSRF_TOKEN": "widget-${asin}+token/part=="`
        + ' }})</script></body></html>';
}

function readerPageFor(asin, sampleRoute = false) {
    const info = { ...BOOKINFO, asin, title: asin === ASIN ? BOOKINFO.title : `测试漫画 ${asin}` };
    if (sampleRoute && service.samplerAsins.has(asin)) {
        // Mirror of the real capture: the plain page carries no revision and no
        // token, and `?sample=1` carries both -- with `isSample` still false and
        // `bookAccessMethod: "SAMPLE"` doing the talking, which is exactly the
        // shape that would silently select the wrong content type if missed.
        //
        // Note this answers for an unborrowed KU volume too, which is what makes
        // "borrow before sampling" a real ordering requirement rather than a
        // stylistic one: measured, `B090000007` serves revision `c2556215` here.
        info.contentGuid = asin === SAMPLER_ASIN ? SAMPLE_REVISION : KU_REVISION;
        info.bookAccessMethod = 'SAMPLE';
        info.isSample = false;
        return `<html><body><script type="application/json" id="bookInfo">${JSON.stringify(info)}</script></body></html>`;
    }
    if (service.ownedAsins.has(asin)) {
        info.contentGuid = KU_REVISION;
        info.bookAccessMethod = 'FULL_BOOK';
        info.isSample = false;
    } else if (asin !== ASIN && !service.borrowed.has(asin)) {
        delete info.contentGuid;
        delete info.karamelToken;
        info.bookAccessMethod = 'SAMPLE';
        info.isSample = true;
    } else if (asin !== ASIN) {
        // Borrowed: the reader now serves the reading token it would not before.
        info.contentGuid = KU_REVISION;
        info.bookAccessMethod = 'PURCHASE';
        info.isSample = false;
    }
    return `<html><body><script type="application/json" id="bookInfo">${JSON.stringify(info)}</script></body></html>`;
}

const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init = {}) => {
    const parsed = new URL(String(url));

    // ---- the store: product page, borrow, library, reader API ----
    if (parsed.hostname === 'www.amazon.co.jp' && parsed.pathname.startsWith('/dp/')) {
        const asin = parsed.pathname.split('/')[2]?.toUpperCase() || '';
        service.offersFetched.push(asin);
        return new Response(service.kuOffers.has(asin) ? kuProductPage(asin) : '<html><body>商品ページ</body></html>',
            { status: 200, headers: { 'content-type': 'text/html' } });
    }
    if (parsed.pathname.startsWith('/kindle-dbs/hz/ajax/returnAndBorrow')) {
        if (service.borrowFlakes > 0) {
            service.borrowFlakes -= 1;
            throw new TypeError('fetch failed');
        }
        const payload = JSON.parse(String(init.body));
        const item = payload[0] || {};
        service.borrowCalls.push({
            asin: item.asin,
            program: item.program,
            channel: item.channel,
            loanId: item.loanId,
            csrf: init.headers?.['x-csrftoken'],
        });
        if (service.borrowRefused.has(item.asin)) {
            return new Response(JSON.stringify({
                succeededResults: [],
                failedResults: [{ requestedBorrowAsin: item.asin, workflowResponse: { resultCode: 'KLU_NOT_ELIGIBLE' } }],
                allSucceeded: false,
            }), { status: 200 });
        }
        service.nextLoan += 1;
        const loanId = `LOAN${String(service.nextLoan).padStart(3, '0')}`;
        service.loans.set(item.asin, loanId);
        service.borrowed.add(item.asin);
        return new Response(JSON.stringify({
            succeededResults: [{
                requestedBorrowAsin: item.asin,
                workflowResponse: { resultCode: 'KLU_BORROW_SUCCEEDED', suggestedReturnLoanId: null },
            }],
            failedResults: [],
            allSucceeded: true,
        }), { status: 200 });
    }
    if (parsed.pathname === '/your-books') {
        service.libraryPageCalls += 1;
        const token = `reader-token-${service.libraryPageCalls}`;
        return new Response('<!-- sp:csrf --><meta name="anti-csrftoken-a2z" '
            + `content="${token}" id="kindle-reader-api" >`, { status: 200 });
    }
    if (parsed.pathname === '/kindle-reader-api') {
        const token = init.headers?.['anti-csrftoken-a2z'];
        // A stale token is refused once, so the re-scrape path is exercised for
        // real rather than assumed.
        if (service.csrfStaleOnce) {
            service.csrfStaleOnce = false;
            return new Response('{"errors":[{"message":"Invalid CSRF token"}]}', { status: 403 });
        }
        const payload = JSON.parse(String(init.body));
        if (String(payload.query).includes('mycdBulkReturnBorrow')) {
            const loanIds = [...String(payload.query).matchAll(/loanId: "([^"]+)"/g)].map((m) => m[1]);
            service.returnBatches.push(loanIds);
            if (!service.returnSuccess) {
                return new Response(JSON.stringify({ data: { mycdBulkReturnBorrow: { success: false } } }), { status: 200 });
            }
            for (const [asin, loanId] of [...service.loans]) {
                if (loanIds.includes(loanId)) service.loans.delete(asin);
            }
            return new Response(JSON.stringify({ data: { mycdBulkReturnBorrow: { success: true } } }), { status: 200 });
        }
        service.libraryCalls += 1;
        const edges = [...service.loans].map(([asin, acquisitionId]) => ({
            node: {
                asin,
                acquisitionId,
                relationshipType: 'ITEM_OWNER',
                relationshipSubType: ['KindleUnlimited'],
                __typename: 'CustomerLibraryBorrowedSingleBookNode',
            },
        }));
        return new Response(JSON.stringify({
            data: {
                getCustomerLibrary: {
                    books: {
                        pageInfo: { hasNextPage: false, endCursor: '' },
                        totalCount: { number: edges.length, relation: 'EQUAL' },
                        edges,
                    },
                },
            },
        }), { status: 200 });
    }

    // ---- the reader ----
    if (parsed.hostname === 'read.amazon.co.jp' && parsed.pathname.startsWith('/api/manga/get-series-data/')) {
        const asin = parsed.pathname.split('/').pop();
        // Measured live: a series answers `seriesType: "VOLUMES"` with a size,
        // while a volume answers with its OWN descriptor -- not a 404 -- saying
        // `seriesType: "UNKNOWN"`, `seriesSize: 0`. Being able to tell those two
        // apart is what lets an unopenable volume reach the borrow path.
        return new Response(JSON.stringify(asin === SERIES_ASIN
            ? { asin, title: 'テスト漫画', seriesSize: 3, seriesType: 'VOLUMES' }
            : { asin, title: `テスト漫画 ${asin}`, seriesSize: 0, seriesType: 'UNKNOWN' }), { status: 200 });
    }
    if (parsed.hostname === 'read.amazon.co.jp' && parsed.pathname === '/api/manga/open-book') {
        const hopFrom = parsed.searchParams.get('asin');
        const next = service.nextInSeries?.[hopFrom] ?? NEXT_IN_SERIES[hopFrom];
        if (!next) return new Response('', { status: 204 });
        // Every volume after the entry one is reported SAMPLE, which is what the
        // reader says for an unborrowed KU volume and for one this account cannot
        // read at all -- the two are indistinguishable from here, which is why the
        // downloader probes the store page.
        return new Response(JSON.stringify({
            asin: next,
            bookAccessMethod: service.ownedAsins.has(next) ? 'FULL_BOOK' : 'SAMPLE',
        }), { status: 200 });
    }
    if (parsed.hostname === 'read.amazon.co.jp' && parsed.pathname.startsWith('/manga/')) {
        service.readerAttempts += 1;
        if (service.readerFlakes > 0) {
            service.readerFlakes -= 1;
            throw new TypeError('fetch failed');
        }
        const asin = parsed.pathname.split('/')[2]?.toUpperCase() || '';
        const sampleRoute = parsed.searchParams.get('sample') === '1';
        service.readerPages.push(asin);
        if (sampleRoute) service.samplePages.push(asin);
        return new Response(readerPageFor(asin, sampleRoute), { status: 200, headers: { 'content-type': 'text/html' } });
    }
    if (parsed.pathname === '/renderer/render') {
        const numPage = Number(parsed.searchParams.get('numPage'));
        const skip = Number(parsed.searchParams.get('skipPageCount'));
        const renderAsin = parsed.searchParams.get('asin');
        renderCalls.push({
            numPage,
            skip,
            token: init.headers?.['x-amz-rendering-token'],
            asin: renderAsin,
            contentType: parsed.searchParams.get('contentType'),
        });
        // The service refuses an oversized window rather than clamping it.
        if (numPage > 6) {
            return new Response(JSON.stringify({ message: 'Unexpected number of pages' }), { status: 400 });
        }
        if (service.downloadFailsFor.has(renderAsin)) {
            return new Response(JSON.stringify({ message: 'Not Found' }), { status: 404 });
        }
        const window = WINDOWS.find((w) => w.skip === skip);
        if (!window || skip > 0) {
            // Past the last window the service answers metadata with no pages.
            return new Response(renderBundle({ views: [] }), { status: 200 });
        }
        if (badAnchorOnce) {
            // An anchor the service cannot place is a 200 with no pages, not a 400.
            badAnchorOnce = false;
            return new Response(renderBundle({ views: [] }), { status: 200 });
        }
        return new Response(renderBundle(window), { status: 200 });
    }
    if (parsed.hostname === 'cdn.test') {
        const key = parsed.pathname.replace(/^\//, '');
        const body = PAGES[key];
        if (!body) return new Response('no such resource', { status: 404 });
        return new Response(body, { status: 200, headers: { 'content-type': 'application/octet-stream' } });
    }
    return new Response('unexpected ' + parsed.href, { status: 500 });
};

/** Put the account back on an empty shelf between scenarios. */
function resetService() {
    service.loans.clear();
    service.borrowed.clear();
    service.borrowRefused.clear();
    service.downloadFailsFor.clear();
    service.ownedAsins = new Set();
    service.nextInSeries = null;
    service.readerFlakes = 0;
    service.borrowFlakes = 0;
    service.readerAttempts = 0;
    service.kuOffers = new Set();
    // Both of these publish a sampler on the real service; the KU one
    // additionally carries the store widget, so it is the volume that proves
    // borrowing is tried first.
    service.samplerAsins = new Set([SAMPLER_ASIN, KU_ASIN]);
    service.returnSuccess = true;
    service.offersFetched.length = 0;
    service.borrowCalls.length = 0;
    service.returnBatches.length = 0;
    service.libraryCalls = 0;
    service.libraryPageCalls = 0;
    service.nextLoan = 0;
    service.csrfStaleOnce = false;
}

const out = fs.mkdtempSync(path.join(os.tmpdir(), 'dokuha-kindle-'));
const session = { cookie: 'session-id=1; at-acbjp=x', source: 'argument', stateFile: null };

try {
    const first = await downloadKindle({ asin: ASIN, key: `kindle:${ASIN}` }, { out, titleDir: true, kindleSession: session, kdlConcurrency: 4 });

    checkEqual('the volume is named from its own metadata', first.title, BOOKINFO.title);
    checkEqual('every source page image is written', first.walkedPages, 3);
    check('a page image is what gets counted', first.downloaded === 3 && first.skipped === 0 && first.failed === 0,
        `downloaded=${first.downloaded} skipped=${first.skipped} failed=${first.failed}`);
    // The regression this test exists for: a shared accumulator updated with
    // `bytes += (await ...).size` loses every concurrent worker's contribution but
    // the last, so a real 44 MB volume reported ~4 MB.
    checkEqual('the byte total is the sum of the pages, not one worker\'s share', first.bytes, PAGE_BYTES);
    check('the byte total is not a fraction of the truth', first.bytes > PAGE_BYTES / 2, String(first.bytes));

    const written = (await fsp.readdir(first.folder)).filter((f) => f.endsWith('.jpg')).sort();
    // One scheme across every store now: `page-0001.jpg`, one-based and four
    // digits wide. It used to be `page_0001.jpg` here, and since `-` sorts before
    // `_` a library holding two stores had no single order.
    checkEqual('pages are numbered from one, four digits wide, dash-prefixed',
        written, ['page-0001.jpg', 'page-0002.jpg', 'page-0003.jpg']);

    // The names sort right, but the pages are fetched by concurrent workers and so
    // land in completion order. A reader sorting by date has to agree with one
    // sorting by name.
    const byTime = (await Promise.all(written.map(async (f) => ({
        f, t: (await fsp.stat(path.join(first.folder, f))).mtimeMs,
    })))).sort((a, b) => a.t - b.t).map((x) => x.f);
    checkEqual('a date sort is reading order too', byTime, written);

    const onDisk = await Promise.all(written.map(async (f) => (await fsp.stat(path.join(first.folder, f))).size));
    checkEqual('what is on disk is the sum that was reported',
        onDisk.reduce((a, b) => a + b, 0), first.bytes);

    // Reading order: the cover, then the spread's two pages in array order.
    const firstPage = await fsp.readFile(path.join(first.folder, 'page-0001.jpg'));
    const secondPage = await fsp.readFile(path.join(first.folder, 'page-0002.jpg'));
    check('the first page on disk is the first image in the manifest', firstPage.equals(PAGES['resource/rsrc1AT']));
    check('a 2-up spread keeps the children order it arrived in', secondPage.equals(PAGES['resource/rsrc1AV']));

    const marker = JSON.parse(await fsp.readFile(path.join(first.folder, 'metadata.json'), 'utf8'));
    checkEqual('the folder records its owner', marker.id, ASIN);
    checkEqual('the folder records the series it belongs to', marker.seriesAsin, 'B090000003');
    checkEqual('the folder records the revision it was rendered from', marker.revision, REVISION);
    checkEqual('the folder records how many pages it holds', marker.pages, 3);

    check('an oversized window is halved rather than abandoned',
        renderCalls.some((c) => c.numPage > 6) && renderCalls.some((c) => c.numPage <= 6),
        JSON.stringify(renderCalls.map((c) => c.numPage)));
    check('the render carries the reading token', renderCalls[0].token === BOOKINFO.karamelToken.token);

    // A second run must reuse what is on disk, and must still report the same size.
    const second = await downloadKindle({ asin: ASIN, key: `kindle:${ASIN}` }, { out, titleDir: true, kindleSession: session, kdlConcurrency: 4 });
    check('a second run downloads nothing', second.downloaded === 0 && second.skipped === 3,
        `downloaded=${second.downloaded} skipped=${second.skipped}`);
    checkEqual('a resumed run reports the same byte total', second.bytes, PAGE_BYTES);

    // A truncated page must be re-fetched rather than kept.
    await fsp.writeFile(path.join(first.folder, 'page-0002.jpg'), Buffer.from([0xff, 0xd8, 0xff, 0x00]));
    const third = await downloadKindle({ asin: ASIN, key: `kindle:${ASIN}` }, { out, titleDir: true, kindleSession: session, kdlConcurrency: 4 });
    check('a truncated page is re-fetched, not trusted', third.downloaded === 1 && third.skipped === 2,
        `downloaded=${third.downloaded} skipped=${third.skipped}`);
    checkEqual('the repaired page is the real page again',
        await fsp.readFile(path.join(first.folder, 'page-0002.jpg')), PAGES['resource/rsrc1AV']);
    checkEqual('the repaired run reports the full total again', third.bytes, PAGE_BYTES);

    // No session is the one failure that must not look like anything else.
    let sessionError = '';
    try {
        await downloadKindle({ asin: ASIN, key: 'k' }, { out, titleDir: true, kindleSession: { cookie: '', source: 'none' } });
    } catch (error) {
        sessionError = error.message;
    }
    check('a missing session is reported as a missing session',
        /signed-in session is required/.test(sessionError) && /--kindle-cookie/.test(sessionError), sessionError);

    // `--force` re-fetches everything.
    const forced = await downloadKindle({ asin: ASIN, key: `kindle:${ASIN}` }, { out, titleDir: true, force: true, kindleSession: session, kdlConcurrency: 4 });
    check('force re-downloads every page', forced.downloaded === 3 && forced.skipped === 0,
        `downloaded=${forced.downloaded} skipped=${forced.skipped}`);

    // The render ceiling is a property of the content, not of the volume, so the
    // shrink ladder only has to be paid once per run. A second volume sharing the
    // driver's context must start where the first one settled; a stale guess is
    // still safe, because an oversized window is refused and halved as before.
    resetService();
    renderCalls.length = 0;
    const shared = { out, titleDir: true, force: true, kindleSession: session, kdlConcurrency: 4, kindleBatch: { size: 0 } };
    await downloadKindle({ asin: ASIN, key: `kindle:${ASIN}` }, shared);
    check('the first volume discovers the window ceiling',
        renderCalls.some((c) => c.numPage > 6), JSON.stringify(renderCalls.map((c) => c.numPage)));
    checkEqual('and records it on the shared context', shared.kindleBatch.size, 6);

    renderCalls.length = 0;
    await downloadKindle({ asin: ASIN, key: `kindle:${ASIN}` }, shared);
    check('a later volume never asks above the learned ceiling',
        renderCalls.length > 0 && renderCalls.every((c) => c.numPage <= 6),
        JSON.stringify(renderCalls.map((c) => c.numPage)));
    check('a later volume still walks every page',
        renderCalls.some((c) => c.numPage === 6), JSON.stringify(renderCalls.map((c) => c.numPage)));

    // -----------------------------------------------------------------------
    // Kindle Unlimited: borrow, download, return
    //
    // The per-run state the driver seeds; each scenario gets its own, exactly as
    // a separate run would, so one scenario cannot settle another's eligibility.
    // -----------------------------------------------------------------------
    const kuState = () => ({ available: null, csrf: null, offers: new Map() });
    // `force` because every scenario writes into the same output directory: the
    // second run of the same ASIN would otherwise resume from the first run's
    // complete pages and report nothing downloaded.
    const kuCtx = (ku) => ({ out, titleDir: true, force: true, kindleSession: session, kdlConcurrency: 4, kindleUnlimited: ku });

    // 1. The whole cycle: the reader refuses to open the volume, the store page
    //    supplies the offer, the borrow releases the token, and the loan goes
    //    back afterwards.
    resetService();
    service.kuOffers.add(KU_ASIN);
    const ku = kuState();
    const borrowed = await downloadKindle({ asin: KU_ASIN, key: `kindle:${KU_ASIN}` }, kuCtx(ku));
    checkEqual('a borrowed KU volume downloads its pages', borrowed.downloaded, 3);
    checkEqual('a borrowed KU volume reports its real byte total', borrowed.bytes, PAGE_BYTES);
    checkEqual('the borrow was attempted exactly once', service.borrowCalls.length, 1);
    checkEqual('the borrow echoed the widget programme and channel',
        [service.borrowCalls[0].program, service.borrowCalls[0].channel], ['KINDLE_UNLIMITED', 'ALL_YOU_CAN_READ']);
    checkEqual('the borrow used the widget CSRF token, not the reader-api one',
        service.borrowCalls[0].csrf, `widget-${KU_ASIN}+token/part==`);
    checkEqual('the borrow sent the empty loanId the capture sends', service.borrowCalls[0].loanId, '');
    check('the return request was issued', service.returnBatches.length === 1, JSON.stringify(service.returnBatches));
    checkEqual('the return carried the loan id the library published', service.returnBatches[0], ['LOAN001']);
    check('the volume is off the shelf afterwards', service.loans.size === 0, JSON.stringify([...service.loans]));
    checkEqual('the run learned that this account can borrow', ku.available, true);
    // The stub answers `?sample=1` for this same volume, exactly as the live
    // service does (`B090000007` serves revision `c2556215` there). Borrowing has
    // to win: sampling first would save trial pages where the whole book was
    // available, and nothing else in this file would notice.
    check('a KU volume with a sampler is borrowed, not sampled',
        borrowed?.sample !== true && service.borrowCalls.length === 1,
        `sample=${borrowed?.sample} borrows=${service.borrowCalls.length}`);
    check('the borrowed volume is the full book, not the trial pages',
        (borrowed?.totalPages || 0) > 0 && service.samplePages.filter((a) => a === KU_ASIN).length === 0,
        `pages=${borrowed?.totalPages} sampleReads=${JSON.stringify(service.samplePages)}`);

    // 2. The assertion this file exists for: a download that fails must still
    //    hand the volume back. Leaving it borrowed is the one outcome that must
    //    not happen, and this is the only path that can leak a loan.
    resetService();
    service.kuOffers.add(KU_ASIN);
    service.downloadFailsFor.add(KU_ASIN);
    let downloadError = '';
    try {
        await downloadKindle({ asin: KU_ASIN, key: `kindle:${KU_ASIN}` }, kuCtx(kuState()));
    } catch (error) {
        downloadError = error.message;
    }
    check('a volume whose render fails is reported as a failure', /HTTP 404/.test(downloadError), downloadError);
    checkEqual('the loan really was created before the download failed', service.borrowCalls.length, 1);
    checkEqual('the volume is returned despite the failed download', service.returnBatches, [['LOAN001']]);
    check('a failed download leaves nothing on the shelf', service.loans.size === 0, JSON.stringify([...service.loans]));

    // 3. A volume that is simply not a KU title must not be borrowed at all, and
    //    must still report the reader's own, usable explanation.
    resetService();
    const kuNon = kuState();
    let nonKuError = null;
    try {
        await downloadKindle({ asin: NONKU_ASIN, key: `kindle:${NONKU_ASIN}` }, kuCtx(kuNon));
    } catch (error) {
        nonKuError = error;
    }
    check('a non-KU volume still reports the reader\'s own error',
        /published no reading token/.test(nonKuError?.message || ''), nonKuError?.message);
    check('a non-KU volume is not blamed on Kindle Unlimited',
        !/Kindle-Unlimited-only/.test(nonKuError?.message || ''), nonKuError?.message);
    checkEqual('the original machine-readable marker survives', nonKuError?.code, 'KINDLE_NO_TOKEN');
    checkEqual('a non-KU volume is never borrowed', service.borrowCalls.length, 0);
    checkEqual('its product page was probed once', service.offersFetched, [NONKU_ASIN]);
    checkEqual('one title does not condemn the whole account', kuNon.available, null);

    // 4. An account that cannot borrow is asked once per run, not once per
    //    volume -- and the long explanation is printed once too.
    resetService();
    service.kuOffers.add(KU_ASIN);
    service.kuOffers.add(KU2_ASIN);
    service.borrowRefused.add(KU_ASIN);
    const kuRefused = kuState();
    let firstRefusal = null;
    try {
        await downloadKindle({ asin: KU_ASIN, key: `kindle:${KU_ASIN}` }, kuCtx(kuRefused));
    } catch (error) {
        firstRefusal = error;
    }
    check('the refusal explains Kindle Unlimited once',
        /Kindle-Unlimited-only/.test(firstRefusal?.message || ''), firstRefusal?.message);
    check('the refusal names the code the service answered',
        /KLU_NOT_ELIGIBLE/.test(firstRefusal?.message || ''), firstRefusal?.message);
    checkEqual('the account is remembered as unable to borrow', kuRefused.available, false);

    const offersBefore = service.offersFetched.length;
    let secondRefusal = null;
    try {
        await downloadKindle({ asin: KU2_ASIN, key: `kindle:${KU2_ASIN}` }, kuCtx(kuRefused));
    } catch (error) {
        secondRefusal = error;
    }
    checkEqual('a later volume is not asked to borrow again', service.borrowCalls.length, 1);
    checkEqual('a later volume does not even fetch its product page', service.offersFetched.length, offersBefore);
    check('the later volume gets the reader\'s original error, not the essay again',
        /published no reading token/.test(secondRefusal?.message || '')
        && !/Kindle-Unlimited-only/.test(secondRefusal?.message || ''), secondRefusal?.message);
    checkEqual('the later error keeps the original marker', secondRefusal?.code, 'KINDLE_NO_TOKEN');

    // 5. Two volumes borrowed and downloaded in parallel hand their loans back in
    //    one bulk mutation, not one call each.
    resetService();
    service.kuOffers.add(KU_ASIN);
    service.kuOffers.add(KU2_ASIN);
    const kuBatch = kuState();
    const both = await Promise.all([
        downloadKindle({ asin: KU_ASIN, key: `kindle:${KU_ASIN}` }, kuCtx(kuBatch)),
        downloadKindle({ asin: KU2_ASIN, key: `kindle:${KU2_ASIN}` }, kuCtx(kuBatch)),
    ]);
    check('both KU volumes downloaded', both.every((record) => record.downloaded === 3),
        JSON.stringify(both.map((r) => r.downloaded)));
    checkEqual('two returns went out as one bulk call', service.returnBatches.length, 1);
    checkEqual('the one call carried both loans', [...service.returnBatches[0]].sort(), ['LOAN001', 'LOAN002']);
    check('the shelf is empty after the batch', service.loans.size === 0, JSON.stringify([...service.loans]));
    checkEqual('one library read served both loan lookups', service.libraryCalls, 1);

    // 6. `--series` must pick up the KU volumes, not only the free ones, and must
    //    not borrow anything while merely resolving the list.
    resetService();
    service.kuOffers.add(KU_ASIN);
    const resolved = await resolveKindleSeries(
        { asin: ASIN, url: `https://read.amazon.co.jp/manga/${ASIN}` },
        {},
        { session },
    );
    // Kindle Unlimited is granted per volume, not per series, so the entry
    // volume's widget cannot answer for the rest: a volume with no widget of its
    // own is not borrowable and must not be queued as a candidate. Letting the
    // first answer stand for all of them tagged a 20-volume series Unlimited when
    // only 8 volumes were, which queued borrows that could never succeed and
    // turned the rest into silent 試し読み downloads.
    checkEqual('the series walk lists the free volume and the borrowable one only',
        resolved.tasks.map((task) => task.asin), [ASIN, KU_ASIN]);
    check('the free volume is not a KU candidate', !resolved.tasks[0].kuCandidate);
    check('the KU volume is offered with the widget the probe already fetched',
        resolved.tasks[1].kuCandidate === true && resolved.tasks[1].kuOffer?.asin === KU_ASIN,
        JSON.stringify(resolved.tasks[1]));
    check('a non-free volume with no widget of its own is not queued',
        !resolved.tasks.some((task) => task.asin === NONKU_ASIN),
        JSON.stringify(resolved.tasks.map((task) => task.asin)));
    check('resolving a series borrows nothing', service.borrowed.size === 0 && service.loans.size === 0);
    checkEqual('every non-free volume is probed for its own offer',
        service.offersFetched, [KU_ASIN, NONKU_ASIN]);

    // 6b. A `--series` run whose entry volume is itself an unborrowed KU volume:
    //     the reader cannot open it, but its page names the series, so the walk
    //     starts from it instead of failing with "not a volume".
    resetService();
    service.kuOffers.add(KU_ASIN);
    const fromKu = await resolveKindleSeries(
        { asin: KU_ASIN, url: `https://read.amazon.co.jp/manga/${KU_ASIN}` },
        {},
        { session },
    );
    checkEqual('a series can start from an unborrowed KU entry volume',
        fromKu.tasks.map((task) => task.asin), [KU_ASIN]);
    check('the entry volume is a KU candidate, not a failure',
        fromKu.tasks[0].kuCandidate === true && fromKu.tasks[0].kuOffer?.asin === KU_ASIN);
    check('a non-KU sibling is left out here too',
        !fromKu.tasks.some((task) => task.asin === NONKU_ASIN),
        JSON.stringify(fromKu.tasks.map((task) => task.asin)));
    check('starting from a KU entry still borrows nothing', service.borrowed.size === 0);

    // 6c. A volume this account can already read in full -- bought, or on a live
    //     Kindle Unlimited loan -- is downloadable, and the walk used to drop it.
    //     It is not `LIMITED_TIME_FREE`, and an already-borrowed volume has no
    //     borrow widget (its button has already become "read now"), so the
    //     Unlimited probe answered null and the volume was discarded. Measured on
    //     a series with two readable volumes, which is how `--series` downloaded
    //     only one of them.
    resetService();
    service.ownedAsins.add(OWNED_ASIN);
    service.nextInSeries = { [ASIN]: OWNED_ASIN, [OWNED_ASIN]: NONKU_ASIN };
    const owned = await resolveKindleSeries(
        { asin: ASIN, url: `https://read.amazon.co.jp/manga/${ASIN}` },
        {},
        { session },
    );
    checkEqual('an already-entitled volume is queued rather than dropped',
        owned.tasks.map((task) => task.asin), [ASIN, OWNED_ASIN]);
    check('it is queued as held rather than as a borrow to make',
        owned.tasks[1]?.entitled === true && !owned.tasks[1]?.kuCandidate,
        JSON.stringify(owned.tasks[1]));
    check('it is not probed on the store page, which carries no widget for it',
        !service.offersFetched.includes(OWNED_ASIN), JSON.stringify(service.offersFetched));
    check('resolving does not borrow or return anything',
        service.borrowed.size === 0 && service.loans.size === 0);

    const ownedRecord = await downloadKindle(
        { asin: OWNED_ASIN, key: `kindle:${OWNED_ASIN}` }, kuCtx(kuState()));
    check('an entitled volume downloads its pages',
        ownedRecord.downloaded === 3 && ownedRecord.failed === 0,
        `downloaded=${ownedRecord.downloaded} failed=${ownedRecord.failed}`);
    check('nothing is handed back, because no loan of ours was made',
        service.returnBatches.length === 0, JSON.stringify(service.returnBatches));

    // 7. A stale reader-api CSRF token is re-scraped once rather than reported as
    //    a dead session.
    resetService();
    service.csrfStaleOnce = true;
    const staleLoans = await kindleLibraryLoans({ cookie: 'session-id=1; at-acbjp=x', source: 'argument' });
    checkEqual('a refused CSRF token is re-scraped and the call still succeeds', staleLoans.size, 0);
    checkEqual('the library page was scraped twice', service.libraryPageCalls, 2);

    // 8. A return the service answers `success: false` for is reported, not
    //    swallowed. This is the one case where a volume really can be left on the
    //    shelf, so the run must not claim it succeeded.
    resetService();
    service.kuOffers.add(KU_ASIN);
    service.returnSuccess = false;
    let returnFailure = '';
    try {
        await downloadKindle({ asin: KU_ASIN, key: `kindle:${KU_ASIN}` }, kuCtx(kuState()));
    } catch (error) {
        returnFailure = error.message;
    }
    check('an unconfirmed return is reported rather than swallowed',
        /did not confirm the return/.test(returnFailure), returnFailure);
    checkEqual('the unreturned loan is still on the shelf', service.loans.size, 1);
// ---------------------------------------------------------------------------
// Samplers: a volume that is neither owned nor borrowable still has a route
// ---------------------------------------------------------------------------
{
    // The plain volume URL must find the sampler on its own. A user pasting a
    // store link has no way to know that the route is `?sample=1`, and the whole
    // product there is the trial pages.
    service.readerPages.length = 0;
    service.samplePages.length = 0;
    renderCalls.length = 0;
    const sampled = await downloadKindle(
        { asin: SAMPLER_ASIN, key: `kindle:${SAMPLER_ASIN}` },
        { out, titleDir: true, kindleSession: session, kdlConcurrency: 2 },
    );
    check('a volume with no reading token is retried on the sampler route',
        service.samplePages.includes(SAMPLER_ASIN), JSON.stringify(service.samplePages));
    check('the plain page is tried first, so an owned volume never pays twice',
        service.readerPages[0] === SAMPLER_ASIN, JSON.stringify(service.readerPages));
    check('the sampler downloads pages', sampled.downloaded > 0 && sampled.failed === 0,
        `downloaded=${sampled.downloaded} failed=${sampled.failed}`);
    check('the sampler is recorded as a sample, not as a free volume', sampled.sample === true,
        String(sampled.sample));
    // contentType is half of what the rendering token is minted against, and the
    // real capture sets `isSample: false` while `bookAccessMethod` says SAMPLE --
    // so reading only `isSample` asks for FullBook and every window is refused.
    const sampleRenders = renderCalls.filter((c) => c.asin === SAMPLER_ASIN);
    check('the sampler asks the renderer for contentType=Sample',
        sampleRenders.length > 0 && sampleRenders.every((c) => c.contentType === 'Sample'),
        JSON.stringify(sampleRenders.map((c) => c.contentType)));
    check('the sampler is not reported as free in full', sampled.free !== true, String(sampled.free));

    // A `--series --download-samplers` task already knows the route, so it must
    // not spend a request discovering what the walk just established.
    service.readerPages.length = 0;
    service.samplePages.length = 0;
    const direct = await downloadKindle(
        { asin: SAMPLER_ASIN, key: `kindle:${SAMPLER_ASIN}`, sample: true },
        { out, titleDir: true, force: true, kindleSession: session, kdlConcurrency: 2 },
    );
    check('an explicit sampler task does not re-read the plain reader page',
        !service.readerPages.includes(SAMPLER_ASIN) || service.samplePages.length === 1,
        JSON.stringify(service.readerPages));
    check('the explicit sampler task still downloads its pages', direct.failed === 0 && direct.downloaded > 0,
        `downloaded=${direct.downloaded} failed=${direct.failed}`);
}

// ---------------------------------------------------------------------------
// A loan that was already open when the run started gets handed back
// ---------------------------------------------------------------------------
{
    // The user borrowed this one themselves (or an earlier run left it). It is
    // readable immediately, so it never enters the borrow path and -- before this
    // -- nothing would ever have returned it, leaving the shelf to fill up with
    // volumes that are already on disk.
    resetService();
    service.borrowed.add(ASIN);
    service.loans.set(ASIN, 'LOAN_PREEXISTING');
    const ku = { available: null, csrf: null, offers: new Map() };
    const ctx = { out, titleDir: true, force: true, kindleSession: session, kdlConcurrency: 4, kindleUnlimited: ku };
    const record = await downloadKindle({ asin: ASIN, key: `kindle:${ASIN}` }, ctx);

    check('an already-borrowed volume is not borrowed again', service.borrowCalls.length === 0,
        JSON.stringify(service.borrowCalls));
    check('an already-borrowed volume is handed back after the download', record.returned === true,
        String(record.returned));
    check('the loan id handed back is the one the library published',
        service.returnBatches.flat().includes('LOAN_PREEXISTING'), JSON.stringify(service.returnBatches));
    check('the volume really is off the shelf afterwards', service.loans.size === 0,
        JSON.stringify([...service.loans]));

    // A sampler is nobody's loan, so it must never trigger a return.
    resetService();
    const samplerCtx = { out, titleDir: true, force: true, kindleSession: session, kdlConcurrency: 4,
        kindleUnlimited: { available: null, csrf: null, offers: new Map() } };
    const sampledAgain = await downloadKindle(
        { asin: SAMPLER_ASIN, key: `kindle:${SAMPLER_ASIN}`, sample: true }, samplerCtx);
    check('a sampler is never returned', sampledAgain.returned !== true && service.returnBatches.length === 0,
        `returned=${sampledAgain.returned} batches=${JSON.stringify(service.returnBatches)}`);

    // A run that did not finish must leave the loan alone: handing it back would
    // remove the only way to retry the download.
    resetService();
    service.borrowed.add(ASIN);
    service.loans.set(ASIN, 'LOAN_KEPT');
    service.downloadFailsFor.add(ASIN);
    const failingCtx = { out, titleDir: true, force: true, kindleSession: session, kdlConcurrency: 4,
        kindleUnlimited: { available: null, csrf: null, offers: new Map() } };
    await downloadKindle({ asin: ASIN, key: `kindle:${ASIN}` }, failingCtx).catch(() => {});
    check('a failed download leaves the pre-existing loan alone',
        service.loans.has(ASIN) && service.returnBatches.length === 0,
        `loans=${JSON.stringify([...service.loans])} batches=${JSON.stringify(service.returnBatches)}`);
}

// ---------------------------------------------------------------------------
// A transient transport error must not cost a volume
// ---------------------------------------------------------------------------

{
    // The reader page is the first thing a volume fetches. One blip used to end
    // the whole volume with a bare `fetch failed`, while the page fetches inside
    // the same volume already retried six times.
    resetService();
    service.readerFlakes = 1;
    service.readerPages.length = 0;
    const opened = await openKindleVolume(ASIN, session);
    checkEqual('a flaked reader page is retried and still opens', opened.asin, ASIN);
    checkEqual('the reader page was asked for twice', service.readerAttempts, 2);
    checkEqual('only the second attempt produced a page', service.readerPages.length, 1);
    check('the volume still has its reading token', Boolean(opened.token), String(opened.token));

    // A permanent failure reports what went wrong rather than undici's message.
    resetService();
    service.readerFlakes = 99;
    const failure = await openKindleVolume(ASIN, session).then(() => null, (error) => error);
    check('a permanent transport failure is an error', failure instanceof Error, String(failure));
    check('the message names the endpoint instead of saying "fetch failed"',
        /\/manga\//.test(failure.message) && !/^fetch failed$/.test(failure.message), failure.message);

    // A POST is not retried: its outcome cannot be read from a failed attempt, so
    // re-sending one could borrow the same volume twice.
    resetService();
    service.kuOffers.add(KU_ASIN);
    const offer = await kindleVolumeOffer(KU_ASIN, session);
    const before = service.borrowCalls.length;
    service.borrowFlakes = 1;
    const refused = await kindleBorrow(KU_ASIN, offer, session).then(() => null, (error) => error);
    check('a flaked borrow fails rather than retrying', refused instanceof Error, String(refused));
    checkEqual('the borrow POST was sent exactly once', service.borrowCalls.length - before, 0);
}

} finally {
    globalThis.fetch = realFetch;
    fs.rmSync(out, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// Free detection, which decides what `--series` keeps
// ---------------------------------------------------------------------------

check('a limited-time-free volume is free', kindleIsFree({ bookAccessMethod: 'LIMITED_TIME_FREE' }) === true);
check('a free-trial campaign is free', kindleIsFree({ bookAccessMethod: 'FREE_TRIAL' }) === true);
check('a sample is NOT free in full', kindleIsFree({ bookAccessMethod: 'SAMPLE' }) === false,
    'a sample is a prefix of the book that ends in a 403');
check('a sample is not free even if the promo flag is set',
    kindleIsFree({ bookAccessMethod: 'SAMPLE', isLimitedFreeTrialReadNow: true }) === false);
check('the reader page spelling is read too', kindleIsFree({ isLimitedFreeTrialReadNow: true }) === true);
check('an owned volume is not mistaken for a free one', kindleIsFree({ bookAccessMethod: 'PURCHASE' }) === false);

// ---------------------------------------------------------------------------
// The session reader
// ---------------------------------------------------------------------------

const session2 = await loadKindleSession({ kindleNoState: true });
check('a run with no cookies and no state yields source=none', session2.source === 'none' && session2.cookie === '');

const cookieFile = path.join(os.tmpdir(), `dokuha-cookie-${process.pid}.txt`);
fs.writeFileSync(cookieFile, 'Cookie: session-id=abc; at-acbjp=zzz\n');
const session3 = await loadKindleSession({ kindleCookies: [`@${cookieFile}`], kindleNoState: true });
check('a cookie header is read from a file', session3.cookie.includes('session-id=abc') && session3.cookie.includes('at-acbjp=zzz'), session3.cookie);
check('the Cookie: prefix is stripped', !/^cookie:/i.test(session3.cookie));
checkEqual('explicit cookies are marked as such', session3.source, 'argument');
fs.rmSync(cookieFile, { force: true });

// A cookie reading that has no name=value pair at all is a user error worth naming.
let cookieError = '';
try {
    await loadKindleSession({ kindleCookies: ['not a cookie'], kindleNoState: true });
} catch (error) {
    cookieError = error.message;
}
check('a cookie argument with no pairs is refused', /no usable name=value pair/.test(cookieError), cookieError);

// Round-trip through a state file, so a repeat run needs no cookies at all.
const stateFile = path.join(os.tmpdir(), `dokuha-session-${process.pid}.json`);
try {
    await loadKindleSession({ kindleCookies: ['session-id=kept; at-acbjp=kept'], kindleState: stateFile });
    const restored = await loadKindleSession({ kindleState: stateFile });
    checkEqual('a saved session is reused', restored.cookie, 'session-id=kept; at-acbjp=kept');
    checkEqual('a restored session is marked as coming from state', restored.source, 'state');
    if (process.platform !== 'win32') {
        const mode = fs.statSync(stateFile).mode & 0o777;
        checkEqual('the session file is not world-readable', mode, 0o600);
    }
    const ignored = await loadKindleSession({ kindleState: stateFile, kindleNoState: true });
    check('--no-state ignores the saved session', ignored.cookie === '' && ignored.source === 'none');
} finally {
    fs.rmSync(stateFile, { force: true });
}

finish();
