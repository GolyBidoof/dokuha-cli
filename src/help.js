
import { OPTIONS, DEFAULTS } from './options.js';

const PROG = 'dokuha';

function optionLines(options) {
    const rows = options.filter((opt) => !opt.hidden).map((opt) => {
        const short = opt.short ? `-${opt.short}, ` : '    ';
        const arg = opt.arg ? ` ${opt.arg}` : '';
        return { left: `  ${short}--${opt.name}${arg}`, help: opt.help };
    });
    const width = Math.min(30, Math.max(...rows.map((r) => r.left.length)) + 2);
    return rows.map((r) => `${r.left.padEnd(width)}${r.help}`);
}

function grouped(predicate) {
    const groups = [];
    for (const opt of OPTIONS) {
        if (opt.hidden || opt.group === 'Meta') continue;
        if (!predicate(opt)) continue;
        let group = groups.find((g) => g.name === opt.group);
        if (!group) {
            group = { name: opt.group, options: [] };
            groups.push(group);
        }
        group.options.push(opt);
    }
    return groups.map((g) => `${g.name}\n${optionLines(g.options).join('\n')}`);
}

export function usage() {
    const meta = OPTIONS.filter((o) => o.group === 'Meta');
    const common = grouped((opt) => !opt.advanced);
    const advanced = grouped((opt) => opt.advanced);

    return [
        `${PROG} - download CMOA, ebookjapan, BookWalker, Kindle, k-manga and DMMブックス volumes, browserless.`,
        '',
        `  ${PROG} URL... [options]`,
        '',
        'Each positional URL is detected automatically across all six stores. A CMOA',
        'title page can be given in place of a speedreader URL and is resolved to its',
        'volumes. A Kindle URL may be a reader URL, a store product page or a bare ASIN.',
        'A k-manga URL may be a title page, a /vol/<n>/ page or a viewer-launcher link.',
        'A DMM URL may be a volume viewer, a product page, /volumes/ or /latest/.',
        'Volumes run in parallel by default: every discovered volume starts at once.',
        'Use --parallel N to cap the download stage, and --bridge-parallel N to cap',
        'the bridge/OCR stage.',
        '',
        `  ${PROG} \\`,
        "    'https://ebookjapan.yahoo.co.jp/books/126001/A009000001/' \\",
        "    'https://www.cmoa.jp/title/249001/' \\",
        "    'https://bookwalker.jp/de00000001-0000-4000-8000-000000000001/?sample=2' \\",
        `    --out ./library --mokuro`,
        '',
        `With --series each URL is instead read as an entry point into a whole series,`,
        'and only the volumes that are free to read in full are downloaded. A free',
        'preview is not a free volume, so trial-only volumes are skipped:',
        '',
        `  ${PROG} --series \\`,
        "    'https://www.cmoa.jp/title/214001/' \\",
        "    'https://ebookjapan.yahoo.co.jp/books/621001/' \\",
        "    'https://bookwalker.jp/de00000003-0000-4000-8000-000000000003/'",
        '',
        '--download-samplers carries on past the free volumes and takes each remaining',
        "volume's 試し読み sampler, as far as the series goes. Samplers are written to",
        'their own （試し読み） folder, so a 10-page preview never sits where the whole',
        'volume belongs. BookWalker, CMOA, ebookjapan, Kindle, k-manga and DMMブックス support it:',
        '',
        `  ${PROG} --series --download-samplers 'https://www.cmoa.jp/title/167001/'`,
        '',
        'Environment',
        '  BWDD_BRIDGE_URL         default mokuro-bridge URL',
        '  NO_COLOR / FORCE_COLOR  control coloured output',
        '  DOKUHA_NO_UPDATE_CHECK  turn off the automatic update notice',
        '  DOKUHA_UPDATE_NOTICE    print that notice even when stderr is not a terminal',
        '',
        'Options',
        ...common.flatMap((block) => [block, '']),
        'Advanced (the defaults are right for most runs; these are for tuning)',
        ...advanced.flatMap((block) => [block, '']),
        '',
        `${optionLines(meta).join('\n')}`,
        '',
        '--check-update asks npm for the newest release and exits 0 when this copy is',
        'current, 1 when a newer one exists and 2 when the check failed. --update runs',
        'the upgrade command for a global npm install, and refuses when dokuha is a git',
        'checkout or a local install where that command would be wrong. After a normal',
        'run dokuha prints one quiet line when a newer release exists, at most once a',
        'day; set DOKUHA_NO_UPDATE_CHECK=1 to turn that off.',
        '',
        'Free volumes on CMOA, ebookjapan, BookWalker, k-manga and DMMブックス need no account or',
        'credentials. BookWalker needs the optional sharp dependency for every volume,',
        'and k-manga, ebookjapan and DMM need it to rebuild their scrambled pages; CMOA and',
        'Kindle never do.',
        'A signed-in session is needed for BookWalker titles already in your library',
        '(--bw-cookie) and for every Kindle volume (--kindle-cookie): an Amazon volume is',
        'never public, not even a limited-time-free one. See the README.',
        `Defaults: every volume at once, format ${DEFAULTS.format}.`,
        '',
    ].join('\n');
}

export function versionLine(pkg) {
    return `読破 ${PROG} ${pkg.version}`;
}
