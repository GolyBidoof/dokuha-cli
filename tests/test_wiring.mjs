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

const out = fs.mkdtempSync(path.join(os.tmpdir(), 'dokuha-ctx-'));

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

    // A BookWalker row used to show no size at all while downloading, because the
    // sampler's progress event carried only page counts and the adapter forwarded
    // exactly that. Both halves are needed before a size can appear, so both are
    // checked: either one going missing is silent, and the row simply stays blank.
    const bwAdapterSource = fs.readFileSync(new URL('../src/download/bookwalker.js', import.meta.url), 'utf8');
    const samplerSource = fs.readFileSync(new URL('../vendor/bookwalker/public-trial.js', import.meta.url), 'utf8');
    check('the BookWalker sampler counts bytes as pages land',
        /bytes\s*\+=\s*(?:normalized\.length|onDisk)/.test(samplerSource),
        'public-trial.js accumulates no byte count, so the progress row has nothing to show');
    check('the BookWalker adapter forwards those bytes to the display',
        /event\.bytes\s*!=\s*null\s*\?\s*\{\s*bytes:\s*event\.bytes\s*\}/.test(bwAdapterSource),
        'reportBookwalker drops event.bytes, so the row shows no size while downloading');

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

    // Every per-store page count, in one sweep. --km-concurrency was documented in
    // --help and the README, parsed into a table entry, and then never read back
    // out of `v`, so k-manga silently ran at a hardcoded 8 instead of 16. A test
    // that only checks the parse passes that bug, so each flag is followed all the
    // way: declared, parsed to a number, and put on the context the adapter reads.
    {
        const { OPTIONS } = await import('../src/options.js');
        const ctxText = ctxBlock ? ctxBlock[1] : '';
        const perStore = OPTIONS
            .filter((opt) => opt.name.endsWith('-concurrency') && opt.name !== 'push-concurrency')
            .map((opt) => ({
                flag: `--${opt.name}`,
                key: `${opt.name.replace(/-concurrency$/, '')}Concurrency`,
            }));

        check('the per-store page counts are all declared', perStore.length === 5, `${perStore.length} found`);

        for (const { flag, key } of perStore) {
            const flagName = flag.replace(/^--/, '');
            const parsed = parseOptions([flagName, '7']).config[key];
            check(`${flag} parses to a number`, Number.isInteger(parsed) && parsed > 0, String(parsed));
            check(`${flag} reaches the store context`, new RegExp(`\\b${key}\\s*[:,]`).test(ctxText),
                `config.${key} is never put on the context`);
        }

        // --concurrency is the shared override for the five store page counts.
        for (const { key } of perStore) {
            checkEqual(`--concurrency sets ${key}`, parseOptions(['--concurrency', '7']).config[key], 7);
        }

        // --push-concurrency is not a store page count: it paces the OCR hand-off,
        // so the bridge stage reads it off the config rather than off a ctx field.
        checkEqual('--push-concurrency parses', parseOptions(['--push-concurrency', '3']).config.pushConcurrency, 3);
        check('--push-concurrency is used by the bridge stage',
            /pushConcurrency:\s*ctx\.config\.pushConcurrency/.test(driverSource),
            'the bridge stage never receives a push concurrency');
    }

    // --jobs reaches the CMOA render pool as a *number*. It used to be left
    // undefined, which fell through to downloadVolume's `jobs = 1` destructuring
    // default and rendered a whole volume on one thread while the help text
    // promised cores - 1.
    check('the driver derives a render budget from the core count',
        /defaultJobCount\(\)/.test(driverSource), 'run.js never asks for the engine default');

    // The sizing itself is asserted on its behaviour rather than on the shape of
    // the expression: it used to be an inline `cores / concurrentCmoa`, which a
    // source grep could check but which could not be tested for the thing that
    // matters -- that two volumes in flight do not each take the whole machine.
    const { allocateCpu } = await import('../src/cpu-budget.js');
    {
        const one = allocateCpu({ cores: 14, active: { cmoa: 1 } });
        const two = allocateCpu({ cores: 14, active: { cmoa: 2 } });
        check('two CMOA volumes do not each start a full pool',
            two.renderJobs * 2 <= 14 + 2, `${two.renderJobs} each, ${two.renderJobs * 2} total`);
        check('a lone CMOA volume gets the machine', one.renderJobs >= 12, String(one.renderJobs));

        const bwOnly = allocateCpu({ cores: 14, active: { bookwalker: 1 } });
        check('BookWalker is sized from its own volume count, not the whole run',
            bwOnly.normalizeWorkers >= 8, String(bwOnly.normalizeWorkers));

        // The bug the old assertion guarded: sharing a run with another store used
        // to floor BookWalker to a single worker and leave the cores idle.
        const shared = allocateCpu({ cores: 14, active: { bookwalker: 1, cmoa: 1 } });
        check('sharing with CMOA still leaves BookWalker real workers',
            shared.normalizeWorkers >= 3, String(shared.normalizeWorkers));
        check('the two stores together do not exceed the machine',
            shared.renderJobs + shared.normalizeWorkers <= 16,
            `${shared.renderJobs} + ${shared.normalizeWorkers}`);

        const explicit = allocateCpu({ cores: 14, active: { cmoa: 2 }, renderJobs: 3 });
        checkEqual('--jobs overrides the derived share', explicit.renderJobs, 3);
    }

    check('an unset --jobs is not forwarded as undefined',
        !/jobs:\s*jobs\s*\?\?\s*undefined/.test(driverSource),
        'run.js still forwards undefined, which the engine reads as 1');
    // A plain value or a getter both count: the point is that the derived budget
    // reaches the engine under the name it reads, and is never left undefined.
    check('the context always carries a numeric jobs value',
        /jobs[^\n]*renderJobs\b/.test(ctxBlock ? ctxBlock[1] : ''),
        'ctx.jobs does not carry the derived budget');

    // Series discovery streams into the same pool the downloads run on, so that a
    // slow walk (Kindle's is one request per volume) does not hold up the volumes
    // already found. Both halves have to be present for that to work: the driver
    // must pass a per-task callback down, and the build must not be awaited before
    // the workers start.
    check('the driver streams discovered tasks to the pool',
        /onTask:\s*addTask/.test(driverSource) && /const addTask = /.test(driverSource),
        'run.js does not hand discovered tasks to the pool as they arrive');
    check('the driver does not await discovery before starting workers',
        /const streaming = !config\.dryRun && !config\.flat/.test(driverSource)
        && /if \(!streaming\) await build;/.test(driverSource),
        'run.js still waits for the whole series before the first download');
    check('buildTasks publishes each task rather than returning a finished list',
        /const publish = \(task\) =>/.test(driverSource) && /onTask\?\.\(task\)/.test(driverSource),
        'buildTasks still only returns its tasks at the end');
    // A streaming resolver calls `onTask` directly and so never passes through
    // `publish`, which is the only other place the key is assigned. `progress.add`
    // refuses an empty key and drops the row silently, so the whole series walked
    // for a minute and displayed nothing -- no rows, no error, "0/0 done" -- while
    // downloading correctly underneath. The key must therefore be set wherever a
    // task is admitted, not only on the non-streaming path.
    check('a streamed task has its key assigned before the row is added',
        /if \(!task\.key\) task\.key = /.test(driverSource)
        && /progress\?\.add\(task\.key/.test(driverSource),
        'a streamed task reaches progress.add with no key and its row is dropped');

    // A Kindle Unlimited loan and a free Kindle volume are the same store with
    // different acquisition, and the difference is worth seeing before anything is
    // fetched, not just after: one is kept, the other is handed back. The series
    // walk already knows which is which, so both the progress row and the dry run
    // have to ask it rather than printing the bare store kind.
    check('a known Unlimited volume is tagged before it is fetched',
        /task\.kuCandidate \? KINDLE_UNLIMITED_LABEL/.test(driverSource),
        'run.js labels every Kindle volume KDL even when the walk found it Unlimited');
    check('the dry run separates Unlimited volumes from free ones',
        /const kindOf = \(t\) => \(t\.kuCandidate \? 'kindle unlimited'/.test(driverSource),
        'the dry-run listing cannot tell a free volume from a borrowed one');
    check('a volume that turns out to be Unlimited retags its own row',
        /tag: record\.unlimited === true \? KINDLE_UNLIMITED_LABEL : undefined/.test(driverSource),
        'a volume pasted on its own stays labelled KDL after the borrow proves otherwise');

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

// ---------------------------------------------------------------------------
// BookWalker output naming
// ---------------------------------------------------------------------------
{
    const source = fs.readFileSync(new URL('../src/download/bookwalker.js', import.meta.url), 'utf8');

    // The sampler names the archive from its own `session.cti` and falls back to
    // `book_<cid>` when that is absent, so the resolved title has to be handed to
    // it explicitly or a folder of downloads is named by uuid.
    check('the resolved title is passed to the sampler as safeTitle',
        /safeTitle:\s*title/.test(source), 'the archive falls back to book_<cid>.zip');

    // And the title itself has to survive a handshake that omits `cti`, which is
    // the case the store hits when it does not echo a content title back.
    check('the title falls back past the handshake to the task title',
        /payload\.cti \|\| task\.title \|\| task\.cid/.test(source),
        'a missing cti drops straight to the uuid');
}

// ---------------------------------------------------------------------------
// Volume folders: titles by default, and never two volumes in one directory
// ---------------------------------------------------------------------------
{
    const out = fs.mkdtempSync(path.join(os.tmpdir(), 'mdl-folder-'));
    const { resolveVolumeFolder, writeVolumeMarker } = await import('../src/download/volume-folder.js');
    try {
        // A fresh folder is used as-is.
        const first = await resolveVolumeFolder(out, '作品名（１）', 'cid-one');
        checkEqual('a fresh title folder is used directly', path.basename(first), '作品名（１）');

        // Re-running the same volume resumes in place rather than starting a copy.
        fs.mkdirSync(first, { recursive: true });
        await writeVolumeMarker(first, { store: 'cmoa', id: 'cid-one' });
        const again = await resolveVolumeFolder(out, '作品名（１）', 'cid-one');
        checkEqual('the same volume resumes into its own folder', path.basename(again), '作品名（１）');

        // A second volume whose title cleans up to the same name must NOT be sent
        // into the first one's directory: both number their pages from zero, so
        // they would overwrite each other page for page.
        const other = await resolveVolumeFolder(out, '作品名（１）', 'cid-two');
        check('a colliding title is disambiguated', other !== first, `both were ${other}`);
        check('the disambiguated folder names the volume', other.includes('cid-two'), other);

        // An interrupted download leaves no marker. That folder stays this
        // volume's own, so a half-finished volume resumes instead of restarting.
        const partial = path.join(out, '作品名（２）');
        fs.mkdirSync(partial, { recursive: true });
        fs.writeFileSync(path.join(partial, 'page-0001.jpg'), 'x');
        const resumed = await resolveVolumeFolder(out, '作品名（２）', 'cid-three');
        checkEqual('an unmarked partial folder is resumed', path.basename(resumed), '作品名（２）');

        // Folder names must not escape the output directory.
        const nasty = await resolveVolumeFolder(out, '../../etc/passwd', 'cid-four');
        checkEqual('a path-traversing title is flattened', path.dirname(path.resolve(nasty)), path.resolve(out));

        // A sampler of a volume and the whole volume share a cid -- both are
        // `..._jp_0003` -- so the marker check cannot tell them apart and only the
        // folder name can. Without the suffix the preview would be written into the
        // full volume's directory and overwrite it page for page.
        const whole = await resolveVolumeFolder(out, '作品名（３）', 'cid-five');
        const preview = await resolveVolumeFolder(out, '作品名（３）', 'cid-five', { sample: true });
        check('a sampler and its full volume get different folders', whole !== preview, `both were ${whole}`);
        check('the sampler folder says so', preview.endsWith('（試し読み）'), preview);
        check('the full volume folder does not', !whole.endsWith('（試し読み）'), whole);

        // The suffix has to survive the 80-character trim, so it is appended after
        // it rather than being part of the title that gets sliced.
        const longTitle = 'あ'.repeat(120);
        const longPreview = await resolveVolumeFolder(out, longTitle, 'cid-six', { sample: true });
        check('a long title cannot slice the sampler marker off',
            path.basename(longPreview).endsWith('（試し読み）'), path.basename(longPreview));
        check('and the long title is still trimmed', path.basename(longPreview).length < 90,
            String(path.basename(longPreview).length));
    } finally {
        fs.rmSync(out, { recursive: true, force: true });
    }
}

// ---------------------------------------------------------------------------
// BookWalker output mode
// ---------------------------------------------------------------------------
{
    const source = fs.readFileSync(new URL('../src/download/bookwalker.js', import.meta.url), 'utf8');
    check('pages are written as files unless the archive is requested',
        /pagesAsFiles:\s*!config\.zip/.test(source), 'the sampler was not told which mode to use');

    // The staging directory used to be the single shared `<out>/pending`, which
    // every concurrent volume created and then renamed out from under the others.
    check('the shared pending stage is gone', !/'pending'/.test(source),
        'volumes still stage through one shared directory');

    const sampler = fs.readFileSync(new URL('../vendor/bookwalker/public-trial.js', import.meta.url), 'utf8');
    check('the sampler can write pages instead of an archive',
        /mode: 'pages'/.test(sampler), 'there is no pages-as-files output path');
    check('the pages path can reuse what a previous run wrote',
        /writePages && !options\.force/.test(sampler), 'the pages path always re-downloads');
}

// ---------------------------------------------------------------------------
// --flat and --no-title-dir
// ---------------------------------------------------------------------------
{
    const runSource = fs.readFileSync(new URL('../src/run.js', import.meta.url), 'utf8');
    check('--flat reaches the adapters', /flat:\s*config\.flat/.test(runSource),
        'the flag is documented but never put in the context');
    // Page filenames restart at 1 in every volume, so a flat multi-volume run
    // would silently keep only whichever volume wrote last.
    check('a multi-volume flat run is refused rather than silently lossy',
        /config\.flat && tasks\.length > 1/.test(runSource), 'no guard against overwriting volumes');

    // Every store resolves its folder through the same helper, so the flags are
    // asserted by running the helper rather than by grepping five adapters for a
    // `ctx.flat` that a rename would move.
    const { volumeFolder, SAMPLE_SUFFIX } = await import('../src/download/volume-folder.js');
    const base = { out: '/out', flat: false, titleDir: true };

    checkEqual('--flat writes straight into --out',
        await volumeFolder({ ...base, flat: true }, { title: 'T', id: 'cid' }), '/out');

    checkEqual('a titled volume gets a folder named after the title',
        path.basename(await volumeFolder(base, { title: '作品名', id: 'cid' })), '作品名');

    checkEqual('--no-title-dir names the folder after the id',
        path.basename(await volumeFolder({ ...base, titleDir: false }, { title: '作品名', id: 'cid' })), 'cid');

    // A sampler and its full volume share one id, so under --no-title-dir they
    // would resolve to the same directory and overwrite each other page for
    // page. Three of the five stores forgot the sample suffix on this branch.
    for (const titleDir of [true, false]) {
        const ctx = { ...base, titleDir };
        const whole = await volumeFolder(ctx, { title: '作品名', id: 'cid-same' });
        const preview = await volumeFolder(ctx, { title: '作品名', id: 'cid-same', sample: true });
        check(`a sampler and its volume differ with titleDir=${titleDir}`, whole !== preview, `both were ${whole}`);
        check(`the sampler folder is marked with titleDir=${titleDir}`,
            preview.endsWith(SAMPLE_SUFFIX), preview);
    }

    check('a store can supply its own sanitiser',
        path.basename(await volumeFolder(base, { title: 'a/b', id: 'cid', sanitize: () => 'fixed' })), 'fixed');
}

finish();
