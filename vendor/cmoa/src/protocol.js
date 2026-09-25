/**
 * CMOA / BinB ("SpeedBinb") speed-reader protocol.
 *
 * Everything here was recovered from the viewer that the site itself runs
 * (`core/js/speedbinb.js`) plus a recorded HAR of
 * `https://www.cmoa.jp/bib/speedreader/?cid=...`. No browser is involved:
 * the two pieces of client-side state the API insists on (`k` on the
 * content-info call, `p` on every content/image call) are both derived from
 * data the client already has.
 *
 *   k  a per-request token generated locally from the cid (see generateK).
 *      The server only shape-checks it; it does not remember it.
 *   p  the request token handed back in the bibGetCntntInfo response.
 *
 * Pipeline:
 *   generateK(cid)
 *     -> GET  /bib/sws/bibGetCntntInfo.php   (ContentsServer, ViewMode, p, scramble tables)
 *     -> decodeTables()                      (XOR-permuted ASCII -> JSON)
 *     -> GET  {server}/sbcGetCntnt.php       (ttx: the page list)
 *     -> parsePageList()                     (timgsLandscape, i.e. the pages actually shown)
 *     -> GET  {server}/sbcGetImg.php         (one JPEG per page)
 */

/** Alphabet used by the viewer's random-string / base64 helpers. */
export const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

/** Scramble-table grids are `rows x cols`, both at most 8. */
const MAX_PIECE_AXIS = 8;
const MAX_PIECE_COUNT = 64;

/**
 * The viewer's `getRandomString`: a string of `length` characters from the
 * URL-safe base64 alphabet.
 */
export function randomString(length, random = Math.random) {
  let out = '';
  for (let i = 0; i < length; i++) out += B64[(random() * B64.length) | 0];
  return out;
}

/**
 * The viewer's `Reader.J(cid)` — the `k` query parameter.
 *
 * 16 random characters, then for each position one additional character chosen
 * by XOR-accumulating the random string against the cid repeated, truncated and
 * reversed to 16 bytes. Reproduced bit-for-bit from `speedbinb.js`.
 */
export function generateK(cid, random = Math.random) {
  const nonce = randomString(16, random);
  const repeated = Array(Math.ceil(16 / String(cid).length) + 1).join(String(cid));
  const head = repeated.substr(0, 16);
  const tail = repeated.substr(-16, 16);
  let xorNonce = 0;
  let xorHead = 0;
  let xorTail = 0;
  return nonce
    .split('')
    .map((ch, i) => {
      xorNonce ^= nonce.charCodeAt(i);
      xorHead ^= head.charCodeAt(i);
      xorTail ^= tail.charCodeAt(i);
      return ch + B64[(xorNonce + xorHead + xorTail) & 63];
    })
    .join('');
}

/**
 * The viewer's `Reader.jt(cid, k, encoded)`.
 *
 * The scramble tables ship as ASCII in the range [32, 126) and are recovered by
 * running a 32-bit LFSR seeded from `cid + ':' + k` and subtracting the low byte
 * of each state, modulo 94. The plaintext is JSON.
 */
export function decodeTable(cid, k, encoded) {
  if (typeof encoded !== 'string') {
    throw new TypeError('decodeTable: encoded table must be a string');
  }
  const seed = `${cid}:${k}`;
  let hash = 0;
  for (let i = 0; i < seed.length; i++) {
    // `+` not `|=`: the viewer adds each shifted char code into a number that
    // is truncated to 31 bits afterwards.
    hash += seed.charCodeAt(i) << (i % 16);
  }
  hash &= 0x7fffffff;
  if (hash === 0) hash = 0x12345678;

  let state = hash;
  let out = '';
  for (let i = 0; i < encoded.length; i++) {
    // LFSR: `u = (u >>> 1) ^ (1210056708 & -(u & 1))`.
    state = ((state >>> 1) ^ (1210056708 & -(state & 1))) >>> 0;
    const ch = (encoded.charCodeAt(i) - 32 + state) % 94 + 32;
    out += String.fromCharCode(ch);
  }
  return JSON.parse(out);
}

/** Decode all four scramble tables at once. */
export function decodeTables(cid, k, item) {
  return {
    stbl: decodeTable(cid, k, item.stbl),
    ttbl: decodeTable(cid, k, item.ttbl),
    ctbl: decodeTable(cid, k, item.ctbl),
    ptbl: decodeTable(cid, k, item.ptbl),
  };
}

/**
 * The viewer's `Reader.mt(src)`: choose the scramble tables for one page from
 * the page's image path.
 *
 * Both eight-entry selection tables are indexed by a checksum of the filename
 * (sum of characters at even/odd offsets, modulo 8), which is why a per-page
 * lookup is needed at all.
 */
export function selectScramble(src, tables) {
  const checksum = [0, 0];
  if (src) {
    const start = src.lastIndexOf('/') + 1;
    for (let i = 0; i < src.length - start; i++) {
      checksum[i % 2] += src.charCodeAt(start + i);
    }
    checksum[0] %= 8;
    checksum[1] %= 8;
  }
  return {
    checksum,
    // `ptbl` is indexed by the even checksum, `ctbl` by the odd one. Unlike the
    // table decoding above, no token is involved.
    pieceTable: tables.ptbl[checksum[0]],
    coordTable: tables.ctbl[checksum[1]],
  };
}

/**
 * Which descrambler class the viewer picks for a (coordTable, pieceTable) pair.
 *
 * The two strings are self-describing:
 *   '=R-C+X-...'  a tiled permutation of an R x C grid with X pixels of padding
 *   '12abc...'    a plain digit-encoded permutation
 *   ''            no scrambling
 */
export function describeScramble(coordTable, pieceTable) {
  const coord = String(coordTable ?? '');
  const piece = String(pieceTable ?? '');
  if (coord === '' && piece === '') return 'none';
  if (coord.charAt(0) === '=' && piece.charAt(0) === '=') return 'tiled';
  if (/^[0-9]/.test(coord) && /^[0-9]/.test(piece)) return 'numeric';
  return 'unknown';
}

/** Parse a `=R-C+X-BODY` scramble pattern. */
export function parseTiledPattern(pattern) {
  const m = /^=([0-9]+)-([0-9]+)([-+])([0-9]+)-([-_0-9A-Za-z]+)$/.exec(String(pattern));
  if (!m) return null;
  return {
    rows: parseInt(m[1], 10),
    cols: parseInt(m[2], 10),
    sign: m[3],
    padding: parseInt(m[4], 10),
    body: m[5],
  };
}

export const constants = { MAX_PIECE_AXIS, MAX_PIECE_COUNT };
