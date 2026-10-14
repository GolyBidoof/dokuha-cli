
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn as nodeSpawn } from 'node:child_process';

/**
 * Update checks are deliberately boring.
 *
 * One cached npm registry request a day, one line of output, and a way to turn
 * the whole thing off. Nothing here may ever delay a download, so the check is
 * started before the run and read after it with a short bound; every network
 * failure is silent, and the cache file is best effort.
 */

export const PACKAGE_NAME = 'dokuha-cli';
export const REGISTRY_URL = `https://registry.npmjs.org/${PACKAGE_NAME}/latest`;
export const UPDATE_COMMAND = `npm install -g ${PACKAGE_NAME}@latest`;
export const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

export const NO_CHECK_ENV = 'DOKUHA_NO_UPDATE_CHECK';
export const NOTICE_ENV = 'DOKUHA_UPDATE_NOTICE';
export const CACHE_DIR_ENV = 'DOKUHA_CACHE_DIR';

const TRUTHY = /^(1|true|yes|on)$/i;

function truthy(value) {
    return TRUTHY.test(String(value ?? ''));
}


/**
 * Parse a version the way semver does, minus the strictness: a leading `v` is
 * allowed, and build metadata after `+` is ignored. A prerelease is everything
 * after the first `-`, so `1.2.3-rc.1` sorts below `1.2.3`.
 */
function parseVersion(value) {
    const raw = String(value ?? '').trim().replace(/^[vV]/, '');
    const [core, ...prerelease] = raw.split('+')[0].split('-');
    const numbers = core.split('.').map((part) => {
        const n = Number.parseInt(part, 10);
        return Number.isFinite(n) ? n : 0;
    });
    return { numbers, prerelease: prerelease.join('-') };
}

function comparePrerelease(a, b) {
    if (a === b) return 0;
    // A release outranks any prerelease of the same core version.
    if (a === '') return 1;
    if (b === '') return -1;
    const left = a.split('.');
    const right = b.split('.');
    const width = Math.max(left.length, right.length);
    for (let i = 0; i < width; i++) {
        const x = left[i];
        const y = right[i];
        if (x === undefined) return -1;
        if (y === undefined) return 1;
        const xNumeric = /^\d+$/.test(x);
        const yNumeric = /^\d+$/.test(y);
        if (xNumeric && yNumeric) {
            const diff = Number(x) - Number(y);
            if (diff !== 0) return diff < 0 ? -1 : 1;
        } else if (xNumeric) {
            return -1;
        } else if (yNumeric) {
            return 1;
        } else if (x !== y) {
            return x < y ? -1 : 1;
        }
    }
    return 0;
}

/** Compare two versions, returning -1, 0 or 1. Tolerant of `v` and prereleases. */
export function compareVersions(a, b) {
    const left = parseVersion(a);
    const right = parseVersion(b);
    const width = Math.max(left.numbers.length, right.numbers.length, 3);
    for (let i = 0; i < width; i++) {
        const x = left.numbers[i] ?? 0;
        const y = right.numbers[i] ?? 0;
        if (x !== y) return x < y ? -1 : 1;
    }
    return comparePrerelease(left.prerelease, right.prerelease);
}

export function isNewer(candidate, current) {
    return compareVersions(candidate, current) > 0;
}


/** Where the answer is remembered. `DOKUHA_CACHE_DIR` exists for tests. */
export function defaultCacheDir(env = process.env, home = os.homedir()) {
    if (env[CACHE_DIR_ENV]) return env[CACHE_DIR_ENV];
    if (env.XDG_CACHE_HOME) return path.join(env.XDG_CACHE_HOME, PACKAGE_NAME);
    return path.join(home, '.cache', PACKAGE_NAME);
}

export function cacheFilePath({ env = process.env, home = os.homedir() } = {}) {
    return path.join(defaultCacheDir(env, home), 'update-check.json');
}

/**
 * Read the cached answer. `fresh` means it is young enough that no request is
 * due; the TTL is what keeps this to at most one request a day.
 */
export function readCache(file, { now = Date.now(), ttl = CACHE_TTL_MS } = {}) {
    let parsed;
    try {
        parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
        return null;
    }
    if (!parsed || typeof parsed !== 'object') return null;
    const latest = typeof parsed.latest === 'string' ? parsed.latest : null;
    const checkedAt = Number(parsed.checkedAt);
    const known = Number.isFinite(checkedAt);
    return {
        latest,
        checkedAt: known ? checkedAt : null,
        fresh: known && now - checkedAt < ttl,
    };
}

/** Write the cache. A cache that cannot be written is not worth an error. */
export function writeCache(file, { latest = null, now = Date.now() } = {}) {
    try {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, `${JSON.stringify({ checkedAt: now, latest }, null, 2)}\n`);
    } catch {
        // Ignore: the next run simply checks again.
    }
}


export async function fetchLatestVersion({ fetchImpl = globalThis.fetch, signal, url = REGISTRY_URL } = {}) {
    const response = await fetchImpl(url, { signal, headers: { accept: 'application/json' } });
    if (!response || !response.ok) throw new Error(`the registry answered ${response?.status ?? 'nothing'}`);
    const body = await response.json();
    const version = body && typeof body.version === 'string' ? body.version : null;
    if (!version) throw new Error('the registry returned no version');
    return version;
}

/**
 * Resolve whether a newer release exists. A fresh cache is served without a
 * request; an explicit `force` (used by `--check-update`) always asks. Fetch
 * failures never throw: they come back as `failed`, which callers keep quiet.
 */
export async function checkForUpdate({
    currentVersion,
    file,
    now = Date.now(),
    ttl = CACHE_TTL_MS,
    force = false,
    fetchImpl,
    signal,
    url,
} = {}) {
    const cached = file ? readCache(file, { now, ttl }) : null;
    if (!force && cached?.fresh) {
        const newer = Boolean(cached.latest) && isNewer(cached.latest, currentVersion);
        return { status: newer ? 'update' : 'current', latest: cached.latest, cached: true };
    }

    try {
        const latest = await fetchLatestVersion({ fetchImpl, signal, url });
        if (file) writeCache(file, { latest, now });
        return { status: isNewer(latest, currentVersion) ? 'update' : 'current', latest, cached: false };
    } catch (error) {
        // Record the attempt so a failure does not turn into a request per run.
        if (file) writeCache(file, { latest: cached?.latest ?? null, now });
        return { status: 'failed', latest: null, cached: false, error };
    }
}


/**
 * The automatic notice is for a human at a terminal. `--json` and `--quiet` are
 * promises about output, so it stays off there; a pipe means a script may be
 * parsing stderr, so it stays off unless `DOKUHA_UPDATE_NOTICE=1` opts back in.
 */
export function noticeEnabled({ json = false, quiet = false, env = process.env, isTTY = process.stderr.isTTY } = {}) {
    if (truthy(env[NO_CHECK_ENV])) return false;
    if (json || quiet) return false;
    if (!isTTY && !truthy(env[NOTICE_ENV])) return false;
    return true;
}

export function noticeLine(latest, currentVersion) {
    return `${PACKAGE_NAME} ${latest} is available (running ${currentVersion}); update with: ${UPDATE_COMMAND}`;
}

export function upToDateLine(currentVersion) {
    return `${PACKAGE_NAME} ${currentVersion} is up to date`;
}

function withTimeout(promise, ms) {
    if (!(ms > 0)) return promise;
    return new Promise((resolve) => {
        const timer = setTimeout(() => resolve(null), ms);
        if (typeof timer.unref === 'function') timer.unref();
        promise.then(
            (value) => { clearTimeout(timer); resolve(value); },
            () => { clearTimeout(timer); resolve(null); },
        );
    });
}

/**
 * Start the check now and read it after the run.
 *
 * Callers hand the returned object's `finish` a writer. The request is made
 * while the download is running, and `finish` bounds how long the run waits, so
 * a slow registry can never slow a download and a pending request does not keep
 * the process alive; `abort` is safe to call at any point.
 */
export function startUpdateNotice({
    currentVersion,
    json = false,
    quiet = false,
    env = process.env,
    isTTY = process.stderr.isTTY,
    cacheFile,
    fetchImpl,
    now = Date.now(),
    timeoutMs = 250,
    url,
} = {}) {
    const controller = new AbortController();
    const done = noticeEnabled({ json, quiet, env, isTTY })
        ? checkForUpdate({
            currentVersion,
            file: cacheFile ?? cacheFilePath({ env }),
            fetchImpl,
            signal: controller.signal,
            now,
            url,
        })
        : Promise.resolve({ status: 'off', latest: null });

    return {
        abort: () => controller.abort(),
        async finish(write) {
            const result = await withTimeout(done, timeoutMs);
            controller.abort();
            if (result?.status === 'update' && result.latest) {
                write(noticeLine(result.latest, currentVersion));
            }
            return result;
        },
    };
}

/**
 * `dokuha --check-update`: ask immediately, ignoring the day-long cache, and
 * report exit codes the caller can act on.
 */
export const CHECK_EXIT = { CURRENT: 0, UPDATE: 1, FAILED: 2 };

export async function runCheckUpdate({
    currentVersion,
    out = process.stdout,
    err = process.stderr,
    env = process.env,
    cacheFile,
    fetchImpl,
    now = Date.now(),
    url,
} = {}) {
    const result = await checkForUpdate({
        currentVersion,
        file: cacheFile ?? cacheFilePath({ env }),
        fetchImpl,
        now,
        force: true,
        url,
    });
    if (result.status === 'update') {
        out.write(`${noticeLine(result.latest, currentVersion)}\n`);
        return CHECK_EXIT.UPDATE;
    }
    if (result.status === 'current') {
        out.write(`${upToDateLine(currentVersion)}\n`);
        return CHECK_EXIT.CURRENT;
    }
    err.write('could not check for updates (the npm registry was not reachable)\n');
    return CHECK_EXIT.FAILED;
}


function safeRealpath(target, realpathSync) {
    try {
        return realpathSync(target);
    } catch {
        return path.resolve(target);
    }
}

function isWithin(child, parent) {
    const relative = path.relative(parent, child);
    return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

/**
 * Where this copy of the CLI came from, which decides whether
 * `npm install -g dokuha-cli@latest` is the right command.
 *
 * A git checkout is recognised by its `.git` entry. A global npm install sits
 * under the node_modules directory next to the running `node` binary; anything
 * else (a project's node_modules, a `file:` path, an `npm link` to a checkout)
 * is a local install. `npm link` resolves through the symlink to the checkout,
 * so it lands on `git`, which is what we want: `git pull` is the right upgrade.
 */
export function installKind({
    pkgRoot,
    execPath = process.execPath,
    existsSync = fs.existsSync,
    realpathSync = fs.realpathSync,
} = {}) {
    const root = safeRealpath(pkgRoot, realpathSync);
    if (existsSync(path.join(root, '.git'))) return 'git';

    const binDir = path.dirname(execPath);
    const globalRoots = [
        path.resolve(binDir, '..', 'lib', 'node_modules'),
        path.resolve(binDir, 'node_modules'),
    ];
    for (const globalRoot of globalRoots) {
        if (isWithin(root, safeRealpath(globalRoot, realpathSync))) return 'global';
    }
    return 'local';
}

/** One clear line for a copy that `npm install -g` would not be upgrading. */
export function updateRefusalLine(kind) {
    if (kind === 'git') {
        return `this dokuha is a git checkout; pull that checkout instead of running ${UPDATE_COMMAND}`;
    }
    return `this dokuha is a local install, not a global npm one; update it with your own package manager instead of ${UPDATE_COMMAND}`;
}

function spawnNpm(spawn) {
    return new Promise((resolve) => {
        let child;
        try {
            child = spawn('npm', ['install', '-g', `${PACKAGE_NAME}@latest`], { stdio: 'inherit' });
        } catch {
            resolve(1);
            return;
        }
        child.on('error', () => resolve(1));
        child.on('close', (code) => resolve(code ?? 1));
    });
}

/**
 * `dokuha --update`: print the exact command, then run it, but only where that
 * command is the right one. Returns 0 on success, 1 when npm failed and 2 when
 * the install kind makes the command wrong.
 */
export async function runUpdate({
    pkgRoot,
    out = process.stdout,
    err = process.stderr,
    spawn = nodeSpawn,
    execPath = process.execPath,
    existsSync,
    realpathSync,
} = {}) {
    const kind = installKind({ pkgRoot, execPath, existsSync, realpathSync });
    if (kind !== 'global') {
        err.write(`${updateRefusalLine(kind)}\n`);
        return 2;
    }
    out.write(`Running: ${UPDATE_COMMAND}\n`);
    return (await spawnNpm(spawn)) === 0 ? 0 : 1;
}
