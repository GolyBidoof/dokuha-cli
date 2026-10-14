#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseOptions, OptionError } from '../src/options.js';
import { usage, versionLine } from '../src/help.js';
import { run } from '../src/run.js';
import { runCheckUpdate, runUpdate, startUpdateNotice } from '../src/update-check.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = path.join(HERE, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(PKG_ROOT, 'package.json'), 'utf8'));

import { writeFailureLog } from '../src/failure-log.js';

async function main() {
    let config;
    let positionals;
    try {
        ({ config, positionals } = parseOptions(process.argv.slice(2)));
    } catch (error) {
        if (error instanceof OptionError) {

            process.stderr.write(`${error.message}\n\n`);
            process.stderr.write(`Run 'dokuha --help' for the full list of options.\n`);
            return 2;
        }
        throw error;
    }

    if (config.help) {
        process.stdout.write(usage());
        return 0;
    }
    if (config.version) {
        process.stdout.write(`${versionLine(pkg)}\n`);
        return 0;
    }
    if (config.checkUpdate) {
        return await runCheckUpdate({ currentVersion: pkg.version });
    }
    if (config.update) {
        return await runUpdate({ pkgRoot: PKG_ROOT });
    }

    // The check starts before the download and is read after it, so a slow
    // registry can never delay a run, and a missing or piped stderr keeps the
    // notice out of scripts. See src/update-check.js.
    const notice = positionals.length
        ? startUpdateNotice({ currentVersion: pkg.version, json: config.json, quiet: config.quiet })
        : null;

    try {
        const { code, summary } = await run(positionals, config);
        if (notice) await notice.finish((line) => process.stderr.write(`${line}\n`));

        if (code !== 0) return code;
        return summary && summary.failed ? 1 : 0;
    } finally {
        notice?.abort();
    }
}

main()
    .then((code) => {
        process.exitCode = code;
    })
    .catch((error) => {
        process.stderr.write(`${explainFatal(error)}\n`);
        // Every fatal failure leaves a file behind, so a bug report has the version,
        // the platform, the exact command and the stack rather than a paraphrase.
        const logged = writeFailureLog({
            error,
            argv: process.argv.slice(2),
            version: pkg.version,
        });
        if (logged) process.stderr.write(`Full details written to ${logged}\n`);
        process.exitCode = 1;
    });

/**
 * A crash still has to be readable. The common causes get a sentence a
 * non-technical user can act on; everything else keeps the real message and the
 * chain behind it, because hiding that only makes a bug report harder.
 */
function explainFatal(error) {
    const message = error && error.message ? error.message : String(error);
    const codes = [];
    for (let cause = error; cause; cause = cause.cause) {
        if (cause.code) codes.push(cause.code);
    }
    const hints = {
        ENOSPC: 'the disk is full — free some space or pass --out to a different folder',
        EACCES: 'permission denied — check the folder you are writing to, or pass --out',
        EPERM: 'permission denied — check the folder you are writing to, or pass --out',
        ECONNREFUSED: 'the connection was refused — is the site (or mokuro-bridge) running?',
        ENOTFOUND: 'that host name could not be found — is this machine online?',
        ETIMEDOUT: 'the connection timed out — check this machine\'s network',
        ECONNRESET: 'the connection was reset — the site may be rate-limiting; try again',
    };
    for (const code of codes) {
        if (hints[code]) return `dokuha stopped: ${hints[code]}\n  (${message})`;
    }
    const lines = [`dokuha stopped: ${message}`];
    for (const cause of chain(error)) lines.push(`  caused by: ${cause}`);
    return lines.join('\n');
}

function chain(error) {
    const out = [];
    let cause = error && error.cause;
    while (cause && out.length < 4) {
        out.push(cause.message ? cause.message : String(cause));
        cause = cause.cause;
    }
    return out;
}
