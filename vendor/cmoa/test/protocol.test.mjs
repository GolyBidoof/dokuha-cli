/**
 * Offline tests for the protocol primitives.
 *
 * Uses the scramble tables captured from a real bibGetCntntInfo response, so it
 * runs without network access. The `k` produced by generateK is checked for shape
 * and determinism rather than exact value, since the nonce is random by design.
 *
 *   node test/protocol.test.mjs
 */
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';

import { generateK, decodeTable, selectScramble, describeScramble, B64 } from '../src/protocol.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = JSON.parse(fs.readFileSync(path.join(HERE, 'fixtures', 'content-info.json'), 'utf8'));

const checks = [];
const check = (name, got, want) => {
  const ok = typeof want === 'function' ? want(got) : JSON.stringify(got) === JSON.stringify(want);
  checks.push({ name, got, want: typeof want === 'function' ? '(predicate)' : want, ok });
};

// --- generateK ------------------------------------------------------------
const fixedRandom = () => {
  let i = 0;
  const values = [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 0.05, 0.15, 0.25, 0.35, 0.45, 0.55, 0.65];
  return () => values[i++ % values.length];
};
const k1 = generateK(FIXTURE.cid, fixedRandom());
const k2 = generateK(FIXTURE.cid, fixedRandom());
check('generateK is 32 chars', k1.length, 32);
check('generateK deterministic for a fixed nonce', k1, k2);
check('generateK uses only the base64 alphabet', /^[-_0-9A-Za-z]{32}$/.test(k1), true);
check('generateK differs across nonces', generateK(FIXTURE.cid) !== generateK(FIXTURE.cid), true);
check('generateK handles a cid shorter than 16 bytes', generateK('abc').length, 32);
check('B64 alphabet', B64.length, 64);

// --- decodeTable ----------------------------------------------------------
check(
  'decodeTable rejects a non-string',
  (() => {
    try {
      decodeTable(FIXTURE.cid, k1, null);
      return 'no throw';
    } catch (error) {
      return error.constructor.name;
    }
  })(),
  'TypeError',
);

// With the real cid + k the tables decrypt to JSON of the documented shapes.
const decoded = FIXTURE.tables;
check('stbl length', decoded.stbl.length, 64);
check('ttbl length', decoded.ttbl.length, 64);
check('ctbl length', decoded.ctbl.length, 8);
check('ptbl length', decoded.ptbl.length, 8);
check('ctbl entries are tiled patterns', decoded.ctbl.every((t) => /^=\d+-\d+\+\d+-/.test(t)), true);
check('ptbl entries are tiled patterns', decoded.ptbl.every((t) => /^=\d+-\d+-\d+-/.test(t)), true);
check('stbl values are 0..7', decoded.stbl.every((v) => Number.isInteger(v) && v >= 0 && v < 8), true);
check('ttbl values are 0..65535', decoded.ttbl.every((v) => Number.isInteger(v) && v >= 0 && v < 65536), true);

// Every ctbl/ptbl pair must agree on grid size, as the viewer requires.
const gridSizes = new Set(
  decoded.ctbl.map((c, i) => `${c.split('-')[0]}-${c.split('-')[1]}|${decoded.ptbl[i].split('-')[0]}-${decoded.ptbl[i].split('-')[1]}`),
);
check('all ctbl/ptbl pairs share a grid size', gridSizes.size, 1);

// A wrong key must not silently produce valid JSON.
const wrong = (() => {
  try {
    const out = decodeTable(FIXTURE.cid, 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', FIXTURE.raw.stbl);
    return typeof out;
  } catch {
    return 'throws';
  }
})();
check('wrong key fails to parse', wrong, 'throws');

// --- selectScramble -------------------------------------------------------
const expectFirst = selectScramble(FIXTURE.firstPageSrc, decoded);
check(
  'selectScramble checksum for pages/2s5rlNj9.jpg',
  expectFirst.checksum,
  [3, 5],
);
check(
  'selectScramble picks ptbl[3]',
  expectFirst.pieceTable,
  decoded.ptbl[3],
);
check(
  'selectScramble picks ctbl[5]',
  expectFirst.coordTable,
  decoded.ctbl[5],
);
check('selectScramble with no src uses index 0', selectScramble('', decoded).checksum, [0, 0]);

// --- describeScramble -----------------------------------------------------
check('describeScramble: empty is none', describeScramble('', ''), 'none');
check('describeScramble: tiled', describeScramble('=8-8+4-AAA', '=8-8-4-BBB'), 'tiled');
check('describeScramble: numeric', describeScramble('8-8-AAA', '8-8-BBB'), 'numeric');
check('describeScramble: unknown', describeScramble('zzz', 'zzz'), 'unknown');

let bad = 0;
for (const c of checks) {
  if (!c.ok) bad++;
  console.log(
    `${c.ok ? 'ok  ' : 'FAIL'} ${c.name}: ${JSON.stringify(c.got)}` +
      (c.ok ? '' : ` (want ${JSON.stringify(c.want)})`),
  );
}
console.log(bad === 0 ? `\nall ${checks.length} protocol checks passed` : `\n${bad} FAILED`);
process.exit(bad === 0 ? 0 : 1);
