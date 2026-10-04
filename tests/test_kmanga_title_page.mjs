/**
 * Reading a k-manga title page's reading offers.
 *
 * The markup here is lifted from the live page, and the distinction it pins is the
 * one that made samplers invisible: a **free** volume is rendered as a real link,
 * while a **sample** or campaign volume is rendered as a button with no `href` at
 * all -- `title.js` fills the href in on `DOMContentLoaded` from the page's own
 * settings plus the button's `data-chapter-*` attributes. A parser that only follows
 * hrefs therefore reports two volumes for a title that offers ten, and calls the
 * other eight non-existent rather than merely not free.
 *
 * The attribute casing is pinned too, because it differs by source: the live page
 * writes `data-chapter-readType`, and a browser-saved copy of the same page writes
 * `data-chapter-readtype`, since serialising a DOM lowercases names.
 */

import { parseTitlePage, parseLauncherUrl } from '../src/download/kmanga.js';
import { checkEqual, finish } from './_harness.mjs';

/** The settings element the page's own script reads. */
const TITLEJS = `<script data-src="/js_new/sp_page/title/title.js" id="titlejs"
    data-book="180001"
    data-format-type="pv"
    data-fcipath="1"
    data-viewer-id-html="0"
    data-viewer-id-pc="3"
    data-quality-default="1"
    data-quality-normal="0"
    data-quality-high="1"
  ></script>`;

/** A free read: a real, server-rendered link. */
const FREE_LINK = `<a href="/viewer-launcher/3/1/180001/pv/1/1/4/0/0"
    class="book-chapter--btn book-chapter--btn__jikuri gaevent-detail-notlogin-btn-free"
    target="_blank" rel="nofollow">無料で読む</a>`;

/** A sample: a button with no href, exactly as the live page serves it. */
const SAMPLE_BUTTON = `<a class="btn book-chapter--btn__sample x-invoke-viewer--btn__selector gaevent-detail-chapter-read-sample"
    data-chapter-exid="3"
    data-chapter-fcipath="1"
    data-chapter-readType="0"
    data-chapter-fcid="0"
    data-chapter-fcupdated="0"
    rel="nofollow">
    試し読み
  </a>`;

const NAME_LD = `<script type="application/ld+json">{"@type": "ProductGroup", "name": "サンプル作品", "url": "https://comic.k-manga.jp/title/180001/pv"}</script>`;

// The blocker itself: a button with no href still has to become a usable launcher.
{
    const page = parseTitlePage(`${TITLEJS}${SAMPLE_BUTTON}`);
    checkEqual('a button with no href is still found', page.volumes.length, 1);
    checkEqual('its volume comes from data-chapter-exid', page.volumes[0]?.volume, 3);
    checkEqual('it is classified as a sample', page.volumes[0]?.sample, true);
    checkEqual('its read type is read from the capital-T attribute', page.volumes[0]?.readType, 0);
    checkEqual('its launcher is rebuilt the way the page\u2019s script would build it',
        page.volumes[0]?.launcher,
        'https://comic.k-manga.jp/viewer-launcher/3/1/180001/pv/3/1/0/0/0');
}

// A rendered link is used as-is, and is a full free read rather than a sample.
{
    const page = parseTitlePage(`${TITLEJS}${FREE_LINK}`);
    checkEqual('a rendered link is used verbatim', page.volumes[0]?.launcher,
        'https://comic.k-manga.jp/viewer-launcher/3/1/180001/pv/1/1/4/0/0');
    checkEqual('read type 4 is a whole free read', page.volumes[0]?.sample, false);
}

// The same page saved by a browser: lowercased attributes, and an href the browser
// wrote in. Both spellings have to read the same, or the parser works against a
// saved copy and silently fails against the live site.
{
    const saved = `<a class="btn book-chapter--btn__sample x-invoke-viewer--btn__selector gaevent-detail-chapter-read-sample" data-chapter-exid="4" data-chapter-fcipath="1" data-chapter-readtype="0" data-chapter-fcid="0" data-chapter-fcupdated="0" rel="nofollow" href="https://comic.k-manga.jp/viewer-launcher/3/1/180001/pv/4/1/0/0/0" target="_blank"> 試し読み </a>`;
    const page = parseTitlePage(`${TITLEJS}${saved}`);
    checkEqual('a lowercased read type reads the same', page.volumes[0]?.readType, 0);
    checkEqual('and is still a sample', page.volumes[0]?.sample, true);
    checkEqual('and keeps the href the browser wrote', page.volumes[0]?.launcher,
        'https://comic.k-manga.jp/viewer-launcher/3/1/180001/pv/4/1/0/0/0');
}

// A whole page: free volumes first in the result, samplers for the rest, and a
// volume offered both ways resolves to the free read.
{
    const html = `${NAME_LD}${TITLEJS}${FREE_LINK}${SAMPLE_BUTTON}`
        + `<a class="btn book-chapter--btn__sample x-invoke-viewer--btn__selector" data-chapter-exid="1" data-chapter-fcipath="1" data-chapter-readType="0" data-chapter-fcid="0" data-chapter-fcupdated="0">試し読み</a>`
        + `<a href="/viewer-launcher/3/1/180001/pv/2/1/4/0/0" class="gaevent-detail-notlogin-chapter-img" rel="nofollow">無料で読む</a>`;
    const page = parseTitlePage(html);
    checkEqual('the series name comes from the structured data', page.name, 'サンプル作品');
    checkEqual('every offer is listed, sorted by volume', page.volumes.map((v) => v.volume), [1, 2, 3]);
    checkEqual('the free read wins over a sample of the same volume', page.volumes[0]?.sample, false);
    checkEqual('the free read keeps its own launcher', page.volumes[0]?.readType, 4);
    checkEqual('volume 2 is a free read too', page.volumes[1]?.sample, false);
    checkEqual('volume 3 is a sample', page.volumes[2]?.sample, true);
}

// Without the settings element, a button cannot be turned into a URL. The rendered
// free link is then used as the template for the prefix -- and if there is neither,
// the button is skipped rather than guessed at.
{
    const page = parseTitlePage(`${FREE_LINK}${SAMPLE_BUTTON}`);
    checkEqual('the fallback reads the prefix off a rendered link', page.volumes[1]?.launcher,
        'https://comic.k-manga.jp/viewer-launcher/3/1/180001/pv/3/1/0/0/0');

    const orphan = parseTitlePage(SAMPLE_BUTTON);
    checkEqual('a button with neither is skipped, not invented', orphan.volumes.length, 0);
}

// Anchors that are not reading offers must not become volumes.
{
    const noise = `${TITLEJS}<a class="btn" href="/title/180001/vol/1">サンプル作品(1)</a>`
        + `<a href="/register/" class="btn">会員登録</a>`;
    checkEqual('ordinary links are not volumes', parseTitlePage(noise).volumes.length, 0);
}

// The launcher path shape, on its own.
{
    const parsed = parseLauncherUrl('/viewer-launcher/3/1/180001/pv/5/1/0/0/0');
    checkEqual('the book id is the fourth segment', parsed.bookId, '180001');
    checkEqual('the volume is the sixth', parsed.volume, 5);
    checkEqual('the read type is the eighth', parsed.readType, 0);
    checkEqual('a non-launcher path is refused', parseLauncherUrl('/title/180001/vol/5'), null);
}

finish();
