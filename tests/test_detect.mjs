/**
 * URL detection.
 *
 * Every case here is a real URL shape that has been seen in the wild, because a
 * detection miss shows up as "not a CMOA, ebookjapan, BookWalker or Kindle URL"
 * and sends the user looking in the wrong place.
 */

import { canExpandSeries, detectSource, isSeriesPage, KINDLE_UNLIMITED_LABEL, STORE_LABELS } from '../src/detect.js';
import { check, checkEqual, finish } from './_harness.mjs';

const CMOA_UUID = 'de00000002-0000-4000-8000-000000000002';

// A CMOA title page expands to volumes, so it is its own kind.
{
    const d = detectSource('https://www.cmoa.jp/title/249001/');
    checkEqual('title page kind', d.kind, 'cmoa-title');
    checkEqual('title page id', d.titleId, '249001');
    checkEqual('a title page has no volume of its own', d.volume, null);
}

// A /vol/<n>/ is more specific than --cm-volume and must be captured, otherwise
// volume 2 silently downloads volume 1.
{
    const d = detectSource('https://www.cmoa.jp/title/249001/vol/2/');
    checkEqual('volume URL kind', d.kind, 'cmoa-title');
    checkEqual('volume URL id', d.titleId, '249001');
    checkEqual('volume URL number', d.volume, 2);

    const d3 = detectSource('https://www.cmoa.jp/title/249001/vol/13/');
    checkEqual('a multi-digit volume survives', d3.volume, 13);
}

// A direct cid, and the viewer URL that carries it.
{
    checkEqual('a bare cid is a CMOA volume', detectSource('0000249001_jp_0001').cid, '0000249001_jp_0001');
    const viewer = detectSource('https://www.cmoa.jp/bib/speedreader/?cid=0000249001_jp_0001&u0=1');
    checkEqual('a speedreader URL yields its cid', viewer.cid, '0000249001_jp_0001');
    checkEqual('a speedreader URL is a volume, not a title', viewer.kind, 'cmoa');
}

// CMOA cids are exactly 10 digits, _jp_, 4 digits. Anything else is not a cid.
{
    check('a malformed cid is not accepted', detectSource('000024951_jp_1').kind === 'unknown');
}

// ebookjapan takes a books URL and a bare *reading* code. A bare *publication*
// code is rejected: it does not name its title, and `open_book` answers 404 for
// one, so sending it to the store only produces a confusing failure.
{
    const url = 'https://ebookjapan.yahoo.co.jp/books/621001/A009000007/';
    const d = detectSource(url);
    checkEqual('ebookjapan URL kind', d.kind, 'ebookjapan');
    checkEqual('the URL is passed through unchanged', d.url, url);
    checkEqual('a volume URL carries its title id', d.titleId, '621001');
    checkEqual('a volume URL carries its publication', d.publication, 'A009000007');

    checkEqual('a bare reading code is accepted', detectSource('B00900000013').kind, 'ebookjapan');
    checkEqual('a viewer-style URL is accepted',
        detectSource('https://ebookjapan.yahoo.co.jp/books/126001/A009000001/').kind, 'ebookjapan');

    const bare = detectSource('A009000007');
    checkEqual('a bare publication code is not treated as a volume', bare.kind, 'unknown');
    check('a bare publication code says which URL does work',
        /does not name its own title/.test(bare.reason) && /books\/<title>\/A009000007\//.test(bare.reason),
        bare.reason);
}

// A /books/<id>/ with no publication code after it is the series page, and it
// must not be mistaken for a volume: the volume engine cannot read it and used
// to fail with "no pages found" rather than naming the missing --series.
{
    const d = detectSource('https://ebookjapan.yahoo.co.jp/books/621001/');
    checkEqual('a series page is its own kind', d.kind, 'ebookjapan-title');
    checkEqual('a series page keeps its title id', d.titleId, '621001');

    checkEqual('a trailing query still reads as a series page',
        detectSource('https://ebookjapan.yahoo.co.jp/books/621001/?ref=x').kind, 'ebookjapan-title');
    check('a series page is not a volume',
        detectSource('https://ebookjapan.yahoo.co.jp/books/621001/A009000007/').kind !== 'ebookjapan-title');
}

// A BookWalker /series/<id>/ page is likewise not a volume.
{
    const d = detectSource('https://bookwalker.jp/series/114001/');
    checkEqual('a series page is its own kind', d.kind, 'bookwalker-series');
    checkEqual('a series page keeps its series id', d.seriesId, '114001');

    checkEqual('the /list/ form resolves to the same series',
        detectSource('https://bookwalker.jp/series/114001/list/').seriesId, '114001');
}

// BookWalker must yield a BARE uuid for the handshake and a canonical /de<uuid>/
// URL for the page job. Getting this wrong produced `dede...` and 404s.
{
    const fromUrl = detectSource(`https://bookwalker.jp/${CMOA_UUID}/`);
    checkEqual('BookWalker kind', fromUrl.kind, 'bookwalker');
    checkEqual('BookWalker cid has no de prefix', fromUrl.cid, CMOA_UUID.replace(/^de/, ''));
    checkEqual('BookWalker url is canonical', fromUrl.url, `https://bookwalker.jp/${CMOA_UUID}/`);

    // A uuid given bare, with or without the de prefix, must normalise the same.
    const bare = detectSource('00000002-0000-4000-8000-000000000002');
    checkEqual('a bare uuid is normalised', bare.cid, '00000002-0000-4000-8000-000000000002');
    checkEqual('a bare uuid gets a canonical url', bare.url, `https://bookwalker.jp/${CMOA_UUID}/`);

    const prefixed = detectSource(CMOA_UUID);
    checkEqual('a de-prefixed uuid is stripped for the cid', prefixed.cid, '00000002-0000-4000-8000-000000000002');

    const upper = detectSource(`https://bookwalker.jp/${CMOA_UUID.toUpperCase()}/`);
    checkEqual('an uppercase uuid is lowercased', upper.cid, '00000002-0000-4000-8000-000000000002');
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
        detectSource('  0000249001_jp_0001  ').cid, '0000249001_jp_0001');
}

// Kindle: a volume is an ASIN, and there is no offline series form, so every
// Kindle form is the one `kindle` kind.
{
    const reader = detectSource('https://read.amazon.co.jp/manga/B090000001?ref_=dbs_ebk_wr_lft');
    checkEqual('the reader is a Kindle volume', reader.kind, 'kindle');
    checkEqual('the reader URL yields the ASIN', reader.asin, 'B090000001');
    checkEqual('the reader URL is normalised to the bare volume', reader.url, 'https://read.amazon.co.jp/manga/B090000001');

    // The URL a user actually copies: a store product page with a long tracking
    // tail and a `/ref=` segment after the ASIN.
    const product = detectSource('https://www.amazon.co.jp/%E3%82%B5%E3%83%B3%E3%83%97%E3%83%AB-1-ebook/dp/B090000002/ref=sr_1_5?__mk_ja_JP=%E3%82%AB%E3%82%BF%E3%82%AB%E3%83%8A&qid=1790540084&sr=8-5');
    checkEqual('a product page is a Kindle volume', product.kind, 'kindle');
    checkEqual('the ASIN is read out of a product page', product.asin, 'B090000002');
    checkEqual('a product page targets the reader', product.url, 'https://read.amazon.co.jp/manga/B090000002');

    checkEqual('the older /gp/product/ route works too',
        detectSource('https://www.amazon.co.jp/gp/product/B090000002').asin, 'B090000002');
    checkEqual('a bare ASIN is accepted', detectSource('b090000002').asin, 'B090000002');
    checkEqual('a lowercase ASIN is uppercased',
        detectSource('https://read.amazon.co.jp/manga/b090000002').asin, 'B090000002');
    // A Kindle ASIN cannot collide with the other stores' codes, which is what
    // makes a bare one safe to accept.
    check('a Kindle ASIN is not mistaken for an ebookjapan code',
        detectSource('B090000002').kind !== 'ebookjapan');
    check('another marketplace is not silently treated as amazon.co.jp',
        detectSource('https://www.amazon.com/dp/B090000002').kind === 'unknown');
}

// Kindle can be expanded into a series, but it is not a series *page* kind: an
// ASIN is a volume or a series landing page and only the network can say which.
{
    const det = detectSource('B090000002');
    check('a Kindle volume can seed a series walk', canExpandSeries(det) === true);
    check('a Kindle volume is not reported as a series page', isSeriesPage(det) === false);
}

// Every result must carry the fields the caller reads, whatever the kind.
{
    for (const input of ['https://www.cmoa.jp/title/1/', 'A009000007', `https://bookwalker.jp/${CMOA_UUID}/`, 'B090000002']) {
        const d = detectSource(input);
        check(`a detected kind always has a url (${d.kind})`, typeof d.url === 'string' && d.url.length > 0);
    }
}

// k-manga. A title page is a series page; a /vol/<n>/ and a viewer-launcher link
// both name one volume. The launcher order matters: `/title/<id>/vol/<n>` has to
// win over the title pattern, or pasting a volume silently downloads volume 1.
{
    const title = detectSource('https://comic.k-manga.jp/title/180001/pv');
    checkEqual('a k-manga title page is its own kind', title.kind, 'kmanga-title');
    checkEqual('the title page carries its book id', title.bookId, '180001');
    check('a k-manga title page asks for --series', isSeriesPage(title) === true);
    check('a k-manga title page can seed a series', canExpandSeries(title) === true);
    checkEqual('the unpaginated title URL is the same kind',
        detectSource('https://comic.k-manga.jp/title/180001').kind, 'kmanga-title');

    const volume = detectSource('https://comic.k-manga.jp/title/180001/vol/3');
    checkEqual('a volume page is a volume, not the series', volume.kind, 'kmanga-volume');
    checkEqual('the volume number survives', volume.volume, 3);
    checkEqual('the book id survives', volume.bookId, '180001');
    check('a volume page does not ask for --series', isSeriesPage(volume) === false);

    // The free-reading entry point, both the signed-out form and the campaign form
    // with a free-content id and an expiry in the tail.
    checkEqual('a signed-out launcher names its volume',
        detectSource('https://comic.k-manga.jp/viewer-launcher/3/1/180001/pv/1/1/4/0/0').volume, 1);
    const campaign = detectSource('https://comic.k-manga.jp/viewer-launcher/3/1/180001/pv/2/1/1/1412944/20260916134355');
    checkEqual('a campaign launcher names its volume too', campaign.volume, 2);
    checkEqual('a launcher is resolved as a volume', campaign.kind, 'kmanga-volume');

    checkEqual('the store has a short label', STORE_LABELS.kmanga, 'KM');
}

finish();

// A Kindle Unlimited loan is the same store with a different acquisition, and it
// gets its own label so a free volume and a borrowed one are told apart before
// anything is downloaded.
check('the Unlimited label is distinct from the store label',
    KINDLE_UNLIMITED_LABEL !== STORE_LABELS.kindle, KINDLE_UNLIMITED_LABEL);
checkEqual('the Unlimited label is KDUL', KINDLE_UNLIMITED_LABEL, 'KDUL');
