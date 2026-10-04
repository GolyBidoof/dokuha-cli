/**
 * Grayscale pages must convert, not throw.
 *
 * CMOA serves a black-and-white volume's interior as single-component JPEGs --
 * the cover is colour and the rest is not. `sampleRgb` read `components[1]` and
 * `components[2]` unconditionally, so on those pages it threw
 * "Cannot read properties of undefined (reading 'h')" and every page of the
 * volume failed while the cover succeeded. A colour title never notices, which is
 * why this survived: it only shows up on a black-and-white book.
 *
 *   node test/grayscale.test.mjs
 */
import { sampleRgb } from '../src/jpeg.js';

const checks = [];
function check(name, ok, got, want) {
  checks.push({ name, ok, got, want });
}

const W = 6;
const H = 4;
const LUMA = Uint8Array.from([
  0, 32, 64, 96, 128, 255,
  255, 128, 96, 64, 32, 0,
  17, 17, 17, 200, 200, 200,
  7, 200, 7, 200, 7, 200,
]);

/** The shape `decodeJpeg` builds for a one-component file. */
const gray = {
  width: W,
  height: H,
  maxH: 1,
  maxV: 1,
  components: [{ id: 1, h: 1, v: 1, stride: W, plane: LUMA }],
};

// The bug: this used to throw before it could return anything.
let threw = null;
const out = [0, 0, 0];
try {
  sampleRgb(gray, 0, 0, out);
} catch (error) {
  threw = error.message;
}
check('a grayscale pixel does not throw', threw === null, threw, null);

// A grayscale page has no chroma, so all three channels take the luma. Anything
// else would tint a black-and-white page.
let mismatched = 0;
let firstBad = null;
for (let y = 0; y < H; y++) {
  for (let x = 0; x < W; x++) {
    const pixel = [0, 0, 0];
    sampleRgb(gray, x, y, pixel);
    const want = LUMA[y * W + x];
    if (pixel[0] !== want || pixel[1] !== want || pixel[2] !== want) {
      mismatched++;
      if (!firstBad) firstBad = { x, y, got: pixel.slice(), want };
    }
  }
}
check('a grayscale pixel is neutral and carries the luma',
  mismatched === 0, firstBad, null);

// The colour path must be untouched: 4:4:4 YCbCr with zero chroma is exactly the
// luma again, which is the same arithmetic the grayscale branch now shortcuts.
const ycbcr = {
  width: 1,
  height: 1,
  maxH: 1,
  maxV: 1,
  components: [
    { id: 1, h: 1, v: 1, stride: 1, plane: Uint8Array.from([120]) },
    { id: 2, h: 1, v: 1, stride: 1, plane: Uint8Array.from([128]) },
    { id: 3, h: 1, v: 1, stride: 1, plane: Uint8Array.from([128]) },
  ],
};
const colour = [0, 0, 0];
sampleRgb(ycbcr, 0, 0, colour);
check('a colour pixel still converts', colour.every((c) => c === 120), colour, [120, 120, 120]);

// And a component count of two is not a YCbCr image either; it must not throw.
const twoComponent = {
  width: 1, height: 1, maxH: 1, maxV: 1,
  components: [
    { id: 1, h: 1, v: 1, stride: 1, plane: Uint8Array.from([90]) },
    { id: 2, h: 1, v: 1, stride: 1, plane: Uint8Array.from([10]) },
  ],
};
let twoThrew = null;
try {
  sampleRgb(twoComponent, 0, 0, [0, 0, 0]);
} catch (error) {
  twoThrew = error.message;
}
check('a two-component image does not throw', twoThrew === null, twoThrew, null);

let bad = 0;
for (const c of checks) {
  if (!c.ok) bad++;
  console.log(`${c.ok ? 'ok  ' : 'FAIL'} ${c.name}: ${JSON.stringify(c.got)}${c.ok ? '' : ` (want ${JSON.stringify(c.want)})`}`);
}
console.log(bad === 0 ? '\nall grayscale checks passed' : `\n${bad} FAILED`);
process.exit(bad === 0 ? 0 : 1);
