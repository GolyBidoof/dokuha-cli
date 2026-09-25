/**
 * PNG output for descrambled pages.
 *
 * The descrambler works on the JPEG's own YCbCr planes and only converts to RGB
 * at the end, so the encoder receives an interleaved 8-bit RGB buffer. PNG is
 * used because Node ships a zlib implementation; no native image library is
 * needed for correctness.
 *
 * Every scanline gets a per-line filter chosen by the standard minimum-sum-of-
 * absolute-differences heuristic. Without filtering a manga page deflates to
 * roughly 3 MB; with it, to well under a megabyte.
 */

import zlib from 'node:zlib';

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typed = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typed), 0);
  return Buffer.concat([len, typed, crc]);
}

/** Apply one PNG filter to a scanline; returns the filtered bytes. */
function filterLine(type, cur, prev, bpp, out) {
  const n = cur.length;
  switch (type) {
    case 0:
      cur.copy(out, 0);
      break;
    case 1:
      for (let i = 0; i < n; i++) out[i] = (cur[i] - (i >= bpp ? cur[i - bpp] : 0)) & 0xff;
      break;
    case 2:
      for (let i = 0; i < n; i++) out[i] = (cur[i] - prev[i]) & 0xff;
      break;
    case 3:
      for (let i = 0; i < n; i++) {
        const left = i >= bpp ? cur[i - bpp] : 0;
        out[i] = (cur[i] - ((left + prev[i]) >> 1)) & 0xff;
      }
      break;
    default: {
      for (let i = 0; i < n; i++) {
        const a = i >= bpp ? cur[i - bpp] : 0;
        const b = prev[i];
        const c = i >= bpp ? prev[i - bpp] : 0;
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        const pred = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
        out[i] = (cur[i] - pred) & 0xff;
      }
    }
  }
  return out;
}

/** Absolute-sum heuristic used to pick the cheapest filter for a line. */
function scoreLine(buf) {
  let sum = 0;
  for (let i = 0; i < buf.length; i++) {
    const v = buf[i];
    sum += v < 128 ? v : 256 - v;
  }
  return sum;
}

/**
 * Encode an interleaved 8-bit RGB buffer as PNG.
 *
 * @param {Uint8Array|Buffer} rgb  width * height * 3 bytes
 * @param {number} width
 * @param {number} height
 * @param {{level?: number, filter?: boolean}} [options]
 */
export function encodePng(rgb, width, height, options = {}) {
  const level = options.level ?? 9;
  const useFilter = options.filter ?? true;
  const bpp = 3;
  const stride = width * bpp;
  const expected = stride * height;
  if (rgb.length < expected) {
    throw new Error(`encodePng: need ${expected} bytes, got ${rgb.length}`);
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type: truecolour
  ihdr[10] = 0; // deflate
  ihdr[11] = 0; // adaptive filtering
  ihdr[12] = 0; // no interlace

  // Wrap once so scanlines can be taken as subarrays; copying per line would
  // dominate the cost for full-page images.
  const source = Buffer.isBuffer(rgb) ? rgb : Buffer.from(rgb.buffer, rgb.byteOffset, rgb.byteLength);
  const filtered = Buffer.alloc((stride + 1) * height);
  const candidates = [0, 1, 2, 3, 4].map((t) => Buffer.alloc(stride));
  let prev = Buffer.alloc(stride);
  for (let y = 0; y < height; y++) {
    const cur = source.subarray(y * stride, (y + 1) * stride);
    let bestType = 0;
    let bestScore = Infinity;
    for (const type of useFilter ? [0, 1, 2, 3, 4] : [0]) {
      const out = filterLine(type, cur, prev, bpp, candidates[type]);
      const score = scoreLine(out);
      if (score < bestScore) {
        bestScore = score;
        bestType = type;
      }
    }
    const rowStart = y * (stride + 1);
    filtered[rowStart] = bestType;
    filterLine(bestType, cur, prev, bpp, filtered.subarray(rowStart + 1, rowStart + 1 + stride));
    prev = cur;
  }

  const idat = zlib.deflateSync(filtered, { level });
  return Buffer.concat([
    SIGNATURE,
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}
