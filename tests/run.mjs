/**
 * Test runner.
 *
 * Every `tests/test_*.mjs` file runs in its own process, so a crash or a stuck
 * await in one cannot take the suite with it. A file passes when it exits 0 and
 * printed the harness's summary line. Tests that need the network or a live
 * mokuro-bridge are skipped unless explicitly enabled, so `npm test` stays fast
 * and works offline.
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FILTER = process.argv[2] || '';
const PER_FILE_TIMEOUT_MS = 120_000;

/** Tests that require the network, opt in with MANGA_DL_TEST_NETWORK=1. */
const NETWORK_TESTS = new Set(['test_network.mjs']);

function testFiles() {
    return fs.readdirSync(HERE)
        .filter((f) => /^test_.*\.mjs$/.test(f))
        .filter((f) => !FILTER || f.includes(FILTER))
        .sort();
}

/** Run one test file, resolving to `{ ok, detail }`. */
function runFile(file) {
    return new Promise((resolve) => {
        const child = spawn(process.execPath, [path.join(HERE, file)], {
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', (c) => { stdout += c; });
        child.stderr.on('data', (c) => { stderr += c; });

        const timer = setTimeout(() => {
            child.kill('SIGKILL');
            resolve({ ok: false, detail: `timed out after ${PER_FILE_TIMEOUT_MS / 1000}s` });
        }, PER_FILE_TIMEOUT_MS);

        child.on('error', (error) => {
            clearTimeout(timer);
            resolve({ ok: false, detail: error.message });
        });
        child.on('close', (code) => {
            clearTimeout(timer);
            if (code === 0 && /ALL \d+ CHECKS PASSED/.test(stdout)) {
                resolve({ ok: true, detail: stdout.match(/ALL (\d+) CHECKS PASSED/)[1] + ' checks' });
                return;
            }
            const why = (stderr.trim().split('\n').slice(-3).join(' / ') || stdout.trim().slice(-200) || `exit ${code}`);
            resolve({ ok: false, detail: why });
        });
    });
}

const networkEnabled = process.env.MANGA_DL_TEST_NETWORK === '1';
const files = testFiles();
let failed = 0;
let skipped = 0;

for (const file of files) {
    if (NETWORK_TESTS.has(file) && !networkEnabled) {
        skipped++;
        process.stdout.write(`SKIP  ${file}  (set MANGA_DL_TEST_NETWORK=1 to run)\n`);
        continue;
    }
    const result = await runFile(file);
    if (result.ok) {
        process.stdout.write(`PASS  ${file}  (${result.detail})\n`);
    } else {
        failed++;
        process.stdout.write(`FAIL  ${file}  ${result.detail}\n`);
    }
}

const ran = files.length - skipped;
process.stdout.write(`\n${ran - failed}/${ran} test files passed${skipped ? `, ${skipped} skipped` : ''}\n`);
if (failed > 0) process.exit(1);
if (ran === 0) {
    process.stderr.write('no test files matched\n');
    process.exit(1);
}
// A filter that matched only skipped files should not look like success.
process.exit(0);
