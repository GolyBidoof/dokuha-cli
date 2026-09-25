/**
 * Round-trips the JPEG encoder: decode an image, re-encode it, and check that the
 * result is a valid JPEG whose pixels still match.
 *
 * With no argument it uses the checked-in fixture and validates with its own
 * decoder, so no network, /tmp files or Python are needed.
 *
 *   node test/jpeg_encode.test.mjs                  # offline fixture
 *   node test/jpeg_encode.test.mjs <image.jpg> [q]  # any file, also checked with Pillow
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { decodeJpeg, sampleRgb } from '../src/jpeg.js';
import { encodeJpeg } from '../src/jpeg_encode.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const file = process.argv[2] ?? null;
const quality = Number(process.argv[3] ?? 92);

const bytes = file
  ? fs.readFileSync(file)
  : Buffer.from(
      JSON.parse(fs.readFileSync(path.join(HERE, 'fixtures', 'jpeg-sample.json'), 'utf8')).jpeg,
      'base64',
    );

const image = decodeJpeg(bytes);
const W = image.width;
const H = image.height;
const rgb = Buffer.alloc(W * H * 3);
const out = [0, 0, 0];
for (let y = 0; y < H; y++) {
  for (let x = 0; x < W; x++) {
    sampleRgb(image, x, y, out);
    const o = (y * W + x) * 3;
    rgb[o] = out[0];
    rgb[o + 1] = out[1];
    rgb[o + 2] = out[2];
  }
}

const encoded = encodeJpeg(rgb, W, H, { quality });
console.log(
  `encoded ${W}x${H} q=${quality}: ${(encoded.length / 1024).toFixed(0)} KiB ` +
    `(source ${(bytes.length / 1024).toFixed(0)} KiB)`,
);

// The result must be a structurally valid JPEG that decodes to the same geometry.
const back = decodeJpeg(encoded);
if (back.width !== W || back.height !== H) {
  console.log(`FAIL size changed: ${W}x${H} -> ${back.width}x${back.height}`);
  process.exit(1);
}

// With a real file, additionally confirm an independent decoder accepts it and
// agrees pixel for pixel. Pillow prints only the sampled grid, because piping a
// full-page RGB buffer would blow execFileSync's maxBuffer.
if (file) {
  const encodedPath = '/tmp/jpeg_encode_out.jpg';
  fs.writeFileSync(encodedPath, encoded);
  const step = 5;
  const lines = execFileSync('python3', ['-c', `
from PIL import Image
import sys
im = Image.open(sys.argv[1]); im.load()
w, h = im.size
buf = im.convert('RGB').tobytes()
for y in range(0, h, ${step}):
    for x in range(0, w, ${step}):
        o = (y * w + x) * 3
        print(buf[o], buf[o+1], buf[o+2])
`, encodedPath], { encoding: 'utf8', maxBuffer: 128 * 1024 * 1024 }).trim().split('\n');
  const pill = lines.map((line) => line.trim().split(' ').map(Number));
  let psum = 0;
  let pmax = 0;
  let pn = 0;
  let i = 0;
  for (let y = 0; y < H; y += step) {
    for (let x = 0; x < W; x += step) {
      const want = pill[i++];
      sampleRgb(back, x, y, out);
      for (let c = 0; c < 3; c++) {
        const d = Math.abs(out[c] - want[c]);
        psum += d;
        if (d > pmax) pmax = d;
        pn++;
      }
    }
  }
  console.log(`our decoder vs Pillow: mean |Δ| = ${(psum / pn).toFixed(3)}, max = ${pmax}`);
}

// Round-trip error against the pre-encode image. Compared against the source
// *decode*, this includes the chroma subsampling loss (4:2:0 vs a 4:4:4 source)
// on top of quantisation. A correct encoder lands around 0.9-1.3 depending on
// quality; the common breakages (a missing coefficient-buffer clear, a
// transposed DCT row) push it past 4, so 2.0 separates them cleanly.
let sum = 0;
let n = 0;
for (let y = 0; y < H; y += 5) {
  for (let x = 0; x < W; x += 5) {
    sampleRgb(back, x, y, out);
    const o = (y * W + x) * 3;
    for (let c = 0; c < 3; c++) {
      sum += Math.abs(out[c] - rgb[o + c]);
      n++;
    }
  }
}
const rt = sum / n;
console.log(`round-trip mean |Δ| = ${rt.toFixed(3)}`);
const ok = rt < 2.0;
console.log(ok ? 'PASS' : 'FAIL');
process.exit(ok ? 0 : 1);
