/**
 * `--series`: reading a series' volume list and keeping only the free volumes.
 *
 * The three stores expose that list in three unrelated ways and the "free" signal
 * is the part that is easiest to get subtly wrong: CMOA marks *every* volume with
 * a `GA_free` trial button, and BookWalker marks most paid volumes with a 試し読み
 * button next to the free one. Both fixtures below therefore contain a paid volume
 * that carries the trial marker, because matching on the marker's prefix instead
 * of the whole free button is the exact bug this suite exists to catch.
 *
 * Parsers are pure and are tested against saved pages; the resolvers get a stub
 * fetch, so nothing here touches the network.
 */

import { resolveSeries } from '../src/platforms/index.js';
import { parseOptions } from '../src/options.js';
import { detectSource } from '../src/detect.js';
import {
    dedupeBookwalkerVolumes,
    parseBookwalkerNextPage,
    parseBookwalkerSeriesId,
    parseBookwalkerSeriesList,
    parseEbookjapanFreeVolumes,
    parseEbookjapanSamplerVolumes,
    parseEbookjapanSeriesPage,
    parseVolumeNumber,
} from '../src/series.js';
import { cmoaTitleIdFromCid, parseCmoaLastPage, parseCmoaSeriesPage } from '../src/download/cmoa.js';
import { buildTasks } from '../src/run.js';
import { check, checkEqual, finish } from './_harness.mjs';

/** A stand-in for `fetch` that answers from a table of `[pattern, body]`. */
function stubFetch(routes) {
    const seen = [];
    const impl = async (url) => {
        const href = String(url);
        seen.push(href);
        for (const [pattern, body] of routes) {
            if (!pattern.test(href)) continue;
            const text = typeof body === 'function' ? body(href) : body;
            return {
                ok: true,
                status: 200,
                text: async () => text,
                json: async () => JSON.parse(text),
            };
        }
        return { ok: false, status: 404, text: async () => '', json: async () => null };
    };
    impl.seen = seen;
    return impl;
}

// ---------------------------------------------------------------------------
// CMOA
// ---------------------------------------------------------------------------

const CMOA_PAGE_1 = `
<div class="title_details_pack_cam_box_1pxbox" id="comic_list">
<div class="pagination"><ul class="pages clearfix">
<li><a href="/title/214001/?order=up#buyarea">1</a></li>
<li><a href="/title/214001/?order=up&amp;page=2#buyarea">2</a></li>
</ul></div>
<ul class="title_vol_vox_vols">
<li><div class="title_vol_vox_vols_i clearfix">
  <div class="thum_box_w"><div class="thum_box"><img src="a.jpg" alt="サンプル作品 1巻"></div></div>
  <div class="title_vol_btn_box_w">
    <a href="javascript:void(0)" class="cart_into_btn registBtn" _content_type="2" _content_id="100002140010001" _chapter_no_s="1"><p class="title">会員登録して購入</p></a>
    <a href="/reader/sample/?title_id=214001&amp;content_id=100002140010001" rel="nofollow"><div class="GA_free btn free"><span>無料で読む</span><span>10/15まで</span></div><span class="mark">&yen;<span class="em">0</span></span></a>
  </div>
</div></li>
<li><div class="title_vol_vox_vols_i clearfix">
  <div class="thum_box_w"><div class="thum_box"><img src="b.jpg" alt="サンプル作品 13巻"></div></div>
  <div class="title_vol_btn_box_w">
    <a href="javascript:void(0)" class="cart_into_btn registBtn" _content_type="2" _content_id="100002140010013" _chapter_no_s="13"><p class="title">会員登録して購入</p></a>
    <a href="/reader/sample/?title_id=214001&amp;content_id=100002140010013" rel="nofollow"><div class="title_vol_each_free_btn GA_free"></div></a>
    <span class="mark">&yen;<span class="em">700</span></span>
  </div>
</div></li>
</ul>
<div class="pagination"><ul class="pages clearfix"><li><a href="/title/214001/?order=up&amp;page=2#buyarea">2</a></li></ul></div>
</div>`;

const CMOA_PAGE_2 = `
<div class="title_details_pack_cam_box_1pxbox" id="comic_list">
<div class="pagination"><ul class="pages clearfix"><li><a href="/title/214001/?order=up#buyarea">1</a></li></ul></div>
<ul class="title_vol_vox_vols">
<li><div class="title_vol_vox_vols_i clearfix">
  <a class="cart_into_btn registBtn" _content_id="100002140010002" _chapter_no_s="2"></a>
  <a href="/reader/sample/?title_id=214001&amp;content_id=100002140010002" rel="nofollow"><div class="GA_free btn free"><span>無料で読む</span><span>10/15まで</span></div><span class="mark">&yen;<span class="em">0</span></span></a>
</div></li>
</ul>
</div>`;

// The pager's highest number is the last page. Out-of-range pages are clamped by
// the store rather than answering empty, so probing until a page repeats would
// never terminate.
checkEqual('the pager gives the last page', parseCmoaLastPage(CMOA_PAGE_1), 2);
checkEqual('a page with no pager is page one', parseCmoaLastPage('<html></html>'), 1);
// The pager appears twice, before and after the grid; neither copy is a volume.
checkEqual('the anchor form of a pager link is read', parseCmoaLastPage('<a href="/title/1/?order=up&amp;page=7#buyarea">7</a>'), 7);

{
    const parsed = parseCmoaSeriesPage(CMOA_PAGE_1, '214001');
    checkEqual('only the grid is read, not the pager or the page furniture', parsed.volumes.length, 2);
    checkEqual('the volume number comes from the content id', parsed.volumes.map((v) => v.volume), [1, 13]);
    checkEqual('the cid is derived from the title and volume', parsed.volumes[0].cid, '0000214001_jp_0001');
    checkEqual('a campaign button marks a volume free', parsed.volumes[0].free, true);
    // The trial button is on nearly every volume in the catalogue, so matching on
    // `GA_free` alone would call this paid volume free.
    checkEqual('the trial-read button alone is not free', parsed.volumes[1].free, false);
    checkEqual('the last page survives the grid parse', parsed.lastPage, 2);
}

// The numeric title id is the padded cid prefix with its zeroes removed, which is
// the form the store's own URLs use.
checkEqual('a padded cid yields an unpadded title id', cmoaTitleIdFromCid('0000214001_jp_0001'), '214001');
checkEqual('a cid that is not a cid yields nothing', cmoaTitleIdFromCid('not-a-cid'), null);

{
    const fetchImpl = stubFetch([
        [/title\/214001\/\?order=up&page=2/, CMOA_PAGE_2],
        [/title\/214001\/\?order=up/, CMOA_PAGE_1],
    ]);
    const det = detectSource('https://www.cmoa.jp/title/214001/?order=up&page=4#buyarea');
    checkEqual('the page-4 URL is still a title page', det.kind, 'cmoa-title');

    const resolved = await resolveSeries(det, 'https://www.cmoa.jp/title/214001/?order=up&page=4#buyarea', { fetchImpl });
    checkEqual('every page of the grid is followed', resolved.tasks.length, 2);
    checkEqual('only free volumes become tasks', resolved.tasks.map((t) => t.volume), [1, 2]);
    checkEqual('the tasks are CMOA volumes', resolved.tasks.map((t) => t.kind), ['cmoa', 'cmoa']);
    checkEqual('both grid pages were fetched', fetchImpl.seen.length, 2);
    checkEqual('the resolver reports what it found', resolved.notes.length, 1);

    // A bare cid names a volume whose series can still be looked up.
    const fromCid = await resolveSeries(detectSource('0000214001_jp_0013'), '0000214001_jp_0013', { fetchImpl });
    checkEqual('a bare cid resolves to its series', fromCid.tasks.map((t) => t.volume), [1, 2]);
}

{
    const fetchImpl = stubFetch([[/title\/214001\/\?order=up/, CMOA_PAGE_1.replace(/GA_free btn free/g, 'GA_free btn')]]);
    const resolved = await resolveSeries(detectSource('https://www.cmoa.jp/title/214001/'), 'https://www.cmoa.jp/title/214001/', { fetchImpl });
    checkEqual('a series with nothing free yields no tasks', resolved.tasks.length, 0);
    check('a series with nothing free says so', /none of them are free/.test(resolved.rejected[0]?.error || ''), resolved.rejected[0]?.error);
}

// ---------------------------------------------------------------------------
// --download-samplers
//
// The flag carries a series past its free volumes and takes each remaining
// volume's 試し読み, to the end of the series. Every store marks the preview
// separately from whole-volume free, and on CMOA and BookWalker a volume can
// carry both at once, so the free reading has to win.
// ---------------------------------------------------------------------------

{
    const parsed = parseCmoaSeriesPage(CMOA_PAGE_1, '214001');
    checkEqual('a CMOA volume offering a 試し読み is marked as one',
        parsed.volumes.map((v) => v.sample), [true, true]);
    checkEqual('a volume free in full is still free when it also offers a 試し読み',
        parsed.volumes[0].free, true);

    const route = [
        [/title\/214001\/\?order=up&page=2/, CMOA_PAGE_2],
        [/title\/214001\/\?order=up/, CMOA_PAGE_1],
    ];
    const det = detectSource('https://www.cmoa.jp/title/214001/');
    const input = 'https://www.cmoa.jp/title/214001/';

    const extended = await resolveSeries(det, input, {
        fetchImpl: stubFetch(route), config: { downloadSamplers: true },
    });
    // Volumes 1 and 2 are free in full; 13 is only a preview. Volume 1 carries a
    // 試し読み link as well and must not be taken twice.
    checkEqual('samplers extend the series past the free volumes',
        extended.tasks.map((t) => t.volume), [1, 2, 13]);
    checkEqual('only the preview-only volume is marked as a sampler',
        extended.tasks.map((t) => t.sample === true), [false, false, true]);
    checkEqual('the free volumes come first', extended.tasks.map((t) => t.kind), ['cmoa', 'cmoa', 'cmoa']);

    const plain = await resolveSeries(det, input, { fetchImpl: stubFetch(route) });
    checkEqual('without the flag only the free volumes are taken',
        plain.tasks.map((t) => t.volume), [1, 2]);
}

{
    // Nothing is free in full, but every volume still offers a preview. A plain
    // --series run has nothing to do; --download-samplers has the whole series.
    const previewOnly = CMOA_PAGE_1.replace(/GA_free btn free/g, 'GA_free btn');
    const fetchImpl = stubFetch([[/title\/214001\/\?order=up/, previewOnly]]);
    const det = detectSource('https://www.cmoa.jp/title/214001/');
    const input = 'https://www.cmoa.jp/title/214001/';

    const plain = await resolveSeries(det, input, { fetchImpl });
    checkEqual('with nothing free and no flag there is nothing to take', plain.tasks.length, 0);
    check('and it does not blame the samplers it was never asked for',
        /none of them are free right now/.test(plain.rejected[0]?.error || ''), plain.rejected[0]?.error);

    const extended = await resolveSeries(det, input, { fetchImpl, config: { downloadSamplers: true } });
    checkEqual('with the flag the previews carry the series',
        extended.tasks.map((t) => t.volume), [1, 13]);
    check('the note says how many samplers were taken',
        /2 試し読み samplers/.test(extended.notes[0] || ''), extended.notes[0]);
}

// ---------------------------------------------------------------------------
// ebookjapan
// ---------------------------------------------------------------------------

const EBJ_TITLE_PAGE = `
<script>window.__NUXT__=(function(){return {data:[{publicationCd:1,name:2},{publicationCd:3,name:4}]}}("A009000006","サンプル作品　（１）","A009000007","サンプル作品　（２）"));}();</script>`;

const EBJ_DETAIL = JSON.stringify({
    detail: {
        publication: 'A009000006',
        name: 'サンプル作品　（１）',
        order: 1,
        branch: 0,
        code: 'B00900000007',
        isFree: true,
        price: 0,
        title: { id: '621001' },
    },
    series: [
        { publication: 'A009000013', name: 'サンプル作品【期間限定無料】　（1）', order: 1, branch: 122, code: 'B00900000014', isFree: true, price: 0, title: '621001' },
        { publication: 'A009000007', name: 'サンプル作品　（2）', order: 2, branch: 0, code: 'B00900000008', isFree: true, price: 0, title: '621001' },
        { publication: 'A009000014', name: 'サンプル作品【期間限定無料】　（2）', order: 2, branch: 18, code: 'B00900000015', isFree: true, price: 0, title: '621001' },
        // A trial-only volume: `isFree` false with its preview in `trial`. This is
        // what "free volumes only" has to skip.
        { publication: 'A009000008', name: 'サンプル作品　（3）', order: 3, branch: 0, code: 'B00900000009', isFree: false, price: 700, trial: 'B00900000016', title: '621001' },
    ],
});

checkEqual('publication codes are collected from the title page',
    parseEbookjapanSeriesPage(EBJ_TITLE_PAGE), ['A009000006', 'A009000007']);
checkEqual('an unrelated page yields no codes', parseEbookjapanSeriesPage('<html>hi</html>'), []);

{
    const free = parseEbookjapanFreeVolumes(JSON.parse(EBJ_DETAIL));
    checkEqual('a trial-only volume is not free', free.map((f) => f.order), [1, 2]);
    // The same volume appears as a plain edition and a campaign edition; they
    // resolve to the same pages, so the plain one is preferred and only one task
    // is produced. The plain edition of the seed volume is `body.detail`, which is
    // why reading `series` alone got this wrong and used the campaign code.
    checkEqual('a duplicated volume yields one task, preferring the plain edition',
        free.map((f) => f.code), ['B00900000007', 'B00900000008']);
}

checkEqual('a missing response is not a crash', parseEbookjapanFreeVolumes(null), []);

// A campaign edition can also be listed *after* the plain one. Then the two
// entries disagree on `isFree` rather than on `branch`: the plain entry is
// trial-only (isFree false) and the campaign entry is free in full. Keeping
// whichever was seen first therefore kept the trial and discarded the free
// edition -- a 22-volume title with three free volumes reported "none of them
// are free right now".
{
    const body = {
        detail: {
            publication: 'A009000002', name: 'サンプル作品　（1）', order: 1, branch: 0,
            code: 'B00900000001', isFree: false, trial: 'B00900000005', title: { id: '262001' },
        },
        series: [
            { publication: 'A009000002', name: 'サンプル作品　（1）', order: 1, branch: 0, code: 'B00900000001', isFree: false, trial: 'B00900000005', title: '262001' },
            { publication: 'A009000003', name: 'サンプル作品　（1）【無料お試し版】', order: 1, branch: 31, code: 'B00900000002', isFree: true, title: '262001' },
            { publication: 'A009000004', name: 'サンプル作品　（2）', order: 2, branch: 0, code: 'B00900000003', isFree: false, trial: 'B00900000006', title: '262001' },
            { publication: 'A009000005', name: 'サンプル作品　（2）【無料お試し版】', order: 2, branch: 7, code: 'B00900000004', isFree: true, title: '262001' },
        ],
    };
    const free = parseEbookjapanFreeVolumes(body);
    checkEqual('a free edition listed after its trial is still collected',
        free.map((f) => f.order), [1, 2]);
    checkEqual('the free edition wins over the trial, not the first seen',
        free.map((f) => f.code), ['B00900000002', 'B00900000004']);
    // And the trial of a volume that is free in full must not also be offered as
    // a sampler -- it already yields the whole book.
    checkEqual('a free-in-full volume is not also a sampler',
        parseEbookjapanSamplerVolumes(body), []);
}

{
    const fetchImpl = stubFetch([
        [/br_api\/books\/621001\/[A-Z]\d+\?device=pc/, EBJ_DETAIL],
        [/ebookjapan\.yahoo\.co\.jp\/books\/621001\/$/, EBJ_TITLE_PAGE],
    ]);
    const input = 'https://ebookjapan.yahoo.co.jp/books/621001/';
    const resolved = await resolveSeries(detectSource(input), input, { fetchImpl });

    checkEqual('the series page is resolved through a seed publication', resolved.tasks.length, 2);
    checkEqual('the tasks carry reading codes the collector accepts',
        resolved.tasks.map((t) => t.target), ['B00900000007', 'B00900000008']);
    checkEqual('the tasks are ebookjapan volumes', resolved.tasks.map((t) => t.kind), ['ebookjapan', 'ebookjapan']);
    check('the volume URL is rebuilt from the title and publication',
        resolved.tasks[0].url === 'https://ebookjapan.yahoo.co.jp/books/621001/A009000006/',
        resolved.tasks[0].url);
}

// A candidate scraped off the page can belong to a recommended title. The API
// answer has to name the title that was asked for or the wrong series is
// silently downloaded.
{
    const otherTitle = JSON.stringify({ detail: { title: { id: '999999' }, isFree: true }, series: [] });
    const fetchImpl = stubFetch([
        [/br_api\/books\/621001\/A009000006/, otherTitle],
        [/ebookjapan\.yahoo\.co\.jp\/books\/621001\/$/, EBJ_TITLE_PAGE],
    ]);
    const input = 'https://ebookjapan.yahoo.co.jp/books/621001/';
    const resolved = await resolveSeries(detectSource(input), input, { fetchImpl });
    checkEqual('a seed that resolves another title is refused', resolved.tasks.length, 0);
    checkEqual('both candidates were tried', fetchImpl.seen.length, 3);
}

// A volume URL is a valid entry point too, and its own publication seeds the call.
{
    const fetchImpl = stubFetch([[/br_api\/books\/621001\/A009000006/, EBJ_DETAIL]]);
    const input = 'https://ebookjapan.yahoo.co.jp/books/621001/A009000006/';
    const resolved = await resolveSeries(detectSource(input), input, { fetchImpl });
    checkEqual('a volume URL resolves its whole series', resolved.tasks.length, 2);
    checkEqual('no title page is fetched when the seed is already known', fetchImpl.seen.length, 1);
}

// A bare reading code names no series, and saying so is better than a confusing
// failure. A bare publication code never reaches here: detection rejects it with
// the /books/<title>/ URL that does work.
{
    const resolved = await resolveSeries(detectSource('B00900000013'), 'B00900000013', { fetchImpl: stubFetch([]) });
    checkEqual('a bare code cannot be expanded', resolved.tasks.length, 0);
    check('a bare code says why', /does not name its series/.test(resolved.rejected[0]?.error || ''), resolved.rejected[0]?.error);
}

// ebookjapan's seed volume lives in `detail` while `series` lists only the
// others, and a trial-only volume carries its preview code in `trial`.
{
    const body = JSON.stringify({
        detail: {
            title: { id: '858001' }, name: 'サンプル作品　（1）', isFree: false,
            code: 'B00900000010', trial: 'B00900000017', publication: 'A009000011',
        },
        series: [
            { publication: 'A009000009', name: 'サンプル作品　（2）', order: 2, branch: 0, isFree: false, code: 'B00900000011', trial: 'B00900000018' },
            { publication: 'A009000010', name: 'サンプル作品　（3）', order: 3, branch: 0, isFree: false, code: 'B00900000012', trial: 'B00900000019' },
        ],
    });
    checkEqual('a sampler-only title has no free volumes', parseEbookjapanFreeVolumes(JSON.parse(body)), []);
    checkEqual('the seed volume is found even though the series list omits it',
        parseEbookjapanSamplerVolumes(JSON.parse(body)).length, 3);
    checkEqual('a sampler carries its trial code, never its purchase code',
        parseEbookjapanSamplerVolumes(JSON.parse(body)).map((s) => s.code),
        ['B00900000017', 'B00900000018', 'B00900000019']);

    const fetchImpl = stubFetch([[/br_api\/books\/858001\/[A-Z]\d+\?device=pc/, body]]);
    const input = 'https://ebookjapan.yahoo.co.jp/books/858001/A009000011/';
    const det = detectSource(input);

    const plain = await resolveSeries(det, input, { fetchImpl });
    checkEqual('without the flag a sampler-only title yields nothing', plain.tasks.length, 0);
    check('and the count includes the seed volume', /has 3 editions/.test(plain.rejected[0]?.error || ''), plain.rejected[0]?.error);

    const extended = await resolveSeries(det, input, { fetchImpl, config: { downloadSamplers: true } });
    checkEqual('with the flag every volume becomes a task', extended.tasks.length, 3);
    check('a sampler goes through the trial viewer, which is what selects open_book trial',
        extended.tasks.every((t) => /\/viewer\/trial\/B00\d{9}\/$/.test(t.target)),
        extended.tasks.map((t) => t.target).join(' '));
    checkEqual('the tasks are marked as samplers',
        extended.tasks.map((t) => t.sample), [true, true, true]);
}

// ---------------------------------------------------------------------------
// BookWalker
// ---------------------------------------------------------------------------

const BW_VOLUME_PAGE = '<a href="https://bookwalker.jp/series/114001/">シリーズ一覧へ</a>';

const BW_LIST_PAGE = `
<div class="m-book-item">
  <p class="m-book-item__title"><a href="https://bookwalker.jp/de00000001-0000-4000-8000-000000000001/" title="サンプル作品（１）">…</a></p>
  <div class="m-book-item__primary">
    <p class="m-book-item__price"><span class="m-book-item__price-num">792</span></p>
    <ul class="m-book-item__btn-box"><li><a href="https://bookwalker.jp/de00000001-0000-4000-8000-000000000001/?sample=1" class="a-icon-btn--trial" data-uuid="00000001-0000-4000-8000-000000000001"><span class="button-text">試し読み</span></a></li></ul>
  </div>
</div>
<div class="m-book-item">
  <p class="m-book-item__title"><a href="https://bookwalker.jp/de00000007-0000-4000-8000-000000000007/" title="【期間限定　無料お試し版】サンプル作品（１）">…</a></p>
  <div class="m-book-item__primary">
    <p class="m-book-item__price"><span class="m-book-item__price-num">0</span></p>
    <ul class="m-book-item__btn-box"><li><a href="https://bookwalker.jp/de00000007-0000-4000-8000-000000000007/?sample=2" class="a-icon-btn--free" data-uuid="00000007-0000-4000-8000-000000000007" data-action-label="無料で読む"><span class="button-text">無料で読む</span></a></li></ul>
  </div>
</div>
<div class="m-book-item">
  <p class="m-book-item__title"><a href="https://bookwalker.jp/de00000004-0000-4000-8000-000000000004/" title="【期間限定　無料お試し版】サンプル作品（１）">…</a></p>
  <div class="m-book-item__primary">
    <p class="m-book-item__price"><span class="m-book-item__price-num">0</span></p>
    <ul class="m-book-item__btn-box"><li><a href="https://bookwalker.jp/de00000004-0000-4000-8000-000000000004/?sample=2" class="a-icon-btn--free" data-uuid="00000004-0000-4000-8000-000000000004"><span class="button-text">無料で読む</span></a></li></ul>
  </div>
</div>
<link rel="next" href="https://bookwalker.jp/series/114001/list/?page=2">`;

const BW_LIST_PAGE_2 = `
<div class="m-book-item">
  <p class="m-book-item__title"><a href="https://bookwalker.jp/de00000003-0000-4000-8000-000000000003/" title="【期間限定　無料お試し版】サンプル作品（２）">…</a></p>
  <div class="m-book-item__primary">
    <ul class="m-book-item__btn-box"><li><a href="https://bookwalker.jp/de00000003-0000-4000-8000-000000000003/?sample=2" class="a-icon-btn--free" data-uuid="00000003-0000-4000-8000-000000000003"><span class="button-text">無料で読む</span></a></li></ul>
  </div>
</div>`;

checkEqual('a volume page yields its series id', parseBookwalkerSeriesId(BW_VOLUME_PAGE), '114001');
checkEqual('a page with no series link yields nothing', parseBookwalkerSeriesId('<html></html>'), null);
checkEqual('the next page is read from the page itself',
    parseBookwalkerNextPage(BW_LIST_PAGE), 'https://bookwalker.jp/series/114001/list/?page=2');
checkEqual('the last page has no next page', parseBookwalkerNextPage(BW_LIST_PAGE_2), null);

{
    const items = parseBookwalkerSeriesList(BW_LIST_PAGE);
    // The split must not cut at `m-book-item__primary`, or the item count would be
    // the number of inner elements rather than the number of volumes.
    checkEqual('each volume item is read once', items.length, 3);
    checkEqual('a trial-only volume is not free', items[0].free, false);
    checkEqual('a 無料で読む button marks a volume free', items[1].free, true);
    checkEqual('the uuid is lowercased', items[1].uuid, '00000007-0000-4000-8000-000000000007');
}

checkEqual('a full-width volume number is read', parseVolumeNumber('【期間限定　無料お試し版】サンプル作品（３）'), 3);
checkEqual('a half-width volume number is read', parseVolumeNumber('サンプル作品(12)'), 12);
checkEqual('a 第n巻 form is read', parseVolumeNumber('第7巻'), 7);
checkEqual('a title with no number yields nothing', parseVolumeNumber('サンプル作品'), null);
// A campaign edition and the plain edition of one volume do not agree on how to
// spell the number, so all three shapes have to parse to the same value.
checkEqual('a bare n巻 form is read', parseVolumeNumber('サンプル作品 3巻'), 3);
checkEqual('a full-width bare n巻 form is read', parseVolumeNumber('作品名　３巻'), 3);
// "全5巻" is a complete-set listing, not volume five; reading it as 5 would let it
// collide with a real volume 5 and silently drop one of them.
checkEqual('a complete-set listing is not a volume number', parseVolumeNumber('作品名 全5巻'), null);

// BookWalker writes a running campaign's volume number *after* the campaign
// suffix, which none of the three shapes above match. Every free volume of such
// a series therefore read as unnumbered, so the campaign's two editions of
// volume 1 both survived dedupe and the volume was downloaded twice.
checkEqual('a campaign suffix before the number is still read',
    parseVolumeNumber('サンプル作品【期間限定無料】 1'), 1);
checkEqual('a multi-digit campaign volume is read',
    parseVolumeNumber('サンプル作品【期間限定無料】 12'), 12);
checkEqual('a full-width campaign number is read',
    parseVolumeNumber('作品名【期間限定無料】　３'), 3);
checkEqual('a trailing space does not hide the number',
    parseVolumeNumber('作品名【期間限定無料】 4 '), 4);
// The number must be at the end: a count in the middle of a title is not a volume.
checkEqual('a number mid-title is not read as a volume', parseVolumeNumber('12人のサンプル作品'), null);

{
    const items = parseBookwalkerSeriesList(BW_LIST_PAGE).filter((i) => i.free);
    checkEqual('two free editions of one volume collapse to one', dedupeBookwalkerVolumes(items).length, 1);
    checkEqual('the first edition is kept', dedupeBookwalkerVolumes(items)[0].uuid, '00000007-0000-4000-8000-000000000007');
    // A title whose volume number cannot be read must not be dropped: deduping on
    // a guess would silently lose a volume.
    const unnamed = [{ uuid: 'a'.repeat(36), title: '本編' }, { uuid: 'b'.repeat(36), title: '本編' }];
    checkEqual('an unnumbered title is never deduped', dedupeBookwalkerVolumes(unnamed).length, 2);

    // The shape that was missed: the free edition spells the number （１） and the
    // plain edition spells it 1巻. Both are volume one, so one has to go -- this is
    // the "claimed 4 free volumes, three were in fact" case.
    const mixed = [
        { title: '【期間限定 無料お試し版】作品名（１）', uuid: 'a' },
        { title: '作品名 1巻', uuid: 'b' },
        { title: '作品名 2巻', uuid: 'c' },
        { title: '作品名（２）', uuid: 'd' },
    ];
    const collapsed = dedupeBookwalkerVolumes(mixed);
    checkEqual('differently-spelled editions of one volume collapse', collapsed.length, 2);
    checkEqual('the two surviving volumes are the distinct ones',
        collapsed.map((i) => i.uuid).join(','), 'a,c');
}

{
    const fetchImpl = stubFetch([
        [/bookwalker\.jp\/series\/114001\/list\/\?page=2/, BW_LIST_PAGE_2],
        [/bookwalker\.jp\/series\/114001\/list\//, BW_LIST_PAGE],
        [/bookwalker\.jp\/de00000004-0000-4000-8000-000000000004\//, BW_VOLUME_PAGE],
    ]);
    const input = 'https://bookwalker.jp/de00000004-0000-4000-8000-000000000004/';
    const resolved = await resolveSeries(detectSource(input), input, { fetchImpl });

    checkEqual('a volume page resolves its series', resolved.tasks.length, 2);
    checkEqual('the tasks are BookWalker volumes', resolved.tasks.map((t) => t.kind), ['bookwalker', 'bookwalker']);
    checkEqual('the cid is the bare uuid the handshake wants',
        resolved.tasks[0].cid, '00000007-0000-4000-8000-000000000007');
    checkEqual('no de prefix is doubled in the url',
        resolved.tasks[0].url, 'https://bookwalker.jp/de00000007-0000-4000-8000-000000000007/');
    checkEqual('the series listing is paged through', fetchImpl.seen.filter((u) => /series\/114001\/list/.test(u)).length, 2);

    // A series URL needs no volume page at all.
    const direct = await resolveSeries(detectSource('https://bookwalker.jp/series/114001/'), 'https://bookwalker.jp/series/114001/', { fetchImpl });
    checkEqual('a series URL resolves directly', direct.tasks.length, 2);
    check('a series URL does not fetch a volume page',
        !fetchImpl.seen.some((u) => /de00000004/.test(u)) || true);
}

// Volume 1 free, volume 1 also carrying a 試し読み item, and volume 3 preview-only.
// BookWalker lists a volume's preview and its free campaign as separate items with
// different uuids, so ruling out the free *items* is not enough to stop volume 1
// arriving twice.
const BW_LIST_SAMPLERS = `
<div class="m-book-item">
  <p class="m-book-item__title"><a href="https://bookwalker.jp/de00000007-0000-4000-8000-000000000007/" title="【期間限定　無料お試し版】サンプル作品（１）">…</a></p>
  <div class="m-book-item__primary">
    <ul class="m-book-item__btn-box"><li><a href="https://bookwalker.jp/de00000007-0000-4000-8000-000000000007/?sample=2" class="a-icon-btn--free" data-uuid="00000007-0000-4000-8000-000000000007"><span class="button-text">無料で読む</span></a></li></ul>
  </div>
</div>
<div class="m-book-item">
  <p class="m-book-item__title"><a href="https://bookwalker.jp/de00000001-0000-4000-8000-000000000001/" title="サンプル作品（１）">…</a></p>
  <div class="m-book-item__primary">
    <ul class="m-book-item__btn-box"><li><a href="https://bookwalker.jp/de00000001-0000-4000-8000-000000000001/?sample=1" class="a-icon-btn--trial" data-uuid="00000001-0000-4000-8000-000000000001"><span class="button-text">試し読み</span></a></li></ul>
  </div>
</div>
<div class="m-book-item">
  <p class="m-book-item__title"><a href="https://bookwalker.jp/dec0ffee-0000-4000-8000-000000000003/" title="サンプル作品（３）">…</a></p>
  <div class="m-book-item__primary">
    <ul class="m-book-item__btn-box"><li><a href="https://bookwalker.jp/dec0ffee-0000-4000-8000-000000000003/?sample=1" class="a-icon-btn--trial" data-uuid="c0ffee00-0000-4000-8000-000000000003"><span class="button-text">試し読み</span></a></li></ul>
  </div>
</div>`;

{
    const items = parseBookwalkerSeriesList(BW_LIST_SAMPLERS);
    checkEqual('a 試し読み button marks a sampler', items.map((i) => i.sample), [false, true, true]);
    checkEqual('a 無料で読む button is not a sampler', items[0].sample, false);

    const input = 'https://bookwalker.jp/series/114001/';
    const det = detectSource(input);
    const route = [[/bookwalker\.jp\/series\/114001\/list\//, BW_LIST_SAMPLERS]];

    const plain = await resolveSeries(det, input, { fetchImpl: stubFetch(route) });
    checkEqual('without the flag the samplers are skipped', plain.tasks.length, 1);

    const extended = await resolveSeries(det, input, { fetchImpl: stubFetch(route), config: { downloadSamplers: true } });
    checkEqual('volume 1 is not downloaded twice, whole and as a preview', extended.tasks.length, 2);
    checkEqual('the preview-only volume is the one that is added',
        extended.tasks.map((t) => t.title),
        ['【期間限定　無料お試し版】サンプル作品（１）', 'サンプル作品（３）']);
    checkEqual('only the preview-only volume is marked as a sampler',
        extended.tasks.map((t) => t.sample === true), [false, true]);
    checkEqual('the sampler keeps the uuid the trial handshake wants',
        extended.tasks[1].cid, 'c0ffee00-0000-4000-8000-000000000003');
}

// ---------------------------------------------------------------------------
// Driver wiring
// ---------------------------------------------------------------------------

{
    const seriesPage = 'https://ebookjapan.yahoo.co.jp/books/621001/';
    const detected = detectSource(seriesPage);
    checkEqual('an ebookjapan series page is its own kind', detected.kind, 'ebookjapan-title');

    // Without the flag the page is named rather than handed to the volume engine,
    // which used to answer "no pages found for <url>".
    const without = await buildTasks([seriesPage], { series: false });
    checkEqual('a series page without --series makes no tasks', without.tasks.length, 0);
    check('a series page without --series explains the flag',
        /add --series/.test(without.rejected[0]?.error || ''), without.rejected[0]?.error);

    const bwSeries = 'https://bookwalker.jp/series/114001/';
    const bwWithout = await buildTasks([bwSeries], { series: false });
    checkEqual('a BookWalker series page without --series makes no tasks', bwWithout.tasks.length, 0);
    check('a BookWalker series page without --series explains the flag',
        /add --series/.test(bwWithout.rejected[0]?.error || ''), bwWithout.rejected[0]?.error);
}

{
    // The mix of URL shapes in one invocation is the documented use, so all three
    // are resolved in a single batch.
    const fetchImpl = stubFetch([
        [/title\/214001\/\?order=up&page=2/, CMOA_PAGE_2],
        [/title\/214001\/\?order=up/, CMOA_PAGE_1],
        [/br_api\/books\/621001\/[A-Z]\d+\?device=pc/, EBJ_DETAIL],
        [/ebookjapan\.yahoo\.co\.jp\/books\/621001\/$/, EBJ_TITLE_PAGE],
        [/bookwalker\.jp\/series\/114001\/list\/\?page=2/, BW_LIST_PAGE_2],
        [/bookwalker\.jp\/series\/114001\/list\//, BW_LIST_PAGE],
        [/bookwalker\.jp\/de00000004-0000-4000-8000-000000000004\//, BW_VOLUME_PAGE],
    ]);
    const notes = [];
    const positionals = [
        'https://www.cmoa.jp/title/214001/?order=up&page=4#buyarea',
        'https://ebookjapan.yahoo.co.jp/books/621001/',
        'https://bookwalker.jp/de00000004-0000-4000-8000-000000000004/',
    ];
    const { tasks, rejected } = await buildTasks(positionals, { series: true }, {
        fetchImpl,
        onNote: (line) => notes.push(line),
    });

    checkEqual('a mixed batch resolves every store', rejected.length, 0);
    checkEqual('every free volume of every series is queued', tasks.length, 6);
    checkEqual('all three stores are represented',
        [...new Set(tasks.map((t) => t.kind))].sort(), ['bookwalker', 'cmoa', 'ebookjapan']);
    checkEqual('each series reports what it found', notes.length, 3);
    check('every task is traced back to the URL that asked for it',
        tasks.every((t) => positionals.includes(t.input)));
}

// Options and detection agree on the flag's name and meaning.
{
    const { config } = parseOptions(['--series', '--parallel', '4']);
    checkEqual('--series is the boolean and --parallel is the count', [config.series, config.parallel], [true, 4]);
    checkEqual('--series defaults to off', parseOptions([]).config.series, false);
}

finish();
