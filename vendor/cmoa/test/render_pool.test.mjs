/**
 * Checks that the worker-thread pool returns exactly what inline rendering does.
 *
 * The pool exists only for speed, so it must be invisible in the output. This
 * test is the guard for a real bug: the worker transferred `data.buffer` out of
 * Node's shared Buffer pool, which both shipped the wrong byte range (the image
 * is a slice of a 64 KiB slab) and detached memory other allocations were still
 * using — surfacing intermittently as `DataCloneError: Cannot transfer object of
 * unsupported type` partway through a volume.
 *
 * It is offline: the checked-in JPEG fixture is rendered with an identity
 * descrambler (null tables), which still exercises decode, re-encode and the
 * transfer path.
 *
 *   node test/render_pool.test.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { renderPage } from '../src/codec.js';
import { RenderPool } from '../src/render_pool.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const bytes = Buffer.from(
  JSON.parse(fs.readFileSync(path.join(HERE, 'fixtures', 'jpeg-sample.json'), 'utf8')).jpeg,
  'base64',
);

// Null tables compile to an identity descrambler, so this needs no network.
const tables = { coordTable: null, pieceTable: null };

const digest = (data) => crypto.createHash('sha256').update(data).digest('hex');

const failures = [];
function check(label, condition, detail) {
  if (condition) {
    console.log(`PASS  ${label}`);
  } else {
    console.log(`FAIL  ${label}${detail ? `  (${detail})` : ''}`);
    failures.push(label);
  }
}

// Every format, because each one returns its bytes from a different encoder and
// the bug depended on the allocation each one happened to make.
//
// `renderPage` and the pool both take `quality` (not `jpegQuality`, which is the
// downloader's option name); passing the wrong one silently falls back to the
// quality-92 default and makes the two paths look different when they are not.
const pool = new RenderPool(3);
for (const format of ['jpeg', 'original', 'png']) {
  const inline = renderPage(bytes, tables, { format, quality: 90 });
  const pooled = await pool.render(bytes, tables, { format, quality: 90 });

  check(
    `pooled ${format} matches inline bytes`,
    digest(inline.data) === digest(pooled.data),
    `inline ${inline.data.length}B vs pooled ${pooled.data.length}B`,
  );
  check(
    `pooled ${format} preserves dimensions`,
    inline.width === pooled.width && inline.height === pooled.height,
    `${inline.width}x${inline.height} vs ${pooled.width}x${pooled.height}`,
  );
  check(
    `pooled ${format} preserves extension`,
    inline.extension === pooled.extension,
    `${inline.extension} vs ${pooled.extension}`,
  );
}

// Run the same job through the pool many times concurrently. A pooled-slab
// transfer corrupts or throws only once a slab has been detached by an earlier
// transfer, so a single sequential pass can miss it.
const rounds = await Promise.all(
  Array.from({ length: 24 }, () => pool.render(bytes, tables, { format: 'jpeg', quality: 90 })),
);
const expected = digest(renderPage(bytes, tables, { format: 'jpeg', quality: 90 }).data);
check(
  '24 concurrent jobs all return identical bytes',
  rounds.every((r) => digest(r.data) === expected),
  `${rounds.filter((r) => digest(r.data) !== expected).length} of ${rounds.length} differ`,
);

await pool.close();

if (failures.length) {
  console.error(`\n${failures.length} check(s) failed`);
  process.exit(1);
}
console.log('\nall render pool checks passed');
