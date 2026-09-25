/**
 * Verifies the from-scratch baseline JPEG decoder.
 *
 * With no argument it decodes the checked-in fixture and compares against the RGB
 * bytes Pillow produced for that exact JPEG, so no network, no /tmp files and no
 * Python are needed.
 *
 *   node test/jpeg.test.mjs                 # offline fixture
 *   node test/jpeg.test.mjs <image.jpg>     # any file, verified with Pillow
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { decodeJpeg, sampleRgb } from '../src/jpeg.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const file = process.argv[2] ?? null;

let bytes;
let reference; // { width, height, rgb }
let label;

if (file) {
  bytes = fs.readFileSync(file);
  label = file;
  // Reference: Pillow, sampled at the same grid we compare on. Piping the whole
  // RGB buffer would exceed execFileSync's default maxBuffer on a full page.
  const step = 7;
  const probe = execFileSync('python3', ['-c', `
from PIL import Image
import sys
im = Image.open(sys.argv[1]).convert('RGB')
w, h = im.size
print(w, h)
buf = im.tobytes()
for y in range(0, h, ${step}):
    for x in range(0, w, ${step}):
        o = (y * w + x) * 3
        print(buf[o], buf[o+1], buf[o+2])
`, file], { encoding: 'utf8', maxBuffer: 128 * 1024 * 1024 }).trim().split('\n');
  const [pw, ph] = probe[0].trim().split(' ').map(Number);
  const samples = probe.slice(1).map((line) => line.trim().split(' ').map(Number));
  reference = { width: pw, height: ph, step, samples };
} else {
  const fixture = JSON.parse(fs.readFileSync(path.join(HERE, 'fixtures', 'jpeg-sample.json'), 'utf8'));
  bytes = Buffer.from(fixture.jpeg, 'base64');
  const rgb = Buffer.from(fixture.rgb, 'base64');
  reference = { width: fixture.width, height: fixture.height, rgb };
  label = 'test/fixtures/jpeg-sample.json';
}

const image = decodeJpeg(bytes);
console.log(
  `decoded ${label}: ${image.width}x${image.height}, ` +
    image.components.map((c) => `${c.id}@${c.h}x${c.v}`).join(' '),
);

// The decoder must agree with the reference on geometry before pixels are compared.
if (image.width !== reference.width || image.height !== reference.height) {
  console.log(`FAIL size mismatch: got ${image.width}x${image.height}, want ${reference.width}x${reference.height}`);
  process.exit(1);
}

// Compare on the same grid the reference was sampled at.
const out = [0, 0, 0];
let sum = 0;
let max = 0;
let n = 0;
if (reference.samples) {
  let i = 0;
  for (let y = 0; y < reference.height; y += reference.step) {
    for (let x = 0; x < reference.width; x += reference.step) {
      const want = reference.samples[i++];
      sampleRgb(image, x, y, out);
      for (let c = 0; c < 3; c++) {
        const d = Math.abs(out[c] - want[c]);
        sum += d;
        if (d > max) max = d;
        n++;
      }
    }
  }
} else {
  const refStride = reference.width * 3;
  for (let y = 0; y < reference.height; y += 7) {
    for (let x = 0; x < reference.width; x += 7) {
      sampleRgb(image, x, y, out);
      const o = y * refStride + x * 3;
      for (let c = 0; c < 3; c++) {
        const d = Math.abs(out[c] - reference.rgb[o + c]);
        sum += d;
        if (d > max) max = d;
        n++;
      }
    }
  }
}
const mean = sum / n;
console.log(`sampled ${n / 3} pixels: mean |Δchannel| = ${mean.toFixed(3)}, max = ${max}`);
// Our upsample-and-colour-convert differs slightly from Pillow's by design, so
// this is a fidelity band rather than an exact match.
const ok = mean < 1.5 && max <= 12;
console.log(ok ? 'PASS' : 'FAIL');
process.exit(ok ? 0 : 1);
