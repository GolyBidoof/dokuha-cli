/**
 * CMOA / BinB image descrambler.
 *
 * The CDN does not serve the pages the reader shows. Each page is stored as a
 * grid of tiles in a permuted order, usually with a thin gap between them. The
 * viewer downloads that scrambled JPEG, decodes it, and copies each tile from
 * its stored position to its display position.
 *
 * Two permuted layouts exist, chosen per page from the decoded scramble tables
 * (see ./protocol.js):
 *
 *   'numeric'  `<C>-<R>-<body>`; a permutation over an C x R grid of tiles that
 *              exactly tiles the image (no padding, no gap).
 *   'tiled'    `=<C>-<R>+<pad>-<body>` (visible) / `=<C>-<R>-<pad>-<body>`
 *              (stored). Same idea, but every stored tile is inset by `pad`
 *              pixels and the body is a compact base64 encoding.
 *
 * "C" counts across and "R" counts down. The body of the tiled form carries
 * three base64 sections: the first C values, the next R values, and C*R
 * permutation entries. Exactly one column and one row carry the leftover
 * pixels, and `Lt`/`Nt`/`Rt`/`Ft` below record which, which is why tile sizes
 * in `regions()` differ by one pixel.
 *
 * The two numeric sections are *not* "the C columns, then the R rows" under
 * the viewer's own names: `Ct` returns them as `{t: <first C>, n: <next R>}`
 * and the viewer then assigns `this.Rt = s.n, this.Ft = s.t, this.Lt = h.n,
 * this.Nt = h.t`. So `Rt`/`Lt` are the *second* (R-entry) run and `Ft`/`Nt`
 * the *first* (C-entry) run, and `Rt`/`Lt` are indexed by a row while
 * `Ft`/`Nt` are indexed by a column.
 *
 * These are ports of the three classes the viewer instantiates in
 * `core/js/speedbinb.js` (minified as `u`, `a` and `f`). Variable names in the
 * tiled port deliberately keep the viewer's single-letter names so the port can
 * be diffed against the original.
 */

import { B64, describeScramble, parseTiledPattern } from './protocol.js';

/**
 * The viewer's `Ht` lookup: character code -> value over the URL-safe base64
 * alphabet. Used only by the tiled layout.
 */
const CHAR_VALUE = new Int8Array(128).fill(-1);
for (let i = 0; i < B64.length; i++) CHAR_VALUE[B64.charCodeAt(i)] = i;
function charValue(ch) {
  const code = ch.charCodeAt(0);
  return code < 128 ? CHAR_VALUE[code] : -1;
}

/** Numeric body characters: uppercase -> value, lowercase -> value + 32. */
function decodeNumericChar(ch) {
  const upper = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.indexOf(ch);
  if (upper >= 0) return upper;
  const lower = 'abcdefghijklmnopqrstuvwxyz'.indexOf(ch);
  if (lower >= 0) return 32 + lower;
  return -1;
}

/** A descrambler that leaves the image untouched. */
class IdentityDescrambler {
  constructor() {
    this.kind = 'none';
  }

  displaySize(width, height) {
    return { width, height };
  }

  regions(width, height) {
    return null;
  }
}

/**
 * Numeric layout: `<C>-<R>-<body>`, a permutation over a C x R tile grid.
 *
 * The viewer ships one of these (minified as class `a`), but no CMOA trial or
 * purchased volume observed so far uses it: every one of the 244 pages of the
 * reference volume selects the tiled layout below. Rather than ship a
 * transcription that has not been checked against real data, this throws.
 * `describeScramble` still detects the format so the caller can report it.
 */
class UnsupportedNumericLayout extends Error {
  constructor(coordTable, pieceTable) {
    super(
      'this volume uses the numeric scramble layout, which this tool does not ' +
        'implement yet (only the tiled layout has been verified against real pages)',
    );
    this.name = 'UnsupportedNumericLayout';
    this.coordTable = coordTable;
    this.pieceTable = pieceTable;
  }
}

/**
 * Tiled layout. Port of the viewer's `f` class (minified names `T`, `j`, `Dt`,
 * `kt`, `Lt`, `Nt`, `Rt`, `Ft`).
 *
 *   T   tiles across
 *   j   tiles down
 *   Dt  padding, in stored-image pixels, around every stored tile
 *   kt  stored tile -> display tile (the composed permutation)
 *   Lt  per stored row, which stored column carries the width remainder
 *   Nt  per stored column, which stored row carries the height remainder
 *   Rt  per display row, which display column carries the width remainder
 *   Ft  per display column, which display row carries the height remainder
 *
 * `Lt`/`Rt` are the body's second section (length j) and `Nt`/`Ft` its first
 * (length T); see the note at the top of this file.
 */
class TiledDescrambler {
  constructor(coordTable, pieceTable) {
    const coord = parseTiledPattern(coordTable);
    const piece = parseTiledPattern(pieceTable);
    if (!coord || !piece) throw new Error('invalid tiled scramble pattern');
    const consistent =
      coord.across === piece.across &&
      coord.down === piece.down &&
      coord.padding === piece.padding &&
      coord.sign === '+' &&
      piece.sign === '-';
    if (!consistent) throw new Error('tiled scramble patterns disagree');

    this.kind = 'tiled';
    this.T = coord.across; // the viewer's `T`: tiles across
    this.j = coord.down; // the viewer's `j`: tiles down
    this.Dt = coord.padding;
    if (this.T > 8 || this.j > 8 || this.T * this.j > 64) {
      throw new Error('tiled scramble pattern too large');
    }
    const expected = this.T + this.j + this.T * this.j;
    if (coord.body.length !== expected || piece.body.length !== expected) {
      throw new Error('tiled scramble body has the wrong length');
    }

    const s = section(this.T, this.j, coord.body);
    const h = section(this.T, this.j, piece.body);
    // `Ct` hands back `{t, n, p}` = (first run, second run, permutation) and the
    // viewer assigns `Rt`/`Lt` the *second* run and `Ft`/`Nt` the first. Taking
    // them in body order instead shifts every source tile by a pixel as soon as
    // the two runs disagree, which is almost always.
    this.Rt = s.second;
    this.Ft = s.first;
    this.Lt = h.second;
    this.Nt = h.first;
    // `kt[storedTileIndex] = displayTileIndex`.
    this.kt = [];
    for (let i = 0; i < this.T * this.j; i++) this.kt.push(s.perm[h.perm[i]]);
  }

  /** The viewer's `It`: images smaller than the padded grid are not permuted. */
  applies(width, height) {
    const t = 2 * this.T * this.Dt;
    const j = 2 * this.j * this.Dt;
    return (
      width >= 64 + t &&
      height >= 64 + j &&
      width * height >= (320 + t) * (320 + j)
    );
  }

  /** The viewer's `yt`: the visible size once the padding is dropped. */
  displaySize(width, height) {
    if (!this.applies(width, height)) return { width, height };
    return {
      width: width - 2 * this.T * this.Dt,
      height: height - 2 * this.j * this.Dt,
    };
  }

  /** The viewer's `Ot`. `width`/`height` are those of the stored image. */
  regions(width, height) {
    const identity = [{ xsrc: 0, ysrc: 0, width, height, xdest: 0, ydest: 0 }];
    if (!this.applies(width, height)) return identity;

    const i = width - 2 * this.T * this.Dt;
    const n = height - 2 * this.j * this.Dt;
    const r = Math.floor((i + this.T - 1) / this.T);
    const e = i - (this.T - 1) * r;
    const s = Math.floor((n + this.j - 1) / this.j);
    const h = n - (this.j - 1) * s;

    const out = [];
    for (let o = 0; o < this.T * this.j; o++) {
      const a = o % this.T;
      const f = Math.floor(o / this.T);
      const c = this.Dt + a * (r + 2 * this.Dt) + (this.Lt[f] < a ? e - r : 0);
      const l = this.Dt + f * (s + 2 * this.Dt) + (this.Nt[a] < f ? h - s : 0);
      const v = this.kt[o] % this.T;
      const d = Math.floor(this.kt[o] / this.T);
      const ws = v * r + (this.Rt[d] < v ? e - r : 0);
      const hs = d * s + (this.Ft[v] < d ? h - s : 0);
      // A source tile is as wide/tall as the *stored* grid says -- the same grid
      // that placed `c`/`l` above -- and the viewer copies exactly the pixels the
      // stored tile holds. Sizing it from the display grid (`Rt`/`Ft`) instead
      // mismatches the position stride by a pixel on the remainder row/column.
      const w = this.Lt[f] === a ? e : r;
      const m = this.Nt[a] === f ? h : s;
      if (i > 0 && n > 0) {
        out.push({
          xsrc: c,
          ysrc: l,
          width: w,
          height: m,
          xdest: ws,
          ydest: hs,
        });
      }
    }
    return out;
  }
}

/**
 * Split a tiled body into its three base64 sections, in the order the viewer's
 * `Ct` reads them and under `Ct`'s own names: first `T` values (`t`), next `j`
 * values (`n`), then the `T*j` permutation (`p`). Do not read the two numeric
 * runs as "columns then rows" -- `TiledDescrambler` documents how they are
 * assigned to `Rt`/`Lt`/`Ft`/`Nt`.
 */
function section(T, j, body) {
  const values = [];
  for (let i = 0; i < T + j + T * j; i++) {
    const value = charValue(body.charAt(i));
    values.push(value < 0 ? 0 : value);
  }
  return {
    first: values.slice(0, T),
    second: values.slice(T, T + j),
    perm: values.slice(T + j),
  };
}

/**
 * Build a descrambler for one page, mirroring the viewer's `Reader.mt`
 * dispatch. Returns:
 *
 *   kind                 'none' | 'numeric' | 'tiled'
 *   displaySize(w, h)    size of the visible image
 *   regions(w, h)        source -> destination rectangles, or null when the
 *                        page is served already assembled
 */
export function compileDescrambler(coordTable, pieceTable) {
  const kind = describeScramble(coordTable, pieceTable);
  let instance;
  if (kind === 'tiled') instance = new TiledDescrambler(coordTable, pieceTable);
  else if (kind === 'numeric') throw new UnsupportedNumericLayout(coordTable, pieceTable);
  else instance = new IdentityDescrambler();
  return {
    kind: instance.kind,
    displaySize: (w, h) => instance.displaySize(w, h),
    regions: (w, h) => instance.regions(w, h),
  };
}
