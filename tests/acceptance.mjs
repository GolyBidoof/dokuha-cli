#!/usr/bin/env node
/*
 * Acceptance entry point for this repo.
 *
 * The harness lives in the userscript repo (`tests/acceptance/run.js`) because
 * that is where the oracle, the discovery code and the headless driver live, and
 * because the CLI is only one half of the check: the interesting question is
 * whether the CLI and the userscript, two independent implementations of the
 * same store protocols, agree on the pixels.
 *
 * So this wrapper finds a userscript checkout and runs that harness with
 * `--cli <this repo>`. It deliberately does not reimplement discovery -- a second
 * copy would drift.
 *
 *   npm run test:acceptance
 *   npm run test:acceptance -- --stores cmoa --keep
 *   BWDD_ACCEPTANCE_US=/path/to/userscript npm run test:acceptance
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const cliRoot = path.resolve(here, '..');

const candidates = [
    process.env.BWDD_ACCEPTANCE_US,
    path.resolve(cliRoot, '..', 'bookwalker-native-downloader'),
    path.resolve(cliRoot, '..', 'us'),
].filter(Boolean);

const usRoot = candidates.find(p => fs.existsSync(path.join(p, 'tests', 'acceptance', 'run.js')));
if (!usRoot) {
    console.error('No userscript checkout found. Tried:');
    for (const c of candidates) console.error('  ' + c);
    console.error('\nSet BWDD_ACCEPTANCE_US to the userscript repo path.');
    process.exit(2);
}

const runner = path.join(usRoot, 'tests', 'acceptance', 'run.js');
const args = [runner, '--cli', cliRoot, ...process.argv.slice(2)];
console.log(`using harness ${path.relative(cliRoot, runner) || runner}`);
const r = spawnSync(process.execPath, args, { stdio: 'inherit' });
process.exit(r.status === null ? 1 : r.status);
