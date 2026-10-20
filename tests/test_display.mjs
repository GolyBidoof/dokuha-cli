/**
 * The live progress block: the batch bar's basis and the volume row budget.
 *
 * Both were changed because the footer and the row list were answering the wrong
 * question. The bar moved only when a whole volume finished, so on a long batch it
 * sat still and then jumped; and the row list hid everything past a fixed ten even
 * on a tall terminal, which is where "… N more" came from.
 */

import { LiveProgress } from '../src/live-progress.js';
import { reportBookwalker } from '../src/download/bookwalker.js';
import { C, displayWidth, humanBytes } from '../src/ansi.js';
import { check, checkEqual, finish } from './_harness.mjs';

/** A fake TTY that records what was written. */
function fakeStream(rows = 24) {
    return {
        isTTY: true,
        columns: 100,
        rows,
        written: '',
        write(chunk) { this.written += chunk; return true; },
        on() {},
        off() {},
    };
}

// ---------------------------------------------------------------------------
// The batch bar tracks operation stages and never counts queued pages as done
// ---------------------------------------------------------------------------

{
    const stream = fakeStream();
    const p = new LiveProgress({ stream, width: 100 });
    p.add('a', {});
    p.add('b', {});
    const [a, b] = p.volumes;

    a.total = 100; a.done = 50; a.completed = 0;
    a.phase = 'downloading';
    b.total = 100; b.done = 0; b.completed = 0;
    // Volume A is half-downloaded, which is half of the download stage's 30 percent;
    // volume B remains queued and contributes no progress.
    checkEqual('the global bar includes only work that has actually started',
        p.overallFraction(p.totals()), 0.075);
    checkEqual('queued volume progress remains zero', p.volumeWeight(b), 0);

    b.total = 100; b.done = 100; b.completed = 100;
    b.phase = 'done';
    checkEqual('a finished volume counts as complete',
        p.overallFraction(p.totals()), 0.575);

    // A volume that finished with a failed page still counts its full length, so
    // the bar has to reach the end rather than stalling just short of 100%.
    a.total = 100; a.done = 90; a.completed = 100;
    a.phase = 'done';
    checkEqual('the bar completes when every volume is finished',
        p.overallFraction(p.totals()), 1);

    // Empty batches have no fraction, so the bar renders blank rather than full.
    const empty = new LiveProgress({ stream: fakeStream(), width: 100 });
    checkEqual('an unknown total has no fraction', empty.overallFraction(empty.totals()), null);
}

{
    // The percentage label is derived from the same fraction, so the bar and its
    // label cannot drift apart.
    const stream = fakeStream();
    const p = new LiveProgress({ stream, width: 100 });
    p.add('a', {});
    p.volumes[0].total = 100;
    p.volumes[0].done = 40;
    p.volumes[0].phase = 'downloading';
    p.draw(true);
    check('the footer percentage matches the staged progress', /12%/.test(stream.written),
        'footer did not show the started work fraction');
}

{
    const p = new LiveProgress({ stream: fakeStream(), width: 100 });
    p.add('queued', {});
    checkEqual('queued series cannot make the global bar look complete',
        p.overallFraction(p.totals()), 0);
}

// ---------------------------------------------------------------------------
// The row budget
// ---------------------------------------------------------------------------

{
    const p = new LiveProgress({ stream: fakeStream(30), width: 100 });
    // Two footer lines plus the overflow notice are reserved, so a 30-row terminal
    // shows 26 volume rows: every volume of a normal batch, rather than ten.
    checkEqual('the default budget is the terminal height', p.rowBudget(), 26);

    p.compact = true;
    checkEqual('compact falls back to the maxLines budget', p.rowBudget(), 7);
    p.compact = false;

    // A terminal that reports no height must still produce a usable number rather
    // than NaN, which would render zero rows.
    const unknown = new LiveProgress({ stream: fakeStream(0), width: 100 });
    check('an unknown terminal height still yields a budget',
        Number.isInteger(unknown.rowBudget()) && unknown.rowBudget() >= 3,
        `got ${unknown.rowBudget()}`);
}

{
    // Twelve free volumes on a tall terminal: all of them, and no "… N more".
    const stream = fakeStream(40);
    const p = new LiveProgress({ stream, width: 100 });
    for (let i = 0; i < 12; i++) p.add(`v${i}`, { tag: 'CMOA', label: `volume ${i}` });
    p.draw(true);
    check('every volume is shown by default', !/more/.test(stream.written),
        'the overflow notice appeared despite room for every row');
    checkEqual('all twelve rows were painted',
        (stream.written.match(/volume \d+/g) || []).length, 12);

    // On a short terminal the tail has to stay hidden, because rows scrolled off
    // the top cannot be walked back over when the block is redrawn in place.
    const small = fakeStream(12);
    const q = new LiveProgress({ stream: small, width: 100 });
    for (let i = 0; i < 12; i++) q.add(`v${i}`, { tag: 'CMOA', label: `volume ${i}` });
    q.draw(true);
    check('a terminal too short for the list still shows an overflow notice',
        /more/.test(small.written), 'nothing was hidden on a 12-row terminal');
}

// ---------------------------------------------------------------------------
// The `c` listener
// ---------------------------------------------------------------------------

{
    // The test runner's stdin is not a TTY, so the listener must decline to
    // install itself -- grabbing a pipe would steal stdin from the caller.
    const p = new LiveProgress({ stream: fakeStream(), width: 100 });
    p.startTicker();
    checkEqual('no key listener is installed without a terminal on stdin', p.keyboard, null);
    p.stopTicker();
    check('detaching with nothing attached is harmless', (() => {
        try { p.detachKeyboard(); return true; } catch { return false; }
    })());
}

{
    // Without the listener the footer must not advertise the key.
    const stream = fakeStream();
    const p = new LiveProgress({ stream, width: 100 });
    p.add('a', {});
    p.draw(true);
    check('the footer only advertises a key that works', !/c: compact/.test(stream.written),
        'the compact hint appeared with no listener installed');
}

{
    // A Kindle volume that turns out to be an Unlimited loan is only known to be
    // one once the borrow path reaches it, which is after its row was created. The
    // row has to be able to correct itself, and the hand-back has to be said out
    // loud: it is a change on the user's own shelf, not an implementation detail.
    const stream = fakeStream();
    const p = new LiveProgress({ stream, width: 100 });
    p.add('k', { tag: 'KDL', label: 'ある漫画 1' });
    p.update('k', { total: 3, phase: 'downloading' });
    p.finish('k', { bytes: 1024, returned: true, tag: 'KDUL' });
    p.plainLine(p.byKey.get('k'));
    check('a late Unlimited tag replaces the store tag', /KDUL/.test(stream.written),
        stream.written);
    check('the hand-back is shown on the volume line', /returned/.test(stream.written),
        stream.written);

    // A free volume must keep the plain store tag: the two are not the same thing
    // and the whole point of the second tag is telling them apart.
    const free = fakeStream();
    const q = new LiveProgress({ stream: free, width: 100 });
    q.add('f', { tag: 'KDL', label: '無料の漫画 1' });
    q.update('f', { total: 3, phase: 'downloading' });
    q.finish('f', { bytes: 1024 });
    q.plainLine(q.byKey.get('f'));
    check('a free volume keeps the KDL tag', /KDL/.test(free.written) && !/KDUL/.test(free.written),
        free.written);
    check('a free volume is not reported as returned', !/returned/.test(free.written), free.written);
}

// ---------------------------------------------------------------------------
// Finalization shows the upload it is waiting on
// ---------------------------------------------------------------------------

// `finalize` used to be one blocking call, so the row could only ever say
// "assembling .mokuro" -- a full bar and no news for the whole of a multi-minute
// archive upload. The bridge publishes the real progress; these are the fields it
// feeds, and the fallback for the moment before the first poll lands.
{
    const stream = fakeStream();
    const p = new LiveProgress({ stream, width: 100 });
    p.add('z', {});
    const v = p.volumes[0];
    v.phase = 'finalizing';

    // Nothing polled yet: the bridge has not said what it is sending. The bar holds one
    // cell short of full, which keeps it from reading as a finished volume while an
    // upload sits at zero, and keeps it from dropping to empty and reading as a stall.
    checkEqual('an unreported finalize stops one cell short of full', p.fraction(v), 0.99);
    check('an unreported finalize still says what it is doing',
        /assembling \.mokuro/.test(p.detail(v)), p.detail(v));

    // A real upload in flight: the bar follows the bytes, not the phase.
    Object.assign(v, {
        uploadFile: 'サンプル作品 5巻.cbz',
        uploadPercent: 42.5,
        uploadBytes: 26_000_000,
        uploadBytesTotal: 61_094_103,
        uploadSpeed: '36.00 MiB/s',
    });
    check('the bar tracks the uploading file', Math.abs(p.fraction(v) - 0.4256) < 0.01, String(p.fraction(v)));
    const detail = p.detail(v);
    check('the row names the file being uploaded', /\.cbz/.test(detail), detail);
    check('the row shows the percentage', /42%/.test(detail), detail);
    check('the row shows the transfer speed', /36\.00 MiB\/s/.test(detail), detail);

    // The archive is the slow part; the small .mokuro after it starts at zero
    // rather than inheriting the finished bar of the file before it.
    Object.assign(v, { uploadFile: '5巻.mokuro', uploadPercent: 0, uploadBytes: 0, uploadBytesTotal: 313_456 });
    checkEqual('a new file resets the bar', p.fraction(v), 0);

    // A zero-byte total must not divide by zero into NaN.
    Object.assign(v, { uploadBytesTotal: 0 });
    check('a missing total does not produce NaN', Number.isFinite(p.fraction(v)), String(p.fraction(v)));

    // Announced but nothing moving: uploads are serialized per destination
    // account, so this is a volume queued behind its siblings. Calling it "0%"
    // made a queue look like a stall.
    Object.assign(v, {
        uploadFile: 'サンプル作品　（5）.cbz', uploadPercent: 0, uploadBytes: 0,
        uploadBytesTotal: 85_400_725, uploadSpeed: null,
    });
    checkEqual('a queued upload says it is waiting', /waiting/.test(p.detail(v)), true);
    check('a queued upload is not labelled 0%', !/0%/.test(p.detail(v)), p.detail(v));

    // Once bytes move, the real figures take over.
    Object.assign(v, { uploadBytes: 12_000_000, uploadPercent: 14.05, uploadSpeed: '9.54 MiB/s' });
    check('a moving upload shows its percentage', /14%/.test(p.detail(v)), p.detail(v));
    check('a moving upload is no longer "waiting"', !/waiting/.test(p.detail(v)), p.detail(v));
}

// ---------------------------------------------------------------------------
// A phase claimed too early freezes the row
// ---------------------------------------------------------------------------

// The rows move forward only, so whichever update claims `finalizing` first owns
// the row for the rest of the run. That is the trap that made an ebookjapan volume
// read "assembling .mokuro" through its entire upload and OCR: the downloader
// announced a *local* finalize before the bridge had sent anything, and every
// later `uploading`/`ocr` update was then silently rejected. The adapters now
// withhold that phase when a bridge will follow; this pins the rule they rely on.
{
    const stream = fakeStream();
    const p = new LiveProgress({ stream, width: 100 });
    p.add('e', {});
    const v = p.volumes[0];

    p.update('e', { phase: 'finalizing' });
    checkEqual('finalizing is reached', v.phase, 'finalizing');

    p.update('e', { phase: 'ocr', ocr: 5, ocrTotal: 100 });
    checkEqual('a later phase cannot move a row backwards', v.phase, 'finalizing');

    // The non-phase fields still land, which is what made the bug look like the
    // data had simply stopped rather than the phase being stuck.
    checkEqual('non-phase fields still update', v.ocr, 5);

    // And an earlier phase on the way up is honoured, so the guard is not simply
    // ignoring everything.
    const q = new LiveProgress({ stream: fakeStream(), width: 100 });
    q.add('f', {});
    q.update('f', { phase: 'downloading' });
    q.update('f', { phase: 'ocr' });
    checkEqual('the pipeline still advances', q.volumes[0].phase, 'ocr');

    // Bridge finalize reports OCR first, then a remote archive upload. The row
    // must switch to the upload meter instead of retaining a completed OCR bar.
    q.update('f', { phase: 'ocr', ocr: 100, ocrTotal: 100 });
    q.update('f', {
        phase: 'finalizing', uploadFile: 'volume.cbz', uploadPercent: 42.5,
        uploadBytes: 42_500, uploadBytesTotal: 100_000, uploadSpeed: '4.00 MiB/s',
    });
    checkEqual('bridge upload events switch the row out of OCR', q.volumes[0].phase, 'finalizing');
    check('the bridge upload meter follows transfer bytes',
        Math.abs(q.fraction(q.volumes[0]) - 0.425) < 1e-9, String(q.fraction(q.volumes[0])));
    check('the bridge upload detail retains speed', /4\.00 MiB\/s/.test(q.detail(q.volumes[0])), q.detail(q.volumes[0]));
}

// ---------------------------------------------------------------------------
// A batch that lost a volume is not a success
// ---------------------------------------------------------------------------

{
    const p = new LiveProgress({ stream: fakeStream(), width: 100 });
    for (const key of ['a', 'b', 'c', 'd', 'e']) p.add(key, { tag: 'CMOA', label: key });
    for (const key of ['a', 'b', 'c', 'd']) p.finish(key);
    p.finish('e', { error: 'fetch failed' });

    const totals = p.totals();
    checkEqual('a failure is not counted as done', p.footer()[1].includes('4/5 done'), true);
    check('the batch bar is not green when a volume failed', p.overallColor(totals) === 'red',
        p.overallColor(totals));

    // The failed volume never left `queued`, so it has no phase meter of its own.
    // It used to render no bar at all, which is indistinguishable from a row the
    // display knows nothing about.
    const failed = p.volumes.find((v) => v.key === 'e');
    check('a volume that failed before it started still draws a meter',
        p.fraction(failed) === 0, String(p.fraction(failed)));

    // A failure with progress keeps that progress rather than dropping to empty.
    const q = new LiveProgress({ stream: fakeStream(), width: 100 });
    q.add('x', { tag: 'CMOA', label: 'x' });
    q.update('x', { phase: 'downloading', done: 30, total: 100 });
    q.finish('x', { error: 'boom' });
    check('a failure mid-download keeps how far it got',
        Math.abs(q.fraction(q.volumes[0]) - 0.3) < 1e-9, String(q.fraction(q.volumes[0])));
}

// ---------------------------------------------------------------------------
// The batch bar shows the pipeline, not one fraction
// ---------------------------------------------------------------------------

// The bar's fill is the download stage, so once every volume has downloaded the
// bar is full even while OCR and the destination upload are still running. OCR
// then replaces blue with yellow from the left, and the upload replaces yellow
// with magenta. The percentage on the right stays the true overall completion,
// which is why it can read lower than the bar looks. These assert on the
// rendered string, not on the fractions behind it.
{
    const savedForce = process.env.FORCE_COLOR;
    process.env.FORCE_COLOR = '1';

    // Two halves of one batch: one volume fully through download and OCR and
    // half-way through its archive upload, the other half-way through download.
    // The run averages are download 0.75, OCR 0.5 and upload 0.25.
    const split = new LiveProgress({ stream: fakeStream(), width: 100 });
    // The run has a destination, so the assembling band is meaningful here and the
    // archive stage shows as cyan rather than being suppressed as a no-upload run.
    split.uploadExpected = true;
    split.add('finished', {});
    split.add('mid', {});
    Object.assign(split.volumes[0], {
        phase: 'finalizing', total: 100, done: 100,
        ocrTotal: 100, ocr: 100, ocrPending: 0,
        uploadBytes: 50, uploadBytesTotal: 100,
    });
    Object.assign(split.volumes[1], { phase: 'downloading', total: 100, done: 50 });
    const uploadingRuns = split.pipelineBar(20);
    // OCR and packing both stand at 0.5 here, so the yellow band has no width and the
    // cyan one takes its place: the bar shows the stage the batch has reached, and the
    // archive exists once a volume is finalizing, whether or not it is still sending.
    checkEqual('the bar renders magenta, cyan, blue and empty runs left to right',
        uploadingRuns,
        `${C.magenta}${'█'.repeat(5)}${C.reset}`
        + `${C.cyan}${'█'.repeat(5)}${C.reset}`
        + `${C.blue}${'█'.repeat(5)}${C.reset}`
        + `${C.dim}${'░'.repeat(5)}${C.reset}`);
    checkEqual('the coloured runs and the empty tail fill the width',
        uploadingRuns.replace(/\x1b\[[0-9;]*m/g, '').length, 20);
    // Assembling is the window before anything has been sent, and that is what lights
    // the cyan band.
    const assembling = new LiveProgress({ stream: fakeStream(), width: 100 });
    assembling.uploadExpected = true;
    assembling.add('building', {});
    Object.assign(assembling.volumes[0], {
        phase: 'finalizing', total: 100, done: 100, ocrTotal: 100, ocr: 100, ocrPending: 0,
    });
    checkEqual('an assembling volume lights the cyan band',
        assembling.pipelineBar(20),
        `${C.cyan}${'█'.repeat(20)}${C.reset}`);

    // The case the operator reported: every volume downloaded, OCR only just
    // started. The bar is full and blue, while the percentage is still low.
    const reported = new LiveProgress({ stream: fakeStream(), width: 100 });
    reported.add('v', {});
    Object.assign(reported.volumes[0], {
        phase: 'ocr', total: 100, done: 100, ocrTotal: 100, ocr: 0, ocrPending: 0,
    });
    const fullBlue = reported.pipelineBar(20);
    checkEqual('a completed download paints the whole bar blue while OCR runs',
        fullBlue, `${C.blue}${'█'.repeat(20)}${C.reset}`);
    check('OCR at zero adds no yellow', !fullBlue.includes(C.yellow), fullBlue);
    const reportedPct = Number((reported.footer()[0].match(/(\d+)%/) || [])[1] ?? NaN);
    check('the percentage keeps its own overall meaning beside a full bar',
        reportedPct === 40, String(reportedPct));

    // Nothing has started: an empty bar, not a full one.
    const idle = new LiveProgress({ stream: fakeStream(), width: 100 });
    idle.add('queued', {});
    const emptyBar = idle.pipelineBar(20);
    checkEqual('an untouched batch renders an empty bar',
        emptyBar, `${C.dim}${'░'.repeat(20)}${C.reset}`);
    check('an untouched batch has no filled cells', !emptyBar.includes('█'), emptyBar);

    // A run with no OCR and no upload: the skipped stages must add no colour, so
    // once the downloads finish the bar is simply full blue. `pipelineExpected: false`
    // is what run.js passes for a plain download; it selects the download-only bar
    // rather than stage bands.
    const plain = new LiveProgress({ stream: fakeStream(), width: 100, pipelineExpected: false });
    plain.add('done', {});
    plain.add('mid', {});
    Object.assign(plain.volumes[0], { phase: 'done', total: 100, done: 100 });
    Object.assign(plain.volumes[1], { phase: 'downloading', total: 100, done: 100 });
    const skipped = plain.pipelineBar(20);
    checkEqual('a run without OCR or upload is full blue once downloads finish',
        skipped, `${C.blue}${'█'.repeat(20)}${C.reset}`);
    check('skipped stages contribute neither yellow nor magenta',
        !skipped.includes(C.yellow) && !skipped.includes(C.magenta), skipped);

    if (savedForce === undefined) delete process.env.FORCE_COLOR;
    else process.env.FORCE_COLOR = savedForce;
}

// ---------------------------------------------------------------------------
// A download-only run has one basis for both halves of its footer
// ---------------------------------------------------------------------------

// The stage weights describe a mokuro run, where the download is only the first 30
// percent of a volume's journey. Applying them to a plain download made the footer
// bar and its own percentage disagree for the whole run: a real capture showed a
// 99 percent blue bar beside 53 percent, and 56 percent at the moment every page
// had downloaded, because no OCR or upload would ever supply the missing weight.
// `pipelineExpected: false` makes the pages the run's whole measure.
{
    const p = new LiveProgress({ stream: fakeStream(), width: 100, pipelineExpected: false });
    for (const [label, pages] of [['volume 1', 185], ['volume 2', 22], ['volume 3', 28], ['volume 4', 32], ['volume 5', 30]]) {
        p.add(label, { tag: 'BW', label });
    }
    const [first, ...rest] = p.volumes;
    Object.assign(first, { phase: 'downloading', total: 185, done: 154 });
    [22, 28, 32, 30].forEach((pages, index) => {
        Object.assign(rest[index], { phase: 'done', total: pages, done: pages });
    });

    const expected = (154 + 22 + 28 + 32 + 30) / (185 + 22 + 28 + 32 + 30);
    checkEqual('a plain download measures its own pages',
        p.overallFraction(p.totals()), expected);

    const [barLine] = p.footer();
    const pct = Number((barLine.match(/(\d+)%/) || [])[1] ?? NaN);
    checkEqual('the footer percentage is the page fraction', pct, Math.floor(expected * 100));
    const cells = (barLine.match(/█/g) || []).length;
    checkEqual('the footer bar fill matches the percentage', cells, Math.round(expected * 92));
    check('a plain download paints only the download band',
        !barLine.includes(C.yellow) && !barLine.includes(C.magenta) && !barLine.includes(C.cyan),
        barLine);

    // The download band of the old weights capped this at 0.3, which is what made a
    // finished download look 56 percent done.
    checkEqual('a fetched page counts in full when no bridge follows',
        p.volumeWeight({ phase: 'downloading', total: 100, done: 100 }), 1);

    // The mokuro weighting is still the default, and a volume that reaches a bridge
    // phase switches a plain-looking run back to it.
    const mokuro = new LiveProgress({ stream: fakeStream(), width: 100 });
    checkEqual('the mokuro weights remain the default',
        mokuro.volumeWeight({ phase: 'downloading', total: 100, done: 100 }), 0.3);
    first.phase = 'ocr';
    checkEqual('a bridge phase turns the pipeline weights back on',
        p.volumeWeight({ phase: 'downloading', total: 100, done: 100 }), 0.3);

    // A local finalize is not a bridge phase. ebookjapan and BookWalker zip their pages
    // after the download with no bridge in sight, and treating that as a pipeline made a
    // download-only run report 88 percent beside a 98 percent bar.
    first.phase = 'finalizing';
    checkEqual('a local finalize does not look like a bridge phase',
        p.pipelineUnderway(), false);
    checkEqual('a local finalize keeps the download-only weight',
        p.volumeWeight({ phase: 'downloading', total: 100, done: 100 }), 1);
    first.phase = 'downloading';

    // At the end of a plain run the bar and the label both read complete.
    for (const volume of p.volumes) volume.phase = 'done';
    checkEqual('a finished plain download is complete', p.overallFraction(p.totals()), 1);
    const [doneLine] = p.footer();
    checkEqual('the finished footer reads 100 percent',
        Number((doneLine.match(/(\d+)%/) || [])[1] ?? NaN), 100);
    checkEqual('the finished bar is full', (doneLine.match(/█/g) || []).length, 92);
}

// ---------------------------------------------------------------------------
// The bookwalker row reports the phases it actually reaches
// ---------------------------------------------------------------------------

// A volume's page total arrives when the fetch starts. BookWalker was the only
// store that left the row in `queued` until the first page landed, so the download
// bar appeared a second late. Its failure path also read a row accessor that did
// not exist and threw instead of counting the bad page.
{
    const p = new LiveProgress({ stream: fakeStream(), width: 100 });
    p.add('k', { tag: 'BW', label: 'uuid' });
    checkEqual('get returns the row a key belongs to', p.get('k'), p.volumes[0]);
    checkEqual('get returns null for an unknown key', p.get('nope'), null);

    reportBookwalker({ type: 'book-total', total: 185, title: '姉のともだち 1' }, { key: 'k' }, p);
    checkEqual('the page total claims the download phase', p.get('k').phase, 'downloading');
    checkEqual('the page total lands with the phase', p.get('k').total, 185);

    reportBookwalker({ type: 'download-error' }, { key: 'k' }, p);
    checkEqual('a failed page increments the counter', p.get('k').failed, 1);
    reportBookwalker({ type: 'download-error' }, { key: 'k' }, p);
    checkEqual('failed pages accumulate', p.get('k').failed, 2);
}

// ---------------------------------------------------------------------------
// The footer never claims more than the run has done
// ---------------------------------------------------------------------------

// A late page total grows the denominator before its numerator, so the raw fraction
// can dip. A progress number that goes backwards reads as a bug, so the footer keeps
// its high water mark.
{
    const p = new LiveProgress({ stream: fakeStream(), width: 100, pipelineExpected: false });
    p.add('a', { label: 'a' });
    p.add('b', { label: 'b' });
    Object.assign(p.volumes[0], { phase: 'downloading', total: 100, done: 10 });
    Object.assign(p.volumes[1], { phase: 'queued' });
    const pct = () => Number((p.footer()[0].match(/(\d+)%/) || [])[1] ?? NaN);
    const before = pct();
    p.volumes[1].total = 1000;
    check('a newly known volume total cannot step the percentage backwards',
        pct() >= before, `${before} then ${pct()}`);
}

// 100 percent waits for the last row to settle; all pages on disk is not a finished
// run while a row still says "download".
{
    const p = new LiveProgress({ stream: fakeStream(), width: 100, pipelineExpected: false });
    [['v1', 185], ['v2', 22], ['v3', 28], ['v4', 32], ['v5', 30]].forEach(([label, pages]) => p.add(label, { label }));
    p.volumes.forEach((volume) => Object.assign(volume, { phase: 'done', total: volume.label === 'v1' ? 185 : undefined }));
    p.volumes[0].phase = 'downloading';
    p.volumes[0].total = 185;
    p.volumes[0].done = 185;
    [22, 28, 32, 30].forEach((pages, index) => Object.assign(p.volumes[index + 1], { total: pages, done: pages, phase: 'done' }));
    const [line] = p.footer();
    checkEqual('a fully fetched run is not 100 percent before its last volume is done',
        Number((line.match(/(\d+)%/) || [])[1] ?? NaN), 99);
    check('the bar is one cell short of full', (line.match(/█/g) || []).length < 92,
        `${(line.match(/█/g) || []).length} cells`);

    p.finish('v1');
    const [doneLine] = p.footer();
    checkEqual('a settled run reads 100 percent', Number((doneLine.match(/(\d+)%/) || [])[1] ?? NaN), 100);
}

// A failed volume contributes only what it finished, so one failure cannot make the
// footer into a false success.
{
    const p = new LiveProgress({ stream: fakeStream(), width: 100 });
    p.add('ok', { label: 'ok' });
    p.add('bad', { label: 'bad' });
    Object.assign(p.volumes[0], { phase: 'done', total: 200, done: 200 });
    Object.assign(p.volumes[1], { phase: 'downloading', total: 200, done: 20 });
    p.finish('bad', { error: 'fetch failed' });
    const overall = p.overallFraction(p.totals());
    check('a failed volume does not weigh as a finished one',
        Math.abs(overall - (200 + 20) / 400) < 1e-9, String(overall));
    check('a failed run does not read complete', overall < 0.99, String(overall));
}

// ---------------------------------------------------------------------------
// Every stage of a bridge run has a band, including a local one
// ---------------------------------------------------------------------------
{
    const savedForce = process.env.FORCE_COLOR;
    process.env.FORCE_COLOR = '1';
    // A local destination never uploads, but it still assembles an archive. The cyan
    // band used to require a remote destination, so a local run showed a full blue bar
    // beside rows saying "assembling .mokuro".
    const local = new LiveProgress({ stream: fakeStream(), width: 100 });
    local.uploadExpected = false;
    local.add('v', { label: 'v' });
    Object.assign(local.volumes[0], { phase: 'finalizing', total: 100, done: 100, ocrTotal: 100, ocr: 100 });
    const assembling = local.pipelineBar(20);
    check('a local destination still lights the assemble band',
        assembling.includes(C.cyan), assembling);

    // And a done volume is green whether or not it uploaded bytes: a skipped or
    // already-present volume used to leave the whole bar cyan at 100 percent.
    Object.assign(local.volumes[0], { phase: 'done' });
    const finished = local.pipelineBar(20);
    check('a finished volume is green without upload byte counters',
        finished.includes(C.green), finished);
    if (savedForce === undefined) delete process.env.FORCE_COLOR;
    else process.env.FORCE_COLOR = savedForce;
}

// ---------------------------------------------------------------------------
// Finalizing stops one cell short until the bridge closes the session
// ---------------------------------------------------------------------------
{
    const p = new LiveProgress({ stream: fakeStream(), width: 100 });
    p.add('v', { label: 'v' });
    const volume = p.volumes[0];
    Object.assign(volume, {
        phase: 'finalizing', total: 100, done: 100,
        uploadFile: 'volume.cbz', uploadBytes: 100, uploadBytesTotal: 100,
        uploadPercent: 100, archiveUploaded: true,
    });
    checkEqual('a complete archive transfer is still not a finished volume', p.fraction(volume), 0.99);
    check('the row meter stays one cell short', (p.meter(volume).match(/█/g) || []).length, 11);
}

// ---------------------------------------------------------------------------
// A done volume normalizes its OCR counters
// ---------------------------------------------------------------------------
{
    const p = new LiveProgress({ stream: fakeStream(), width: 100 });
    p.add('v', { label: 'v' });
    p.update('v', { phase: 'ocr', ocr: 27, ocrTotal: 28, ocrPending: 1 });
    p.finish('v');
    checkEqual('a finished volume has OCR-d everything it received', p.totals().ocr, 28);
    checkEqual('no OCR page stays pending on a finished volume', p.volumes[0].ocrPending, 0);
    check('the footer counts every OCR page', p.footer()[1].includes("28 OCR'd"), p.footer()[1]);
}

// ---------------------------------------------------------------------------
// A narrow terminal keeps one row per volume
// ---------------------------------------------------------------------------

// Below roughly 48 columns the fixed columns alone overflowed, and a wrapped row
// makes the block's redraw clear one line too few.
{
    const p = new LiveProgress({ stream: fakeStream(), width: 40 });
    p.add('v', { tag: 'BW', label: '姉のともだち【期間限定無料】 1' });
    Object.assign(p.volumes[0], { phase: 'downloading', total: 185, done: 100, bytes: 12_345_678 });
    const row = p.renderVolume(p.volumes[0]);
    check('a row fits the terminal it is drawn on',
        displayWidth(row) <= 40, `${displayWidth(row)} columns: ${row}`);
}

// ---------------------------------------------------------------------------
// The live block can be paused so its text can be selected and copied
// ---------------------------------------------------------------------------

// Every 120 ms redraw moves the cursor and rewrites the same rows, which is what
// makes a drag-selection jump while a download is running. Pausing stops every paint
// while the run keeps recording progress; resuming paints the current state and any
// notes that arrived meanwhile.
{
    const stream = fakeStream();
    const p = new LiveProgress({ stream, width: 100 });
    // The test runner's stdin is not a TTY, so the real listener cannot install. A
    // truthy marker is enough for the footer to advertise the keys.
    p.keyboard = { fake: true };
    p.add('a', { tag: 'BW', label: 'volume a' });
    Object.assign(p.volumes[0], { phase: 'downloading', total: 100, done: 10 });
    p.draw(true);

    p.togglePause();
    const frozen = stream.written;
    check('pausing paints a frozen frame', stream.written.length > 0);
    check('the paused footer marks the block', /paused/.test(frozen), frozen.slice(-200));
    check('the paused footer offers the resume key', /p: resume/.test(frozen), frozen.slice(-200));

    p.update('a', { done: 40 });
    p.note('a note that arrived while frozen');
    p.finish('a');
    checkEqual('a paused block does not repaint on progress', stream.written.length, frozen.length);
    checkEqual('progress still lands while paused', p.get('a').done, 40);
    checkEqual('a finished volume does not repaint a paused block', p.paused, true);
    check('a note is held, not printed over the frozen block',
        !stream.written.includes('a note that arrived while frozen'));

    p.togglePause();
    checkEqual('resume clears the pause', p.paused, false);
    check('resuming prints the held note',
        stream.written.includes('a note that arrived while frozen'));
    check('resuming advertises the pause key again', /p: pause/.test(stream.written.slice(frozen.length)));
}

// A run that ends while the block is paused must not leave the terminal frozen, and
// the final frame must still be painted with the held notes above it.
{
    const stream = fakeStream();
    const p = new LiveProgress({ stream, width: 100 });
    p.keyboard = { fake: true };
    p.add('a', { tag: 'BW', label: 'volume a' });
    Object.assign(p.volumes[0], { phase: 'downloading', total: 100, done: 10 });
    p.draw(true);
    p.togglePause();
    p.note('held until the run ends');
    p.done();
    checkEqual('the end of a paused run lifts the pause', p.paused, false);
    check('the end of a paused run prints the held note',
        stream.written.includes('held until the run ends'));
}

// ---------------------------------------------------------------------------
// Sizes: the done row keeps the manga, the footer totals it and the artifacts
// ---------------------------------------------------------------------------
{
    const stream = fakeStream(30);
    const p = new LiveProgress({ stream, width: 120 });
    p.add('v', { tag: 'BW', label: 'volume v' });
    Object.assign(p.volumes[0], { phase: 'done', total: 185, done: 185, bytes: 98_774_085 });

    check('a done row keeps the size of the manga',
        p.detail(p.volumes[0]).includes(humanBytes(98_774_085)), p.detail(p.volumes[0]));
    check('the footer totals the downloaded manga bytes',
        p.footer()[1].includes(humanBytes(98_774_085)), p.footer()[1]);
    checkEqual('no artifact line before the bridge reports sizes', p.footer().length, 2);
    checkEqual('the row budget is unchanged without artifacts', p.rowBudget(), 26);

    p.artifact('v', 'webp', 225_060);
    p.artifact('v', 'cbz', 96_253_610);
    p.artifact('v', 'mokuro', 353_545);
    p.artifact('v', 'series', 2_048);

    const lines = p.footer();
    checkEqual('artifact sizes add a footer line', lines.length, 3);
    for (const label of ['.webp cover', '.cbz archive', '.mokuro OCR', 'series.json']) {
        check(`the artifact line lists ${label}`, lines[2].includes(label), lines[2]);
    }
    checkEqual('the extras total excludes the archive',
        p.totals().extras, 225_060 + 353_545 + 2_048);
    checkEqual('the footer reserves a row for the artifact line', p.rowBudget(), 25);

    p.artifact('v', 'webp', 225_060);
    checkEqual('a repeated artifact size is not added twice', p.totals().artifacts.webp, 225_060);
    p.add('w', { tag: 'BW', label: 'volume w' });
    p.volumes[1].bytes = 100;
    p.artifact('w', 'webp', 50);
    checkEqual('manga sizes accumulate across volumes', p.totals().bytes, 98_774_085 + 100);
    checkEqual('artifact sizes accumulate across volumes', p.totals().artifacts.webp, 225_060 + 50);
    // Every volume in a series reports the same series.json; it is one file, not one
    // per volume, so the footer must not multiply it by the volume count.
    p.artifact('w', 'series', 2_048);
    checkEqual('a shared series.json is counted once', p.totals().artifacts.series, 2_048);
}

finish();
