/**
 * URL detection.
 *
 * Every case here is a real URL shape that has been seen in the wild, because a
 * detection miss shows up as "not a CMOA, ebookjapan or BookWalker URL" and sends
 * the user looking in the wrong place.
 */

import { detectSource } from '../src/detect.js';
import { check, checkEqual, finish } from './_harness.mjs';

const CMOA_UUID = 'de6461eaef-29c4-4fd2-8e8b-ffee523559ca';

// A CMOA title page expands to volumes, so it is its own kind.
{
    const d = detectSource('https://www.cmoa.jp/title/249510/');
    checkEqual('title page kind', d.kind, 'cmoa-title');
    checkEqual('title page id', d.titleId, '249510');
    checkEqual('a title page has no volume of its own', d.volume, null);
}

// A /vol/<n>/ is more specific than --cm-volume and must be captured, otherwise
// volume 2 silently downloads volume 1.
{
    const d = detectSource('https://www.cmoa.jp/title/249510/vol/2/');
    checkEqual('volume URL kind', d.kind, 'cmoa-title');
    checkEqual('volume URL id', d.titleId, '249510');
    checkEqual('volume URL number', d.volume, 2);

    const d3 = detectSource('https://www.cmoa.jp/title/249510/vol/13/');
    checkEqual('a multi-digit volume survives', d3.volume, 13);
}

// A direct cid, and the viewer URL that carries it.
{
    checkEqual('a bare cid is a CMOA volume', detectSource('0000249510_jp_0001').cid, '0000249510_jp_0001');
    const viewer = detectSource('https://www.cmoa.jp/bib/speedreader/?cid=0000249510_jp_0001&u0=1');
    checkEqual('a speedreader URL yields its cid', viewer.cid, '0000249510_jp_0001');
    checkEqual('a speedreader URL is a volume, not a title', viewer.kind, 'cmoa');
}

// CMOA cids are exactly 10 digits, _jp_, 4 digits. Anything else is not a cid.
{
    check('a malformed cid is not accepted', detectSource('000024951_jp_1').kind === 'unknown');
}

// ebookjapan takes a books URL, a bare publication code, and passes the string
// through untouched because the tool accepts several shapes itself.
{
    const url = 'https://ebookjapan.yahoo.co.jp/books/621986/A002664637/';
    const d = detectSource(url);
    checkEqual('ebookjapan URL kind', d.kind, 'ebookjapan');
    checkEqual('the URL is passed through unchanged', d.url, url);

    checkEqual('a bare publication code is accepted', detectSource('A002664637').kind, 'ebookjapan');
    checkEqual('a viewer-style URL is accepted',
        detectSource('https://ebookjapan.yahoo.co.jp/books/126344/A000065415/').kind, 'ebookjapan');
}

// BookWalker must yield a BARE uuid for the handshake and a canonical /de<uuid>/
// URL for the page job. Getting this wrong produced `dede...` and 404s.
{
    const fromUrl = detectSource(`https://bookwalker.jp/${CMOA_UUID}/`);
    checkEqual('BookWalker kind', fromUrl.kind, 'bookwalker');
    checkEqual('BookWalker cid has no de prefix', fromUrl.cid, CMOA_UUID.replace(/^de/, ''));
    checkEqual('BookWalker url is canonical', fromUrl.url, `https://bookwalker.jp/${CMOA_UUID}/`);

    // A uuid given bare, with or without the de prefix, must normalise the same.
    const bare = detectSource('6461eaef-29c4-4fd2-8e8b-ffee523559ca');
    checkEqual('a bare uuid is normalised', bare.cid, '6461eaef-29c4-4fd2-8e8b-ffee523559ca');
    checkEqual('a bare uuid gets a canonical url', bare.url, `https://bookwalker.jp/${CMOA_UUID}/`);

    const prefixed = detectSource(CMOA_UUID);
    checkEqual('a de-prefixed uuid is stripped for the cid', prefixed.cid, '6461eaef-29c4-4fd2-8e8b-ffee523559ca');

    const upper = detectSource(`https://bookwalker.jp/${CMOA_UUID.toUpperCase()}/`);
    checkEqual('an uppercase uuid is lowercased', upper.cid, '6461eaef-29c4-4fd2-8e8b-ffee523559ca');
}

// A trailing query is dropped: the trial route is chosen by an option, and a
// leftover `?sample=2` gets spliced into the licence URL as part of the cid.
{
    const d = detectSource(`https://bookwalker.jp/${CMOA_UUID}/?sample=2`);
    checkEqual('a sample query is dropped from the canonical url', d.url, `https://bookwalker.jp/${CMOA_UUID}/`);
    check('no query survives in the url', !d.url.includes('?'), d.url);
}

// Unknown input is reported rather than guessed.
{
    const d = detectSource('https://example.com/not-a-store');
    checkEqual('an unrelated URL is unknown', d.kind, 'unknown');
    check('unknown input carries a reason', typeof d.reason === 'string' && d.reason.length > 0);
    checkEqual('empty input is unknown', detectSource('').kind, 'unknown');
    checkEqual('whitespace is trimmed before matching',
        detectSource('  0000249510_jp_0001  ').cid, '0000249510_jp_0001');
}

// Every result must carry the fields the caller reads, whatever the kind.
{
    for (const input of ['https://www.cmoa.jp/title/1/', 'A002664637', `https://bookwalker.jp/${CMOA_UUID}/`]) {
        const d = detectSource(input);
        check(`a detected kind always has a url (${d.kind})`, typeof d.url === 'string' && d.url.length > 0);
    }
}

finish();
