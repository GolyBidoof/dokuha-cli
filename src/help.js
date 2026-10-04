
import { OPTIONS, DEFAULTS } from './options.js';

const PROG = 'dokuha';

function optionLines(options) {
    const rows = options.map((opt) => {
        const short = opt.short ? `-${opt.short}, ` : '    ';
        const arg = opt.arg ? ` ${opt.arg}` : '';
        return { left: `  ${short}--${opt.name}${arg}`, help: opt.help };
    });
    const width = Math.min(30, Math.max(...rows.map((r) => r.left.length)) + 2);
    return rows.map((r) => `${r.left.padEnd(width)}${r.help}`);
}

export function usage() {
    const groups = [];
    for (const opt of OPTIONS) {
        if (opt.name === 'help' || opt.name === 'version') continue;
        let group = groups.find((g) => g.name === opt.group);
        if (!group) {
            group = { name: opt.group, options: [] };
            groups.push(group);
        }
        group.options.push(opt);
    }

    const meta = OPTIONS.filter((o) => o.group === 'Meta');

    const blocks = groups.map((g) => `${g.name}\n${optionLines(g.options).join('\n')}`);

    return [
        `${PROG} - download CMOA, ebookjapan, BookWalker, Kindle and k-manga volumes, browserless.`,
        '',
        `  ${PROG} URL... [options]`,
        '',
        'Each positional URL is detected automatically across all five stores. A CMOA',
        'title page can be given in place of a speedreader URL and is resolved to its',
        'volumes. A Kindle URL may be a reader URL, a store product page or a bare ASIN.',
        'A k-manga URL may be a title page, a /vol/<n>/ page or a viewer-launcher link.',
        'Volumes run in parallel by default.',
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
        'volume belongs. ebookjapan, CMOA, BookWalker and k-manga are supported:',
        '',
        `  ${PROG} --series --download-samplers 'https://www.cmoa.jp/title/167001/'`,
        '',
        'Environment',
        '  BWDD_DIR                BookWalker sampler checkout (only for development;',
        '                          the sampler is vendored, so this is normally unset)',
        '  BWDD_BRIDGE_URL         default mokuro-bridge URL',
        '  NO_COLOR / FORCE_COLOR  control coloured output',
        '',
        blocks.join('\n\n'),
        '',
        `${optionLines(meta).join('\n')}`,
        '',
        'Free volumes on CMOA, ebookjapan, BookWalker and k-manga need no account or',
        'credentials. k-manga pages are block-scrambled, so they need the optional sharp',
        'dependency to be readable (CMOA and Kindle never do).',
        'A signed-in session is needed for BookWalker titles already in your library',
        '(--bw-cookie) and for every Kindle volume (--kindle-cookie): an Amazon volume is',
        'never public, not even a limited-time-free one. See the README.',
        `Defaults: parallel cap ${DEFAULTS.parallelCap}, format ${DEFAULTS.format}.`,
        '',
    ].join('\n');
}

export function versionLine(pkg) {
    return `読破 ${PROG} ${pkg.version}`;
}
