/**
 * BookWalker page names, the ZIP entry-order parser, and the engine seam.
 *
 * The published manifest names every page after the EPUB source it was built
 * from, so the folder keeps the book's own stem (`0001 cover.jpg`) rather than
 * an opaque ordinal. The ordinal stays first and four digits wide, so a plain
 * name sort is still reading order; the stem is what varies, and it has to be
 * sanitized and byte-capped before it can be a filename.
 *
 * The parser half is what keeps entry order correct once the name is no longer
 * `page-NNNN.jpg`: it reads the ordinal out of either shape. The engine half
 * proves `runPublicTrialJob` uses the caller's policy for the files it writes
 * and still defaults to `page-NNNN.jpg` when nobody passes one.
 */
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
    bookWalkerPageName,
    sanitizePageStem,
    zipEntryNumber,
} from '../src/download/page-files.js';
import { check, checkEqual, finish } from './_harness.mjs';

const require = createRequire(import.meta.url);
const { runPublicTrialJob } = require('../vendor/bookwalker/public-trial.js');

/** Names of the entries in a stored (uncompressed) ZIP, in archive order. */
function zipLocalNames(buffer) {
    const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
    const names = [];
    let offset = 0;
    while (offset + 30 <= buffer.length && view.getUint32(offset, true) === 0x04034b50) {
        const nameLength = view.getUint16(offset + 26, true);
        const extraLength = view.getUint16(offset + 28, true);
        const size = view.getUint32(offset + 18, true);
        names.push(buffer.toString('utf8', offset + 30, offset + 30 + nameLength));
        offset += 30 + nameLength + extraLength + size;
    }
    return names;
}

// --- ordinal, basename and extension -------------------------------------

checkEqual('the ordinal is padded and the source stem follows it',
    bookWalkerPageName(1, 'OEBPS/text/p-0001.xhtml'), '0001 p-0001.jpg');
checkEqual('padding holds past nine',
    bookWalkerPageName(10, 'OEBPS/text/p-0010.xhtml'), '0010 p-0010.jpg');
checkEqual('only the basename of a nested path is kept',
    bookWalkerPageName(3, 'OEBPS/text/chapter/表紙.xhtml'), '0003 表紙.jpg');
checkEqual('a query string is not part of the name',
    bookWalkerPageName(4, 'OEBPS/p-0004.xhtml?token=abc'), '0004 p-0004.jpg');
checkEqual('a fragment is not part of the name',
    bookWalkerPageName(4, 'OEBPS/p-0004.xhtml#page-4'), '0004 p-0004.jpg');

checkEqual('.xhtml is dropped', bookWalkerPageName(2, 'OEBPS/cover.xhtml'), '0002 cover.jpg');
checkEqual('.html is dropped', bookWalkerPageName(2, 'cover.html'), '0002 cover.jpg');
checkEqual('.htm is dropped', bookWalkerPageName(2, 'cover.htm'), '0002 cover.jpg');
checkEqual('the extension is a parameter',
    bookWalkerPageName(7, 'cover.xhtml', 'webp'), '0007 cover.webp');

// --- sanitization ---------------------------------------------------------

checkEqual('characters Windows forbids are dropped',
    bookWalkerPageName(5, 'a:b*c"d<e>f|g\\h\u0001.xhtml'), '0005 abcdefgh.jpg');
checkEqual('a trailing dot and space are stripped', sanitizePageStem('cover. '), 'cover');
checkEqual('a reserved device name is escaped', sanitizePageStem('CON'), '_CON');
checkEqual('a stem of only dots sanitizes to nothing', sanitizePageStem('...'), '');

// --- the 255-byte cap, counted in encoded bytes ---------------------------

{
    for (const [label, stem] of [['three-byte kanji', '界'], ['four-byte emoji', '😀']]) {
        const name = bookWalkerPageName(12345, `${stem.repeat(190)}.xhtml`);
        const bytes = Buffer.byteLength(name, 'utf8');
        check(`a ${label} stem is truncated to fit 255 UTF-8 bytes`, bytes <= 255, `${bytes} bytes`);
        check(`a ${label} stem keeps the ordinal and extension`,
            name.startsWith('12345 ') && name.endsWith('.jpg'), name);
        check(`a ${label} stem is cut on a character boundary`,
            !name.includes('\uFFFD'), name);
        // Character count alone would allow 190, which is 570 UTF-8 bytes.
        check(`a ${label} stem really was shortened`,
            Array.from(name.replace(/^12345 |\.jpg$/g, '')).length < 190, name);
    }
}

// --- missing / empty sources ---------------------------------------------

checkEqual('an empty source still yields a padded ordinal', bookWalkerPageName(1, ''), '0001.jpg');
checkEqual('a missing source still yields a padded ordinal', bookWalkerPageName(2, null), '0002.jpg');
checkEqual('a trailing slash leaves no stem', bookWalkerPageName(3, 'OEBPS/text/'), '0003.jpg');

// --- the index parser -----------------------------------------------------

checkEqual('the new shape parses from the basename', zipEntryNumber('0010 表紙.jpg'), 10);
checkEqual('a numbered parent directory is ignored',
    zipEntryNumber('2026 Series/Volume/0002 cover.jpg'), 2);
checkEqual('the legacy shape still parses', zipEntryNumber('Series/Volume/page-0002.jpg'), 2);
checkEqual('an unnumbered entry sorts last', zipEntryNumber('notes.txt'), Infinity);
checkEqual('a digit run with no separator is not an ordinal', zipEntryNumber('0010x.jpg'), Infinity);

{
    const mixed = ['0010 c.jpg', '0002 b.jpg', 'page-0001.jpg', '0003 a.jpg'];
    mixed.sort((a, b) => (zipEntryNumber(a) - zipEntryNumber(b)) || a.localeCompare(b));
    checkEqual('numbered and legacy names sort together by ordinal',
        mixed, ['page-0001.jpg', '0002 b.jpg', '0003 a.jpg', '0010 c.jpg']);
}

// --- the engine seam ------------------------------------------------------

// A one-page-per-manifest-entry public trial, served entirely from stubs: no
// network, no sharp (normalizePage is the caller's), no bridge. `pageName` is
// the only thing under test.
{
    const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0xff, 0xd9]);
    const file = 'OEBPS/text/cover.xhtml';
    const config = {
        configuration: { contents: [{ file }] },
        [file]: { FileLinkInfo: { PageCount: 2 } },
    };
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => ({
        ok: true, status: 200,
        arrayBuffer: async () => JPEG,
        text: async () => '',
    });

    const run = (dir, extra) => runPublicTrialJob({
        session: {
            cid: 'cid', cti: 'volume', apiHost: 'https://viewer.bookwalker.jp',
            auth: {}, baseUrl: 'https://viewer.bookwalker.jp/viewer/',
        },
        configBody: JSON.stringify(config),
        outputDir: dir,
        safeTitle: 'volume',
        pagesAsFiles: true,
        normalizePage: (data) => data,
        ...extra,
    });

    const first = fs.mkdtempSync(path.join(os.tmpdir(), 'dokuha-bw-name-'));
    const second = fs.mkdtempSync(path.join(os.tmpdir(), 'dokuha-bw-default-'));
    const zipped = fs.mkdtempSync(path.join(os.tmpdir(), 'dokuha-bw-zip-'));
    try {
        const named = await run(first, { pageName: bookWalkerPageName });
        checkEqual('the engine reports the caller names it wrote',
            named.pageFiles, ['0001 cover.jpg', '0002 cover.jpg']);
        checkEqual('and those are the files on disk',
            fs.readdirSync(first).sort(), ['0001 cover.jpg', '0002 cover.jpg']);

        const unnamed = await run(second, {});
        checkEqual('with no pageName the engine keeps page-NNNN.jpg',
            unnamed.pageFiles, ['page-0001.jpg', 'page-0002.jpg']);
        checkEqual('and writes those files',
            fs.readdirSync(second).sort(), ['page-0001.jpg', 'page-0002.jpg']);

        // ZIP entries carry the same name (third site).
        const zippedResult = await run(zipped, { pageName: bookWalkerPageName, pagesAsFiles: false });
        const archive = fs.readFileSync(zippedResult.outputPath);
        checkEqual('the ZIP entries carry the caller names',
            zipLocalNames(archive), ['0001 cover.jpg', '0002 cover.jpg']);

        // The bridge upload carries it too (bridge stub records what it is handed).
        const streamed = [];
        const bridge = {
            startSession: async () => ({ session_id: 'sess', safe_title: 'volume' }),
            pushPageBuffer: async (sessionId, data, filename, pageNumber) => {
                streamed.push(filename);
                return { ok: true };
            },
        };
        const uploaded = await run(first, {
            pageName: bookWalkerPageName, ocr: true, pagesAsFiles: false, bridge,
            bridgeUrl: 'http://stub.invalid',
        });
        check('the bridge run completed', uploaded.ok === true, JSON.stringify(uploaded));
        checkEqual('the bridge is handed the caller names',
            streamed.sort(), ['0001 cover.jpg', '0002 cover.jpg']);
    } finally {
        globalThis.fetch = originalFetch;
        for (const dir of [first, second, zipped]) fs.rmSync(dir, { recursive: true, force: true });
    }
}

finish();
