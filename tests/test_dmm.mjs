/**
 * DMMブックス: the request shapes and the page pipeline.
 *
 * The store is unusual in that its viewer is not a cipher: the auth call
 * returns a CDN base and either CloudFront cookies (a free volume) or an
 * `auth_info` query object (a 試し読み sample), and `configuration_pack.json`
 * is plain JSON. The page JPEG *is* a 64×64 tile shuffle, though, so the
 * geometry is checked here too. These checks pin both routes, the page order
 * and the unshuffle, using fixtures from the recorded capture rather than the
 * live store.
 *
 * The second half pins the regressions the first live audit found: a pasted
 * viewer URL resolves without a BFF call, a direct task keeps an empty title so
 * auth.cti names it, sampler folders carry exactly one suffix, a folder built in
 * the other descramble state is rebuilt, a manifest 403 refreshes the auth once,
 * `--retries` governs the page budget with the 403 refresh outside it, the series
 * walk honours the live `pager.total_count` shape, a product-page sampler falls
 * back to the series listing, and a decoded size that disagrees with the manifest
 * is refused.
 */

import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
    downloadDmm,
    dmmSignedUrl,
    parseDmmConfiguration,
    parseDmmContentsBook,
    parseDmmViewerUrl,
    platform as dmmPlatform,
    resolveDmmInput,
} from '../src/download/dmm.js';
import {
    descrambleDmmPage,
    dmmDescramblePixels,
    dmmPattern,
    dmmTileRects,
    sharpAvailable,
} from '../src/download/dmm-descramble.js';
import { existingVolume } from '../src/download/existing-volume.js';
import { writeVolumeMarker } from '../src/download/volume-folder.js';
import { detectSource } from '../src/platforms/index.js';
import { check, checkEqual, finish } from './_harness.mjs';

// ---- URL forms -------------------------------------------------------------

{
    const free = parseDmmViewerUrl('https://book.dmm.com/product/605237/b999asqex01885/free_streaming/?cid=OPAQUE&lin=0&sd=0');
    checkEqual('a free viewer names its series', free.seriesId, '605237');
    checkEqual('a free viewer names its content', free.contentId, 'b999asqex01885');
    checkEqual('a free viewer keeps its cid', free.cid, 'OPAQUE');
    checkEqual('a free viewer is lin=0', free.lin, '0');
    checkEqual('a free viewer is not a sample', free.viewer, 'free_streaming');

    const sample = parseDmmViewerUrl('https://book.dmm.com/product/605237/b999asqex01886/tachiyomi/?cid=OPAQUE2&lin=1');
    checkEqual('a tachiyomi viewer is a sample', sample.viewer, 'tachiyomi');
    checkEqual('a tachiyomi viewer is lin=1', sample.lin, '1');
    checkEqual('a product page is not a viewer', parseDmmViewerUrl('https://book.dmm.com/product/605237/b999asqex01885/'), null);
}

// Detection has to order the volume pattern before the series pattern.
{
    checkEqual('a free viewer is a volume', detectSource('https://book.dmm.com/product/605237/b999asqex01885/free_streaming/?cid=x&lin=0').kind, 'dmm-volume');
    checkEqual('a product page is a volume', detectSource('https://book.dmm.com/product/605237/b999asqex01885/').kind, 'dmm-volume');
    checkEqual('a product root is a series', detectSource('https://book.dmm.com/product/605237/').kind, 'dmm-series');
    checkEqual('the volumes listing is a series', detectSource('https://book.dmm.com/product/605237/volumes/').kind, 'dmm-series');
    checkEqual('latest is its own kind', detectSource('https://book.dmm.com/product/605237/latest/').kind, 'dmm-latest');
}

// ---- Series listing --------------------------------------------------------

const SERIES = {
    volume_books: [
        {
            content_id: 'b999asqex01885',
            title: 'サンプル作品 1巻',
            volume_number: 1,
            free_streaming_url: ['https://book.dmm.com/product/605237/b999asqex01885/free_streaming/?cid=A&lin=0'],
            tachiyomi_url: null,
            sell: { free_status: 'paid' },
            limited_free: { end: '2026-10-22T23:59:59+09:00' },
        },
        {
            content_id: 'b999asqex01886',
            title: 'サンプル作品 2巻',
            volume_number: 2,
            free_streaming_url: null,
            tachiyomi_url: 'https://book.dmm.com/product/605237/b999asqex01886/tachiyomi/?cid=B&lin=1',
            sell: { free_status: 'paid' },
            limited_free: { end: null },
        },
        {
            content_id: 'b999asqex01887',
            title: 'サンプル作品 3巻',
            volume_number: 3,
            free_streaming_url: null,
            tachiyomi_url: null,
            sell: { free_status: 'paid' },
            limited_free: { end: null },
        },
    ],
    pager: { next_page: false },
    total_free_count: 1,
};

{
    const parsed = parseDmmContentsBook(SERIES);
    checkEqual('every volume is listed', parsed.volumes.length, 3);
    checkEqual('only the free volume has a free URL', parsed.volumes.map((v) => v.free), [true, false, false]);
    checkEqual('only the unpaid sampler is a sample', parsed.volumes.map((v) => v.sample), [false, true, false]);
    checkEqual('the free count is kept', parsed.totalFree, 1);
}

// ---- configuration_pack.json ----------------------------------------------

const CONFIG = {
    configuration: {
        contents: [
            { file: 'item/xhtml/p-cover.xhtml', index: 1, type: 'bmp' },
            { file: 'item/xhtml/p-001.xhtml', index: 2, type: 'jpeg' },
            { file: 'item/xhtml/p-002.xhtml', index: 3, type: 'jpeg' },
        ],
    },
    'item/xhtml/p-cover.xhtml': {
        Linear: 1,
        FileLinkInfo: {
            PageCount: 1,
            PageLinkInfoList: [{ Page: { No: 0, DummyWidth: 4, DummyHeight: 0, Size: { Width: 900, Height: 1280 } } }],
        },
    },
    'item/xhtml/p-001.xhtml': {
        Linear: 1,
        FileLinkInfo: {
            PageCount: 1,
            PageLinkInfoList: [{ Page: { No: 0, DummyWidth: 4, DummyHeight: 0, Size: { Width: 900, Height: 1280 } } }],
        },
    },
    'item/xhtml/p-002.xhtml': {
        Linear: 0,
        FileLinkInfo: {
            PageCount: 1,
            PageLinkInfoList: [{ Page: { No: 0, Size: { Width: 900, Height: 1280 } } }],
        },
    },
};

{
    const pages = parseDmmConfiguration(CONFIG);
    checkEqual('a Linear=0 item is skipped, as the viewer skips it', pages.length, 2);
    checkEqual('the cover keeps reading order', pages[0].file, 'item/xhtml/p-cover.xhtml');
    checkEqual('a bmp item is fetched as jpeg', pages[0].type, 'jpeg');
    checkEqual('the second page follows', pages[1].file, 'item/xhtml/p-001.xhtml');
    checkEqual('the page records the 4px dummy width', pages[0].dummyWidth, 4);
    checkEqual('a page with both dummy fields is shuffled', pages[0].scrambled, true);
    checkEqual('the shuffle pattern comes from the page path', pages[0].pattern, dmmPattern('item/xhtml/p-cover.xhtml', 0));
}

// ---- the 64×64 tile shuffle ------------------------------------------------

{
    // The viewer's own key is the sum of the page path's char codes:
    // "item/xhtml/p-011.xhtml/0" sums to 2083, so the captured page uses 4.
    checkEqual('the captured page uses pattern 4', dmmPattern('item/xhtml/p-011.xhtml', 0), 4);
    checkEqual('a 904×1280 page has 14×20 full tiles plus edge strips',
        dmmTileRects(904, 1280, 4).length, 300);
}

{
    // A 3×2 grid, pattern 1, with each source tile filled with its own index.
    // The destination row-major labels are the viewer's Wu() output for this
    // exact geometry, written out so a change to the port is visible. The
    // viewer's own field names are inverted: its `destX` is the source in the
    // scrambled JPEG and its `srcX` is the destination in the clean page.
    const W = 192, H = 128, B = 64, CH = 3;
    const source = Buffer.alloc(W * H * CH);
    for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) {
            const label = Math.floor(x / B) + Math.floor(y / B) * 3;
            const at = (y * W + x) * CH;
            source[at] = label;
            source[at + 1] = label;
            source[at + 2] = label;
        }
    }
    const clean = dmmDescramblePixels(source, { width: W, height: H, channels: CH }, {
        file: 'item/xhtml/p-cover.xhtml', no: 0, dummyWidth: 0, dummyHeight: 0, pattern: 1,
    });
    checkEqual('the clean page keeps the source box', [clean.width, clean.height], [W, H]);
    const labels = [];
    for (let y = 0; y < 2; y++) {
        for (let x = 0; x < 3; x++) {
            const at = ((y * B + 32) * W + (x * B + 32)) * CH;
            labels.push(clean.data[at]);
        }
    }
    checkEqual('the tiles land in the viewer’s order', labels, [5, 3, 1, 0, 4, 2]);
}

if (!sharpAvailable()) {
    process.stdout.write('NOTE  sharp is not installed; the JPEG round trip was not run\n');
} else {
    const sharp = (await import('sharp')).default;
    const W = 192, H = 128, B = 64, CH = 3;
    const raw = Buffer.alloc(W * H * CH);
    for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) {
            const label = Math.floor(x / B) + Math.floor(y / B) * 3;
            const at = (y * W + x) * CH;
            raw[at] = label * 40;
            raw[at + 1] = label * 40;
            raw[at + 2] = label * 40;
        }
    }
    const jpeg = await sharp(raw, { raw: { width: W, height: H, channels: CH } }).jpeg().toBuffer();
    const rebuilt = await descrambleDmmPage(jpeg, {
        file: 'item/xhtml/p-cover.xhtml', no: 0, dummyWidth: 0, dummyHeight: 0, pattern: 1,
    });
    const decoded = await sharp(rebuilt.data).raw().toBuffer({ resolveWithObject: true });
    const seen = [];
    for (let y = 0; y < 2; y++) {
        for (let x = 0; x < 3; x++) {
            const at = ((y * B + 32) * W + (x * B + 32)) * CH;
            seen.push(Math.round(decoded.data[at] / 40));
        }
    }
    checkEqual('the JPEG round trip lands the tiles in the same order', seen, [5, 3, 1, 0, 4, 2]);
}

// Signed query parameters are appended, never merged into the path.
{
    const signed = dmmSignedUrl('https://trial.book.dmm.co.jp/base/configuration_pack.json', {
        Policy: 'P', Signature: 'S', 'Key-Pair-Id': 'K',
    });
    const u = new URL(signed);
    checkEqual('Policy is a query parameter', u.searchParams.get('Policy'), 'P');
    checkEqual('Signature is a query parameter', u.searchParams.get('Signature'), 'S');
    checkEqual('Key-Pair-Id is a query parameter', u.searchParams.get('Key-Pair-Id'), 'K');
    checkEqual('the path is untouched', u.pathname, '/base/configuration_pack.json');
}

// ---- resolve: series and samplers -----------------------------------------

function jsonResponse(body, extra = {}) {
    return {
        ok: (extra.status ?? 200) >= 200 && (extra.status ?? 200) < 300,
        status: extra.status ?? 200,
        headers: {
            get: (name) => (String(name).toLowerCase() === 'set-cookie' ? (extra.setCookie || null) : null),
            getSetCookie: () => (extra.setCookie ? [extra.setCookie] : []),
        },
        json: async () => body,
        text: async () => JSON.stringify(body),
    };
}

function bytesResponse(bytes, extra = {}) {
    return {
        ok: true,
        status: 200,
        headers: { get: () => 'image/jpeg', getSetCookie: () => [] },
        arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
        json: async () => ({}),
        text: async () => '',
    };
}

function fakeContentsFetch(seriesBody) {
    return async (url) => {
        const u = new URL(url);
        if (u.pathname === '/ajax/bff/contents_book/') {
            const page = Number(u.searchParams.get('page') || '1');
            return page === 1 ? jsonResponse(seriesBody) : jsonResponse({ volume_books: [], pager: { next_page: false } });
        }
        if (u.pathname === '/ajax/bff/viewer/lastpage/volume/') {
            const id = u.searchParams.get('content_id');
            const entry = seriesBody.volume_books.find((v) => v.content_id === id);
            return jsonResponse({
                content_id: id,
                series_id: '605237',
                title: entry?.title || '',
                volume_number: entry?.volume_number || null,
                free_streaming_url: entry?.free_streaming_url || null,
                tachiyomi_url: entry?.tachiyomi_url || null,
                sell: { free_status: 'paid' },
                limited_free: { end: null },
            });
        }
        throw new Error('unexpected URL ' + url);
    };
}

{
    const det = detectSource('https://book.dmm.com/product/605237/volumes/');
    const resolved = await resolveDmmInput(det, { series: true }, det.url, {
        fetchImpl: fakeContentsFetch(SERIES), samplers: false,
    });
    checkEqual('a series walk takes only the free volume', resolved.tasks.map((t) => t.contentId), ['b999asqex01885']);
    checkEqual('and it is not marked as a sample', resolved.tasks[0].sample, false);

    const withSamples = await resolveDmmInput(det, { series: true }, det.url, {
        fetchImpl: fakeContentsFetch(SERIES), samplers: true,
    });
    checkEqual('--download-samplers adds the sampler', withSamples.tasks.map((t) => t.contentId), ['b999asqex01885', 'b999asqex01886']);
    checkEqual('the sampler is tagged as one', withSamples.tasks[1].sample, true);
    checkEqual('and its own id cannot collide with the full volume', withSamples.tasks[1].id, 'b999asqex01886sample');

    const product = detectSource('https://book.dmm.com/product/605237/b999asqex01886/');
    const one = await resolveDmmInput(product, {}, product.url, {
        fetchImpl: fakeContentsFetch(SERIES), samplers: true,
    });
    checkEqual('a product page resolves to its own volume', one.tasks[0].contentId, 'b999asqex01886');
    checkEqual('a product page for a sampler is a sample only with --download-samplers', one.tasks[0].sample, true);
}

// ---- end-to-end download ---------------------------------------------------

const JPEG_A = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0xff, 0xd9]);
const JPEG_B = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0xff, 0xd9]);

{
    const out = await fsp.mkdtemp(path.join(os.tmpdir(), 'dokuha-dmm-'));
    const seen = [];
    const fetchImpl = async (url, options = {}) => {
        const u = new URL(url);
        seen.push({ path: u.pathname, query: u.searchParams, cookie: options.headers?.Cookie || '' });
        if (u.pathname === '/viewerapi/auth/') {
            checkEqual('auth carries the viewer cid', u.searchParams.get('cid'), 'OPAQUE');
            checkEqual('auth carries lin', u.searchParams.get('lin'), '0');
            return jsonResponse(
                { status: '200', url: 'https://ebook04.dmm.com/bb/test/', cti: 'サンプル作品 1巻', cty: 1 },
                { setCookie: 'CloudFront-Policy=P; path=/; domain=.dmm.com' },
            );
        }
        if (u.pathname === '/bb/test/configuration_pack.json') {
            check('the manifest is fetched with the auth cookie', /CloudFront-Policy=P/.test(options.headers?.Cookie || ''));
            return jsonResponse(CONFIG);
        }
        if (u.pathname === '/bb/test/item/xhtml/p-cover.xhtml/0.jpeg') return bytesResponse(JPEG_A);
        if (u.pathname === '/bb/test/item/xhtml/p-001.xhtml/0.jpeg') return bytesResponse(JPEG_B);
        throw new Error('unexpected URL ' + url);
    };

    const result = await downloadDmm({
        kind: 'dmm',
        id: 'b999asqex01885',
        contentId: 'b999asqex01885',
        seriesId: '605237',
        title: 'サンプル作品 1巻',
        target: 'サンプル作品 1巻',
        viewerUrl: 'https://book.dmm.com/product/605237/b999asqex01885/free_streaming/?cid=OPAQUE&lin=0',
        sample: false,
    }, { out, fetchImpl, titleDir: true, config: {}, descramble: false });

    checkEqual('the result names the store', result.store, 'dmm');
    checkEqual('two pages were written', result.downloaded, 2);
    checkEqual('none failed', result.failed, 0);
    checkEqual('the page count comes from the manifest', result.totalPages, 2);
    const files = (await fsp.readdir(result.folder)).sort();
    checkEqual('the pages use the shared ordinal naming', files, ['metadata.json', 'page-0001.jpg', 'page-0002.jpg']);
    const first = await fsp.readFile(path.join(result.folder, 'page-0001.jpg'));
    checkEqual('the first page is the cover bytes', first.equals(JPEG_A), true);
    const marker = JSON.parse(await fsp.readFile(path.join(result.folder, 'metadata.json'), 'utf8'));
    checkEqual('the marker records the store', marker.store, 'dmm');
    checkEqual('the marker records the content id', marker.contentId, 'b999asqex01885');
    checkEqual('the marker records the viewer route', marker.viewer, 'free_streaming');
    checkEqual('--no-descramble is recorded as such', [marker.descrambled, marker.descramble], [false, null]);
    checkEqual('the run reports the page as left shuffled', result.descrambled, false);

    // A resumed run reuses both pages and requests nothing.
    const before = seen.length;
    const again = await downloadDmm({
        kind: 'dmm',
        id: 'b999asqex01885',
        contentId: 'b999asqex01885',
        seriesId: '605237',
        title: 'サンプル作品 1巻',
        target: 'サンプル作品 1巻',
        viewerUrl: 'https://book.dmm.com/product/605237/b999asqex01885/free_streaming/?cid=OPAQUE&lin=0',
        sample: false,
    }, { out, fetchImpl, titleDir: true, config: {}, descramble: false });
    checkEqual('a completed volume is recognised', again.skipped, 2);
    check('and no page is requested again',
        seen.slice(before).every((entry) => !entry.path.includes('/item/xhtml/')),
        seen.slice(before).map((entry) => entry.path).join(' '));

    await fsp.rm(out, { recursive: true, force: true });
}

// ---- a sample uses auth_info instead of cookies ---------------------------

{
    const out = await fsp.mkdtemp(path.join(os.tmpdir(), 'dokuha-dmm-sample-'));
    const seen = [];
    const fetchImpl = async (url) => {
        const u = new URL(url);
        seen.push(u);
        if (u.pathname === '/viewerapi/auth/') {
            return jsonResponse({
                status: '200',
                url: 'https://trial.book.dmm.co.jp/browsing/test/',
                cti: 'サンプル作品 2巻',
                auth_info: { Policy: 'P', Signature: 'S', 'Key-Pair-Id': 'K' },
            });
        }
        if (u.pathname === '/browsing/test/configuration_pack.json') {
            checkEqual('the manifest carries Policy', u.searchParams.get('Policy'), 'P');
            checkEqual('the manifest carries Signature', u.searchParams.get('Signature'), 'S');
            checkEqual('the manifest carries Key-Pair-Id', u.searchParams.get('Key-Pair-Id'), 'K');
            return jsonResponse({
                configuration: { contents: [{ file: 'item/xhtml/p-cover.xhtml', index: 1, type: 'jpeg' }] },
                'item/xhtml/p-cover.xhtml': {
                    Linear: 1,
                    FileLinkInfo: { PageCount: 1, PageLinkInfoList: [{ Page: { No: 0 } }] },
                },
            });
        }
        if (u.pathname === '/browsing/test/item/xhtml/p-cover.xhtml/0.jpeg') {
            checkEqual('the page carries Policy too', u.searchParams.get('Policy'), 'P');
            return bytesResponse(JPEG_A);
        }
        throw new Error('unexpected URL ' + url);
    };

    const result = await downloadDmm({
        kind: 'dmm',
        id: 'b999asqex01886sample',
        contentId: 'b999asqex01886',
        seriesId: '605237',
        title: 'サンプル作品 2巻',
        target: 'サンプル作品 2巻（試し読み）',
        viewerUrl: 'https://book.dmm.com/product/605237/b999asqex01886/tachiyomi/?cid=OPAQUE2&lin=1',
        sample: true,
    }, { out, fetchImpl, titleDir: true, config: {} });

    checkEqual('the sample result is marked as a sample', result.sample, true);
    checkEqual('the sample folder carries the shared suffix exactly once',
        path.basename(result.folder), 'サンプル作品 2巻（試し読み）');
    checkEqual('one page was written', result.downloaded, 1);
    await fsp.rm(out, { recursive: true, force: true });
}


// ---- the default run unscrambles the page ----------------------------------

if (sharpAvailable()) {
    const sharp = (await import('sharp')).default;
    const W = 192, H = 128, B = 64, CH = 3;
    const raw = Buffer.alloc(W * H * CH);
    for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) {
            const label = Math.floor(x / B) + Math.floor(y / B) * 3;
            const at = (y * W + x) * CH;
            raw[at] = label * 40;
            raw[at + 1] = label * 40;
            raw[at + 2] = label * 40;
        }
    }
    const scrambledJpeg = await sharp(raw, { raw: { width: W, height: H, channels: CH } })
        .jpeg({ quality: 100 }).toBuffer();
    const config = {
        configuration: { contents: [{ file: 'item/xhtml/p-cover.xhtml', index: 1, type: 'jpeg' }] },
        'item/xhtml/p-cover.xhtml': {
            Linear: 1,
            FileLinkInfo: { PageCount: 1, PageLinkInfoList: [{ Page: {
                No: 0, DummyWidth: 0, DummyHeight: 0, Size: { Width: W, Height: H },
            } }] },
        },
    };
    const out = await fsp.mkdtemp(path.join(os.tmpdir(), 'dokuha-dmm-shuffle-'));
    const fetchImpl = async (url) => {
        const u = new URL(url);
        if (u.pathname === '/viewerapi/auth/') {
            // A free volume's real auth answer sets the CloudFront cookies; the
            // CLI refuses an answer that carries neither them nor auth_info.
            return jsonResponse({ status: '200', url: 'https://ebook04.dmm.com/bb/shuffle/', cti: 'サンプル作品 1巻' },
                { setCookie: 'CloudFront-Policy=P; path=/; domain=.dmm.com' });
        }
        if (u.pathname === '/bb/shuffle/configuration_pack.json') return jsonResponse(config);
        if (u.pathname === '/bb/shuffle/item/xhtml/p-cover.xhtml/0.jpeg') return bytesResponse(scrambledJpeg);
        throw new Error('unexpected URL ' + url);
    };
    const result = await downloadDmm({
        kind: 'dmm',
        id: 'shuffle',
        contentId: 'shuffle',
        seriesId: '605237',
        title: 'サンプル作品 1巻',
        target: 'サンプル作品 1巻',
        viewerUrl: 'https://book.dmm.com/product/605237/shuffle/free_streaming/?cid=OPAQUE&lin=0',
        sample: false,
    }, { out, fetchImpl, titleDir: true, config: {} });
    checkEqual('the default run reports a descrambled page', result.descrambled, true);
    checkEqual('the marker records the descramble algorithm', JSON.parse(
        await fsp.readFile(path.join(result.folder, 'metadata.json'), 'utf8')).descramble, 'dmm64-v1');
    const decoded = await sharp(await fsp.readFile(path.join(result.folder, 'page-0001.jpg')))
        .raw().toBuffer({ resolveWithObject: true });
    const seen = [];
    for (let y = 0; y < 2; y++) {
        for (let x = 0; x < 3; x++) {
            const at = ((y * B + 32) * W + (x * B + 32)) * CH;
            seen.push(Math.round(decoded.data[at] / 40));
        }
    }
    checkEqual('the written page is in reading order', seen, [5, 3, 1, 0, 4, 2]);
    await fsp.rm(out, { recursive: true, force: true });
} else {
    process.stdout.write('NOTE  sharp is not installed; the end-to-end unshuffle was not run\n');
}

// ===========================================================================
// Regressions from the first live audit
// ===========================================================================

// A one-page volume whose manifest declares the 904×1280 wire size (900×1280
// clean plus a 4px dummy column), which is the shape the live store serves.
const SINGLE_PAGE = {
    configuration: { contents: [{ file: 'item/xhtml/p-cover.xhtml', index: 1, type: 'jpeg' }] },
    'item/xhtml/p-cover.xhtml': {
        Linear: 1,
        FileLinkInfo: { PageCount: 1, PageLinkInfoList: [{ Page: {
            No: 0, DummyWidth: 4, DummyHeight: 0, Size: { Width: 900, Height: 1280 },
        } }] },
    },
};

/** The task shape resolveDmmInput publishes for a pasted viewer URL. */
function directViewerTask({ id = 'b999asqex01885', title = '作品 1巻', viewer = 'free_streaming', sample = false } = {}) {
    return {
        kind: 'dmm',
        id: sample ? `${id}sample` : id,
        contentId: id,
        seriesId: '605237',
        title,
        target: title,
        viewerUrl: `https://book.dmm.com/product/605237/${id}/${viewer}/?cid=OPAQUE&lin=${sample ? 1 : 0}`,
        sample,
    };
}

/** Decode a 3×2 tiled page and read the label at each tile's centre. */
async function tileReadingOrder(sharp, jpeg, W, H, CH, B) {
    const decoded = await sharp(jpeg).raw().toBuffer({ resolveWithObject: true });
    const seen = [];
    for (let y = 0; y < 2; y++) {
        for (let x = 0; x < 3; x++) {
            const at = ((y * B + 32) * W + (x * B + 32)) * CH;
            seen.push(Math.round(decoded.data[at] / 40));
        }
    }
    return seen;
}

function freeSeriesRow(volume) {
    return {
        content_id: `c${volume}`,
        title: `作品 ${volume}巻`,
        volume_number: volume,
        free_streaming_url: [`https://book.dmm.com/product/605237/c${volume}/free_streaming/?cid=X&lin=0`],
        tachiyomi_url: null,
        sell: { free_status: 'paid' },
        limited_free: { end: null },
    };
}

// ---- a pasted viewer URL resolves without the BFF -------------------------
{
    const freeDet = detectSource('https://book.dmm.com/product/605237/b999asqex01885/free_streaming/?cid=OPAQUE&lin=0&sd=0');
    checkEqual('detection carries a free viewer cid and lin', [freeDet.cid, freeDet.lin], ['OPAQUE', '0']);
    const sampleDet = detectSource('https://book.dmm.com/product/605237/b999asqex01886/tachiyomi/?cid=OPAQUE2&lin=1');
    checkEqual('detection carries a tachiyomi viewer cid and lin', [sampleDet.cid, sampleDet.lin], ['OPAQUE2', '1']);

    const calls = [];
    const noBff = async (url) => {
        calls.push(String(url));
        throw new Error(`a pasted viewer URL needed a BFF request: ${url}`);
    };
    const free = await resolveDmmInput(freeDet, {}, freeDet.url, { fetchImpl: noBff });
    checkEqual('a pasted free viewer resolves to one task', free.tasks.length, 1);
    checkEqual('the free task keeps the pasted viewer URL', free.tasks[0].viewerUrl, freeDet.url);
    checkEqual('a free viewer is not a sample', free.tasks[0].sample, false);
    checkEqual('a direct task keeps an empty title for auth.cti', free.tasks[0].title, '');
    checkEqual('the free task identity is the content id', free.tasks[0].id, 'b999asqex01885');

    const sample = await resolveDmmInput(sampleDet, {}, sampleDet.url, { fetchImpl: noBff });
    checkEqual('a pasted tachiyomi viewer is a sample by itself', sample.tasks[0].sample, true);
    checkEqual('the sampler identity cannot collide with the volume', sample.tasks[0].id, 'b999asqex01886sample');
    checkEqual('the sampler task keeps an empty title for auth.cti', sample.tasks[0].title, '');
    checkEqual('neither pasted viewer needed the BFF', calls, []);
}

// ---- auth.cti names a direct viewer volume --------------------------------
{
    const out = await fsp.mkdtemp(path.join(os.tmpdir(), 'dokuha-dmm-cti-'));
    const det = detectSource('https://book.dmm.com/product/605237/b999asqex01885/free_streaming/?cid=OPAQUE&lin=0');
    const resolved = await resolveDmmInput(det, {}, det.url, {
        fetchImpl: async (url) => { throw new Error(`a viewer URL needed a BFF request: ${url}`); },
    });
    const fetchImpl = async (url) => {
        const u = new URL(url);
        if (u.pathname === '/viewerapi/auth/') {
            return jsonResponse(
                { status: '200', url: 'https://ebook04.dmm.com/bb/cti/', cti: '作品 9巻【無料お試し版】' },
                { setCookie: 'CloudFront-Policy=P; path=/' },
            );
        }
        if (u.pathname === '/bb/cti/configuration_pack.json') return jsonResponse(SINGLE_PAGE);
        if (u.pathname === '/bb/cti/item/xhtml/p-cover.xhtml/0.jpeg') return bytesResponse(JPEG_A);
        throw new Error(`unexpected URL ${url}`);
    };
    const result = await downloadDmm(resolved.tasks[0], {
        out, fetchImpl, titleDir: true, config: {}, descramble: false, retries: 0,
    });
    checkEqual('auth.cti names a direct viewer volume', result.title, '作品 9巻');
    checkEqual('the folder is named from auth.cti', path.basename(result.folder), '作品 9巻');
    checkEqual('the volume number is read from the auth title', result.volume, 9);
    await fsp.rm(out, { recursive: true, force: true });
}

// ---- a folder built in the other descramble state is rebuilt -------------
if (sharpAvailable()) {
    const sharp = (await import('sharp')).default;
    const W = 192, H = 128, B = 64, CH = 3;
    const raw = Buffer.alloc(W * H * CH);
    for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) {
            const label = Math.floor(x / B) + Math.floor(y / B) * 3;
            const at = (y * W + x) * CH;
            raw[at] = label * 40;
            raw[at + 1] = label * 40;
            raw[at + 2] = label * 40;
        }
    }
    const shuffled = await sharp(raw, { raw: { width: W, height: H, channels: CH } })
        .jpeg({ quality: 100 }).toBuffer();
    const onePage = {
        configuration: { contents: [{ file: 'item/xhtml/p-cover.xhtml', index: 1, type: 'jpeg' }] },
        'item/xhtml/p-cover.xhtml': {
            Linear: 1,
            FileLinkInfo: { PageCount: 1, PageLinkInfoList: [{ Page: {
                No: 0, DummyWidth: 0, DummyHeight: 0, Size: { Width: W, Height: H },
            } }] },
        },
    };
    const out = await fsp.mkdtemp(path.join(os.tmpdir(), 'dokuha-dmm-resume-'));
    let pageCalls = 0;
    const fetchImpl = async (url) => {
        const u = new URL(url);
        if (u.pathname === '/viewerapi/auth/') {
            return jsonResponse({ status: '200', url: 'https://ebook04.dmm.com/bb/resume/', cti: '作品 1巻' },
                { setCookie: 'CloudFront-Policy=P; path=/' });
        }
        if (u.pathname === '/bb/resume/configuration_pack.json') return jsonResponse(onePage);
        if (u.pathname === '/bb/resume/item/xhtml/p-cover.xhtml/0.jpeg') {
            pageCalls += 1;
            return bytesResponse(shuffled);
        }
        throw new Error(`unexpected URL ${url}`);
    };
    const task = {
        kind: 'dmm',
        id: 'resume',
        contentId: 'resume',
        seriesId: '605237',
        title: '作品 1巻',
        target: '作品 1巻',
        viewerUrl: 'https://book.dmm.com/product/605237/resume/free_streaming/?cid=OPAQUE&lin=0',
        sample: false,
    };
    const rawRun = await downloadDmm(task, { out, fetchImpl, titleDir: true, config: {}, descramble: false, retries: 0 });
    const rawMarker = JSON.parse(await fsp.readFile(path.join(rawRun.folder, 'metadata.json'), 'utf8'));
    const rawPage = await fsp.readFile(path.join(rawRun.folder, 'page-0001.jpg'));
    checkEqual('a --no-descramble run records the raw state',
        [rawMarker.descrambled, rawMarker.descramble, rawRun.descrambled], [false, null, false]);

    const rebuiltRun = await downloadDmm(task, { out, fetchImpl, titleDir: true, config: {}, retries: 0 });
    const rebuiltMarker = JSON.parse(await fsp.readFile(path.join(rebuiltRun.folder, 'metadata.json'), 'utf8'));
    const rebuiltPage = await fsp.readFile(path.join(rebuiltRun.folder, 'page-0001.jpg'));
    check('a run in the other descramble state rebuilds instead of reusing',
        rebuiltRun.downloaded === 1 && rebuiltRun.skipped === 0,
        JSON.stringify({ downloaded: rebuiltRun.downloaded, skipped: rebuiltRun.skipped }));
    check('the rebuild re-fetches the scrambled page', pageCalls === 2, String(pageCalls));
    check('the rebuilt page differs from the shuffled wire bytes', !rawPage.equals(rebuiltPage),
        'the shuffled page was reused');
    checkEqual('the rebuilt marker records the descramble algorithm',
        [rebuiltMarker.descrambled, rebuiltMarker.descramble], [true, 'dmm64-v1']);
    checkEqual('the rebuilt page is in reading order',
        await tileReadingOrder(sharp, rebuiltPage, W, H, CH, B), [5, 3, 1, 0, 4, 2]);
    await fsp.rm(out, { recursive: true, force: true });
} else {
    process.stdout.write('NOTE  sharp is not installed; the cross-descramble rebuild was not run\n');
}

// ---- the platform states what a finished folder means ---------------------
{
    checkEqual('the DMM platform declares a marker check', typeof dmmPlatform.markerCheck, 'function');
    const rawMarker = { descrambled: false, descramble: null };
    checkEqual('a raw marker does not satisfy a descramble run',
        dmmPlatform.markerCheck(rawMarker, { descramble: true }), false);
    checkEqual('a raw marker satisfies a --no-descramble run',
        dmmPlatform.markerCheck(rawMarker, { descramble: false }), true);

    const out = await fsp.mkdtemp(path.join(os.tmpdir(), 'dokuha-dmm-marker-'));
    const folder = path.join(out, '作品 3巻');
    await fsp.mkdir(folder, { recursive: true });
    await fsp.writeFile(path.join(folder, 'page-0001.jpg'), JPEG_A);
    await writeVolumeMarker(folder, {
        store: 'dmm',
        id: 'cid-marker',
        title: '作品 3巻',
        expectedPages: 1,
        descrambled: false,
        descramble: null,
    });
    const ctx = { out, config: {}, titleDir: true };
    const mismatched = await existingVolume(ctx, {
        store: 'dmm', title: '作品 3巻', id: 'cid-marker', expectedPages: 1, folder,
        checkRemote: false,
        markerCheck: (marker) => dmmPlatform.markerCheck(marker, { descramble: true }),
    });
    checkEqual('a folder in the other descramble state is not already present', mismatched, null);
    const matched = await existingVolume(ctx, {
        store: 'dmm', title: '作品 3巻', id: 'cid-marker', expectedPages: 1, folder,
        checkRemote: false,
        markerCheck: (marker) => dmmPlatform.markerCheck(marker, { descramble: false }),
    });
    check('a folder in the same descramble state is already present',
        Boolean(matched) && matched.skipped === 1,
        matched ? JSON.stringify({ skipped: matched.skipped }) : 'null');
    await fsp.rm(out, { recursive: true, force: true });
}

// ---- a manifest 403 refreshes the auth once -------------------------------
{
    const out = await fsp.mkdtemp(path.join(os.tmpdir(), 'dokuha-dmm-manifest-refresh-'));
    let authCalls = 0;
    let manifestCalls = 0;
    const manifestCookies = [];
    const fetchImpl = async (url, options = {}) => {
        const u = new URL(url);
        const cookie = options.headers?.Cookie || '';
        if (u.pathname === '/viewerapi/auth/') {
            authCalls += 1;
            return jsonResponse(
                { status: '200', url: 'https://ebook04.dmm.com/bb/refresh/', cti: '作品 1巻' },
                { setCookie: authCalls === 1 ? 'CloudFront-Policy=OLD; path=/' : 'CloudFront-Policy=NEW; path=/' },
            );
        }
        if (u.pathname === '/bb/refresh/configuration_pack.json') {
            manifestCalls += 1;
            manifestCookies.push(cookie);
            return cookie.includes('CloudFront-Policy=OLD')
                ? jsonResponse({}, { status: 403 })
                : jsonResponse(SINGLE_PAGE);
        }
        if (u.pathname === '/bb/refresh/item/xhtml/p-cover.xhtml/0.jpeg') return bytesResponse(JPEG_A);
        throw new Error(`unexpected URL ${url}`);
    };
    const result = await downloadDmm(directViewerTask(), {
        out, fetchImpl, titleDir: true, config: {}, descramble: false, retries: 0,
    });
    checkEqual('a 403 manifest refreshes the auth exactly once', authCalls, 2);
    checkEqual('the manifest is retried after the refresh', manifestCalls, 2);
    check('the retried manifest carries the replacement cookie',
        manifestCookies[1].includes('CloudFront-Policy=NEW'), manifestCookies[1]);
    checkEqual('the volume completes after the manifest refresh',
        [result.downloaded, result.failed], [1, 0]);
    await fsp.rm(out, { recursive: true, force: true });
}

// ---- --retries governs the page budget, and a 403 refresh is free ---------
{
    const out = await fsp.mkdtemp(path.join(os.tmpdir(), 'dokuha-dmm-403-budget-'));
    let authCalls = 0;
    let pageCalls = 0;
    const fetchImpl = async (url, options = {}) => {
        const u = new URL(url);
        const cookie = options.headers?.Cookie || '';
        if (u.pathname === '/viewerapi/auth/') {
            authCalls += 1;
            return jsonResponse({ status: '200', url: 'https://ebook04.dmm.com/bb/403/', cti: '作品 1巻' },
                { setCookie: authCalls === 1 ? 'CloudFront-Policy=OLD; path=/' : 'CloudFront-Policy=NEW; path=/' });
        }
        if (u.pathname === '/bb/403/configuration_pack.json') return jsonResponse(SINGLE_PAGE);
        if (u.pathname === '/bb/403/item/xhtml/p-cover.xhtml/0.jpeg') {
            pageCalls += 1;
            return cookie.includes('CloudFront-Policy=OLD')
                ? jsonResponse({}, { status: 403 })
                : bytesResponse(JPEG_A);
        }
        throw new Error(`unexpected URL ${url}`);
    };
    const result = await downloadDmm(directViewerTask(), {
        out, fetchImpl, titleDir: true, config: {}, descramble: false, retries: 0,
    });
    checkEqual('a 403 page is retried even with --retries 0', [authCalls, pageCalls], [2, 2]);
    checkEqual('the page completes after the refresh', [result.downloaded, result.failed], [1, 0]);
    await fsp.rm(out, { recursive: true, force: true });
}
{
    const out = await fsp.mkdtemp(path.join(os.tmpdir(), 'dokuha-dmm-500-budget-'));
    let pageCalls = 0;
    const fetchImpl = async (url) => {
        const u = new URL(url);
        if (u.pathname === '/viewerapi/auth/') {
            return jsonResponse({ status: '200', url: 'https://ebook04.dmm.com/bb/500/', cti: '作品 1巻' },
                { setCookie: 'CloudFront-Policy=P; path=/' });
        }
        if (u.pathname === '/bb/500/configuration_pack.json') return jsonResponse(SINGLE_PAGE);
        if (u.pathname === '/bb/500/item/xhtml/p-cover.xhtml/0.jpeg') {
            pageCalls += 1;
            return pageCalls <= 2 ? jsonResponse({}, { status: 500 }) : bytesResponse(JPEG_A);
        }
        throw new Error(`unexpected URL ${url}`);
    };
    const result = await downloadDmm(directViewerTask(), {
        out, fetchImpl, titleDir: true, config: {}, descramble: false, retries: 2,
    });
    checkEqual('a 5xx page is retried up to --retries', pageCalls, 3);
    checkEqual('the page completes inside the retry budget', [result.downloaded, result.failed], [1, 0]);
    await fsp.rm(out, { recursive: true, force: true });
}

// ---- the series walk honours the live pager shape -------------------------
{
    const det = detectSource('https://book.dmm.com/product/605237/volumes/');
    const pageRequests = [];
    const fetchImpl = async (url) => {
        const u = new URL(url);
        if (u.pathname === '/ajax/bff/contents_book/') {
            const page = Number(u.searchParams.get('page'));
            pageRequests.push(page);
            return jsonResponse({
                volume_books: page === 1
                    ? Array.from({ length: 100 }, (_, i) => freeSeriesRow(i + 1))
                    : Array.from({ length: 50 }, (_, i) => freeSeriesRow(i + 101)),
                pager: { page, per_page: 100, total_count: 150 },
                total_free_count: 150,
            });
        }
        throw new Error(`unexpected URL ${url}`);
    };
    const resolved = await resolveDmmInput(det, { series: true }, det.url, { fetchImpl, samplers: false });
    checkEqual('the walk reads the second page stated by total_count', pageRequests, [1, 2]);
    checkEqual('every volume of both pages is queued', resolved.tasks.length, 150);
    checkEqual('the tasks keep the listing order',
        [resolved.tasks[0].contentId, resolved.tasks[resolved.tasks.length - 1].contentId], ['c1', 'c150']);

    const shortRequests = [];
    const shortFetch = async (url) => {
        const u = new URL(url);
        if (u.pathname === '/ajax/bff/contents_book/') {
            const page = Number(u.searchParams.get('page'));
            shortRequests.push(page);
            return jsonResponse({
                volume_books: page === 1 ? Array.from({ length: 100 }, (_, i) => freeSeriesRow(i + 1)) : [],
                pager: { page, per_page: 100, total_count: 150 },
                total_free_count: 0,
            });
        }
        throw new Error(`unexpected URL ${url}`);
    };
    let shortError = null;
    try {
        await resolveDmmInput(det, { series: true }, det.url, { fetchImpl: shortFetch, samplers: false });
    } catch (error) {
        shortError = error;
    }
    check('a walk shorter than total_count throws instead of returning a short run',
        Boolean(shortError), shortError ? shortError.message : 'resolved anyway');
    check('the shortfall names both counts',
        Boolean(shortError) && /100 of 150/.test(shortError.message),
        shortError ? shortError.message : 'resolved anyway');
    checkEqual('the short walk stopped after the empty page', shortRequests, [1, 2]);
}

// ---- a product page resolves its sampler from the series listing ----------
{
    const det = detectSource('https://book.dmm.com/product/605237/b999asqex01886/');
    const tachiyomiUrl = 'https://book.dmm.com/product/605237/b999asqex01886/tachiyomi/?cid=OPAQUE2&lin=1';
    let lastpageCalls = 0;
    let contentsCalls = 0;
    const fetchImpl = async (url) => {
        const u = new URL(url);
        if (u.pathname === '/ajax/bff/viewer/lastpage/volume/') {
            lastpageCalls += 1;
            // The live endpoint names no free link and no tachiyomi_url; the
            // title and volume arrive from the series listing instead.
            return jsonResponse({ content_id: 'b999asqex01886', series_id: 605237, free_streaming_url: null });
        }
        if (u.pathname === '/ajax/bff/contents_book/') {
            contentsCalls += 1;
            return jsonResponse({
                volume_books: [{
                    content_id: 'b999asqex01886',
                    title: '作品 2巻',
                    volume_number: 2,
                    free_streaming_url: null,
                    tachiyomi_url: tachiyomiUrl,
                    sell: { free_status: 'paid' },
                    limited_free: { end: null },
                }],
                pager: { page: 1, per_page: 100, total_count: 1 },
                total_free_count: 0,
            });
        }
        throw new Error(`unexpected URL ${url}`);
    };
    const resolved = await resolveDmmInput(det, {}, det.url, { fetchImpl, samplers: true });
    checkEqual('a product page asks its own volume endpoint first', lastpageCalls, 1);
    checkEqual('the sampler is read from the series listing', contentsCalls, 1);
    checkEqual('the product page resolves one task', resolved.tasks.length, 1);
    checkEqual('the task is a sampler', resolved.tasks[0].sample, true);
    checkEqual('the sampler keeps the listing title and volume',
        [resolved.tasks[0].title, resolved.tasks[0].volume], ['作品 2巻', 2]);
    checkEqual('the sampler uses the listing viewer URL', resolved.tasks[0].viewerUrl, tachiyomiUrl);
    checkEqual('the sampler identity cannot collide with the volume',
        resolved.tasks[0].id, 'b999asqex01886sample');
    checkEqual('the sampler target carries the shared suffix',
        resolved.tasks[0].target, '作品 2巻（試し読み）');

    const without = await resolveDmmInput(det, {}, det.url, { fetchImpl, samplers: false });
    checkEqual('without --download-samplers the product page is refused',
        [without.tasks.length, without.rejected.length], [0, 1]);
}

// ---- a decoded size that disagrees with the manifest is refused -----------
if (sharpAvailable()) {
    const sharp = (await import('sharp')).default;
    const W = 192, H = 128;
    const jpeg = await sharp(Buffer.alloc(W * H * 3, 7), { raw: { width: W, height: H, channels: 3 } })
        .jpeg().toBuffer();
    let error = null;
    try {
        await descrambleDmmPage(jpeg, {
            file: 'item/xhtml/p-cover.xhtml',
            no: 0,
            dummyWidth: 4,
            dummyHeight: 0,
            width: 900,
            height: 1280,
            pattern: 1,
        });
    } catch (caught) {
        error = caught;
    }
    check('a decoded page that disagrees with the manifest is refused',
        Boolean(error), 'the page was descrambled against the wrong grid');
    check('the refusal names both sizes',
        Boolean(error) && /is 192x128, expected 904x1280/.test(error.message),
        error ? error.message : 'no error');
} else {
    process.stdout.write('NOTE  sharp is not installed; the manifest-size guard was not run\n');
}

finish();
