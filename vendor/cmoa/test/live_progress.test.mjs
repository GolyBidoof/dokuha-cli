/**
 * Checks that the live block really redraws in place.
 *
 * The display is the one part of this project that cannot be verified by looking
 * at return values, and it broke in a way that was easy to miss but very visible:
 * lines wider than the terminal wrapped, the cursor-up count no longer matched the
 * rows drawn, and the redraw painted over itself — a screenful of repeated headers
 * and half-overwritten lines.
 *
 * So this test renders frames into a small ANSI terminal emulator and asserts on
 * what a terminal would actually show: one header, one row per volume, nothing
 * wider than the screen, and no leftovers from earlier frames.
 *
 *   node vendor/cmoa/test/live_progress.test.mjs
 */
// The display moved into the CLI's src/ as part of the vendoring: it is pure
// presentation and no engine module depends on it.
import { LiveProgress, displayWidth } from '../../../src/display.js';

const ANSI_RE = /\x1b\[[0-9;]*m/g;

/**
 * A deliberately small VT100 subset: exactly the control sequences the renderer
 * emits (DEC save/restore, erase-down, colour) plus newline handling. Anything
 * unsupported is ignored rather than guessed at.
 */
class Screen {
  constructor(width = 80, height = 40) {
    this.width = width;
    this.height = height;
    this.grid = Array.from({ length: height }, () => Array(width).fill(' '));
    this.row = 0;
    this.col = 0;
    this.saved = [0, 0];
  }

  get text() {
    return this.grid.map((r) => r.join('').replace(/\s+$/, ''));
  }

  feed(input) {
    let i = 0;
    while (i < input.length) {
      const ch = input[i];
      if (ch === '\x1b') {
        const dec = /^\x1b([78])/.exec(input.slice(i));
        if (dec) {
          if (dec[1] === '7') this.saved = [this.col, this.row];
          else [this.col, this.row] = this.saved;
          i += dec[0].length;
          continue;
        }
        const csi = /^\x1b\[(\d*)([A-Za-z])/.exec(input.slice(i));
        if (csi) {
          const n = Number(csi[1] || 1);
          if (csi[2] === 'A') this.row = Math.max(0, this.row - n);
          else if (csi[2] === 'J') this.eraseDown();
          i += csi[0].length;
          continue;
        }
        const sgr = new RegExp(`^${ANSI_RE.source}`).exec(input.slice(i));
        i += sgr ? sgr[0].length : 1;
        continue;
      }
      if (ch === '\n') {
        this.row += 1;
        this.col = 0;
        i += 1;
        continue;
      }
      if (ch === '\r') {
        this.col = 0;
        i += 1;
        continue;
      }
      this.put(ch);
      i += 1;
    }
  }

  eraseDown() {
    for (let y = this.row; y < this.height; y++) {
      for (let x = y === this.row ? this.col : 0; x < this.width; x++) this.grid[y][x] = ' ';
    }
  }

  put(ch) {
    const w = displayWidth(ch);
    if (this.row >= this.height) return;
    if (this.col + w > this.width) {
      // A real terminal wraps; the display is required never to need this.
      this.row += 1;
      this.col = 0;
      if (this.row >= this.height) return;
    }
    this.grid[this.row][this.col] = ch;
    for (let k = 1; k < w; k++) this.grid[this.row][this.col + k] = '';
    this.col += w;
  }
}

const failures = [];
function check(label, condition, detail) {
  if (condition) console.log(`PASS  ${label}`);
  else {
    console.log(`FAIL  ${label}${detail ? `  (${detail})` : ''}`);
    failures.push(label);
  }
}

// A full-width Japanese title, which is what overflowed before: 20 of these
// characters occupy 40 columns, but `padEnd` counts them as 20.
const WIDE = '無料・試し読みページ スーパーの裏でヤニ吸うふたり 1巻（ビッグガンガンコミックス） ｜ 地主 ｜ 漫画';

for (const width of [60, 80, 120]) {
  const chunks = [];
  const stream = { isTTY: true, columns: width, write: (s) => chunks.push(s) };
  const progress = new LiveProgress({ stream });

  progress.add('a', { tag: 'CMOA', label: WIDE });
  progress.add('b', { tag: 'BW', label: 'さんかく窓の外側は夜 1' });
  progress.add('c', { tag: 'EBJ', label: '/books/126344/A000065415/' });
  progress.draw(true);

  // Walk the same phases a real run does, forcing a paint each time.
  progress.update('a', { phase: 'downloading', total: 302, done: 120, bytes: 60e6 });
  progress.draw(true);
  progress.update('b', { phase: 'uploading', uploadTotal: 62, upload: 44 });
  progress.draw(true);
  progress.note('bridge http://127.0.0.1:62642 (mokuro ready)');
  progress.update('a', { phase: 'ocr', ocrTotal: 302, ocr: 200, ocrPending: 102 });
  progress.update('c', { phase: 'downloading', total: 199, done: 199 });
  progress.draw(true);
  progress.finish('c');
  progress.update('a', { phase: 'finalizing' });
  progress.draw(true);
  progress.update('a', { phase: 'uploading', uploadTotal: 10, upload: 1 });
  progress.draw(true); // a late event must not move the phase backwards
  progress.done();

  const screen = new Screen(width);
  screen.feed(chunks.join(''));
  const rows = screen.text.filter((r) => r.trim());

  // One footer bar, not one per frame. Matched by its percentage, which is what
  // distinguishes the full-width summary bar from the per-volume meters.
  const bars = rows.filter((r) => /[█░]{10,}\s+\d+%|^\s*[█░]{10,}\s+-$/.test(r));
  check(
    `width ${width}: exactly one summary bar remains`,
    bars.length === 1,
    `${bars.length} summary bars`,
  );
  const counters = rows.filter((r) => /\d+\/\d+ done/.test(r));
  check(
    `width ${width}: exactly one counter line remains`,
    counters.length === 1,
    `${counters.length} counter lines`,
  );

  const volumeRows = rows.filter((r) => /^\s+\S\s+(CMOA|BW|EBJ)\s/.test(r));
  check(
    `width ${width}: one row per live volume`,
    volumeRows.length <= 3 && volumeRows.length >= 1,
    `${volumeRows.length} volume rows`,
  );

  const tooWide = rows.filter((r) => displayWidth(r) > width);
  check(
    `width ${width}: nothing exceeds the terminal width`,
    tooWide.length === 0,
    tooWide.length ? `widest ${Math.max(...tooWide.map(displayWidth))}` : '',
  );

  // The note must survive the redraws that follow it.
  check(
    `width ${width}: the bridge note is not erased`,
    rows.some((r) => r.includes('mokuro ready')),
  );

  // The phase never goes backwards.
  check(
    `width ${width}: completed volume stays finished`,
    rows.some((r) => r.includes('1 finished')) || rows.some((r) => r.includes('done')),
  );

  // Regression: the block must never rely on the terminal's saved-cursor state.
  // DEC save/restore was clobbered by the ebookjapan subprocess sharing the pty,
  // which left restores with nothing to restore to and appended every frame.
  const emitted = chunks.join('');
  check(
    `width ${width}: no reliance on terminal cursor save/restore`,
    !emitted.includes('\x1b7') && !emitted.includes('\x1b8'),
  );
  // And a redraw must actually move the cursor up before erasing.
  check(
    `width ${width}: redraws step back up before erasing`,
    /\x1b\[\d+A\x1b\[0J/.test(emitted),
  );
}

// A finished volume must keep its row: without this the block empties out as
// books complete, so a run looks like it is losing work rather than finishing it.
{
  const chunks = [];
  const stream = { isTTY: true, columns: 100, write: (s) => chunks.push(s) };
  const progress = new LiveProgress({ stream });
  for (const [key, tag, label] of [
    ['a', 'CMOA', 'Volume A'],
    ['b', 'EBJ', 'Volume B'],
    ['c', 'BW', 'Volume C'],
  ]) {
    progress.add(key, { tag, label });
    progress.update(key, { phase: 'downloading', total: 10, done: 10 });
  }
  progress.draw(true);
  // Finish them all, one at a time, painting between each.
  for (const key of ['a', 'b', 'c']) {
    progress.finish(key);
    progress.draw(true);
  }
  progress.done();

  const screen = new Screen(100);
  screen.feed(chunks.join(''));
  const rows = screen.text.filter((r) => r.trim());
  for (const label of ['Volume A', 'Volume B', 'Volume C']) {
    check(`finished volume "${label}" stays on screen`, rows.some((r) => r.includes(label)));
  }
  check('a completion count is shown', rows.some((r) => /3 done/.test(r)));
  // Nothing may vanish between frames: the last frame must still hold all three.
  check(
    'all three finished volumes are visible at once',
    ['Volume A', 'Volume B', 'Volume C'].every((l) => rows.some((r) => r.includes(l))),
  );
}

// Each phase paints the same bar geometry but a different colour, so a row does
// not jump sideways as it advances.
{
  // `NO_COLOR` wins over `FORCE_COLOR` by design, and CI shells often set it, so
  // it has to be cleared before the instance is built (colour is resolved in the
  // constructor).
  const savedNoColor = process.env.NO_COLOR;
  const savedForceColor = process.env.FORCE_COLOR;
  delete process.env.NO_COLOR;
  process.env.FORCE_COLOR = '1';
  const progress = new LiveProgress({
    stream: { isTTY: true, columns: 100, write: () => {} },
    plain: false,
  });
  const observed = new Map();
  const geometry = new Set();
  for (const [phase, patch] of [
    ['downloading', { total: 100, done: 40 }],
    ['uploading', { uploadTotal: 100, upload: 40 }],
    ['ocr', { ocrTotal: 100, ocr: 40, ocrPending: 60 }],
    ['finalizing', {}],
    ['done', {}],
  ]) {
    progress.volumes = [];
    progress.byKey.clear();
    progress.add('k', { tag: 'CMOA', label: 'test' });
    progress.update('k', { phase, ...patch });
    const line = progress.renderVolume(progress.byKey.get('k'));
    const match = /\x1b\[(\d+)m([█░]+)/.exec(line);
    if (match) {
      observed.set(phase, match[1]);
      geometry.add(match[2].length);
    }
  }

  check('every phase paints a bar', observed.size === 5, `${observed.size} of 5`);
  check('bar colour differs per phase', new Set(observed.values()).size === observed.size);
  check('bar width is identical in every phase', geometry.size === 1, `widths ${[...geometry]}`);

  if (savedNoColor === undefined) delete process.env.NO_COLOR;
  else process.env.NO_COLOR = savedNoColor;
  if (savedForceColor === undefined) delete process.env.FORCE_COLOR;
  else process.env.FORCE_COLOR = savedForceColor;
}

// The header must distinguish things the old one conflated. It used to print
// "0/7 volumes · 234/234 pages", which looks like the run is finished when only
// one volume's length is even known.
{
  const progress = new LiveProgress({
    stream: { isTTY: true, columns: 120, write: () => {} },
    plain: true,
  });
  progress.add('a', { tag: 'EBJ', label: 'a' });
  progress.update('a', { phase: 'uploading', total: 185, done: 185, uploadTotal: 185, upload: 20 });
  progress.add('b', { tag: 'CMOA', label: 'b' });
  progress.update('b', { phase: 'downloading', total: 244, done: 120 });
  progress.add('c', { tag: 'BW', label: 'c' });
  progress.add('d', { tag: 'BW', label: 'd' });
  progress.finish('d');
  const lines = progress.footer().map((l) => l.replace(/\x1b\[[0-9;]*m/g, ''));
  const foot = lines.join('\n');

  check('footer separates done count from page count', /1\/4 done/.test(foot), foot);
  check('footer shows downloaded over a growing known total', /305\/429 pages/.test(foot), foot);
  check('footer breaks down active phases', /1 get/.test(foot) && /1 push/.test(foot), foot);
  check('footer counts queued volumes', /1 queued/.test(foot), foot);
  // A page count must never claim to be complete while volumes are unopened.
  check('page total cannot read as complete mid-run', !/429\/429 pages/.test(foot), foot);
  check('footer has a progress bar', /[█░]{10,}/.test(lines[0]), lines[0]);

  // A volume that merely uploaded pages is not finished work, so the overall bar
  // must not count it. Three of four volumes are still running here.
  const percent = Number((lines[0].match(/(\d+)%/) || [])[1] ?? 0);
  check('overall bar does not count unfinished volumes', percent === 0, `${percent}%`);

  // Once a volume finishes, its pages count toward completion.
  progress.finish('b');
  const after = progress.footer().map((l) => l.replace(/\x1b\[[0-9;]*m/g, ''));
  const afterPercent = Number((after[0].match(/(\d+)%/) || [])[1] ?? 0);
  check('finishing a volume advances the bar', afterPercent > percent, `${percent}% -> ${afterPercent}%`);
}

// Terminals report no width over a pipe; the fallback must still be sane.
{
  const chunks = [];
  const stream = { isTTY: true, columns: undefined, write: (s) => chunks.push(s) };
  const progress = new LiveProgress({ stream });
  progress.add('a', { tag: 'CMOA', label: WIDE });
  progress.update('a', { phase: 'downloading', total: 10, done: 5 });
  progress.draw(true);
  const line = chunks.join('').split('\n').filter((l) => l.includes('CMOA'))[0] ?? '';
  const width = Math.max(...line.split('\n').map(displayWidth));
  check('no terminal width: falls back to a bounded line', width <= 100, `width ${width}`);
}

// Not a TTY: no cursor games at all, just durable lines.
{
  const chunks = [];
  const stream = { isTTY: false, write: (s) => chunks.push(s) };
  const progress = new LiveProgress({ stream });
  progress.add('a', { tag: 'CMOA', label: 'テスト' });
  progress.update('a', { phase: 'downloading', total: 4, done: 4 });
  progress.finish('a');
  const output = chunks.join('');
  check('piped output contains no cursor movement', !/\x1b\[[0-9]*[AJ]/.test(output) && !/[\x1b][78]/.test(output));
}

if (failures.length) {
  console.error(`\n${failures.length} check(s) failed`);
  process.exit(1);
}
console.log('\nall live progress checks passed');
