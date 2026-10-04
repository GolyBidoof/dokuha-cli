#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseOptions, OptionError } from '../src/options.js';
import { usage, versionLine } from '../src/help.js';
import { run } from '../src/run.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(fs.readFileSync(path.join(HERE, '..', 'package.json'), 'utf8'));

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
    if (config.bwLogin) {
        process.stderr.write(
            '--bw-login needs a browser and this build is browserless.\n'
            + 'Sign in on bookwalker.jp in your normal browser, then pass the cookie with --bw-cookie.\n',
        );
        return 2;
    }

    const { code, summary } = await run(positionals, config);

    if (code !== 0) return code;
    return summary && summary.failed ? 1 : 0;
}

main()
    .then((code) => {
        process.exitCode = code;
    })
    .catch((error) => {
        process.stderr.write(`Fatal: ${error && error.message ? error.message : error}\n`);
        process.exitCode = 1;
    });
