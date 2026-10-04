/**
 * k-manga wire format, against frames taken from a real capture.
 *
 * The fixtures are two messages lifted verbatim out of a HAR's
 * `_webSocketMessages` for volume 1 of a free-campaign title: the header reply
 * (176 pages) and one content reply (a scrambled page). They are kept as bytes
 * rather than rebuilt in the test on purpose -- a synthetic frame would only prove
 * this decoder agrees with this encoder, and every mistake worth catching here
 * (field widths, the header reply having no chunk table, raw rather than base64
 * image bytes) is exactly the kind a round trip through my own code would hide.
 *
 * The JSONP and viewer-URL cases are the literal strings from the same capture.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
    buildDataRequest,
    buildHeaderRequest,
    isScrambled,
    parseFrame,
    parseIndexJsonp,
    parseViewerUrl,
    readJpegSize,
    scrambleGeometry,
    scrambleOrder,
    KM_MAGIC,
} from '../src/download/kmanga-protocol.js';
import { check, checkEqual, finish } from './_harness.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const fixture = (name) => fs.readFileSync(path.join(HERE, 'fixtures', name));

const headerFrame = fixture('kmanga-header.bcp');
const pageFrame = fixture('kmanga-page8.bcp');

// The greeting is the magic on its own. Reading it as "a frame with no JSON"
// would leave the client waiting for a length field that never comes.
{
    const parsed = parseFrame(Buffer.from(KM_MAGIC, 'latin1'));
    check('the greeting parses as a greeting', parsed.hello === true);
}

// The header reply stops after its JSON. Its `contentInfos` is the page list, so
// this fixture is also the proof that a volume is listed up front rather than
// discovered page by page.
{
    const parsed = parseFrame(headerFrame);
    check('the header frame is not a greeting', parsed.hello === false);
    check('the header frame carries no chunk table', parsed.chunks === null);
    checkEqual('it declares 176 scenes', parsed.body.numOfScenes, 176);
    checkEqual('it declares the page box', [parsed.body.frameWidth, parsed.body.frameHeight], [846, 1200]);
    checkEqual('it lists one content entry per page', parsed.body.contentInfos.length, 176);
    checkEqual('the first page is scene 1', parsed.body.contentInfos[0], { name: '0', size: 322524, startSceneNo: 1, endSceneNo: 1 });
    checkEqual('the decrypt key is the capture\u2019s 48-byte hex string', parsed.body.dk.length, 96);
    check('the decrypt key is hex', /^[0-9a-f]{96}$/.test(parsed.body.dk));
}

// A content reply appends the chunk table. The chunks are raw JPEG bytes, not
// base64: the viewer base64-encodes them itself only to build a data: URL, and
// treating the wire bytes as base64 silently produces a 170-byte "image".
{
    const parsed = parseFrame(pageFrame);
    checkEqual('the page frame carries exactly one chunk', parsed.chunks.length, 1);
    const image = parsed.body.scenes[0].images[0];
    checkEqual('the scene is the one asked for', parsed.body.scenes[0].sceneNo, 8);
    checkEqual('the image is scrambled', isScrambled(image), true);
    checkEqual('its scramble key is the capture\u2019s', image.key, 59861);
    checkEqual('it is a JPEG', image.format, 'jpeg');
    checkEqual('its declared box is the QVGA profile', [image.width, image.height], [846, 1200]);
    check('the chunk is raw JPEG, not base64 of it',
        parsed.chunks[0][0] === 0xFF && parsed.chunks[0][1] === 0xD8, `got ${parsed.chunks[0].subarray(0, 2).toString('hex')}`);
    const size = readJpegSize(parsed.chunks[0]);
    checkEqual('the JPEG is wider than the declared box', size.width, 864);
    checkEqual('the JPEG is taller than the declared box', size.height, 1248);
    checkEqual('the chunk table accounts for every byte', parsed.chunks[0].length, 185871);
}

// Truncation and trailing bytes must be refused rather than papered over: both
// mean a page would be written half-formed.
{
    let threw = false;
    try { parseFrame(headerFrame.subarray(0, 4000)); } catch { threw = true; }
    check('a truncated JSON body is refused', threw);

    threw = false;
    try { parseFrame(Buffer.concat([pageFrame, Buffer.from([0])])); } catch { threw = true; }
    check('trailing bytes after the chunks are refused', threw);

    threw = false;
    try { parseFrame(Buffer.concat([Buffer.from('BCP00X'), headerFrame.subarray(6)])); } catch { threw = true; }
    check('a wrong magic is refused', threw);
}

// The request strings are the contract with the server, so they are asserted
// exactly rather than by shape.
{
    checkEqual('the header request is spelled the way the viewer spells it',
        buildHeaderRequest({ ticket: 'BGTK_abc_202609280600', obfuid: 'o1', profile: '64kb_QVGA_h' }),
        'REQUEST HEADER\nt=BGTK_abc_202609280600&fn=64kb_QVGA_h&o=o1');
    checkEqual('the data request carries the decrypt key last',
        buildDataRequest({ ticket: 'T', obfuid: 'O', name: '7', decryptKey: 'DK' }),
        'REQUEST DATA\nt=T&fn=7&o=O&dk=DK');
    checkEqual('a data request without a key omits the parameter',
        buildDataRequest({ ticket: 'T', obfuid: 'O', name: '7' }),
        'REQUEST DATA\nt=T&fn=7&o=O');
}

// The table of contents: a header row, chapters, then flag rows whose second cell
// is empty. Treating the flags as chapters would invent pages.
{
    const body = 'cb([["\u8a71\u540d","\u958b\u59cb\u30da\u30fc\u30b8\u6570"],["\u8868\u7d19","1"],["\u76ee\u6b21","7"],["\u5965\u4ed8","175"],["rtl",""],["sc",""],["mr",""],["ml",""],[null]]);';
    const index = parseIndexJsonp(body);
    checkEqual('only the chapters are chapters', index.chapters, [
        { name: '\u8868\u7d19', page: 1 },
        { name: '\u76ee\u6b21', page: 7 },
        { name: '\u5965\u4ed8', page: 175 },
    ]);
    checkEqual('the layout flags are kept as flags', index.flags, ['rtl', 'sc', 'mr', 'ml']);

    let threw = false;
    try { parseIndexJsonp('not a jsonp call'); } catch { threw = true; }
    check('a reply that is not JSONP is refused', threw);
}

// The viewer URL owns the session: without the ticket and obfuid the socket has
// nothing to authenticate with.
{
    const viewer = 'https://comic.k-manga.jp/viewer/pc/viewer.html'
        + '?p0=BGTK_0000000000000000000000000000000_20260101000000&p1=0000000000000000000000000000001&p2=2&p3=180001'
        + '&p4=1&p8=sid0000000000000000000000&p10=2&p20=00000005-0000-4000-8000-000000000005&p21=0';
    const session = parseViewerUrl(viewer);
    checkEqual('the ticket comes from p0', session.ticket, 'BGTK_0000000000000000000000000000000_20260101000000');
    checkEqual('the obfuid comes from p1', session.obfuid, '0000000000000000000000000000001');
    checkEqual('the book id comes from p3', session.bookId, '180001');
    checkEqual('the session id comes from p8', session.sid, 'sid0000000000000000000000');
    checkEqual('the access uuid comes from p20', session.accessUuid, '00000005-0000-4000-8000-000000000005');
}

// The grid. The cell constant is chosen from the declared size while the grid is
// measured against the JPEG, and each cell gives up its inner cell-2 square.
{
    checkEqual('the QVGA profile is a 96px grid',
        scrambleGeometry({ declaredWidth: 846, declaredHeight: 1200, sourceWidth: 864, sourceHeight: 1248 }),
        { cell: 96, block: 94, gridX: 9, gridY: 13 });
    checkEqual('a mid-size page doubles the 32px cell',
        scrambleGeometry({ declaredWidth: 300, declaredHeight: 400, sourceWidth: 320, sourceHeight: 448 }),
        { cell: 64, block: 62, gridX: 5, gridY: 7 });
    checkEqual('a small page keeps 32px',
        scrambleGeometry({ declaredWidth: 200, declaredHeight: 250, sourceWidth: 256, sourceHeight: 320 }),
        { cell: 32, block: 30, gridX: 8, gridY: 10 });

    let threw = false;
    try { scrambleGeometry({ declaredWidth: 846, declaredHeight: 1200, sourceWidth: 850, sourceHeight: 1248 }); } catch { threw = true; }
    check('a page that is not a whole number of cells is refused rather than guessed at', threw);
}

// The permutation: a bijection whose prefix is pinned to the values the capture's
// own seed produces. A wrong LCG constant still yields a bijection, so the pinned
// prefix is what actually holds the generator in place.
{
    const order = scrambleOrder({ gridX: 9, gridY: 13, key: 59861 });
    checkEqual('one draw per block', order.length, 117);
    checkEqual('every block is used exactly once', new Set(order).size, 117);
    checkEqual('the capture\u2019s seed draws the capture\u2019s order',
        Array.from(order.slice(0, 10)), [77, 64, 47, 99, 62, 116, 50, 85, 55, 48]);
    const other = scrambleOrder({ gridX: 9, gridY: 13, key: 59862 });
    check('a different key draws a different order', order[0] !== other[0] || order[5] !== other[5]);
}

finish();
