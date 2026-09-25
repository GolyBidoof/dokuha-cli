#!/usr/bin/env node
/**
 * Descramble an ebookjapan volume (Node port of tools/descramble_book.py).
 *
 * The scrambling is a per-book tile permutation: the served image is a 16x16 (or
 * similar) grid of tiles stored in permuted order, with a small inter-tile gap.
 * Each tile is 92x132 inside a 104x144 cell for the sample book; both the grid
 * and the tile size differ per volume, so a table is required.
 *
 *   node descramble.mjs --table out/shuffle_patterns.json \
 *        --book-dir "headless/<title>" --out "headless/<title>/descrambled" [--pdf book.pdf]
 *
 * Options
 *   --table PATH     pattern table (geometry + patterns + page_pattern)
 *   --book-dir DIR   directory of page_NNN.webp
 *   --out DIR        output directory (default: <book-dir>/descrambled)
 *   --format FMT     webp | png
 *   --pdf PATH       also write a PDF (uses the `img2pdf` CLI if available)
 *   --limit N        only the first N pages
 *   --glob PATTERN   input name template (default page_{:03d}.webp)
 *   --report PATH    verification report JSON
 *
 * Verification: tile geometry is per-book, so a wrong table yields a page that
 * looks plausible but has a discontinuity at every tile seam. A correct result
 * has seam |d| close to the page's own interior |d|; we score each page and
 * report anything that does not separate.
 *
 * Node here has no image codecs, so encoding is done by delegating pixel work to
 * the same primitives the Python tool uses: raw RGBA composition in JS, then a
 * PNG/WebP encode via macOS `sips` (always present) or the `img2pdf`/`cwebp`
 * CLIs when available.
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawnSync, execFileSync } from 'node:child_process';

const argv = process.argv.slice(2);
const VALUE = new Set(['--table', '--book-dir', '--out', '--format', '--pdf', '--limit', '--glob', '--report']);
function opt(name, dflt) {
  const i = argv.indexOf(name);
  if (i < 0) return dflt;
  const v = argv[i + 1];
  return v && !v.startsWith('--') ? v : true;
}
const TABLE  = typeof opt('--table', null) === 'string' ? opt('--table') : 'out/shuffle_patterns.json';
const BOOK   = opt('--book-dir', null);
const FORMAT = opt('--format', 'webp');
const LIMIT  = Number(opt('--limit', 0)) || 0;

if (!BOOK || BOOK === true) {
  console.error('usage: node descramble.mjs --table TABLE --book-dir DIR [--out DIR] [--format webp|png] [--pdf FILE]');
  process.exit(2);
}

const OUT    = typeof opt('--out', null) === 'string' ? opt('--out') : path.join(BOOK, 'descrambled');
const PDF    = opt('--pdf', null);
const GLOB   = typeof opt('--glob', null) === 'string' ? opt('--glob') : 'page_{:03d}.webp';
const REPORT = typeof opt('--report', null) === 'string' ? opt('--report') : path.join(OUT, 'descramble_report.json');

// ---------------------------------------------------------------- table load
function loadTable(p) {
  const t = JSON.parse(fs.readFileSync(p, 'utf8'));
  const geo = t.geometry || t;                       // both shapes exist
  const grid = geo.grid, tile = geo.tile, cell = geo.cell;
  return {
    raw: t,
    grid: [grid[0], grid[1]],
    tile: [tile[0], tile[1]],
    cell: [cell[0], cell[1]],
    origin: geo.origin ?? 0,
    destPage: t.dest_page,
    patterns: t.patterns,
    pagePattern: t.page_pattern,
  };
}

// ------------------------------------------------------- pixel decode/encode
// Node has no codecs. We shell out to a tiny helper that speaks PPM (a trivial
// uncompressed format), using whatever decoder the host already has.
//   decode: sips  (macOS)  -> PNG -> we parse the PNG ourselves
// We keep it dependency-free by using Python+Pillow when present, since the
// repo's tooling already requires it; otherwise we fail with a clear message.

function hasModule(mod) {
  const r = spawnSync('python3', ['-c', `import ${mod}`], { stdio: 'ignore' });
  return r.status === 0;
}
const HAVE_PIL = hasModule('PIL') && hasModule('numpy');

if (!HAVE_PIL) {
  console.error('This tool needs python3 with Pillow and numpy (same deps as tools/descramble_book.py).');
  process.exit(3);
}

/**
 * Decode a webp/png/jpg to raw RGBA in JS by asking Python for a compact binary
 * dump on stdout: 4-byte width, 4-byte height, then w*h*4 bytes.
 */
function decodeRGBA(file) {
  const py = `
import sys, struct
from PIL import Image
im = Image.open(sys.argv[1]).convert('RGBA')
w, h = im.size
sys.stdout.buffer.write(struct.pack('<II', w, h))
sys.stdout.buffer.write(im.tobytes())
`;
  const out = execFileSync('python3', ['-c', py, file], { maxBuffer: 1 << 30 });
  const w = out.readUInt32LE(0), h = out.readUInt32LE(4);
  return { w, h, data: out.subarray(8) };
}

/** Encode raw RGBA to the requested format via Python. */
function encodeRGBA(file, w, h, data, format) {
  const py = `
import sys
from PIL import Image
w, h = int(sys.argv[2]), int(sys.argv[3])
im = Image.frombytes('RGBA', (w, h), sys.stdin.buffer.read()).convert('RGB')
fmt = sys.argv[4]
if fmt == 'png':
    im.save(sys.argv[1], 'PNG', compress_level=6)
else:
    im.save(sys.argv[1], 'WEBP', lossless=True, quality=100, method=4)
`;
  spawnSync('python3', ['-c', py, file, String(w), String(h), format], { input: data, maxBuffer: 1 << 30 });
}

/** Grayscale copy of an RGBA buffer, as a Float64Array-ish plain array. */
function toGray(w, h, data) {
  const g = new Uint8Array(w * h);
  for (let i = 0, p = 0; i < g.length; i++, p += 4) {
    // Rec.601 luma, matching PIL's convert('L') closely enough for seam scoring
    g[i] = (data[p] * 299 + data[p + 1] * 587 + data[p + 2] * 114) / 1000 | 0;
  }
  return g;
}

/**
 * Rebuild the tile grid from the scrambled source.
 * `pattern` is a list of [sx, sy, sw, sh] in destination row-major order.
 * Tiles may be smaller than the tile size near the right/bottom edge, which is
 * how the gaps at the grid border are filled.
 */
function compose(src, sw0, sh0, pattern, grid, tile) {
  const ow = tile[0], oh = tile[1];
  const W = grid[0] * ow, H = grid[1] * oh;
  const out = Buffer.alloc(W * H * 4);
  for (let idx = 0; idx < pattern.length; idx++) {
    const [sx, sy, sw, sh] = pattern[idx];
    const dx = (idx % grid[0]) * ow;
    const dy = Math.floor(idx / grid[0]) * oh;
    if (dx >= W || dy >= H) continue;
    const w = Math.min(sw, W - dx), h = Math.min(sh, H - dy);
    for (let y = 0; y < h; y++) {
      const srow = ((sy + y) * sw0 + sx) * 4;
      const drow = ((dy + y) * W + dx) * 4;
      src.copy(out, drow, srow, srow + w * 4);
    }
  }
  return { w: W, h: H, data: out };
}

/** Crop to (0,0,w,h). */
function crop(img, w, h) {
  const out = Buffer.alloc(w * h * 4);
  for (let y = 0; y < h; y++) {
    img.data.copy(out, y * w * 4, y * img.w * 4, y * img.w * 4 + w * 4);
  }
  return { w, h, data: out };
}

// ------------------------------------------------------------- verification
function meanAbsDiffRow(gray, w, h, y, x0, x1) {
  let s = 0, n = 0;
  const row = y * w;
  for (let x = x0; x < x1; x++) { s += Math.abs(gray[row + x + 1] - gray[row + x]); n++; }
  return n ? s / n : 0;
}
function meanAbsDiffCol(gray, w, h, x, y0, y1) {
  let s = 0, n = 0;
  for (let y = y0; y < y1; y++) { s += Math.abs(gray[(y + 1) * w + x] - gray[y * w + x]); n++; }
  return n ? s / n : 0;
}

/**
 * seam |d| at tile boundaries vs the page's interior |d|.
 * Ported from tools/descramble_book.py seam_scores(): the seam is sampled only
 * at columns that are exact multiples of the tile width, and the interior
 * excludes a small band around those columns.
 */
function seamScores(gray, w, h, tile, dest) {
  const tw = tile[0];
  const dw = Math.min(dest[0], w), dh = Math.min(dest[1], h);
  if (dh < 3 || dw < 3) return { seam: 0, interior: 0 };

  // horizontal differences: d[y][x] = |g[y][x+1] - g[y][x]|
  const d = (x, y) => Math.abs(gray[y * w + x + 1] - gray[y * w + x]);

  // seam columns: x-1 for x = tw, 2tw, ...  (i.e. the join between two tiles)
  let ssum = 0, snum = 0;
  const seamCols = [];
  for (let x = tw; x < dw; x += tw) { seamCols.push(x - 1); }
  for (const c of seamCols) {
    for (let y = 0; y < dh; y++) { ssum += d(c, y); snum++; }
  }

  // interior: every column except a +/-2 band around each seam column
  const mask = new Uint8Array(dw - 1).fill(1);
  for (const c of seamCols) {
    for (const o of [-2, -1, 0, 1]) {
      const i = c + o;
      if (i >= 0 && i < mask.length) mask[i] = 0;
    }
  }
  let isum = 0, inum = 0;
  for (let y = 0; y < dh; y++) {
    for (let x = 0; x < mask.length; x++) {
      if (mask[x]) { isum += d(x, y); inum++; }
    }
  }
  return { seam: snum ? ssum / snum : 0, interior: inum ? isum / inum : 0 };
}

/** mean |d| at source cell boundaries: the "still scrambled" baseline. */
function scrambledEdgeScore(gray, w, h, cell) {
  const cw = cell[0];
  let s = 0, n = 0;
  for (let x = cw; x < w - 1; x += cw) {
    const c = x - 1;
    for (let y = 0; y < h; y++) { s += Math.abs(gray[y * w + c + 1] - gray[y * w + c]); n++; }
  }
  return n ? s / n : 0;
}

// --------------------------------------------------------------------- main
const table = loadTable(TABLE);
const total = table.pagePattern.length;
const n = LIMIT ? Math.min(total, LIMIT) : total;
const ext = FORMAT === 'png' ? 'png' : 'webp';

await fsp.mkdir(OUT, { recursive: true });
console.log(`descrambling ${n} pages -> ${OUT} (${FORMAT})`);
console.log(`  grid ${table.grid.join('x')}  tile ${table.tile.join('x')}  cell ${table.cell.join('x')}  dest ${table.destPage.join('x')}`);

const rows = [];
for (let page = 0; page < n; page++) {
  // supports page_{:03d}.webp, page_{:d}.webp, page_%03d.webp
  const name = GLOB
    .replace(/\{:0(\d+)d\}/g, (_, w) => String(page).padStart(Number(w), '0'))
    .replace(/\{:(\d*)d\}/g, () => String(page))
    .replace(/%0(\d+)d/g, (_, w) => String(page).padStart(Number(w), '0'));
  const src = path.join(BOOK, name);
  if (!fs.existsSync(src)) { console.error(`  missing ${src}`); continue; }

  const img = decodeRGBA(src);
  const pid = table.pagePattern[page];
  const pattern = table.patterns[String(pid)];
  const full = compose(img.data, img.w, img.h, pattern, table.grid, table.tile);
  const out = crop(full, Math.min(table.destPage[0], full.w), Math.min(table.destPage[1], full.h));

  const grayOut = toGray(out.w, out.h, out.data);
  const graySrc = toGray(img.w, img.h, img.data);
  const { seam, interior } = seamScores(grayOut, out.w, out.h, table.tile, table.destPage);
  const edge = scrambledEdgeScore(graySrc, img.w, img.h, table.cell);

  const file = path.join(OUT, `page_${String(page).padStart(3, '0')}.${ext}`);
  encodeRGBA(file, out.w, out.h, out.data, FORMAT);

  const ratio = interior > 1e-6 ? seam / interior : Infinity;
  const vsScrambled = edge > 1e-6 ? seam / edge : 0;
  rows.push({
    page, pattern: pid, file, size: [out.w, out.h],
    seam: +seam.toFixed(2), interior: +interior.toFixed(2),
    ratio: +ratio.toFixed(2), scrambled_edge: +edge.toFixed(2),
    ratio_vs_scrambled: +vsScrambled.toFixed(3),
  });
  if ((page + 1) % 20 === 0 || page + 1 === n) process.stdout.write(`\r  ${page + 1}/${n}`);
}
process.stdout.write('\n');

// summary + the same "did it separate cleanly" judgement the Python tool makes
const ratios = rows.map(r => r.ratio_vs_scrambled).sort((a, b) => a - b);
const median = arr => arr.length ? arr[arr.length >> 1] : 0;
const bad = rows.filter(r => r.ratio_vs_scrambled > 0.35);

console.log(`\npages written      : ${rows.length}`);
console.log(`seam/interior med  : ${median(rows.map(r => r.ratio).sort((a,b)=>a-b)).toFixed(2)}`);
console.log(`seam/scrambled med : ${median(ratios).toFixed(3)}`);
console.log(`cleanly separated  : ${rows.length - bad.length}/${rows.length}`);
if (bad.length) {
  console.log(`\n${bad.length} page(s) did not separate cleanly:`);
  for (const r of bad.slice(0, 20)) {
    console.log(`  page ${String(r.page).padStart(3)} pattern ${r.pattern}  seam ${String(r.seam).padStart(6)} interior ${String(r.interior).padStart(6)} scrambled ${String(r.scrambled_edge).padStart(6)}`);
  }
}

await fsp.mkdir(path.dirname(REPORT), { recursive: true });
await fsp.writeFile(REPORT, JSON.stringify({ table: TABLE, book_dir: BOOK, pages: rows }, null, 1));
console.log(`report -> ${REPORT}`);

if (PDF && PDF !== true) {
  const r = spawnSync('img2pdf', [...rows.map(x => x.file), '-o', PDF], { stdio: 'inherit' });
  if (r.status === 0) console.log(`pdf -> ${PDF}`);
  else console.log('pdf: img2pdf not available; install it or use tools/make_pdf.py');
}
