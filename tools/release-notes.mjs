#!/usr/bin/env node
/*
 * Prints the CHANGELOG.md body for one tag, for the GitHub Release.
 *
 * Exits non-zero when there is no section, so a release cannot quietly ship with
 * empty notes: the changelog is the release body, and a missing entry means the
 * bump was not finished.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const tag = process.argv[2];
if (!tag) {
    console.error('usage: node tools/release-notes.mjs <tag>   e.g. v1.0.0');
    process.exit(2);
}

const text = fs.readFileSync(path.join(ROOT, 'CHANGELOG.md'), 'utf8');
const want = '## ' + tag + '\n';
const section = text.split(/\n(?=## )/).find(s => s.startsWith(want));
if (!section) {
    console.error('no "## ' + tag + '" section in CHANGELOG.md');
    process.exit(1);
}
const body = section.slice(want.length).trim();
if (!body) {
    console.error('CHANGELOG.md section for ' + tag + ' is empty');
    process.exit(1);
}
process.stdout.write(body + '\n');
