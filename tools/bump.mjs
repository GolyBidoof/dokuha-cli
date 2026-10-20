#!/usr/bin/env node
/*
 * Version bump.
 *
 * The version has one source of truth: the "version" field in package.json,
 * which is what npm publishes, what `dokuha --version` prints and what the
 * publish workflow checks a tag against. This script also keeps the version in
 * the README title in step, because the README is the first thing a user sees.
 *
 *   node tools/bump.mjs patch        1.0.0 -> 1.0.1
 *   node tools/bump.mjs minor        1.0.0 -> 1.1.0
 *   node tools/bump.mjs major        1.0.0 -> 2.0.0
 *   node tools/bump.mjs 1.1.2        an explicit version
 *   node tools/bump.mjs --dry-run patch
 *
 * CHANGELOG.md is deliberately not touched: its "## vX.Y.Z" headings are
 * history, and the release notes come from the section you write there. The
 * script prints the reminder instead.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const README = path.join(ROOT, 'README.md');
const PKG = path.join(ROOT, 'package.json');
const SEMVER = /^[0-9]+\.[0-9]+\.[0-9]+$/;

function currentVersion() {
    return JSON.parse(fs.readFileSync(PKG, 'utf8')).version;
}

function nextVersion(cur, how) {
    if (SEMVER.test(how)) return how;
    const [maj, min, pat] = cur.split('.').map(Number);
    if (how === 'major') return (maj + 1) + '.0.0';
    if (how === 'minor') return maj + '.' + (min + 1) + '.0';
    if (how === 'patch') return maj + '.' + min + '.' + (pat + 1);
    throw new Error('expected patch|minor|major or an explicit x.y.z, got: ' + JSON.stringify(how));
}

function replaceIn(file, re, make, what) {
    const before = fs.readFileSync(file, 'utf8');
    if (!before.match(re)) throw new Error('could not find ' + what + ' in ' + path.relative(ROOT, file));
    const after = before.replace(re, make);
    if (after === before) throw new Error(what + ' did not change in ' + path.relative(ROOT, file));
    return { file, before, after, what };
}

function main() {
    const args = process.argv.slice(2);
    const dry = args.includes('--dry-run');
    const how = args.filter(a => !a.startsWith('--'))[0];
    if (!how) {
        console.error('usage: node tools/bump.mjs <patch|minor|major|x.y.z> [--dry-run]');
        process.exit(2);
    }
    const cur = currentVersion();
    const next = nextVersion(cur, how);
    if (next === cur) {
        console.error('version is already ' + cur + '; nothing to do');
        process.exit(1);
    }

    const edits = [
        replaceIn(PKG, /"version":\s*"[0-9]+\.[0-9]+\.[0-9]+"/,
            '"version": "' + next + '"', 'the package version'),
        replaceIn(README, new RegExp('· v' + cur.replace(/\./g, '\\.')),
            '· v' + next, 'the version in the title'),
    ];

    console.log('version  ' + cur + ' -> ' + next + (dry ? '   (dry run, nothing written)' : ''));
    for (const e of edits) console.log('  ' + path.relative(ROOT, e.file).padEnd(26) + ' ' + e.what);
    if (dry) return;
    for (const e of edits) fs.writeFileSync(e.file, e.after);

    console.log('\nNext:');
    console.log('  1. add the "## v' + next + '" section to CHANGELOG.md');
    console.log('  2. npm test');
    console.log('  3. git add -A && git commit -m "Release v' + next + '"');
    console.log('  4. git tag v' + next + ' && git push origin main --tags');
    console.log('\nPushing the tag publishes to npm and creates the GitHub Release; see RELEASING.md.');
}

main();
