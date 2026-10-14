/**
 * Update checks and the update command.
 *
 * Everything here is hermetic: the registry is a fake `fetch`, the cache lives
 * in a throwaway temp directory, and `--update` spawns a fake npm. The only
 * network the real code can reach is behind `fetchImpl`, so these tests also
 * pin that the automatic notice never asks anything when it is suppressed.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
    CACHE_TTL_MS,
    CHECK_EXIT,
    NOTICE_ENV,
    NO_CHECK_ENV,
    REGISTRY_URL,
    UPDATE_COMMAND,
    cacheFilePath,
    checkForUpdate,
    compareVersions,
    defaultCacheDir,
    installKind,
    isNewer,
    noticeEnabled,
    noticeLine,
    readCache,
    runCheckUpdate,
    runUpdate,
    startUpdateNotice,
    updateRefusalLine,
    writeCache,
} from '../src/update-check.js';
import { parseOptions } from '../src/options.js';
import { usage } from '../src/help.js';
import { check, checkEqual, finish } from './_harness.mjs';

const T0 = 1_700_000_000_000;
const temps = [];
function tempDir(prefix) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    temps.push(dir);
    return dir;
}
function sink() {
    let text = '';
    return { write: (chunk) => { text += chunk; }, get text() { return text; } };
}
const okFetch = (version) => async () => ({ ok: true, status: 200, json: async () => ({ version }) });

// ---------------------------------------------------------------------------
// Version comparison stays tolerant of a leading v and of prerelease tags
// ---------------------------------------------------------------------------
{
    checkEqual('a leading v is ignored', compareVersions('v1.2.3', '1.2.3'), 0);
    checkEqual('a leading v works on both sides', compareVersions('V1.2.3', 'v1.2.3'), 0);
    check('a newer patch wins', compareVersions('1.2.4', '1.2.3') > 0);
    check('an older minor loses', compareVersions('1.1.9', '1.2.0') < 0);
    check('a missing segment reads as zero', compareVersions('1.2', '1.2.0') === 0);
    check('a release outranks its prerelease', compareVersions('1.0.0', '1.0.0-rc.1') > 0);
    check('a prerelease loses to the release', compareVersions('1.0.0-beta', '1.0.0') < 0);
    check('prerelease identifiers compare alphabetically', compareVersions('1.0.0-alpha', '1.0.0-beta') < 0);
    check('numeric prerelease identifiers compare as numbers', compareVersions('1.0.0-alpha.10', '1.0.0-alpha.2') > 0);
    check('a numeric identifier is below an alphanumeric one', compareVersions('1.0.0-1', '1.0.0-alpha') < 0);
    check('build metadata is ignored', compareVersions('1.0.0+build.5', '1.0.0') === 0);

    check('isNewer accepts the registry tag as it comes', isNewer('v0.2.0', '0.1.0') === true);
    check('isNewer is false for the same version', isNewer('0.1.0', '0.1.0') === false);
    check('isNewer is false for a prerelease of the current version', isNewer('0.1.0-rc.1', '0.1.0') === false);
}

// ---------------------------------------------------------------------------
// The cache is what keeps this to at most one request a day
// ---------------------------------------------------------------------------
{
    const dir = tempDir('dokuha-update-');
    const file = path.join(dir, 'update-check.json');
    let calls = 0;
    const countingFetch = async () => { calls++; return { ok: true, status: 200, json: async () => ({ version: '9.9.9' }) }; };

    writeCache(file, { latest: '9.9.9', now: T0 });
    const fresh = await checkForUpdate({ currentVersion: '0.1.0', file, now: T0 + 1000, fetchImpl: countingFetch });
    check('a fresh cache answers without a request', calls === 0);
    checkEqual('the fresh cache reports the cached version', fresh.latest, '9.9.9');
    checkEqual('the fresh cache reports an update', fresh.status, 'update');

    const stale = await checkForUpdate({ currentVersion: '0.1.0', file, now: T0 + CACHE_TTL_MS + 1, fetchImpl: countingFetch });
    check('a stale cache asks the registry exactly once', calls === 1);
    checkEqual('the stale result comes from the registry', stale.status, 'update');
    const rewritten = readCache(file, { now: T0 + CACHE_TTL_MS + 2 });
    check('the fetched answer is written back', rewritten.latest === '9.9.9' && rewritten.fresh);

    writeCache(file, { latest: '1.0.0', now: T0 });
    check('the cache expires exactly at the TTL', readCache(file, { now: T0 + CACHE_TTL_MS }).fresh === false);
    check('the cache is fresh one millisecond before the TTL', readCache(file, { now: T0 + CACHE_TTL_MS - 1 }).fresh === true);

    let failures = 0;
    const failing = async () => { failures++; throw new Error('offline'); };
    writeCache(file, { latest: null, now: T0 });
    const failed = await checkForUpdate({ currentVersion: '0.1.0', file, now: T0 + CACHE_TTL_MS, fetchImpl: failing });
    checkEqual('a failed check reports failure', failed.status, 'failed');
    check('a failed check keeps the error', failed.error instanceof Error);
    check('a failed check does not throw', failures === 1);
    check('a failed check still stamps the attempt so it is not retried at once',
        readCache(file, { now: T0 + CACHE_TTL_MS + 10 }).fresh === true);

    check('a non-200 answer is a failure',
        (await checkForUpdate({ currentVersion: '0.1.0', file: null, now: T0, fetchImpl: async () => ({ ok: false, status: 500 }) })).status === 'failed');
    check('an answer with no version is a failure',
        (await checkForUpdate({ currentVersion: '0.1.0', file: null, now: T0, fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({}) }) })).status === 'failed');
}

// ---------------------------------------------------------------------------
// Cache location
// ---------------------------------------------------------------------------
{
    const home = path.join(path.sep, 'tmp', 'home');
    checkEqual('the cache falls back to ~/.cache/dokuha-cli',
        defaultCacheDir({}, home), path.join(home, '.cache', 'dokuha-cli'));
    checkEqual('XDG_CACHE_HOME is honoured',
        defaultCacheDir({ XDG_CACHE_HOME: '/tmp/xdg' }, home), path.join('/tmp/xdg', 'dokuha-cli'));
    checkEqual('DOKUHA_CACHE_DIR overrides everything',
        defaultCacheDir({ DOKUHA_CACHE_DIR: '/tmp/own', XDG_CACHE_HOME: '/tmp/xdg' }, home), '/tmp/own');
    check('the cache file is named update-check.json',
        cacheFilePath({ env: { DOKUHA_CACHE_DIR: '/tmp/own' } }).endsWith('update-check.json'));
    check('the registry endpoint is the documented one',
        REGISTRY_URL === 'https://registry.npmjs.org/dokuha-cli/latest', REGISTRY_URL);
}

// ---------------------------------------------------------------------------
// Suppression: the env var, --quiet, --json and a non-terminal stderr
// ---------------------------------------------------------------------------
{
    check('the notice is on for a human at a terminal', noticeEnabled({ env: {}, isTTY: true }));
    check('--json turns it off', !noticeEnabled({ json: true, env: {}, isTTY: true }));
    check('--quiet turns it off', !noticeEnabled({ quiet: true, env: {}, isTTY: true }));
    check('a piped stderr turns it off', !noticeEnabled({ env: {}, isTTY: false }));
    check(`${NO_CHECK_ENV}=1 turns it off`, !noticeEnabled({ env: { [NO_CHECK_ENV]: '1' }, isTTY: true }));
    check(`${NO_CHECK_ENV}=true turns it off`, !noticeEnabled({ env: { [NO_CHECK_ENV]: 'true' }, isTTY: true }));
    check(`${NOTICE_ENV}=1 opts a pipe back in`, noticeEnabled({ env: { [NOTICE_ENV]: '1' }, isTTY: false }));
    check('--json still wins over the opt-in', !noticeEnabled({ json: true, env: { [NOTICE_ENV]: '1' }, isTTY: false }));

    const dir = tempDir('dokuha-update-');
    const file = path.join(dir, 'update-check.json');
    writeCache(file, { latest: '9.9.9', now: T0 });

    let suppressedFetches = 0;
    const suppressed = startUpdateNotice({
        currentVersion: '0.1.0',
        quiet: true,
        env: {},
        isTTY: true,
        now: T0,
        cacheFile: file,
        fetchImpl: async () => { suppressedFetches++; return { ok: true, json: async () => ({ version: '9.9.9' }) }; },
    });
    const lines = [];
    await suppressed.finish((line) => lines.push(line));
    check('a suppressed notice makes no request', suppressedFetches === 0);
    checkEqual('a suppressed notice prints nothing', lines.length, 0);

    let disabledFetches = 0;
    const disabled = startUpdateNotice({
        currentVersion: '0.1.0',
        env: { [NO_CHECK_ENV]: '1' },
        isTTY: true,
        now: T0,
        cacheFile: file,
        fetchImpl: async () => { disabledFetches++; return { ok: true, json: async () => ({ version: '9.9.9' }) }; },
    });
    await disabled.finish(() => {});
    check('the escape hatch makes no request', disabledFetches === 0);

    const announced = startUpdateNotice({
        currentVersion: '0.1.0',
        env: {},
        isTTY: true,
        now: T0,
        cacheFile: file,
        fetchImpl: async () => { throw new Error('should not be called, the cache is fresh'); },
    });
    const printed = [];
    const result = await announced.finish((line) => printed.push(line));
    checkEqual('an available update prints exactly one line', printed.length, 1);
    check('the line names the new version', printed[0].includes('9.9.9'));
    check('the line names the current version', printed[0].includes('0.1.0'));
    check('the line carries the single upgrade command', printed[0].includes(UPDATE_COMMAND));
    checkEqual('the line is the shared wording', printed[0], noticeLine('9.9.9', '0.1.0'));
    checkEqual('the notice reports the update', result.status, 'update');
}

// ---------------------------------------------------------------------------
// --check-update: immediate, cache-bypassing, documented exit codes
// ---------------------------------------------------------------------------
{
    const dir = tempDir('dokuha-update-');
    const upToDateFile = path.join(dir, 'up.json');
    const out = sink();
    const err = sink();
    const upToDate = await runCheckUpdate({
        currentVersion: '0.1.0', cacheFile: upToDateFile, now: T0,
        fetchImpl: okFetch('0.1.0'), out, err,
    });
    checkEqual('--check-update exits 0 when current', upToDate, CHECK_EXIT.CURRENT);
    check('--check-update says so on stdout', /up to date/.test(out.text), out.text);
    check('--check-update says nothing on stderr when current', err.text === '');

    const availableOut = sink();
    const available = await runCheckUpdate({
        currentVersion: '0.1.0', cacheFile: path.join(dir, 'avail.json'), now: T0,
        fetchImpl: okFetch('v0.2.0'), out: availableOut, err: sink(),
    });
    checkEqual('--check-update exits 1 when an update exists', available, CHECK_EXIT.UPDATE);
    check('--check-update prints the same line as the notice',
        availableOut.text.includes(noticeLine('v0.2.0', '0.1.0')));

    const failErr = sink();
    const failed = await runCheckUpdate({
        currentVersion: '0.1.0', cacheFile: path.join(dir, 'fail.json'), now: T0,
        fetchImpl: async () => { throw new Error('offline'); }, out: sink(), err: failErr,
    });
    checkEqual('--check-update exits 2 when the check fails', failed, CHECK_EXIT.FAILED);
    check('--check-update explains a failure on stderr', /not reachable/.test(failErr.text), failErr.text);

    // An explicit ask must not be answered from the day-long cache.
    const forcedFile = path.join(dir, 'forced.json');
    writeCache(forcedFile, { latest: '0.1.0', now: T0 });
    let forcedCalls = 0;
    await runCheckUpdate({
        currentVersion: '0.1.0', cacheFile: forcedFile, now: T0, out: sink(), err: sink(),
        fetchImpl: async () => { forcedCalls++; return { ok: true, status: 200, json: async () => ({ version: '0.2.0' }) }; },
    });
    check('--check-update ignores a fresh cache and asks', forcedCalls === 1);
}

// ---------------------------------------------------------------------------
// --update: only a global npm install may run the npm command
// ---------------------------------------------------------------------------
{
    const prefix = tempDir('dokuha-prefix-');
    const execPath = path.join(prefix, 'bin', 'node');
    const globalPkg = path.join(prefix, 'lib', 'node_modules', 'dokuha-cli');
    fs.mkdirSync(globalPkg, { recursive: true });
    checkEqual('a global npm install is recognised',
        installKind({ pkgRoot: globalPkg, execPath }), 'global');

    const project = tempDir('dokuha-project-');
    const localPkg = path.join(project, 'node_modules', 'dokuha-cli');
    fs.mkdirSync(localPkg, { recursive: true });
    checkEqual('a local node_modules install is refused',
        installKind({ pkgRoot: localPkg, execPath }), 'local');

    const checkout = tempDir('dokuha-checkout-');
    fs.mkdirSync(path.join(checkout, '.git'));
    checkEqual('a git checkout is refused', installKind({ pkgRoot: checkout, execPath }), 'git');

    // `npm link` puts a symlink in the global directory; the real path is the
    // checkout, and pulling that checkout is the correct upgrade, not npm -g.
    const linkPrefix = tempDir('dokuha-link-');
    const linked = path.join(linkPrefix, 'lib', 'node_modules', 'dokuha-cli');
    fs.mkdirSync(path.dirname(linked), { recursive: true });
    fs.symlinkSync(checkout, linked);
    checkEqual('an npm link to a checkout resolves to the checkout',
        installKind({ pkgRoot: linked, execPath: path.join(linkPrefix, 'bin', 'node') }), 'git');

    for (const kind of ['git', 'local']) {
        check(`${kind} refusal is one line`, updateRefusalLine(kind).split('\n').length === 1);
        check(`${kind} refusal names the command it will not run`,
            updateRefusalLine(kind).includes(UPDATE_COMMAND), updateRefusalLine(kind));
    }

    // Refusal: one line, exit 2, and npm is never spawned.
    let spawned = 0;
    const refuseOut = sink();
    const refuseErr = sink();
    const refused = await runUpdate({
        pkgRoot: checkout, execPath,
        out: refuseOut, err: refuseErr,
        spawn: () => { spawned++; return { on: () => {} }; },
    });
    checkEqual('--update refuses a git checkout with exit 2', refused, 2);
    checkEqual('--update prints nothing on stdout when refusing', refuseOut.text, '');
    check('--update refusal is a single line', refuseErr.text.trim().split('\n').length === 1);
    check('--update does not spawn npm on a checkout', spawned === 0);

    // Success: the exact command is printed before it is run.
    const record = [];
    const fakeSpawn = (code) => (command, args) => {
        record.push([command, args.join(' ')]);
        const child = {
            on(event, handler) {
                if (event === 'close') queueMicrotask(() => handler(code));
                return child;
            },
        };
        return child;
    };
    const runOut = sink();
    const ok = await runUpdate({
        pkgRoot: globalPkg, execPath,
        out: runOut, err: sink(), spawn: fakeSpawn(0),
    });
    checkEqual('--update exits 0 when npm succeeds', ok, 0);
    checkEqual('--update runs the documented npm command', record[0], ['npm', 'install -g dokuha-cli@latest']);
    checkEqual('--update prints the exact command first', runOut.text, `Running: ${UPDATE_COMMAND}\n`);

    const failedRun = await runUpdate({
        pkgRoot: globalPkg, execPath,
        out: sink(), err: sink(), spawn: fakeSpawn(1),
    });
    checkEqual('--update exits 1 when npm fails', failedRun, 1);
}

// ---------------------------------------------------------------------------
// The flag surface and the help text
// ---------------------------------------------------------------------------
{
    checkEqual('--check-update parses as a flag', parseOptions(['--check-update']).config.checkUpdate, true);
    checkEqual('--update parses as a flag', parseOptions(['--update']).config.update, true);
    const defaults = parseOptions([]).config;
    checkEqual('both are off by default', [defaults.checkUpdate, defaults.update], [false, false]);

    const help = usage();
    check('--help shows --check-update', help.includes('--check-update'));
    check('--help shows --update', help.includes('--update'));
    check('--help names the escape hatch', help.includes(NO_CHECK_ENV));
    check('--help names the non-terminal opt-in', help.includes(NOTICE_ENV));
    check('--help states the check-update exit codes', /exits 0 when this copy is/.test(help));
}

for (const dir of temps) fs.rmSync(dir, { recursive: true, force: true });
finish();
