/**
 * That the documented options actually reach the store engines.
 *
 * A flag that parses but is never passed anywhere is worse than a missing one: the
 * help text promises behaviour that does not happen. `--retries` was exactly that
 * bug until it was wired up, so it is pinned here rather than trusted to review.
 *
 * These call sites are stubbed, so nothing touches the network.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { check, checkEqual, finish } from './_harness.mjs';

const out = fs.mkdtempSync(path.join(os.tmpdir(), 'manga-dl-ctx-'));

try {
    // Every store adapter must receive the context fields the driver builds, or a
    // field silently goes missing between the two.
    const driverSource = fs.readFileSync(new URL('../src/run.js', import.meta.url), 'utf8');
    const ctxBlock = /const ctx = \{([\s\S]*?)\n    \};/.exec(driverSource);
    check('the driver builds a store context', ctxBlock !== null, 'no `const ctx = {` block in run.js');

    for (const field of ['out', 'titleDir', 'progress', 'bridge', 'config', 'userAgent', 'concurrency', 'force', 'format']) {
        check(`the context carries ${field}`,
            new RegExp(`\\b${field}[,:]`).test(ctxBlock ? ctxBlock[1] : ''), 'missing from the ctx block');
    }

    // The specific wiring for retries, named because it was the bug.
    check('the driver passes retries to the adapters',
        /retries:\s*config\.retries/.test(driverSource), 'run.js does not forward --retries');

    // The CMOA adapter must forward the budget on the request that can fail before
    // any page is fetched, which is the licence call.
    const cmoaSource = fs.readFileSync(new URL('../src/download/cmoa.js', import.meta.url), 'utf8');
    check('the CMOA adapter forwards retries to openVolume', /openVolume\(cid,\s*retryOptions\(/.test(cmoaSource));
    check('the CMOA adapter forwards retries to downloadVolume', /retryOptions/.test(cmoaSource));
    check('the CMOA scan uses the caller retry budget',
        /scanCmoaTitle\(det\.titleId,\s*config\.cmScanLimit,\s*\{\s*retries:/.test(cmoaSource),
        'scanCmoaTitle is called without a retry budget');

    // An unset budget must stay unset rather than becoming a number, so the engine's
    // own default applies instead of a second policy invented by us.
    check('an unset budget is not turned into a number',
        /ctx\?\.retries == null\)\s*return \{\}/.test(cmoaSource),
        'retryOptions does not preserve an unset budget');

    // ebookjapan defaults to the engine's 4 unless told otherwise.
    const ebjSource = fs.readFileSync(new URL('../src/download/ebookjapan.js', import.meta.url), 'utf8');
    check('the ebookjapan adapter treats null as "engine default"',
        /ctx\.retries === undefined \|\| ctx\.retries === null \? DEFAULT_RETRIES/.test(ebjSource));
    check('the ebookjapan adapter clamps a negative retry count',
        /Math\.max\(0, wanted\)/.test(ebjSource));

    // BookWalker is the exception: its sampler owns an internal retry loop, so a
    // budget passed to it would be ignored rather than honoured.
    const bwSource = fs.readFileSync(new URL('../src/download/bookwalker.js', import.meta.url), 'utf8');
    check('the BookWalker adapter does not claim to take a retry budget',
        !/ctx\.retries/.test(bwSource));

    // The option must be validated the same way as the other counts.
    const { parseOptions } = await import('../src/options.js');
    checkEqual('--retries accepts 0', parseOptions(['--retries', '0']).config.retries, 0);
    checkEqual('--retries defaults to 6', parseOptions([]).config.retries, 6);
    let negative = null;
    try { parseOptions(['--retries', '-1']); } catch (e) { negative = e; }
    check('a negative --retries is rejected', negative !== null, 'accepted a negative budget');
} finally {
    fs.rmSync(out, { recursive: true, force: true });
}

finish();
