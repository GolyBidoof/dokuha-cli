/**
 * Work out which store a positional argument belongs to.
 *
 * Deliberately synchronous and offline: a CMOA title page needs a network probe to
 * expand into volumes, and that is the caller's job. Recognising a CMOA *title*
 * page here, rather than only a speedreader URL, is what lets a plain
 * `https://www.cmoa.jp/title/167701/` be pasted in.
 *
 * Each result carries whatever the stores need, and the shapes genuinely differ,
 * so they are normalised explicitly instead of being passed around as raw URLs.
 */

/** A bare BookWalker uuid, optionally carrying the `de` prefix. */
const BW_UUID = '(?:de)?([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})';

const PATTERNS = [
    {
        kind: 'cmoa-title',
        // A /vol/<n>/ is more specific than --cm-volume, so it is captured and wins.
        re: /cmoa\.jp\/title\/(\d+)\/vol\/(\d+)/i,
        build: (m, raw) => ({ kind: 'cmoa-title', titleId: m[1], volume: Number(m[2]), url: raw }),
    },
    {
        kind: 'cmoa-title',
        re: /cmoa\.jp\/title\/(\d+)/i,
        build: (m, raw) => ({ kind: 'cmoa-title', titleId: m[1], volume: null, url: raw }),
    },
    {
        kind: 'cmoa',
        re: /cmoa\.jp\/bib\/speedreader\/?\?[^\s]*?cid=(\d{10}_jp_\d{4})/i,
        build: (m, raw) => ({ kind: 'cmoa', cid: m[1], url: raw }),
    },
    {
        kind: 'cmoa',
        re: /^(\d{10}_jp_\d{4})$/,
        build: (m, raw) => ({ kind: 'cmoa', cid: m[1], url: raw }),
    },
    {
        kind: 'ebookjapan',
        re: /ebookjapan\.yahoo\.co\.jp/i,
        build: (m, raw) => ({ kind: 'ebookjapan', url: raw }),
    },
    {
        kind: 'ebookjapan',
        re: /^(A\d{6,})$/,
        build: (m, raw) => ({ kind: 'ebookjapan', url: raw }),
    },
    {
        kind: 'bookwalker',
        re: new RegExp(`bookwalker\\.jp\\/${BW_UUID}`, 'i'),
        build: (m, raw) => ({
            kind: 'bookwalker',
            // The bare uuid is what the licence handshake wants; it builds
            // `https://bookwalker.jp/de${cid}/` itself, so a prefixed value gives
            // `dede...` and 404s every route.
            cid: m[1].toLowerCase(),
            // The canonical URL is what the page job wants: it parses the uuid
            // back out of the `/de<uuid>` path and rejects a bare cid. Any
            // `?sample=2` is dropped, because the trial route is selected by an
            // option and a trailing query would be spliced into the cid too.
            url: `https://bookwalker.jp/de${m[1].toLowerCase()}/`,
        }),
    },
    {
        kind: 'bookwalker',
        re: new RegExp(`^${BW_UUID}$`, 'i'),
        build: (m, raw) => ({
            kind: 'bookwalker',
            cid: m[1].toLowerCase(),
            url: `https://bookwalker.jp/de${m[1].toLowerCase()}/`,
        }),
    },
];

/**
 * Classify one positional argument.
 *
 * @param {string} input raw argument as typed by the user
 * @returns {{kind: string, reason?: string, cid?: string, titleId?: string, volume?: number|null, url: string}}
 *   `kind: 'unknown'` carries a `reason` for the caller to report.
 */
export function detectSource(input) {
    const raw = String(input ?? '').trim();
    if (!raw) return { kind: 'unknown', reason: 'empty input', url: raw };

    for (const pattern of PATTERNS) {
        const m = pattern.re.exec(raw);
        if (m) return pattern.build(m, raw);
    }
    return { kind: 'unknown', reason: 'not a CMOA, ebookjapan or BookWalker URL', url: raw };
}

/** Human label for a store, used in progress rows and reports. */
export const STORE_LABELS = {
    cmoa: 'CMOA',
    ebookjapan: 'EBJ',
    bookwalker: 'BW',
};
