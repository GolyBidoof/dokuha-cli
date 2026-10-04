/**
 * Option parsing.
 *
 * The parser is the part users meet first, so it is tested for the failures that
 * produce bad error messages rather than for the happy path alone.
 */

import { parseOptions, OptionError, DEFAULTS } from '../src/options.js';
import { check, checkEqual, finish } from './_harness.mjs';

// Positionals and values.
{
    const { config, positionals } = parseOptions(['https://a.test/x', '--out', '/tmp/o', '--parallel', '7']);
    checkEqual('positionals are collected in order', positionals, ['https://a.test/x']);
    checkEqual('--out takes its value', config.out, '/tmp/o');
    checkEqual('--parallel is a number', config.parallel, 7);
}

// A default must not be mistaken for an explicit value: --parallel drives whether
// volumes queue, so "unset" has to stay distinguishable from "set to 1".
{
    checkEqual('--parallel defaults to null, not 1', parseOptions([]).config.parallel, null);
    checkEqual('an explicit 1 is kept', parseOptions(['--parallel', '1']).config.parallel, 1);
}

// --series is a boolean that is off unless asked for, and it is a different
// thing from --parallel. Confusing the two is the whole reason it is tested.
{
    checkEqual('--series is off by default', parseOptions([]).config.series, false);
    checkEqual('--series is a flag, not a count', parseOptions(['--series']).config.series, true);
    const both = parseOptions(['--series', '--parallel', '3']).config;
    checkEqual('--series and --parallel are independent', [both.series, both.parallel], [true, 3]);
}

// Repeated flags must survive as an array; the sampler merges them by name.
{
    const { config } = parseOptions(['--bw-cookie', 'a=1', '--bw-cookie', 'b=2']);
    checkEqual('repeated --bw-cookie is kept as a list', config.bwCookies, ['a=1', 'b=2']);
    checkEqual('absent cookies are an empty list', parseOptions([]).config.bwCookies, []);
}

// --concurrency is a convenience that sets all three stores at once.
{
    const { config } = parseOptions(['--concurrency', '64']);
    check('--concurrency sets CMOA', config.cmConcurrency === 64, String(config.cmConcurrency));
    check('--concurrency sets ebookjapan', config.ebConcurrency === 64, String(config.ebConcurrency));
    check('--concurrency sets BookWalker', config.bwConcurrency === 64, String(config.bwConcurrency));
}

// A specific flag must win over the shared one regardless of order.
{
    const after = parseOptions(['--concurrency', '64', '--eb-concurrency', '8']).config;
    const before = parseOptions(['--eb-concurrency', '8', '--concurrency', '64']).config;
    check('a specific concurrency wins when given after', after.ebConcurrency === 8, String(after.ebConcurrency));
    check('a specific concurrency wins when given before', before.ebConcurrency === 8, String(before.ebConcurrency));
}

// Defaults are the documented numbers.
{
    const { config } = parseOptions([]);
    checkEqual('CMOA concurrency default', config.cmConcurrency, DEFAULTS.cmConcurrency);
    checkEqual('an explicit --cm-concurrency still wins',
        parseOptions(['--cm-concurrency', '20']).config.cmConcurrency, 20);
    checkEqual('ebookjapan concurrency default', config.ebConcurrency, DEFAULTS.ebConcurrency);
    checkEqual('BookWalker concurrency default', config.bwConcurrency, DEFAULTS.bwConcurrency);
    checkEqual('format default', config.format, DEFAULTS.format);
    checkEqual('ocr-wait default is seconds', config.ocrWaitSeconds, DEFAULTS.ocrWaitSeconds);
}

// Bad input must raise OptionError, because the CLI turns that into usage text
// plus exit 2 rather than a stack trace.
{
    let unknown = null;
    try { parseOptions(['--definitely-not-a-flag']); } catch (e) { unknown = e; }
    check('an unknown flag raises OptionError', unknown instanceof OptionError, String(unknown));
    check('the unknown-flag message is lowercase and quoted', /unknown option '--definitely-not-a-flag'/.test(unknown?.message || ''), unknown?.message);

    let badNumber = null;
    try { parseOptions(['--parallel', 'abc']); } catch (e) { badNumber = e; }
    check('a non-numeric count raises OptionError', badNumber instanceof OptionError);
    check('the bad-number message names the flag', /--parallel/.test(badNumber?.message || ''), badNumber?.message);

    let zero = null;
    try { parseOptions(['--parallel', '0']); } catch (e) { zero = e; }
    check('zero is rejected for a count', zero instanceof OptionError, String(zero));

    let missing = null;
    try { parseOptions(['--out']); } catch (e) { missing = e; }
    check('a value flag with no value raises OptionError', missing instanceof OptionError, String(missing));

    // --retries is the one count where zero is meaningful.
    checkEqual('--retries accepts 0', parseOptions(['--retries', '0']).config.retries, 0);
}

// A value flag followed by another flag must be an error, not a silent
// misparse: `--out --mokuro` would otherwise create a directory literally named
// "--mokuro". The wording is checked too, because parseArgs calls this
// "ambiguous", which reads like a contradiction rather than a missing value.
{
    let ambiguous = null;
    try { parseOptions(['--out', '--mokuro', 'https://a.test/x']); } catch (e) { ambiguous = e; }
    check('a flag is not swallowed as the previous value', ambiguous instanceof OptionError, String(ambiguous));
    check('the message says the value is missing, not "ambiguous"',
        /needs a value/.test(ambiguous?.message || ''), ambiguous?.message);
}

// The positional still works when the flags are well formed.
{
    const { config, positionals } = parseOptions(['--mokuro', '--out', '/tmp/o', 'https://a.test/x']);
    check('flags before positionals parse', config.mokuro === true);
    checkEqual('the URL stays positional', positionals, ['https://a.test/x']);
}

// Determinism: parsing twice must not share or mutate state, which is what the
// import-time parsing in the original single-file version made impossible.
{
    const first = parseOptions(['--out', '/tmp/one', '--json']).config;
    const second = parseOptions(['--out', '/tmp/two']).config;
    checkEqual('a second parse is independent', [first.out, second.out, second.json], ['/tmp/one', '/tmp/two', false]);
}

// ---------------------------------------------------------------------------
// Output shape: title folders by default, archive on request
// ---------------------------------------------------------------------------
{
    // Folders are named after the volume now. The cid is still reachable, but it
    // is the opt-out rather than the default, because a folder called
    // `00000004-0000-4000-8000-000000000004` tells a human nothing.
    checkEqual('title folders are the default', parseOptions([]).config.titleDir, true);
    checkEqual('--title-dir is still accepted as the default', parseOptions(['--title-dir']).config.titleDir, true);
    checkEqual('--no-title-dir opts back out to the content id',
        parseOptions(['--no-title-dir']).config.titleDir, false);

    // BookWalker collects pages into an archive only when asked.
    checkEqual('the archive is off by default', parseOptions([]).config.zip, false);
    checkEqual('--zip turns the archive on', parseOptions(['--zip']).config.zip, true);
}

// ---------------------------------------------------------------------------
// Kindle: the one store that cannot work anonymously
// ---------------------------------------------------------------------------
{
    // The cookie flag takes every shape --bw-cookie does, so it must survive as a
    // list and be merged by the same reader rather than parsed here.
    const { config } = parseOptions(['--kindle-cookie', 'session-id=a', '--kindle-cookie', 'at-acbjp=b']);
    checkEqual('repeated --kindle-cookie is kept as a list', config.kindleCookies, ['session-id=a', 'at-acbjp=b']);
    checkEqual('absent Kindle cookies are an empty list', parseOptions([]).config.kindleCookies, []);

    checkEqual('--kindle-state names the session file',
        parseOptions(['--kindle-state', '/tmp/k.json']).config.kindleState, '/tmp/k.json');
    checkEqual('the session file is unset by default', parseOptions([]).config.kindleState, null);
    // A single flag has to mean "do not touch my session file" for both account
    // stores, or it means different things depending on which URL is pasted.
    checkEqual('--no-state disables the Kindle session too',
        parseOptions(['--no-state']).config.kindleNoState, true);
    checkEqual('--no-state still disables the BookWalker session',
        parseOptions(['--no-state']).config.bwNoState, true);

    checkEqual('Kindle pages in flight has its own default',
        parseOptions([]).config.kdlConcurrency, DEFAULTS.kdlConcurrency);
    checkEqual('--kdl-concurrency overrides it',
        parseOptions(['--kdl-concurrency', '4']).config.kdlConcurrency, 4);
    checkEqual('--kdl-concurrency follows the shared --concurrency',
        parseOptions(['--concurrency', '6']).config.kdlConcurrency, 6);
    checkEqual('a specific Kindle concurrency wins over the shared one',
        parseOptions(['--concurrency', '6', '--kdl-concurrency', '2']).config.kdlConcurrency, 2);

    checkEqual('the series walk is capped by default',
        parseOptions([]).config.kindleMaxVolumes, null);
    checkEqual('--kindle-max-volumes sets the cap',
        parseOptions(['--kindle-max-volumes', '10']).config.kindleMaxVolumes, 10);
}

finish();
