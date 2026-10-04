/**
 * The live progress block: the batch bar's basis and the volume row budget.
 *
 * Both were changed because the footer and the row list were answering the wrong
 * question. The bar moved only when a whole volume finished, so on a long batch it
 * sat still and then jumped; and the row list hid everything past a fixed ten even
 * on a tall terminal, which is where "… N more" came from.
 */

import { LiveProgress } from '../src/live-progress.js';
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
// The batch bar tracks pages, not finished volumes
// ---------------------------------------------------------------------------

{
    const stream = fakeStream();
    const p = new LiveProgress({ stream, width: 100 });
    p.add('a', {});
    p.add('b', {});
    const [a, b] = p.volumes;

    a.total = 100; a.done = 50; a.completed = 0;
    b.total = 100; b.done = 0; b.completed = 0;
    // Half of volume A's pages have arrived, but no volume has finished. The old
    // `completed / known` basis reported 0 here and the bar did not move at all.
    checkEqual('the bar advances while a volume is still downloading',
        p.overallFraction(p.totals()), 0.25);

    b.total = 100; b.done = 100; b.completed = 100;
    checkEqual('a finished volume counts towards the bar',
        p.overallFraction(p.totals()), 0.75);

    // A volume that finished with a failed page still counts its full length, so
    // the bar has to reach the end rather than stalling just short of 100%.
    a.total = 100; a.done = 90; a.completed = 100;
    checkEqual('the bar still completes when a finished volume had failures',
        p.overallFraction(p.totals()), 1);

    // Nothing known yet: no fraction, so the bar renders blank rather than full.
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
    p.draw(true);
    check('the footer percentage matches the page fraction', /40%/.test(stream.written),
        'footer did not show 40%');
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

    // Nothing polled yet: the bridge has not said what it is sending, so the bar
    // stays full rather than dropping to empty and reading as a stall.
    checkEqual('an unreported finalize keeps its full bar', p.fraction(v), 1);
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

finish();
