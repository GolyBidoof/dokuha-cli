
import fs from 'node:fs';
import { parseArgs } from 'node:util';

import { UPDATE_COMMAND } from './update-check.js';
import { PLATFORMS, concurrencyDefaults, concurrencyKey, concurrencyPlatforms } from './platforms/index.js';

function toInt(name, value, { min = 1, max = null, fallback = null } = {}) {
    if (value === undefined || value === null || value === '') return fallback;
    const n = Number(value);
    const range = max === null ? `>= ${min}` : `${min}-${max}`;
    if (!Number.isInteger(n) || n < min || (max !== null && n > max)) {
        throw new OptionError(`--${name} needs a whole number ${range} (got "${value}")`);
    }
    return n;
}

function toConcurrency(name, value, { fallback = null } = {}) {
    if (value === undefined || value === null || value === '') return fallback;
    if (/^unlimited$/i.test(String(value).trim())) return Infinity;
    return toInt(name, value, { min: 1, fallback });
}

/**
 * A cookie argument of the form `@FILE` names a file that has to exist. Catching
 * that here means a mistyped path is one clear message at startup, not one
 * failure per volume after the run has already begun.
 */
function assertCookieFiles(flag, values) {
    for (const value of values) {
        const text = String(value);
        if (!text.startsWith('@')) continue;
        const file = text.slice(1);
        if (!fs.existsSync(file)) {
            throw new OptionError(`--${flag} @${file} does not exist`);
        }
    }
}

export class OptionError extends Error {
    constructor(message) {
        super(message);
        this.name = 'OptionError';
    }
}

// The per-store page counts are not listed here: each one is read from the
// store's own `tuning` block, so a new store brings its own default and flag
// with it. Everything in this object is tuning that is not owned by one store.
export const DEFAULTS = {
    ...concurrencyDefaults(),

    pushConcurrency: 4,
    retries: 6,
    cmScanLimit: 60,
    ocrWaitSeconds: 3600,
    format: 'original',
};

// `advanced` options stay available but move under one heading in --help, so the
// first screen is the dozen flags a new user actually needs.
//
// The per-store page counts are generated from the registry and spliced in after
// `concurrency`, so this list holds only the tuning that belongs to no one store.
const BASE_OPTIONS = [

    { name: 'series', type: 'boolean', group: 'Selection', help: 'treat every URL as an entry point into its series and download only the volumes that are free in full' },
    { name: 'download-samplers', type: 'boolean', group: 'Selection', help: "with --series, carry on past the free volumes and take each remaining volume's 試し読み sampler, as far as the series goes" },

    { name: 'out', short: 'o', type: 'string', arg: 'DIR', group: 'Output', default: './library', help: "where volumes are written (default ./library)" },
    { name: 'no-title-dir', type: 'boolean', group: 'Output', advanced: true, help: 'name each folder after the content id instead of the title' },
    { name: 'zip', type: 'boolean', group: 'Output', advanced: true, help: 'BookWalker only: collect each volume into one .zip instead of writing its pages' },
    { name: 'flat', type: 'boolean', group: 'Output', advanced: true, help: 'write pages straight into --out' },
    { name: 'dry-run', type: 'boolean', group: 'Output', help: 'list what would be downloaded, then stop (the list is a table even with --json)' },
    { name: 'force', type: 'boolean', group: 'Output', help: 're-download pages that already exist and overwrite an existing destination' },
    { name: 'json', type: 'boolean', group: 'Output', help: 'machine-readable summary on stdout after a real run' },
    { name: 'quiet', type: 'boolean', group: 'Output', help: 'no live block and no closing summary (failures and notes still print)' },
    { name: 'no-progress', type: 'boolean', group: 'Output', advanced: true, help: 'print one plain line per volume instead of the live block (in the block, c compacts and p pauses for copying)' },

    { name: 'parallel', type: 'string', arg: 'N', group: 'Concurrency', help: 'how many volumes to work on at once (default: all of them, as fast as the machine allows)' },
    { name: 'jobs', type: 'string', arg: 'N', group: 'Concurrency', advanced: true, help: 'render workers for each running CMOA volume (default: cores - 1, divided by the volumes running at once; an explicit N is per volume)' },
    { name: 'concurrency', type: 'string', arg: 'N', group: 'Concurrency', advanced: true, help: 'set the per-store page concurrency at once' },
    { name: 'push-concurrency', type: 'string', arg: 'N', group: 'Concurrency', advanced: true, help: `pages pushed to mokuro-bridge at once (default ${DEFAULTS.pushConcurrency})` },

    { name: 'cm-volume', type: 'string', arg: 'V', group: 'CMOA', advanced: true, default: '1', help: 'volume number, comma list, or "all"; a /vol/<n>/ in the URL overrides it' },
    { name: 'cm-scan-limit', type: 'string', arg: 'N', group: 'CMOA', advanced: true, help: `highest volume to probe with "all" (default ${DEFAULTS.cmScanLimit})` },
    { name: 'quality', type: 'string', arg: 'N', group: 'CMOA', advanced: true, help: 'image quality multiplier passed to the CMOA API' },
    { name: 'jpeg-quality', type: 'string', arg: 'N', group: 'CMOA', advanced: true, help: 'quality of the JPEG CMOA pages are re-encoded at, 1-100 (default 92); lower is faster to write and smaller' },

    { name: 'format', type: 'string', arg: 'FMT', group: 'Page format', advanced: true, help: 'page format: original or jpeg for CMOA, jpeg or webp for ebookjapan (default: the store\'s own for CMOA, jpeg for ebookjapan)' },
    { name: 'descramble', type: 'boolean', group: 'Page format', advanced: true, help: 'require page descrambling (ebookjapan, k-manga); fails if the optional sharp dependency is missing' },
    { name: 'no-descramble', type: 'boolean', group: 'Page format', advanced: true, help: 'keep the scrambled pages exactly as the CDN serves them (ebookjapan, k-manga)' },

    { name: 'bw-cookie', type: 'string', arg: 'TEXT', multiple: true, group: 'BookWalker auth', help: 'Cookie header, "Copy as cURL" command, @FILE, a path, or "-" for stdin. Repeatable and merged' },
    { name: 'bw-state', type: 'string', arg: 'FILE', group: 'BookWalker auth', advanced: true, help: 'where the saved session lives' },
    { name: 'bw-sample', type: 'boolean', group: 'BookWalker auth', advanced: true, help: 'force the trial route instead of the free one' },
    { name: 'bw-u1', type: 'string', arg: 'UUID', group: 'BookWalker auth', advanced: true, help: 'supply u1 explicitly (HttpOnly, normally inside --bw-cookie)' },
    { name: 'bw-cr', type: 'string', arg: 'N', group: 'BookWalker auth', advanced: true, help: 'send a specific cr instead of reading it from getLoader' },
    { name: 'bw-no-cr', type: 'boolean', group: 'BookWalker auth', advanced: true, help: 'omit cr from the licence request' },
    { name: 'bw-entry', type: 'string', arg: 'URL', group: 'BookWalker auth', advanced: true, help: 'open through this URL instead of choosing a route' },

    { name: 'kindle-cookie', type: 'string', arg: 'TEXT', multiple: true, group: 'Kindle auth', help: 'read.amazon.co.jp cookies: a Cookie header, "Copy as cURL" command, @FILE, a path, or "-" for stdin. Repeatable and merged' },
    { name: 'kindle-state', type: 'string', arg: 'FILE', group: 'Kindle auth', advanced: true, help: 'where the saved Kindle session lives (default ~/.bwdd-cli/kindle-session.json)' },

    { name: 'no-state', type: 'boolean', group: 'Sessions', advanced: true, help: 'do not read or write a saved session, for either account store' },

    { name: 'mokuro', type: 'boolean', group: 'mokuro-bridge (OCR)', help: 'push every volume through the bridge; without it, resume matching existing bridge sessions only' },
    { name: 'bridge', type: 'string', arg: 'URL', group: 'mokuro-bridge (OCR)', advanced: true, help: 'bridge base URL (default: auto-discover :62642)' },
    { name: 'dest', type: 'string', arg: 'METHOD', group: 'mokuro-bridge (OCR)', advanced: true, help: 'bridge destination id or account alias: local, mega, drive, onedrive, webdav, rclone, mega-work (default: the bridge owns it; naming one here also makes it the bridge\u2019s default for every later run)' },
    { name: 'dest-folder', type: 'string', arg: 'DIR', group: 'mokuro-bridge (OCR)', advanced: true, help: 'folder to use when --dest is local; a relative path is resolved on this machine, not the bridge' },
    { name: 'ocr-wait', type: 'string', arg: 'SECONDS', group: 'mokuro-bridge (OCR)', advanced: true, help: `how long to wait for OCR (default ${DEFAULTS.ocrWaitSeconds})` },
    { name: 'bridge-parallel', type: 'string', arg: 'N', group: 'mokuro-bridge (OCR)', advanced: true, help: 'bridge/OCR volumes at once or unlimited (default: the same as --parallel)' },
    { name: 'no-folder-ingest', type: 'boolean', group: 'mokuro-bridge (OCR)', advanced: true, help: 'upload pages one at a time instead of letting a local bridge read the folder' },
    { name: 'retries', type: 'string', arg: 'N', group: 'mokuro-bridge (OCR)', advanced: true, help: `attempts per failed page (default ${DEFAULTS.retries})` },

    { name: 'check-update', type: 'boolean', group: 'Meta', help: 'ask npm now whether a newer dokuha-cli exists: exit 0 when current, 1 when an update is available, 2 when the check failed' },
    { name: 'update', type: 'boolean', group: 'Meta', help: `run "${UPDATE_COMMAND}" for a global npm install; refuses a git checkout or a local path install` },

    { name: 'help', short: 'h', type: 'boolean', group: 'Meta', help: 'show this help' },
    { name: 'version', short: 'V', type: 'boolean', group: 'Meta', help: 'show the version' },
];

/**
 * One `--<store>-concurrency` entry per store that declares a concurrency in its
 * `tuning` block. The wording and the default both come from the descriptor, so
 * a new store adds its flag by existing rather than by editing this file.
 */
export function storeConcurrencyOptions(platforms = PLATFORMS) {
    return concurrencyPlatforms(platforms)
        .map((entry) => {
            const { flag, concurrency } = entry.tuning;
            return {
                name: flag.name,
                type: 'string',
                arg: flag.arg || 'N',
                group: 'Concurrency',
                advanced: true,
                order: flag.order ?? Number.MAX_SAFE_INTEGER,
                help: `${flag.help} (default ${concurrency})${flag.hint || ''}`,
            };
        })
        .sort((a, b) => a.order - b.order);
}

function withStoreConcurrency(options, platforms = PLATFORMS) {
    const at = options.findIndex((opt) => opt.name === 'concurrency') + 1;
    const generated = storeConcurrencyOptions(platforms).map(({ order, ...opt }) => opt);
    return [...options.slice(0, at), ...generated, ...options.slice(at)];
}

export const OPTIONS = withStoreConcurrency(BASE_OPTIONS);

export function buildParseConfig(options = OPTIONS) {
    const table = {};
    for (const opt of options) {
        table[opt.name] = {
            type: opt.type,

            ...(opt.short ? { short: opt.short } : {}),
            ...(opt.multiple ? { multiple: true } : {}),
            ...(opt.default !== undefined && !opt.multiple ? { default: opt.default } : {}),
        };
    }
    return { options: table, allowPositionals: true, strict: true };
}

function nearestOption(name, options = OPTIONS) {
    const wanted = String(name).replace(/^--?/, '');
    let best = null;
    let bestDistance = Infinity;
    for (const opt of options) {
        const distance = editDistance(wanted, opt.name);
        if (distance < bestDistance) {
            bestDistance = distance;
            best = opt.name;
        }
    }
    const limit = wanted.length <= 4 ? 1 : 2;
    return bestDistance <= limit ? best : null;
}

function editDistance(a, b) {
    const rows = a.length + 1;
    const cols = b.length + 1;
    const table = Array.from({ length: rows }, (_, i) => [i, ...Array(cols - 1).fill(0)]);
    for (let j = 0; j < cols; j++) table[0][j] = j;
    for (let i = 1; i < rows; i++) {
        for (let j = 1; j < cols; j++) {
            table[i][j] = Math.min(
                table[i - 1][j] + 1,
                table[i][j - 1] + 1,
                table[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
            );
        }
    }
    return table[rows - 1][cols - 1];
}

function explainParseError(error, options = OPTIONS) {
    const message = String(error.message || '');

    const unknown = /Unknown option '([^']+)'/.exec(message);
    if (unknown) {
        const near = nearestOption(unknown[1], options);
        return near
            ? `unknown option '${unknown[1]}'; did you mean --${near}?`
            : `unknown option '${unknown[1]}'`;
    }

    const ambiguous = /Option '([^']+)' argument is ambiguous/.exec(message);
    if (ambiguous) return `${ambiguous[1]} needs a value (a following flag cannot be its value)`;

    const missing = /Option '([^']+)' argument (?:missing|is required)|Option '([^']+)' requires an argument/.exec(message);
    if (missing) {
        const raw = missing[1] || missing[2];
        const flag = /--([\w-]+)/.exec(raw);
        return `${flag ? `--${flag[1]}` : raw} needs a value`;
    }

    return message;
}

export function parseOptions(argv = [], { platforms = PLATFORMS } = {}) {
    const options = withStoreConcurrency(BASE_OPTIONS, platforms);
    let parsed;
    try {
        parsed = parseArgs({ args: argv, ...buildParseConfig(options) });
    } catch (error) {
        throw new OptionError(explainParseError(error, options));
    }

    const v = parsed.values;
    const perStore = toInt('concurrency', v.concurrency, { fallback: null });

    if (v.descramble && v['no-descramble']) {
        throw new OptionError('--descramble and --no-descramble cannot both be given');
    }

    // Every store that declares a concurrency on its descriptor gets its flag
    // parsed here. --concurrency still overrides them all unless the store's own
    // flag was given, and the descriptor supplies the default for a store that
    // has no flag of its own in the run.
    const storeConcurrency = {};
    for (const entry of concurrencyPlatforms(platforms)) {
        const flag = entry.tuning.flag;
        storeConcurrency[concurrencyKey(entry)] = toInt(flag.name, v[flag.name], {
            min: 1,
            max: flag.max ?? null,
            fallback: perStore ?? entry.tuning.concurrency,
        });
    }

    const config = {
        help: Boolean(v.help),
        version: Boolean(v.version),
        checkUpdate: Boolean(v['check-update']),
        update: Boolean(v.update),

        series: Boolean(v.series),

        downloadSamplers: Boolean(v['download-samplers']),

        out: String(v.out ?? './library'),

        titleDir: v['no-title-dir'] ? false : true,
        zip: Boolean(v.zip),
        flat: Boolean(v.flat),
        dryRun: Boolean(v['dry-run']),
        force: Boolean(v.force),
        // One flag: --force already means "ignore what is already there", and the
        // bridge destination used to have a second name for the same idea.
        overwrite: Boolean(v.force),
        json: Boolean(v.json),
        quiet: Boolean(v.quiet),
        noProgress: Boolean(v['no-progress']),

        parallel: toConcurrency('parallel', v.parallel, { fallback: null }),
        jobs: toInt('jobs', v.jobs, { fallback: null }),
        // The shared override, kept so a caller can see whether --concurrency was
        // given at all. The per-store values are spread in below.
        concurrency: perStore,
        ...storeConcurrency,
        pushConcurrency: toInt('push-concurrency', v['push-concurrency'], { fallback: DEFAULTS.pushConcurrency }),

        cmVolume: String(v['cm-volume'] ?? '1'),
        cmScanLimit: toInt('cm-scan-limit', v['cm-scan-limit'], { fallback: DEFAULTS.cmScanLimit }),
        format: String(v.format ?? DEFAULTS.format),
        quality: v.quality === undefined ? null : toInt('quality', v.quality),
        jpegQuality: v['jpeg-quality'] === undefined ? null : toInt('jpeg-quality', v['jpeg-quality'], { min: 1, max: 100 }),

        descramble: v.descramble ? true : (v['no-descramble'] ? false : null),

        bwCookies: Array.isArray(v['bw-cookie']) ? v['bw-cookie'] : (v['bw-cookie'] ? [v['bw-cookie']] : []),
        bwState: v['bw-state'] ?? null,
        bwNoState: Boolean(v['no-state']),
        bwSample: Boolean(v['bw-sample']),
        bwU1: v['bw-u1'] ?? null,
        bwCr: v['bw-cr'] ?? null,
        bwNoCr: Boolean(v['bw-no-cr']),
        bwEntry: v['bw-entry'] ?? null,

        kindleCookies: Array.isArray(v['kindle-cookie']) ? v['kindle-cookie'] : (v['kindle-cookie'] ? [v['kindle-cookie']] : []),
        kindleState: v['kindle-state'] ?? null,
        kindleNoState: Boolean(v['no-state']),

        mokuro: Boolean(v.mokuro),
        bridge: v.bridge ?? null,
        dest: v.dest ?? null,
        destFolder: v['dest-folder'] ?? null,
        ocrWaitSeconds: toInt('ocr-wait', v['ocr-wait'], { fallback: DEFAULTS.ocrWaitSeconds }),
        bridgeParallel: toConcurrency('bridge-parallel', v['bridge-parallel'], { fallback: null }),
        folderIngest: v['no-folder-ingest'] ? false : true,
        retries: toInt('retries', v.retries, { min: 0, fallback: DEFAULTS.retries }),
    };

    assertCookieFiles('bw-cookie', config.bwCookies);
    assertCookieFiles('kindle-cookie', config.kindleCookies);

    return { config, positionals: parsed.positionals };
}
