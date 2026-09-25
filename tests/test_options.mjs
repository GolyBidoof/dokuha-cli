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
    const { config, positionals } = parseOptions(['https://a.test/x', '--out', '/tmp/o', '--series', '7']);
    checkEqual('positionals are collected in order', positionals, ['https://a.test/x']);
    checkEqual('--out takes its value', config.out, '/tmp/o');
    checkEqual('--series is a number', config.series, 7);
}

// A default must not be mistaken for an explicit value: --series drives whether
// volumes queue, so "unset" has to stay distinguishable from "set to 1".
{
    checkEqual('--series defaults to null, not 1', parseOptions([]).config.series, null);
    checkEqual('an explicit 1 is kept', parseOptions(['--series', '1']).config.series, 1);
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
    try { parseOptions(['--series', 'abc']); } catch (e) { badNumber = e; }
    check('a non-numeric count raises OptionError', badNumber instanceof OptionError);
    check('the bad-number message names the flag', /--series/.test(badNumber?.message || ''), badNumber?.message);

    let zero = null;
    try { parseOptions(['--series', '0']); } catch (e) { zero = e; }
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

finish();
