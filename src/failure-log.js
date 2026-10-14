import fs from 'node:fs';
import path from 'node:path';

// Anything that carries a credential must be stripped before it reaches a file on
// disk. A log is the easiest place to leak a session by accident, and these files
// sit in the working tree where they are easy to share.
const SECRET_FLAGS = ['--kindle-cookie', '--bw-cookie', '--km-cookie', '--cookie', '--cookies'];

export function redactArgv(argv) {
    const out = [];
    for (let i = 0; i < argv.length; i += 1) {
        const arg = String(argv[i]);
        const flag = SECRET_FLAGS.find((name) => arg === name || arg.startsWith(`${name}=`));
        if (!flag) {
            out.push(arg);
            continue;
        }
        if (arg.includes('=')) {
            out.push(`${flag}=<redacted>`);
            continue;
        }
        out.push(arg, '<redacted>');
        i += 1;
    }
    return out;
}

/**
 * Write one file describing a fatal failure, and return its path or null.
 *
 * A failure that leaves no trace is the hardest kind to act on, and the CLI keeps
 * nothing today. This is deliberately best effort: a log that cannot be written
 * must never mask the error it was meant to describe, so every problem here is
 * swallowed and reported as null.
 */
export function writeFailureLog({ error, argv, version, dir, label = 'failure', extra = [], heading = 'error' }) {
    try {
        const target = dir || path.join(process.cwd(), '.dokuha-logs');
        fs.mkdirSync(target, { recursive: true });
        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        const file = path.join(target, `${label}-${stamp}-${process.pid}.log`);
        const body = String(error && error.stack ? error.stack : error);
        const lines = [
            `time      ${new Date().toISOString()}`,
            `dokuha    ${version || 'unknown'}`,
            `node      ${process.version}`,
            `platform  ${process.platform} ${process.arch}`,
            `cwd       ${process.cwd()}`,
            `command   dokuha ${redactArgv(argv || []).join(' ')}`,
            ...extra,
            '',
            heading,
            ...body.split('\n').map((line) => `  ${line}`),
            '',
        ];
        fs.writeFileSync(file, lines.join('\n'), { mode: 0o600 });
        return file;
    } catch {
        return null;
    }
}
