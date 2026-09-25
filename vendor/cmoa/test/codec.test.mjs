/**
 * End-to-end check of the codec: descramble the real cover page and compare it
 * against CMOA's own unscrambled thumbnail of the same volume.
 *
 * The thumbnail is served from a different CDN path with no scrambling applied,
 * which makes it an independent reference for both the descramble direction and
 * the tile geometry.
 *
 *   node test/codec.test.mjs
 */
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { renderPage } from '../src/codec.js';

const page = fs.readFileSync('/tmp/e2e_p0.jpg');
const ctx = JSON.parse(fs.readFileSync('/tmp/e2e_ctx.json', 'utf8'));
const src = 'pages/2s5rlNj9.jpg';
const idx = [0, 0];
{
  const n = src.lastIndexOf('/') + 1;
  for (let i = 0; i < src.length - n; i++) idx[i % 2] += src.charCodeAt(n + i);
  idx[0] %= 8;
  idx[1] %= 8;
}
const tables = { coordTable: ctx.ctbl[idx[1]], pieceTable: ctx.ptbl[idx[0]] };

const scrambled = renderPage(page, { coordTable: '', pieceTable: '' }, { format: 'png' });
const out = renderPage(page, tables, { format: 'png' });
console.log(`descrambler kind=${out.kind} visible=${out.width}x${out.height} ` +
  `(stored ${scrambled.width}x${scrambled.height})`);

fs.writeFileSync('/tmp/codec_descrambled.png', out.data);
fs.writeFileSync('/tmp/codec_identity.png', scrambled.data);

// Correlate each candidate against the thumbnail with Pillow.
const result = execFileSync('python3', ['-c', `
from PIL import Image
import numpy as np, sys
th = Image.open('/tmp/thumb_full.jpg').convert('L')
def ncc(path):
    im = Image.open(path).convert('L').resize(th.size, Image.LANCZOS)
    a = np.asarray(im, dtype=np.float64); b = np.asarray(th, dtype=np.float64)
    a = (a - a.mean()) / (a.std() + 1e-9); b = (b - b.mean()) / (b.std() + 1e-9)
    return float((a * b).mean())
print('descrambled vs thumbnail NCC:', round(ncc('/tmp/codec_descrambled.png'), 4))
print('identity    vs thumbnail NCC:', round(ncc('/tmp/codec_identity.png'), 4))
`], { encoding: 'utf8' });
process.stdout.write(result);
const lines = result.trim().split('\n');
const desc = Number(lines[0].split(':')[1]);
const ident = Number(lines[1].split(':')[1]);
const ok = desc > 0.9 && Math.abs(ident) < 0.3;
console.log(ok ? 'PASS' : 'FAIL');
process.exit(ok ? 0 : 1);
