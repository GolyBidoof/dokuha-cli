/**
 * Every module loads, and every shared helper a module calls is imported into it.
 *
 * `node --check` proves a file parses; it does not prove an identifier resolves. A
 * missing import for `timed` sat in the CMOA adapter through a green test suite and
 * a clean syntax pass, and only surfaced on a live run -- because the reference is
 * inside a function body, so nothing evaluates it until a download happens.
 *
 * Loading each module catches a wrong import path. The second half catches the
 * other case: a helper that is called but never imported, which no amount of
 * loading will reveal.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { check, checkEqual, finish } from './_harness.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const SRC = path.join(ROOT, 'src');

function modulesIn(dir) {
    const found = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) found.push(...modulesIn(full));
        else if (entry.name.endsWith('.js')) found.push(full);
    }
    return found;
}

// A worker entry point talks to `parentPort` at module scope, so it cannot be
// imported into the main thread. Its helpers are still checked below.
const WORKER_ENTRY = path.join('src', 'workers') + path.sep;
const modules = modulesIn(SRC).sort();
check('the source tree is where it is expected', modules.length > 10, `${modules.length} modules`);

for (const file of modules) {
    const rel = path.relative(ROOT, file);
    if (file.includes(WORKER_ENTRY)) continue;
    let loaded = null;
    let failure = null;
    try {
        loaded = await import(pathToFileURL(file).href);
    } catch (error) {
        failure = error;
    }
    check(`${rel} loads`, failure === null, failure ? `${failure.message}` : '');
    if (failure) continue;
    check(`${rel} exports something`, loaded !== null && typeof loaded === 'object');
}

// A helper called but not imported throws only when that line runs, which for an
// adapter means during a download. Anything shared across modules is checked here.
const SHARED = [
    // cross-module helpers this project added
    'timed', 'normalizeStoreResult', 'createPhaseTimer', 'readPhases',
    'writeVolumeMarker', 'resolveVolumeFolder', 'pageFileName',
    'allocateCpu', 'createPool', 'retry', 'describeError',
    // the presentation helpers, which moved to ansi.js and are easy to forget
    'useColor', 'humanBytes', 'humanTime', 'displayWidth', 'padTo', 'clampLine', 'truncate',
];

for (const file of modules) {
    const source = fs.readFileSync(file, 'utf8');
    const rel = path.relative(ROOT, file);
    for (const helper of SHARED) {
        const called = new RegExp(`(?<![\\w.$])${helper}\\s*\\(`).test(source);
        if (!called) continue;
        const imported = new RegExp(`import[^;]*\\b${helper}\\b[^;]*from`, 's').test(source);
        const declared = new RegExp(`(?:function|const|let|class)\\s+${helper}\\b`).test(source);
        check(`${rel} has ${helper} in scope`, imported || declared,
            `calls ${helper}() but neither imports nor declares it`);
    }
}

checkEqual('the five adapters are all present',
    modules.filter((f) => f.includes(`${path.sep}download${path.sep}`)).length >= 5, true);

finish();
