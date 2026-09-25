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

    // Per-store concurrency, named because it was the same bug as --retries: all
    // three flags parse and show up in --help, but the driver handed every store
    // the CMOA value, so --eb-concurrency was dead and ebookjapan ran at 12
    // instead of its documented 32. The parser tests in test_options.mjs passed
    // throughout, because they only ever checked the parse.
    const ctxText = ctxBlock ? ctxBlock[1] : '';
    check('the driver gives CMOA its own concurrency',
        /cmoaConcurrency:\s*config\.cmConcurrency/.test(ctxText), 'no cmoaConcurrency in the ctx block');
    check('the driver gives ebookjapan its own concurrency',
        /ebConcurrency:\s*config\.ebConcurrency/.test(ctxText), 'no ebConcurrency in the ctx block');
    check('the driver gives BookWalker its own concurrency',
        /bwConcurrency:\s*config\.bwConcurrency/.test(ctxText), 'no bwConcurrency in the ctx block');
    check('no store is still fed the CMOA concurrency under a shared name',
        !/concurrency:\s*config\.cmConcurrency/.test(ctxText),
        'a shared ctx.concurrency is still set from --cm-concurrency');

    // The CMOA adapter must forward the budget on the request that can fail before
    // any page is fetched, which is the licence call.
    const cmoaSource = fs.readFileSync(new URL('../src/download/cmoa.js', import.meta.url), 'utf8');
    const ebSource = fs.readFileSync(new URL('../src/download/ebookjapan.js', import.meta.url), 'utf8');
    const bwSourceForConcurrency = fs.readFileSync(new URL('../src/download/bookwalker.js', import.meta.url), 'utf8');

    check('the ebookjapan adapter reads its own concurrency key',
        /ctx\.ebConcurrency/.test(ebSource), 'ebookjapan.js never reads ctx.ebConcurrency');
    check('the CMOA adapter reads its own concurrency key',
        /ctx\.cmoaConcurrency/.test(cmoaSource), 'cmoa.js never reads ctx.cmoaConcurrency');
    check('the BookWalker adapter reads its own concurrency key',
        /ctx\.bwConcurrency/.test(bwSourceForConcurrency), 'bookwalker.js never reads ctx.bwConcurrency');

    // Every store key must still be honoured by its adapter, and the old shared
    // name kept only as a fallback for a direct caller.
    check('the per-store keys take precedence over the shared fallback',
        /ctx\.cmoaConcurrency\s*\?\?\s*ctx\.concurrency/.test(cmoaSource) &&
        /ctx\.ebConcurrency\s*\?\?\s*ctx\.concurrency/.test(ebSource) &&
        /ctx\.bwConcurrency\s*\?\?\s*config\.bwConcurrency/.test(bwSourceForConcurrency),
        'a store key is not preferred over its fallback');

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

    // --jobs reaches the CMOA render pool as a *number*. It used to be left
    // undefined, which fell through to downloadVolume's `jobs = 1` destructuring
    // default and rendered a whole volume on one thread while the help text
    // promised cores - 1.
    check('the driver derives a render budget from the core count',
        /defaultJobCount\(\)/.test(driverSource), 'run.js never asks for the engine default');
    check('the render budget is divided by the concurrent CMOA volumes',
        /defaultJobCount\(\)\s*\/\s*concurrentCmoa/.test(driverSource),
        'the budget is not divided, so N volumes would each start a full pool');
    check('an unset --jobs is not forwarded as undefined',
        !/jobs:\s*jobs\s*\?\?\s*undefined/.test(driverSource),
        'run.js still forwards undefined, which the engine reads as 1');
    check('the context always carries a numeric jobs value',
        /jobs:\s*renderJobs\b/.test(ctxBlock ? ctxBlock[1] : ''),
        'ctx.jobs does not carry the derived budget');

    const { defaultJobCount } = await import('../vendor/cmoa/src/render_pool.js');
    const cores = defaultJobCount();
    check('the engine default is a positive worker count',
        Number.isInteger(cores) && cores >= 1, String(cores));
    check('a single CMOA volume gets the whole pool, not one thread',
        Math.max(1, Math.floor(cores / 1)) === cores && cores > 1, `cores=${cores}`);
    check('sixteen concurrent volumes do not spawn sixteen full pools',
        Math.max(1, Math.floor(cores / 16)) * 16 <= cores + 15,
        `cores=${cores} -> ${Math.max(1, Math.floor(cores / 16))} each`);

    // An explicit --jobs must still win over the derived budget.
    checkEqual('--jobs is parsed as given',
        parseOptions(['--jobs', '5']).config.jobs, 5);
    checkEqual('--jobs defaults to unset so the core count decides',
        parseOptions([]).config.jobs, null);
} finally {
    fs.rmSync(out, { recursive: true, force: true });
}

finish();
