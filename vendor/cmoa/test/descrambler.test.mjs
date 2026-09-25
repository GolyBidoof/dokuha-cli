/**
 * Descrambler geometry tests.
 *
 * Two independent checks:
 *
 *  1. `refTiledRegions` is a literal port of the viewer's `f.prototype.Ot`
 *     (variable names kept as in the bundle) and is compared rectangle for
 *     rectangle against the implementation for several grid shapes and image
 *     sizes.
 *  2. The regions must describe a *complete, non-overlapping* tiling of the
 *     visible image. That property is what makes the output a valid page: if a
 *     tile were dropped or a size off by one, area would not add up.
 *
 *   node test/descrambler.test.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { compileDescrambler } from '../src/descrambler.js';
import { selectScramble } from '../src/protocol.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = JSON.parse(fs.readFileSync(path.join(HERE, 'fixtures', 'content-info.json'), 'utf8'));
const tables = FIXTURE.tables;

/**
 * Verbatim port of the viewer's `f.prototype.Ot`, used as the reference.
 * `kt`/`Lt`/`Nt`/`Rt`/`Ft` and `T`/`j`/`Dt` are the bundle's names.
 */
function refTiledRegions(kt, Lt, Nt, Rt, Ft, T, j, Dt, width, height) {
  const It = (w, h) => {
    const i = 2 * T * Dt;
    const n = 2 * j * Dt;
    return w >= 64 + i && h >= 64 + n && w * h >= (320 + i) * (320 + n);
  };
  if (!It(width, height)) return [{ xsrc: 0, ysrc: 0, width, height, xdest: 0, ydest: 0 }];
  const i = width - 2 * T * Dt;
  const n = height - 2 * j * Dt;
  const r = Math.floor((i + T - 1) / T);
  const e = i - (T - 1) * r;
  const s = Math.floor((n + j - 1) / j);
  const h = n - (j - 1) * s;
  const u = [];
  for (let o = 0; o < T * j; ++o) {
    const a = o % T;
    const f = Math.floor(o / T);
    const c = Dt + a * (r + 2 * Dt) + (Lt[f] < a ? e - r : 0);
    const l = Dt + f * (s + 2 * Dt) + (Nt[a] < f ? h - s : 0);
    const v = kt[o] % T;
    const d = Math.floor(kt[o] / T);
    const b = v * r + (Rt[d] < v ? e - r : 0);
    const g = d * s + (Ft[v] < d ? h - s : 0);
    const p = Rt[d] === v ? e : r;
    const m = Ft[v] === d ? h : s;
    if (0 < i && 0 < n) u.push({ xsrc: c, ysrc: l, width: p, height: m, xdest: b, ydest: g });
  }
  return u;
}

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
const CV = new Int8Array(128).fill(-1);
for (let i = 0; i < B64.length; i++) CV[B64.charCodeAt(i)] = i;

function parsePattern(text) {
  const m = /^=([0-9]+)-([0-9]+)([-+])([0-9]+)-([-_0-9A-Za-z]+)$/.exec(text);
  if (!m) throw new Error(`bad pattern ${text}`);
  return { T: +m[1], j: +m[2], Dt: +m[4], body: m[5] };
}
function sections(T, j, body) {
  const values = Array.from({ length: T + j + T * j }, (_, i) => CV[body.charCodeAt(i)]);
  return {
    colShift: values.slice(0, T),
    rowShift: values.slice(T, T + j),
    perm: values.slice(T + j),
  };
}

const checks = [];
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  checks.push({ name, got, want, ok });
};

// --- 1. compare against the reference for every ctbl/ptbl pair in the fixture ---
let compared = 0;
let mismatches = 0;
for (let ci = 0; ci < tables.ctbl.length; ci++) {
  for (let pi = 0; pi < tables.ptbl.length; pi++) {
    const coordText = tables.ctbl[ci];
    const pieceText = tables.ptbl[pi];
    const coord = parsePattern(coordText);
    const piece = parsePattern(pieceText);
    if (coord.T !== piece.T || coord.j !== piece.j || coord.Dt !== piece.Dt) continue;
    const s = sections(coord.T, coord.j, coord.body);
    const h = sections(piece.T, piece.j, piece.body);
    const kt = Array.from({ length: coord.T * coord.j }, (_, i) => s.perm[h.perm[i]]);
    const impl = compileDescrambler(coordText, pieceText);
    for (const [w, hh] of [
      [1414, 1984],
      [1350, 1920],
      [1195, 1673],
      [2000, 2800],
      [800, 1100],
    ]) {
      const ref = refTiledRegions(kt, h.colShift, h.rowShift, s.colShift, s.rowShift, coord.T, coord.j, coord.Dt, w, hh);
      const got = impl.regions(w, hh);
      compared++;
      if (JSON.stringify(ref) !== JSON.stringify(got)) {
        mismatches++;
        if (mismatches <= 3) {
          console.log(`MISMATCH ctbl[${ci}]/ptbl[${pi}] ${w}x${hh}`);
          console.log('  ref ', JSON.stringify(ref[0]));
          console.log('  impl', JSON.stringify(got[0]));
        }
      }
    }
  }
}
check('reference comparisons run', compared > 0, true);
check('no mismatch against the viewer port', mismatches, 0);

// --- 2. the regions must exactly tile the visible image -------------------
function tilingProblems(regions, size) {
  if (!regions) return ['null regions'];
  const problems = [];
  const covered = new Uint8Array(size.width * size.height);
  let outOfBounds = 0;
  for (const r of regions) {
    if (r.xdest < 0 || r.ydest < 0 || r.xdest + r.width > size.width || r.ydest + r.height > size.height) {
      outOfBounds++;
      continue;
    }
    for (let y = 0; y < r.height; y++) {
      const base = (r.ydest + y) * size.width + r.xdest;
      for (let x = 0; x < r.width; x++) covered[base + x]++;
    }
  }
  if (outOfBounds) problems.push(`${outOfBounds} regions out of bounds`);
  let gaps = 0;
  let overlaps = 0;
  for (let i = 0; i < covered.length; i++) {
    if (covered[i] === 0) gaps++;
    else if (covered[i] > 1) overlaps++;
  }
  if (gaps) problems.push(`${gaps} uncovered pixels`);
  if (overlaps) problems.push(`${overlaps} overlapped pixels`);
  return problems;
}

let tilingChecked = 0;
for (const size of [
  { width: 1414, height: 1984 },
  { width: 1350, height: 1920 },
  { width: 1195, height: 1673 },
]) {
  const scramble = selectScramble('pages/2s5rlNj9.jpg', tables);
  const impl = compileDescrambler(scramble.coordTable, scramble.pieceTable);
  const regions = impl.regions(size.width, size.height);
  const visible = impl.displaySize(size.width, size.height);
  const problems = tilingProblems(regions, visible);
  if (problems.length) {
    console.log(`tiling problems for ${size.width}x${size.height}:`, problems.join(', '));
  }
  tilingChecked++;
}
check('tiling is complete and non-overlapping', tilingChecked, 3);

// --- 3. size gates ---------------------------------------------------------
const scramble = selectScramble('pages/2s5rlNj9.jpg', tables);
const impl = compileDescrambler(scramble.coordTable, scramble.pieceTable);
check('small image is left alone', impl.regions(40, 40), [
  { xsrc: 0, ysrc: 0, width: 40, height: 40, xdest: 0, ydest: 0 },
]);
check('small image display size is unchanged', impl.displaySize(40, 40), { width: 40, height: 40 });

// --- 4. unsupported layouts are refused, not guessed -----------------------
const numericError = (() => {
  try {
    compileDescrambler('8-8-' + 'A'.repeat(128), '8-8-' + 'A'.repeat(128));
    return 'no throw';
  } catch (error) {
    return error.name;
  }
})();
check('numeric layout is refused explicitly', numericError, 'UnsupportedNumericLayout');

let bad = 0;
for (const c of checks) {
  if (!c.ok) bad++;
  console.log(`${c.ok ? 'ok  ' : 'FAIL'} ${c.name}: ${JSON.stringify(c.got)}`);
}
console.log(`\ncompared ${compared} region sets against the viewer port`);
console.log(bad === 0 ? `all ${checks.length} descrambler checks passed` : `${bad} FAILED`);
process.exit(bad === 0 ? 0 : 1);
