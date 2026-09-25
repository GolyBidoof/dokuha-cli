#!/usr/bin/env node
/**
 * Test runner.
 *
 *   node test/run.mjs          offline tests only
 *   node test/run.mjs --live   also run the network tests
 *
 * Offline tests take no network and complete in a couple of seconds. The live
 * tests fetch one volume's metadata and a handful of images from CMOA, so they
 * need connectivity and are opt-in.
 */
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const live = process.argv.includes('--live');

const offline = [
  ['protocol', 'protocol.test.mjs'],
  ['descrambler', 'descrambler.test.mjs'],
  ['jpeg decode', 'jpeg.test.mjs'],
  ['jpeg encode', 'jpeg_encode.test.mjs'],
  ['render pool', 'render_pool.test.mjs'],
  ['live progress', 'live_progress.test.mjs'],
];

const liveTests = [
  ['page list (live)', 'pagelist.test.mjs'],
  ['codec (live)', 'codec.test.mjs'],
];

function available(test) {
  const args = test[2] ?? [];
  return args.every((a) => fs.existsSync(a));
}

const results = [];
function run([name, file, args = []]) {
  const started = Date.now();
  const result = spawnSync(process.execPath, [path.join(HERE, file), ...args], {
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf8',
  });
  const ok = result.status === 0;
  results.push({ name, ok, ms: Date.now() - started });
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`.trimEnd();
  console.log(`\n${ok ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m'}  ${name} (${Date.now() - started}ms)`);
  if (!ok || process.env.VERBOSE) {
    if (output) console.log(output.split('\n').map((l) => `    ${l}`).join('\n'));
  }
}

console.log('\x1b[1moffline tests\x1b[0m');
for (const test of offline) {
  if (!available(test)) {
    console.log(`\n\x1b[33mSKIP\x1b[0m  ${test[0]} (fixture ${(test[2] ?? []).join(', ')} not present)`);
    continue;
  }
  run(test);
}

if (live) {
  console.log('\n\x1b[1mlive tests\x1b[0m');
  for (const test of liveTests) {
    const ctx = '/tmp/e2e_ctx.json';
    if (!fs.existsSync(ctx)) {
      console.log(`\n\x1b[33mSKIP\x1b[0m  ${test[0]} (needs ${ctx} from a prior live capture)`);
      continue;
    }
    run(test);
  }
}

const passed = results.filter((r) => r.ok).length;
const failed = results.length - passed;
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
