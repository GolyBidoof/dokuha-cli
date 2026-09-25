/**
 * Command-line options for manga-dl.
 *
 * Every option is declared once, here, and `parseOptions` returns a plain object.
 * Nothing is read from `process.argv` at import time, which matters for two
 * reasons: the parser can be exercised directly in tests, and `main()` can be
 * called more than once in one process.
 */

import { parseArgs } from 'node:util';

/** Positive integer, with a friendly error rather than a silent NaN. */
function toInt(name, value, { min = 1, fallback = null } = {}) {
    if (value === undefined || value === null || value === '') return fallback;
    const n = Number(value);
    if (!Number.isInteger(n) || n < min) {
        throw new OptionError(`--${name} needs a whole number >= ${min} (got "${value}")`);
    }
    return n;
}

/** An error caused by bad user input, as opposed to a failure while downloading. */
export class OptionError extends Error {
    constructor(message) {
        super(message);
        this.name = 'OptionError';
    }
}

/** Per-store defaults. Kept in one table so the help text and the parser agree. */
export const DEFAULTS = {
    seriesCap: 16,
    cmConcurrency: 12,
    ebConcurrency: 32,
    bwConcurrency: 128,
    pushConcurrency: 4,
    retries: 6,
    cmScanLimit: 60,
    ocrWaitSeconds: 3600,
    format: 'original',
};

/** Declarations, used for both parsing and for rendering the help text. */
export const OPTIONS = [
    // Output
    { name: 'out', short: 'o', type: 'string', arg: 'DIR', group: 'Output', default: './library', help: 'where volumes are written' },
    { name: 'title-dir', type: 'boolean', group: 'Output', help: 'name each folder after the volume title instead of the cid' },
    { name: 'flat', type: 'boolean', group: 'Output', help: 'write pages straight into --out' },
    { name: 'dry-run', type: 'boolean', group: 'Output', help: 'list what would be downloaded, then stop' },
    { name: 'force', type: 'boolean', group: 'Output', help: 're-download pages that already exist' },
    { name: 'overwrite', type: 'boolean', group: 'Output', help: 'replace an existing file at the destination' },
    { name: 'json', type: 'boolean', group: 'Output', help: 'machine-readable summary on stdout' },
    { name: 'quiet', type: 'boolean', group: 'Output', help: 'no progress redraws' },
    { name: 'no-progress', type: 'boolean', group: 'Output', help: 'disable the progress block entirely' },

    // Concurrency
    { name: 'series', type: 'string', arg: 'N', group: 'Concurrency', help: `volumes at once (default: all of them, up to ${DEFAULTS.seriesCap})` },
    { name: 'jobs', type: 'string', arg: 'N', group: 'Concurrency', help: 'render workers across all CMOA volumes (default: cores - 1, divided by the volumes running at once)' },
    { name: 'concurrency', type: 'string', arg: 'N', group: 'Concurrency', help: 'set the per-store page concurrency at once' },
    { name: 'cm-concurrency', type: 'string', arg: 'N', group: 'Concurrency', help: `CMOA pages in flight (default ${DEFAULTS.cmConcurrency})` },
    { name: 'eb-concurrency', type: 'string', arg: 'N', group: 'Concurrency', help: `ebookjapan pages in flight (default ${DEFAULTS.ebConcurrency})` },
    { name: 'bw-concurrency', type: 'string', arg: 'N', group: 'Concurrency', help: `BookWalker pages in flight (default ${DEFAULTS.bwConcurrency})` },
    { name: 'push-concurrency', type: 'string', arg: 'N', group: 'Concurrency', help: `pages pushed to mokuro-bridge at once (default ${DEFAULTS.pushConcurrency})` },

    // CMOA
    { name: 'cm-volume', type: 'string', arg: 'V', group: 'CMOA', default: '1', help: 'volume number, comma list, or "all"; a /vol/<n>/ in the URL overrides it' },
    { name: 'cm-scan-limit', type: 'string', arg: 'N', group: 'CMOA', help: `highest volume to probe with "all" (default ${DEFAULTS.cmScanLimit})` },
    { name: 'format', type: 'string', arg: 'FMT', group: 'CMOA', help: `page format: original or jpeg (default ${DEFAULTS.format})` },
    { name: 'quality', type: 'string', arg: 'N', group: 'CMOA', help: 'image quality multiplier passed to the CMOA API' },

    // ebookjapan
    { name: 'descramble', type: 'boolean', group: 'ebookjapan', help: 'keep the descrambled image rather than the original' },
    { name: 'table', type: 'string', arg: 'FILE', group: 'ebookjapan', help: 'use a specific scramble table' },
    { name: 'pdf', type: 'string', arg: 'FILE', group: 'ebookjapan', help: 'also write a PDF' },

    // BookWalker auth
    { name: 'bw-cookie', type: 'string', arg: 'TEXT', multiple: true, group: 'BookWalker auth', help: 'Cookie header, "Copy as cURL" command, @FILE, a path, or "-" for stdin. Repeatable and merged' },
    { name: 'bw-login', type: 'boolean', group: 'BookWalker auth', help: 'not available: needs a browser. Sign in normally and use --bw-cookie' },
    { name: 'bw-state', type: 'string', arg: 'FILE', group: 'BookWalker auth', help: 'where the saved session lives' },
    { name: 'no-state', type: 'boolean', group: 'BookWalker auth', help: 'do not read or write a saved session' },
    { name: 'bw-sample', type: 'boolean', group: 'BookWalker auth', help: 'force the trial route instead of the free one' },
    { name: 'bw-u1', type: 'string', arg: 'UUID', group: 'BookWalker auth', help: 'supply u1 explicitly (HttpOnly, normally inside --bw-cookie)' },
    { name: 'bw-cr', type: 'string', arg: 'N', group: 'BookWalker auth', help: 'send a specific cr instead of reading it from getLoader' },
    { name: 'bw-no-cr', type: 'boolean', group: 'BookWalker auth', help: 'omit cr from the licence request' },
    { name: 'bw-entry', type: 'string', arg: 'URL', group: 'BookWalker auth', help: 'open through this URL instead of choosing a route' },

    // OCR
    { name: 'mokuro', type: 'boolean', group: 'mokuro-bridge (OCR)', help: 'push every volume through the bridge' },
    { name: 'bridge', type: 'string', arg: 'URL', group: 'mokuro-bridge (OCR)', help: 'bridge base URL (default: auto-discover :62642)' },
    { name: 'dest', type: 'string', arg: 'METHOD', group: 'mokuro-bridge (OCR)', help: 'local, mega, drive, ... (default: the bridge owns it)' },
    { name: 'dest-folder', type: 'string', arg: 'DIR', group: 'mokuro-bridge (OCR)', help: 'folder to use when --dest is local' },
    { name: 'local-dir', type: 'string', arg: 'DIR', group: 'mokuro-bridge (OCR)', help: 'alias for --dest local --dest-folder DIR' },
    { name: 'ocr-wait', type: 'string', arg: 'SECONDS', group: 'mokuro-bridge (OCR)', help: `how long to wait for OCR (default ${DEFAULTS.ocrWaitSeconds})` },
    { name: 'retries', type: 'string', arg: 'N', group: 'mokuro-bridge (OCR)', help: `attempts per failed page (default ${DEFAULTS.retries})` },

    // Meta
    { name: 'help', short: 'h', type: 'boolean', group: 'Meta', help: 'show this help' },
    { name: 'version', short: 'V', type: 'boolean', group: 'Meta', help: 'show the version' },
];

/**
 * Expand the declaration table into the shape `node:util`'s parseArgs wants.
 *
 * Both the long and short spelling are registered so that parseArgs rejects an
 * unknown flag for us, which keeps the error text consistent with the help.
 */
export function buildParseConfig() {
    const options = {};
    for (const opt of OPTIONS) {
        options[opt.name] = {
            type: opt.type,
            // `short` is a property of the option definition, not a comma-joined
            // key: `'out,o'` is silently treated as a long name and every use of
            // `--out` then fails as unknown.
            ...(opt.short ? { short: opt.short } : {}),
            ...(opt.multiple ? { multiple: true } : {}),
            ...(opt.default !== undefined && !opt.multiple ? { default: opt.default } : {}),
        };
    }
    return { options, allowPositionals: true, strict: true };
}

/**
 * Reword a `parseArgs` failure into something that points at the fix.
 *
 * `parseArgs` reports a missing value as "ambiguous" when the next token is
 * another flag, which reads like a contradiction rather than a typo, and it
 * capitalises "Unknown option" inconsistently with the rest of our output.
 */
function explainParseError(error) {
    const message = String(error.message || '');

    const unknown = /Unknown option '([^']+)'/.exec(message);
    if (unknown) return `unknown option '${unknown[1]}'`;

    const ambiguous = /Option '([^']+)' argument is ambiguous/.exec(message);
    if (ambiguous) return `${ambiguous[1]} needs a value (a following flag cannot be its value)`;

    const missing = /Option '([^']+)' argument is required/.exec(message);
    if (missing) return `${missing[1]} needs a value`;

    const expectsArg = /Option '([^']+)' requires an argument/.exec(message);
    if (expectsArg) return `${expectsArg[1]} needs a value`;

    return message;
}

/**
 * Parse argv into a normalised config object.
 *
 * @param {string[]} argv arguments without the node/script prefix
 * @returns {{ config: object, positionals: string[] }}
 */
export function parseOptions(argv = []) {
    let parsed;
    try {
        parsed = parseArgs({ args: argv, ...buildParseConfig() });
    } catch (error) {
        throw new OptionError(explainParseError(error));
    }

    const v = parsed.values;
    const perStore = toInt('concurrency', v.concurrency, { fallback: null });

    const config = {
        help: Boolean(v.help),
        version: Boolean(v.version),

        out: String(v.out ?? './library'),
        titleDir: Boolean(v['title-dir']),
        flat: Boolean(v.flat),
        dryRun: Boolean(v['dry-run']),
        force: Boolean(v.force),
        overwrite: Boolean(v.overwrite),
        json: Boolean(v.json),
        quiet: Boolean(v.quiet),
        noProgress: Boolean(v['no-progress']),

        series: toInt('series', v.series, { fallback: null }),
        jobs: toInt('jobs', v.jobs, { fallback: null }),
        cmConcurrency: toInt('cm-concurrency', v['cm-concurrency'], { fallback: perStore ?? DEFAULTS.cmConcurrency }),
        ebConcurrency: toInt('eb-concurrency', v['eb-concurrency'], { fallback: perStore ?? DEFAULTS.ebConcurrency }),
        bwConcurrency: toInt('bw-concurrency', v['bw-concurrency'], { fallback: perStore ?? DEFAULTS.bwConcurrency }),
        pushConcurrency: toInt('push-concurrency', v['push-concurrency'], { fallback: DEFAULTS.pushConcurrency }),

        cmVolume: String(v['cm-volume'] ?? '1'),
        cmScanLimit: toInt('cm-scan-limit', v['cm-scan-limit'], { fallback: DEFAULTS.cmScanLimit }),
        format: String(v.format ?? DEFAULTS.format),
        quality: v.quality === undefined ? null : toInt('quality', v.quality),

        descramble: Boolean(v.descramble),
        table: v.table ?? null,
        pdf: v.pdf ?? null,

        // Repeated flags arrive as an array already; keep it that way so the
        // sampler's own reader handles the shapes (header, cURL, @FILE, path, -).
        bwCookies: Array.isArray(v['bw-cookie']) ? v['bw-cookie'] : (v['bw-cookie'] ? [v['bw-cookie']] : []),
        bwLogin: Boolean(v['bw-login']),
        bwState: v['bw-state'] ?? null,
        bwNoState: Boolean(v['no-state']),
        bwSample: Boolean(v['bw-sample']),
        bwU1: v['bw-u1'] ?? null,
        bwCr: v['bw-cr'] ?? null,
        bwNoCr: Boolean(v['bw-no-cr']),
        bwEntry: v['bw-entry'] ?? null,

        mokuro: Boolean(v.mokuro),
        bridge: v.bridge ?? null,
        dest: v.dest ?? null,
        destFolder: v['dest-folder'] ?? null,
        localDir: v['local-dir'] ?? null,
        ocrWaitSeconds: toInt('ocr-wait', v['ocr-wait'], { fallback: DEFAULTS.ocrWaitSeconds }),
        retries: toInt('retries', v.retries, { min: 0, fallback: DEFAULTS.retries }),
    };

    return { config, positionals: parsed.positionals };
}
