/**
 * Help and usage text.
 *
 * Generated from the option declarations in `options.js` so the help cannot drift
 * away from what the parser actually accepts, which is the usual failure mode for
 * hand-maintained usage blocks.
 */

import { OPTIONS, DEFAULTS } from './options.js';

const PROG = 'manga-dl';

/** Two-column alignment for the option lines. */
function optionLines(options) {
    const rows = options.map((opt) => {
        const short = opt.short ? `-${opt.short}, ` : '    ';
        const arg = opt.arg ? ` ${opt.arg}` : '';
        return { left: `  ${short}--${opt.name}${arg}`, help: opt.help };
    });
    const width = Math.min(30, Math.max(...rows.map((r) => r.left.length)) + 2);
    return rows.map((r) => `${r.left.padEnd(width)}${r.help}`);
}

/** Render the full help, grouped the way the options are declared. */
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
    // Meta flags are always listed last.
    const meta = OPTIONS.filter((o) => o.group === 'Meta');

    const blocks = groups.map((g) => `${g.name}\n${optionLines(g.options).join('\n')}`);

    return [
        `${PROG} - download CMOA, ebookjapan and BookWalker volumes, browserless.`,
        '',
        `  ${PROG} URL... [options]`,
        '',
        'Each positional URL is detected automatically across all three stores. A CMOA',
        'title page can be given in place of a speedreader URL and is resolved to its',
        'volumes. Volumes run in parallel by default.',
        '',
        `  ${PROG} \\`,
        "    'https://ebookjapan.yahoo.co.jp/books/126344/A000065415/' \\",
        "    'https://www.cmoa.jp/title/249510/' \\",
        "    'https://bookwalker.jp/def45047f5-6b90-4d4f-84f7-bd8263daee70/?sample=2' \\",
        `    --out ./library --mokuro`,
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
        'Free volumes on all three stores need no account or credentials. A signed-in',
        'BookWalker session is only needed for titles already in your library; pass it',
        `with --bw-cookie (see README). Defaults: series cap ${DEFAULTS.seriesCap}, format ${DEFAULTS.format}.`,
        '',
    ].join('\n');
}

/** Version line, read from package.json so there is one source of truth. */
export function versionLine(pkg) {
    return `${PROG} ${pkg.version}`;
}
