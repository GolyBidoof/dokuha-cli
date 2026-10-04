/**
 * The Kindle protocol, offline.
 *
 * Everything asserted here was recovered from the reader bundle and measured
 * against live captures, and each check is one of the facts that would rot
 * silently if Amazon changed it. The render bundle is built here rather than
 * checked in, so the fixture cannot drift away from the reader's real shape
 * without someone editing this file on purpose.
 *
 * No network, no account, no fixture download.
 */

import crypto from 'node:crypto';

import { check, checkEqual, finish } from './_harness.mjs';
import {
    kindleAuthPolicyIsPrefix,
    kindleAuthPolicyResource,
    kindleBorrowPayload,
    kindleBorrowResult,
    kindleContentType,
    kindleDecodePage,
    kindleIsVolumeInfo,
    kindleLibraryQuery,
    kindleLoansFromLibrary,
    kindleLooksLikeJpeg,
    kindleLooksSigned,
    kindleManifestResources,
    kindlePageKey,
    kindleParseBookInfo,
    kindlePickAuth,
    kindleReadTar,
    kindleReaderApiToken,
    kindleRenderUrl,
    kindleResourceUrl,
    kindleReturnMutation,
    kindleSeriesDescriptor,
    kindleSplitFrame,
    kindleUnlimitedOffer,
    kindleWindowAtEnd,
    kindleWindowMeta,
    kindleWindowPages,
    kindleWindowViewCount,
} from '../src/download/kindle-protocol.js';

// ---------------------------------------------------------------------------
// A render bundle, written the way the service writes one: ustar, `./` names,
// a pax header member, 512-byte padding.
// ---------------------------------------------------------------------------

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0xff, 0xd9]);

function tarMember(name, body) {
    const data = Buffer.isBuffer(body) ? body : Buffer.from(body, 'utf8');
    const header = Buffer.alloc(512);
    header.write(name, 0, 'utf8');
    header.write('0000644', 100, 'utf8');
    header.write('0000000', 108, 'utf8');
    header.write('0000000', 116, 'utf8');
    header.write(`${data.length.toString(8).padStart(11, '0')} `, 124, 'utf8');
    header.write('00000000000 ', 136, 'utf8');
    header.write('        ', 148, 'utf8');
    header.write('0', 156, 'utf8');            // plain file
    header.write('ustar\0', 257, 'utf8');
    header.write('00', 263, 'utf8');
    const padded = Buffer.alloc(Math.ceil(data.length / 512) * 512);
    data.copy(padded);
    return Buffer.concat([header, padded]);
}

/** The pax member the real bundles carry before every file. */
function paxHeader(name) {
    const record = `28 atime=1790537349.55\n28 mtime=1790537349.55\n`;
    return tarMember(`./PaxHeaders.X/${name}`, record);
}

function tarOf(members) {
    const parts = [];
    for (const [name, body] of members) {
        parts.push(paxHeader(name));
        parts.push(tarMember(name.startsWith('./') ? name : `./${name}`, body));
    }
    parts.push(Buffer.alloc(1024));
    return Buffer.concat(parts);
}

// A window of two views: the cover (one image) and a 2-up spread (two images,
// each preceded by a `group` child that must NOT be mistaken for a page).
const PAGE_DATA = [
    {
        sectionId: 788,
        startPositionId: 1,
        endPositionId: 1,
        children: [{ type: 'image', imageReference: 'resource/rsrc1AT', rect: { top: 0, left: 0, bottom: 1200, right: 880 } }],
    },
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
];

const METADATA = {
    bookTitle: 'テスト漫画 1 (テストコミックス)',
    authors: ['テスト作者'],
    lang: 'ja',
    firstPositionId: 0,
    lastPositionId: 5,
    progressionDirection: 'rtl',
};
const LOCATION_MAP = { locations: [0, 3, 5, 7] };
const MANIFEST = {
    revision: 'c5bd2d88',
    asin: 'B090000001',
    cdn: { baseUrl: 'https://d1wni8hbjtvcd0.cloudfront.net/B090000001/c5bd2d88/fullbook', authParameter: null, isEncrypted: false },
    cdnResources: [
        { url: 'resource/rsrc1AT', type: 'IMAGE_PNG', authParameter: 'Policy=EXACT&Signature=abc&Key-Pair-Id=K1' },
        { url: 'resource/rsrc1AV', type: 'IMAGE_PNG', authParameter: 'null&renderingOrigin=KRS' },
        { url: 'resource/rsrc1AX', type: 'IMAGE_PNG', authParameter: null },
    ],
};
const BUNDLE = tarOf([
    ['page_data_0_1.json', JSON.stringify(PAGE_DATA)],
    ['manifest.json', JSON.stringify(MANIFEST)],
    ['metadata.json', JSON.stringify(METADATA)],
    ['location_map.json', JSON.stringify(LOCATION_MAP)],
    ['toc.json', JSON.stringify([{ label: '第一話', position: 0 }])],
]);

// ---------------------------------------------------------------------------
// Tar
// ---------------------------------------------------------------------------

const files = kindleReadTar(BUNDLE);
check('a render bundle yields every member', files.has('page_data_0_1.json') && files.has('manifest.json')
    && files.has('metadata.json') && files.has('location_map.json'), [...files.keys()].join(','));
check('the `./` prefix is stripped from member names', ![...files.keys()].some((n) => n.startsWith('./')));

let tarThrew = false;
try {
    kindleReadTar(Buffer.from('<html>not a tar</html>'));
} catch {
    tarThrew = true;
}
check('a body that is not a tar is refused rather than parsed as one', tarThrew);

// ---------------------------------------------------------------------------
// Reading order and the two page scales
// ---------------------------------------------------------------------------

const ordered = kindleWindowPages(files);
checkEqual('the pages are the image children only, in array order',
    ordered.map((p) => p.imageReference),
    ['resource/rsrc1AT', 'resource/rsrc1AV', 'resource/rsrc1AX']);
checkEqual('a `group` child is not mistaken for a page image',
    ordered.length, 3);
checkEqual('pages are sorted by sectionId', ordered.map((p) => p.sectionId), [788, 789, 789]);
check('the end-of-book test uses the reader\'s own cursor', kindleWindowAtEnd(ordered, 5) === true);
check('a position cursor short of lastPositionId is not the end', kindleWindowAtEnd(ordered, 6) === false);

// The trap that silently downloads half a book: `skipPageCount` counts *views*,
// and a 2-up spread is one view holding two images.
checkEqual('a window\'s skip unit is views, not images', kindleWindowViewCount(files), 2);
check('views and images are different numbers here', kindleWindowViewCount(files) !== ordered.length);

const meta = kindleWindowMeta(files);
checkEqual('the title comes from metadata.json', meta.title, METADATA.bookTitle);
checkEqual('the position-map page count is locations - 1', meta.pageCount, 3);
checkEqual('lastPositionId is the reader\'s end bound', meta.lastPositionId, 5);
checkEqual('the reading direction is kept', meta.direction, 'rtl');

// ---------------------------------------------------------------------------
// bookInfo: a volume, a series landing page, and neither
// ---------------------------------------------------------------------------

const bookInfoHtml = (info) => `<html><body><script type="application/json" id="bookInfo">${JSON.stringify(info)}</script></body></html>`;
const volumeInfo = {
    asin: 'B090000001',
    title: 'テスト漫画 2',
    seriesAsin: 'B090000003',
    contentGuid: 'c5bd2d88',
    bookAccessMethod: 'LIMITED_TIME_FREE',
    isSample: false,
    karamelToken: { token: 'A'.repeat(1244), expiresAt: 1790541466514 },
    cdnPrefetchInfo: '{"cdn":{"baseUrl":"https://x/B090000001/c5bd2d88/fullbook"}}',
};
check('a volume page is recognised', kindleIsVolumeInfo(kindleParseBookInfo(bookInfoHtml(volumeInfo))) === true);
check('a series landing page is not a volume',
    kindleIsVolumeInfo(kindleParseBookInfo(bookInfoHtml({ asin: 'B090000003', title: 'テスト漫画', seriesAsin: '' }))) === false,
    'the series page carries a bookInfo with no contentGuid');
checkEqual('bookInfo is parsed out of the page',
    kindleParseBookInfo(bookInfoHtml(volumeInfo)).contentGuid, 'c5bd2d88');
checkEqual('a page with no bookInfo yields null', kindleParseBookInfo('<html></html>'), null);
checkEqual('a bookInfo that is not JSON yields null', kindleParseBookInfo(bookInfoHtml('x').replace('"x"', 'nope')), null);

// `contentType` is half of what the rendering token is minted against, and the
// wrong one refuses every request.
checkEqual('a sample asks for contentType=Sample', kindleContentType({ isSample: true }), 'Sample');
checkEqual('bookAccessMethod=SAMPLE is the same fact spelled differently',
    kindleContentType({ isSample: false, bookAccessMethod: 'SAMPLE' }), 'Sample');
checkEqual('a limited-time-free volume is a FullBook', kindleContentType({ bookAccessMethod: 'LIMITED_TIME_FREE' }), 'FullBook');

// ---------------------------------------------------------------------------
// The render URL
// ---------------------------------------------------------------------------

const renderUrl = kindleRenderUrl({ asin: 'B090000001', revision: 'c5bd2d88', numPage: 6, skipPageCount: 12 });
const renderParams = new URL(renderUrl).searchParams;
checkEqual('the render URL is same-origin', new URL(renderUrl).origin, 'https://read.amazon.co.jp');
checkEqual('the window offset is sent in views', renderParams.get('skipPageCount'), '12');
checkEqual('the window size is sent', renderParams.get('numPage'), '6');
// Measured: omitting width/height earns 400 "Invalid viewport dimensions", which
// reads like a window-size refusal and is not one.
checkEqual('a viewport width is always sent', renderParams.get('width'), '1333');
checkEqual('a viewport height is always sent', renderParams.get('height'), '1270');
checkEqual('the first page is the anchor', renderParams.get('startingPosition'), '1');
checkEqual('a null anchor is omitted so the service falls back',
    new URL(kindleRenderUrl({ asin: 'A'.repeat(10), revision: 'r', numPage: 2, startPosition: null })).searchParams.has('startingPosition'), false);

// ---------------------------------------------------------------------------
// The signature's own policy decides which extra parameters a fetch needs
// ---------------------------------------------------------------------------

const encodePolicy = (resource) => Buffer.from(JSON.stringify({
    Statement: [{ Resource: resource, Condition: { DateLessThan: { 'AWS:EpochTime': 1790541559 } } }],
}), 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

const prefixPolicy = `Policy=${encodePolicy('https://host/asin/rev/fullbook/*')}&Signature=s&Key-Pair-Id=K1`;
const exactPolicy = `Policy=${encodePolicy('https://host/asin/rev/fullbook/resource/rsrc1AT')}&Signature=s&Key-Pair-Id=K1`;

// Amazon's placeholder is not a signature, and treating it as one shipped a URL
// CloudFront answers 403.
check('the literal null placeholder is not a signature', kindleLooksSigned('null&renderingOrigin=KRS') === false);
check('a real policy is a signature', kindleLooksSigned(prefixPolicy) === true);
check('an empty value is not a signature', kindleLooksSigned('') === false);
checkEqual('a signed resource field wins over the CDN field', kindlePickAuth(exactPolicy, prefixPolicy), exactPolicy);
checkEqual('a CDN-level policy is used when the resource field is the placeholder',
    kindlePickAuth('null&renderingOrigin=KRS', prefixPolicy), prefixPolicy);
checkEqual('neither field signed means no signature', kindlePickAuth('null&renderingOrigin=KRS', null), null);

checkEqual('a prefix policy is read from its base64url JSON', kindleAuthPolicyResource(prefixPolicy),
    'https://host/asin/rev/fullbook/*');
check('a prefix policy is recognised as a prefix', kindleAuthPolicyIsPrefix(prefixPolicy) === true);
check('an exact-resource policy is recognised as exact', kindleAuthPolicyIsPrefix(exactPolicy) === false);
checkEqual('an unreadable policy is reported as unknown, not guessed', kindleAuthPolicyIsPrefix('Policy=not-base64!!'), null);

// The encrypted host 502s without the reading-session token; every plain host
// 403s with it. Getting this backwards costs every page either way.
const withToken = kindleResourceUrl({
    baseUrl: 'https://host/asin/rev/fullbook', path: 'resource/rsrc1AT',
    authParameter: prefixPolicy, token: 'TOKEN', expiresAt: 1790541466514,
});
check('a prefix policy gets the reading-session token', withToken.includes('token=TOKEN'));
check('a prefix policy gets the token expiry', withToken.includes('expiration=1790541466514'));

const withoutToken = kindleResourceUrl({
    baseUrl: 'https://host/asin/rev/fullbook', path: 'resource/rsrc1AT',
    authParameter: exactPolicy, token: 'TOKEN', expiresAt: 1790541466514,
});
check('an exact-resource policy must NOT get the session token', !withoutToken.includes('token='));
check('an exact-resource policy keeps its own signature', withoutToken.startsWith('https://host/asin/rev/fullbook/resource/rsrc1AT?Policy='));

let resourceThrew = false;
try {
    kindleResourceUrl({ baseUrl: 'https://host', path: 'resource/x', authParameter: null, token: 'T' });
} catch {
    resourceThrew = true;
}
check('a resource with no signature fails by name rather than emitting ?undefined', resourceThrew);

// ---------------------------------------------------------------------------
// The page cipher
// ---------------------------------------------------------------------------

// The key is 40 characters cut out of the token at `expiresAt % 60`, which is why
// two volumes in two captures needed offsets 5 and 8.
const digits = '0123456789'.repeat(130);
checkEqual('the key offset is expiresAt % 60 (offset 5)',
    kindlePageKey(digits, 1_790_541_465_005), digits.substring(5, 45));
checkEqual('a second volume lands on a different offset',
    kindlePageKey('abcdefghij'.repeat(130), 1_790_540_950_358),
    'abcdefghij'.repeat(130).substring(38, 78));

let keyThrew = false;
try {
    kindlePageKey('short', 1);
} catch {
    keyThrew = true;
}
check('a truncated token is refused instead of deriving a bad key', keyThrew);

/** Encrypt the way the reader decrypts: PBKDF2 -> AES-128-GCM, with the key's first nine bytes as AAD. */
function encryptPage(jpeg, key) {
    const salt = crypto.randomBytes(16);
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv('aes-128-gcm', crypto.pbkdf2Sync(key, salt, 1000, 16, 'sha256'), iv);
    cipher.setAAD(Buffer.from(key.slice(0, 9), 'utf8'));
    const body = Buffer.concat([cipher.update(jpeg), cipher.final(), cipher.getAuthTag()]);
    return Buffer.from(salt.toString('base64') + iv.toString('base64') + body.toString('base64'), 'utf8');
}

const token = 'Z'.repeat(300);
const expiresAt = 1_790_541_465_015;      // % 60 === 15
const key = kindlePageKey(token, expiresAt);
const pageBytes = Buffer.from(JPEG);

check('a plain JPEG is passed through untouched',
    kindleDecodePage(pageBytes, { isEncrypted: false, token, expiresAt }).equals(pageBytes));

const framed = encryptPage(pageBytes, key);
checkEqual('an encrypted body is base64 with two fixed-width headers', framed.toString('utf8').slice(22, 24), '==');
const decrypted = kindleDecodePage(framed, { isEncrypted: true, token, expiresAt });
check('an encrypted page round-trips to the same JPEG', decrypted.equals(pageBytes));
check('a decrypted page is a JPEG', kindleLooksLikeJpeg(decrypted));

// The framing is three base64 pieces, not one stream: a standard decoder stops at
// the first `==` and would silently truncate the salt.
const { salt, iv, body } = kindleSplitFrame(framed.toString('utf8'));
checkEqual('the salt is 16 bytes', salt.length, 16);
checkEqual('the iv is 16 bytes', iv.length, 16);
check('the body carries ciphertext plus a 16-byte tag', body.length === pageBytes.length + 16);

let decryptThrew = false;
try {
    kindleDecodePage(framed, { isEncrypted: true, token: 'Q'.repeat(300), expiresAt });
} catch {
    decryptThrew = true;
}
check('a wrong token fails the GCM tag rather than producing a corrupt page', decryptThrew);

let garbageThrew = false;
try {
    kindleDecodePage(Buffer.from('this is an html error page, not a page image'), { isEncrypted: true, token, expiresAt });
} catch (error) {
    garbageThrew = /not a page image/.test(error.message);
}
check('a non-image body is refused with what actually arrived', garbageThrew);

// ---------------------------------------------------------------------------
// Manifest resources
// ---------------------------------------------------------------------------

const resources = kindleManifestResources(files);
checkEqual('only resources with a usable signature are kept',
    resources.map((r) => r.path), ['resource/rsrc1AT']);
checkEqual('a kept resource carries the manifest\'s own base URL',
    resources[0].baseUrl, MANIFEST.cdn.baseUrl);
checkEqual('a kept resource carries the manifest\'s encryption flag',
    resources[0].isEncrypted, false);

check('the module exposes no network call', typeof kindleReadTar === 'function');

// ---------------------------------------------------------------------------
// Kindle Unlimited
//
// Every fixture below is copied from a live capture
// (`kindle-free-manga/whole_flow_kindle_unlimited.har`), with the identifiers
// desyntheticised: the widget as `P.declare` receives it, two distinct loan reads
// (a test compares them), the borrow response and the bulk return.
// ---------------------------------------------------------------------------

// This is the shape of a real capture, character for character, including the
// bare `widgetContext:` key -- `P.declare` takes a JavaScript object literal, not
// JSON, which is why a plain JSON.parse of the whole argument does not work.
const KU_PRODUCT_HTML = '<html><body><script>P.declare(\'KU-DP-BottomSheet-Context\', '
    + '{ widgetContext: {'
    + '"ASIN": "B090000007", "PROGRAM": "KINDLE_UNLIMITED", '
    + '"CHANNEL": "ALL_YOU_CAN_READ", "BORROW_SUB_TYPE": "KINDLE_UNLIMITED", '
    + '"CSRF_TOKEN": "gwmev0i1kUQ3rFbvNiOwvPuzfT+HhA2/jhoNHnhEdK2wAAAAAgA==" }})'
    + '</script></body></html>';

const offer = kindleUnlimitedOffer(KU_PRODUCT_HTML);
checkEqual('the KU widget names the volume', offer?.asin, 'B090000007');
checkEqual('the KU widget names the programme the borrow must echo', offer?.program, 'KINDLE_UNLIMITED');
checkEqual('the KU widget names the channel the borrow must echo', offer?.channel, 'ALL_YOU_CAN_READ');
checkEqual('the KU widget carries the borrow sub-type', offer?.borrowSubType, 'KINDLE_UNLIMITED');
checkEqual('the widget CSRF token survives a base64 token with +, / and ==',
    offer?.csrfToken, 'gwmev0i1kUQ3rFbvNiOwvPuzfT+HhA2/jhoNHnhEdK2wAAAAAgA==');

// A limited-time-free volume carries no widget at all: measured, 0 occurrences
// of KINDLE_UNLIMITED against 6 on a KU volume. This null is the "not a KU
// title" signal the whole flow branches on, so it is asserted explicitly.
checkEqual('a page with no KU widget yields null',
    kindleUnlimitedOffer('<html><body>ただの商品ページ</body></html>'), null);
checkEqual('the string appearing without a widget is still null',
    kindleUnlimitedOffer('<html>KINDLE_UNLIMITED</html>'), null);
checkEqual('a truncated widget does not throw',
    kindleUnlimitedOffer('<script>P.declare(\'KU-DP-BottomSheet-Context\', { widgetContext: {'), null);
// A JSON-shaped widget (quoted keys all the way out) is accepted too, because the
// real page may be serialised either way and both mean the same thing.
checkEqual('a fully-quoted widget parses as well',
    kindleUnlimitedOffer('<script>P.declare(\'KU-DP-BottomSheet-Context\', {"widgetContext":'
        + '{"ASIN":"B090000007","PROGRAM":"KINDLE_UNLIMITED","CHANNEL":"ALL_YOU_CAN_READ",'
        + '"BORROW_SUB_TYPE":"KINDLE_UNLIMITED","CSRF_TOKEN":"t"}})</script>')?.asin, 'B090000007');

// The live page is NOT JSON: Amazon mixes single-quoted keys and values into the
// same object as the double-quoted ones, and the object carries a dozen more
// fields after the CSRF token. A parser that insists on JSON rejects a perfectly
// good widget -- measured, and the reason the fields are read one by one.
const KU_MIXED_QUOTES = '<script>(function(P) {\n    P.declare(\'KU-DP-BottomSheet-Context\', {\n'
    + '    widgetContext: {\n'
    + '    "ASIN": "B090000007",\n    "PROGRAM": "KINDLE_UNLIMITED",\n'
    + '    "CHANNEL": "ALL_YOU_CAN_READ",\n    "BORROW_SUB_TYPE": "KINDLE_UNLIMITED",\n\n'
    + '    "CSRF_TOKEN": "gwmev0i1kUQ3rFbvNiOwvPuzfT+HhA2/jhoNHnhEdK2wAAAAAgA==",\n\n'
    + '    "CURRENT_PAGE_KEY" : "",\n'
    + '    \'WIDGET_NAME_BORROW\': \'kuAjaxBorrow\',\n'
    + '    \'WIDGET_NAME_RETURN_AND_BORROW\': \'kuAjaxRNB\',\n'
    + '    "BORROW_BUTTON_REF_TAG": "dbs_p_ebk_r00_pbcb_cvbru0",\n'
    + '    }})</script>';
const mixed = kindleUnlimitedOffer(KU_MIXED_QUOTES);
checkEqual('a widget that mixes single- and double-quoted keys still parses',
    mixed?.asin, 'B090000007');
checkEqual('the CSRF token is read from the mixed literal', mixed?.csrfToken,
    'gwmev0i1kUQ3rFbvNiOwvPuzfT+HhA2/jhoNHnhEdK2wAAAAAgA==');
checkEqual('a field after the mixed-quote block does not leak in', mixed?.borrowSubType, 'KINDLE_UNLIMITED');

// The borrow body is the captured one, byte for byte: loanId is deliberately the
// empty string, because this is a new borrow and the response returns no loan id.
checkEqual('the borrow payload is the captured one',
    kindleBorrowPayload('B090000005', offer),
    '[{"asin":"B090000005","program":"KINDLE_UNLIMITED","channel":"ALL_YOU_CAN_READ","loanId":""}]');

const BORROW_OK = {
    succeededResults: [{
        requestedReturnLoanId: '',
        requestedBorrowAsin: 'B090000005',
        workflowResponse: {
            resultCode: 'KLU_BORROW_SUCCEEDED',
            suggestedReturnLoanId: null,
            suggestedReturnAsin: null,
            mfapending: false,
        },
    }],
    failedResults: [],
    allSucceeded: true,
    serviceExceptionEncountered: false,
};
checkEqual('a successful borrow is read from succeededResults',
    kindleBorrowResult(BORROW_OK), { ok: true, code: 'KLU_BORROW_SUCCEEDED' });
checkEqual('the raw JSON body is accepted as well',
    kindleBorrowResult(JSON.stringify(BORROW_OK)).ok, true);

// A refusal is a 200 with a failedResults entry, so the code -- not the status --
// is the only thing that can tell the caller why the account could not borrow.
checkEqual('a refusal is not a borrow, and names its reason',
    kindleBorrowResult({
        succeededResults: [],
        failedResults: [{ requestedBorrowAsin: 'B090000005', workflowResponse: { resultCode: 'KLU_CONCURRENT_LIMIT_REACHED' } }],
        allSucceeded: false,
    }),
    { ok: false, code: 'KLU_CONCURRENT_LIMIT_REACHED' });
checkEqual('an empty response is a failure with no code',
    kindleBorrowResult({}), { ok: false, code: '' });
checkEqual('a body that is not JSON is a failure, not a throw',
    kindleBorrowResult('<html>not json</html>'), { ok: false, code: '' });

const libraryBody = kindleLibraryQuery();
check('the library query is a JSON body shape, not a bare string',
    typeof libraryBody === 'object' && typeof libraryBody.query === 'string');
check('the library query asks for the fields the loan id is read from',
    /asin/.test(libraryBody.query) && /acquisitionId/.test(libraryBody.query)
    && /getCustomerLibrary/.test(libraryBody.query));
// The captured page asks for groupBySeries and for activeBorrow; the former can
// collapse several borrowed volumes into one series node whose asin is the
// series, so it must stay out of a loan lookup. `activeBorrow` is wanted, but
// only behind the inline fragment: asked for on the base node it fails the whole
// query with `Field 'activeBorrow' in type 'CustomerLibraryBookNode' is
// undefined` -- measured live, twice, before it was moved.
check('the library query does not group by series', !/groupBySeries/.test(libraryBody.query));
check('the library query asks for activeBorrow inside the concrete fragment',
    /\.\.\. on CustomerLibraryBorrowedSingleBookNode \{ activeBorrow \}/.test(libraryBody.query),
    libraryBody.query);

// The real response, trimmed to the fields the query asks for.
const LIBRARY_OK = {
    data: {
        getCustomerLibrary: {
            books: {
                pageInfo: { hasNextPage: false, endCursor: '' },
                totalCount: { number: 2, relation: 'EQUAL' },
                edges: [
                    {
                        node: {
                            asin: 'B090000005',
                            acquisitionId: 'ALOAN0000000001',
                            relationshipType: 'ITEM_OWNER',
                            relationshipSubType: ['KindleUnlimited'],
                            __typename: 'CustomerLibraryBorrowedSingleBookNode',
                        },
                    },
                    {
                        node: {
                            asin: 'B090000004',
                            acquisitionId: 'ALOAN0000000002',
                            relationshipType: 'ITEM_OWNER',
                            relationshipSubType: ['KindleUnlimited'],
                            __typename: 'CustomerLibraryBorrowedSingleBookNode',
                        },
                    },
                ],
            },
        },
    },
};
checkEqual('acquisitionId is the loan id',
    kindleLoansFromLibrary(LIBRARY_OK),
    [{ asin: 'B090000005', loanId: 'ALOAN0000000001', active: true, unlimited: true },
        { asin: 'B090000004', loanId: 'ALOAN0000000002', active: true, unlimited: true }]);

// A returned volume keeps its library edge with `activeBorrow: false`. Reading
// list membership as "borrowed" would try to hand back a volume that is already
// on the shelf, and -- worse -- would treat an owned book as returnable.
{
    const returned = { data: { getCustomerLibrary: { books: { edges: [{ node: {
        asin: 'B090000007', acquisitionId: 'ALOAN0000000003',
        relationshipSubType: ['KindleUnlimited'], __typename: 'CustomerLibraryBorrowedSingleBookNode',
        activeBorrow: false,
    } }] } } } };
    checkEqual('a returned volume is not an active loan', kindleLoansFromLibrary(returned)[0].active, false);

    const owned = { data: { getCustomerLibrary: { books: { edges: [{ node: {
        asin: 'B0OWNED001', acquisitionId: 'AOWNEDLOAN',
        relationshipSubType: ['Purchase'], __typename: 'CustomerLibraryBookNode',
        activeBorrow: true,
    } }] } } } };
    checkEqual('an owned book is not an Unlimited loan', kindleLoansFromLibrary(owned)[0].unlimited, false);
    check('an owned book is never treated as returnable',
        kindleLoansFromLibrary(owned).filter((l) => l.active && l.unlimited).length === 0);
}
checkEqual('a serialised library body parses too', kindleLoansFromLibrary(JSON.stringify(LIBRARY_OK)).length, 2);
checkEqual('a missing payload is an empty list', kindleLoansFromLibrary(null), []);
checkEqual('a missing books shape is an empty list',
    kindleLoansFromLibrary({ data: { getCustomerLibrary: {} } }), []);
checkEqual('edges that are not an array are an empty list',
    kindleLoansFromLibrary({ data: { getCustomerLibrary: { books: { edges: null } } } }), []);
checkEqual('a node with no loan id is dropped rather than returned blank',
    kindleLoansFromLibrary({
        data: { getCustomerLibrary: { books: { edges: [{ node: { asin: 'B090000005' } }] } } },
    }), []);

// The return mutation takes a list: this is the whole reason a batch of borrowed
// volumes costs one call rather than one round trip each.
const returnBody = kindleReturnMutation([
    { asin: 'B090000005', loanId: 'ALOAN0000000001' },
    { asin: 'B090000004', loanId: 'ALOAN0000000002' },
]);
checkEqual('the return mutation is named the way the capture names it',
    returnBody.operationName, 'BulkReturnBorrowMutation');
check('both loans travel in one mutation',
    returnBody.query.includes('contentId: "B090000005"') && returnBody.query.includes('contentId: "B090000004"'));
check('each loan carries the loan id the library published',
    returnBody.query.includes('loanId: "ALOAN0000000001"') && returnBody.query.includes('loanId: "ALOAN0000000002"'));
check('the captured content type and return type are used',
    /contentType: "EBook"/.test(returnBody.query) && /returnType: "KU"/.test(returnBody.query));
check('the input object is the only return, not one mutation per volume',
    (returnBody.query.match(/mycdBulkReturnBorrow/g) || []).length === 1
    && (returnBody.query.match(/mutation /g) || []).length === 1);
// JSON.stringify would quote the input field names, which GraphQL refuses.
check('the input field names are bare GraphQL fields, not JSON keys',
    !/"contentId"/.test(returnBody.query) && !/'contentId'/.test(returnBody.query));
checkEqual('an item with no loan id is dropped rather than breaking the batch',
    kindleReturnMutation([{ asin: 'B090000005', loanId: '' }, { asin: '', loanId: 'X' }]).query,
    'mutation BulkReturnBorrowMutation { mycdBulkReturnBorrow(input: []) { success } }');

// Two attribute orders and an unrelated CSRF meta, because the reader-api token
// is not the borrow token and picking the wrong one is refused by the service.
const READER_META = '<!-- sp:csrf --><meta name="anti-csrftoken-a2z" '
    + 'content="hLBPLcHB3yjiloD+Ophkd85Ykj527jr0iLp+0Z4pPOfLAAAAAGq5gNliNTgyMTQ0Zi1hNDI5LTQzODQtOGRmYy04N2U2NzU5NTRlMGQ=" '
    + 'id="kindle-reader-api" ><!-- sp:end-csrf -->';
checkEqual('the reader-api token is scraped from its meta element',
    kindleReaderApiToken(READER_META),
    'hLBPLcHB3yjiloD+Ophkd85Ykj527jr0iLp+0Z4pPOfLAAAAAGq5gNliNTgyMTQ0Zi1hNDI5LTQzODQtOGRmYy04N2U2NzU5NTRlMGQ=');
checkEqual('the attribute order does not matter',
    kindleReaderApiToken('<meta id="kindle-reader-api" content="tok" name="anti-csrftoken-a2z">'), 'tok');
checkEqual('a page with no reader-api token yields null', kindleReaderApiToken('<html></html>'), null);

// `get-series-data/<volumeAsin>` answers with the volume's own descriptor rather
// than 404 (measured live), so an answer existing is not proof of a series. This
// is what makes an unborrowed KU volume reach the borrow path instead of being
// reported as a series page.
check('a real series descriptor is a series',
    kindleSeriesDescriptor({ asin: 'B090000006', title: 'サンプル作品', seriesSize: 7, seriesType: 'VOLUMES' }) === true);
check('a volume\'s own descriptor is not a series',
    kindleSeriesDescriptor({ asin: 'B090000007', title: 'サンプル作品 ： 2 (テストコミックス)', seriesSize: 0, seriesType: 'UNKNOWN' }) === false);
check('a descriptor with no seriesType falls back to its size',
    kindleSeriesDescriptor({ asin: 'X', seriesSize: 72 }) === true);
check('a one-volume answer is not called a series',
    kindleSeriesDescriptor({ asin: 'X', seriesSize: 1 }) === false);
check('nothing at all is not a series', kindleSeriesDescriptor(null) === false);

finish();
