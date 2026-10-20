#!/usr/bin/env node
/**
 * One volume per store, with the phase breakdown a normal run reports.
 *
 * This is the audit's §3 table, reproduced from the shipped CLI rather than from a
 * throwaway harness: it runs `bin/dokuha.mjs --json` per store and prints what each
 * adapter attributed to `handshake`, `prework`, `fetch`, `rebuild` and `write`.
 *
 *   node tools/bench-phases.mjs                 # every store with a URL set below
 *   node tools/bench-phases.mjs cmoa bookwalker # a subset
 *   node tools/bench-phases.mjs --no-descramble # keep the scrambled mosaic
 *
 * DMMブックス viewer URLs carry a short-lived `cid`, so its STORES entry is a
 * placeholder to paste a live URL into before a DMM run.
 *
 * Read `docs/performance.md` before quoting a number from this: the phases do
 * not all mean the same thing, and two of them are aggregates rather than wall time.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const BIN = path.join(ROOT, 'bin', 'dokuha.mjs');

// One free volume per store, of the title the audit used throughout.
const STORES = {
    cmoa: 'https://www.cmoa.jp/title/249001/',
    ebookjapan: 'https://ebookjapan.yahoo.co.jp/books/716241/A007056462/',
    bookwalker: 'https://bookwalker.jp/def5a49973-58a0-44b0-a6ce-41abdc306335/',
    kmanga: 'https://comic.k-manga.jp/title/167001/pv',
    kindle: 'https://www.amazon.co.jp/dp/B000000001/',
    // DMM viewer URLs carry a short-lived cid; paste a live free-viewer URL here
    // before a DMM run. The placeholder is skipped with a note otherwise.
    dmm: 'https://book.dmm.com/product/000000/aaaaaaaaaaaa/free_streaming/?cid=REPLACE_WITH_FRESH_CID',
};

const argv = process.argv.slice(2);
const flags = argv.filter((a) => a.startsWith('--'));
const wanted = argv.filter((a) => !a.startsWith('--'));
const names = (wanted.length ? wanted : Object.keys(STORES)).filter((n) => n in STORES);

if (!names.length) {
    process.stderr.write(`unknown store; pick from ${Object.keys(STORES).join(', ')}\n`);
    process.exit(2);
}

const out = fs.mkdtempSync(path.join(os.tmpdir(), 'dokuha-phases-'));

function run(url) {
    return new Promise((resolve) => {
        const child = spawn(process.execPath, [
            BIN, url, '--out', out, '--json', '--no-progress', '--force', ...flags,
        ], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', (d) => { stdout += d; });
        child.stderr.on('data', (d) => { stderr += d; });
        child.on('close', () => {
            try {
                resolve({ record: JSON.parse(stdout).results?.[0] ?? null, stderr });
            } catch {
                resolve({ record: null, stderr });
            }
        });
    });
}

const rows = [];
for (const name of names) {
    const url = STORES[name];
    if (url.includes('REPLACE_WITH_FRESH_CID')) {
        process.stderr.write(`${name}: paste a live free-viewer URL into STORES.dmm first\n`);
        continue;
    }
    process.stderr.write(`${name}: downloading one volume...\n`);
    const { record, stderr } = await run(url);
    if (!record) {
        process.stderr.write(`${name}: no result (${stderr.trim().split('\n').pop() || 'no output'})\n`);
        continue;
    }
    rows.push({ name, record });
}

const PHASES = ['handshake', 'prework', 'fetch', 'rebuild', 'write'];
const secs = (ms) => (ms === undefined ? '-' : (ms / 1000).toFixed(2));

process.stdout.write('\n');
process.stdout.write(`store        pages   ok    wall     ${PHASES.map((p) => p.padStart(9)).join('')}\n`);
process.stdout.write(`${'-'.repeat(72)}\n`);
for (const { name, record } of rows) {
    const phases = record.phases || {};
    process.stdout.write(
        `${name.padEnd(12)} ${String(record.downloaded ?? '-').padStart(5)}   `
        + `${record.ok ? 'yes' : 'NO '}  ${secs((record.seconds || 0) * 1000).padStart(6)}   `
        + PHASES.map((p) => secs(phases[p]).padStart(9)).join('')
        + '\n',
    );
}
process.stdout.write('\nA phase is blank when that store cannot measure it; see docs/performance.md.\n');
process.stdout.write(`Pages were written to ${out}\n`);
