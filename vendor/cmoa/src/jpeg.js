/**
 * Minimal baseline JPEG decoder, enough for CMOA page images.
 *
 * CMOA serves baseline sequential (`SOF0`), 4:4:4 JPEGs with *non-standard*
 * Huffman tables, so a decoder that assumes the usual Annex K tables will not
 * work. This one reads whatever `DHT` segments the file carries.
 *
 * Deliberately narrow:
 *   - baseline sequential only (no progressive)
 *   - 8-bit samples
 *   - any component sampling factors, but CMOA uses 1x1 for all three
 *   - no CMYK / Adobe transforms
 *
 * The decoder hands back the raw YCbCr planes rather than RGB. That is what the
 * descrambler wants: it copies rectangles between positions, so staying in the
 * JPEG's own colour space avoids doing a colour conversion twice and keeps the
 * output free of chroma bleed at tile seams.
 */

/** DHT table class nibbles. */
const DC_CLASS = 0;
const AC_CLASS = 1;

const ZIGZAG = new Int32Array([
  0, 1, 8, 16, 9, 2, 3, 10, 17, 24, 32, 25, 18, 11, 4, 5, 12, 19, 26, 33, 40, 48, 41, 34, 27, 20,
  13, 6, 7, 14, 21, 28, 35, 42, 49, 56, 57, 50, 43, 36, 29, 22, 15, 23, 30, 37, 44, 51, 58, 59, 52,
  45, 38, 31, 39, 46, 53, 60, 61, 54, 47, 55, 62, 63,
]);

/** Even part of the AAN-ish 1-D IDCT basis, precomputed as floats. */
const COS = new Float64Array(64);
for (let u = 0; u < 8; u++) {
  for (let x = 0; x < 8; x++) {
    COS[u * 8 + x] = Math.cos(((2 * x + 1) * u * Math.PI) / 16) * (u === 0 ? Math.SQRT1_2 : 1);
  }
}

class BitReader {
  constructor(data, offset) {
    this.data = data;
    this.pos = offset;
    this.bitBuf = 0;
    this.bitCount = 0;
    this.eof = false;
  }

  /** Read one byte, transparently unescaping 0xFF00 stuffing. */
  byte() {
    if (this.pos >= this.data.length) {
      this.eof = true;
      return 0;
    }
    const b = this.data[this.pos++];
    if (b !== 0xff) return b;
    // A 0xFF byte is either stuffed (followed by 0x00) or a marker, which means
    // the entropy-coded data has ended.
    if (this.data[this.pos] === 0x00) {
      this.pos++;
      return 0xff;
    }
    this.eof = true;
    return 0;
  }

  bits(n) {
    while (this.bitCount < n) {
      this.bitBuf = (this.bitBuf << 8) | this.byte();
      this.bitCount += 8;
    }
    const v = (this.bitBuf >>> (this.bitCount - n)) & ((1 << n) - 1);
    this.bitCount -= n;
    return v;
  }

  /** Discard bits up to the next byte boundary. */
  align() {
    this.bitCount = 0;
    this.bitBuf = 0;
  }

  /** After a restart marker, resynchronise on the next 0xFF RSTn. */
  resync() {
    this.align();
    while (this.pos < this.data.length - 1) {
      if (this.data[this.pos] === 0xff && this.data[this.pos + 1] >= 0xd0 && this.data[this.pos + 1] <= 0xd7) {
        this.pos += 2;
        return true;
      }
      this.pos++;
    }
    return false;
  }
}

/** Canonical Huffman table as a code -> symbol lookup. */
function buildHuffman(counts, symbols) {
  const minCode = new Int32Array(17);
  const maxCode = new Int32Array(17).fill(-1);
  const valPtr = new Int32Array(17);
  let code = 0;
  let k = 0;
  for (let len = 1; len <= 16; len++) {
    minCode[len] = code;
    valPtr[len] = k;
    code += counts[len - 1] ?? 0;
    k += counts[len - 1] ?? 0;
    maxCode[len] = counts[len - 1] ? code - 1 : -1;
    code <<= 1;
  }
  return { minCode, maxCode, valPtr, symbols };
}

function decodeHuffman(br, table) {
  let code = 0;
  for (let len = 1; len <= 16; len++) {
    code = (code << 1) | br.bits(1);
    if (table.maxCode[len] >= 0 && code <= table.maxCode[len]) {
      const index = table.valPtr[len] + code - table.minCode[len];
      return table.symbols[index] ?? -1;
    }
  }
  return -1;
}

/** Accurate separable 1-D IDCT over an 8x8 block of dequantised coefficients. */
const BLOCK = new Float64Array(64);
function idct(coeff, out) {
  // Rows.
  for (let y = 0; y < 8; y++) {
    const base = y * 8;
    for (let x = 0; x < 8; x++) {
      let sum = 0;
      for (let u = 0; u < 8; u++) {
        const c = coeff[base + u];
        if (c !== 0) sum += c * COS[u * 8 + x];
      }
      BLOCK[base + x] = sum;
    }
  }
  // Columns, then scale by 1/4 and level-shift by +128.
  for (let x = 0; x < 8; x++) {
    for (let y = 0; y < 8; y++) {
      let sum = 0;
      for (let v = 0; v < 8; v++) {
        const c = BLOCK[v * 8 + x];
        if (c !== 0) sum += c * COS[v * 8 + y];
      }
      const value = sum * 0.25 + 128;
      out[y * 8 + x] = value < 0 ? 0 : value > 255 ? 255 : value;
    }
  }
}

/**
 * Decode a baseline JPEG.
 *
 * Returns `{ width, height, components: [{ id, h, v, plane, stride }] }` with
 * `plane` holding one byte per sample for that component at its own resolution.
 */
export function decodeJpeg(bytes) {
  const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (data[0] !== 0xff || data[1] !== 0xd8) throw new Error('not a JPEG');

  const quant = new Map();
  const huff = new Map();
  let frame = null;
  let restartInterval = 0;
  let scan = null;

  let pos = 2;
  while (pos < data.length - 1) {
    if (data[pos] !== 0xff) {
      pos++;
      continue;
    }
    const marker = data[pos + 1];
    pos += 2;
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) continue;
    if (marker === 0xd9) break; // EOI
    const length = (data[pos] << 8) | data[pos + 1];
    const segEnd = pos + length;
    const seg = data.subarray(pos + 2, segEnd);

    if (marker === 0xdb) {
      // DQT
      let p = 0;
      while (p < seg.length) {
        const pq = seg[p] >> 4;
        const tq = seg[p] & 15;
        p++;
        const table = new Int32Array(64);
        for (let i = 0; i < 64; i++) {
          table[ZIGZAG[i]] = pq ? (seg[p] << 8) | seg[p + 1] : seg[p];
          p += pq ? 2 : 1;
        }
        quant.set(tq, table);
      }
    } else if (marker === 0xc4) {
      // DHT
      let p = 0;
      while (p < seg.length) {
        const tc = seg[p] >> 4;
        const th = seg[p] & 15;
        p++;
        const counts = Array.from(seg.subarray(p, p + 16));
        p += 16;
        const total = counts.reduce((a, b) => a + b, 0);
        const symbols = Array.from(seg.subarray(p, p + total));
        p += total;
        huff.set((tc << 4) | th, buildHuffman(counts, symbols));
      }
    } else if (marker === 0xdd) {
      restartInterval = (seg[0] << 8) | seg[1];
    } else if (marker === 0xc0 || marker === 0xc1) {
      // SOF0/SOF1: baseline sequential
      frame = {
        precision: seg[0],
        height: (seg[1] << 8) | seg[2],
        width: (seg[3] << 8) | seg[4],
        components: [],
      };
      const n = seg[5];
      for (let i = 0; i < n; i++) {
        frame.components.push({
          id: seg[6 + i * 3],
          h: seg[7 + i * 3] >> 4,
          v: seg[7 + i * 3] & 15,
          tq: seg[8 + i * 3],
        });
      }
    } else if (marker === 0xc2) {
      throw new Error('progressive JPEG is not supported');
    } else if (marker === 0xda) {
      // SOS: scan header, then entropy-coded data follows.
      const ns = seg[0];
      scan = [];
      for (let i = 0; i < ns; i++) {
        scan.push({ cs: seg[1 + i * 2], td: seg[2 + i * 2] >> 4, ta: seg[2 + i * 2] & 15 });
      }
      pos = segEnd;
      break;
    }
    pos = segEnd;
  }

  if (!frame) throw new Error('no SOF segment');
  if (!scan) throw new Error('no SOS segment');
  if (frame.precision !== 8) throw new Error(`unsupported sample precision ${frame.precision}`);

  const { width, height } = frame;
  const maxH = Math.max(...frame.components.map((c) => c.h));
  const maxV = Math.max(...frame.components.map((c) => c.v));
  const mcuW = 8 * maxH;
  const mcuH = 8 * maxV;
  const mcusX = Math.ceil(width / mcuW);
  const mcusY = Math.ceil(height / mcuH);

  // Allocate a plane per component, at its own sampling resolution.
  for (const c of frame.components) {
    c.stride = mcusX * c.h * 8;
    c.planeHeight = mcusY * c.v * 8;
    c.plane = new Uint8Array(c.stride * c.planeHeight);
    c.dcPred = 0;
  }

  const byId = new Map(frame.components.map((c) => [c.id, c]));
  const scanComps = scan.map((s) => {
    const comp = byId.get(s.cs);
    if (!comp) throw new Error(`scan references unknown component ${s.cs}`);
    // The scan header's Td/Ta fields are bare table *ids* (0 or 1); the class
    // bits live in the DHT specifier byte, so DC and AC must be looked up with
    // their class nibble restored. Getting this wrong silently decodes the
    // whole image through the DC table.
    return {
      comp,
      dc: huff.get((DC_CLASS << 4) | s.td),
      ac: huff.get((AC_CLASS << 4) | s.ta),
      q: quant.get(comp.tq),
    };
  });
  for (const sc of scanComps) {
    if (!sc.dc || !sc.ac || !sc.q) throw new Error('scan references a missing table');
  }

  const br = new BitReader(data, pos);
  const coeff = new Float64Array(64);
  const block = new Uint8Array(64);
  let mcuCount = 0;

  for (let my = 0; my < mcusY; my++) {
    for (let mx = 0; mx < mcusX; mx++) {
      if (restartInterval && mcuCount > 0 && mcuCount % restartInterval === 0) {
        br.resync();
        for (const c of frame.components) c.dcPred = 0;
      }
      for (const sc of scanComps) {
        const { comp, q } = sc;
        for (let by = 0; by < comp.v; by++) {
          for (let bx = 0; bx < comp.h; bx++) {
            coeff.fill(0);
            // DC
            const t = decodeHuffman(br, sc.dc);
            if (t < 0) throw new Error('corrupt JPEG: bad DC symbol');
            let diff = 0;
            if (t > 0) diff = br.bits(t);
            if (t > 0 && diff < 1 << (t - 1)) diff -= (1 << t) - 1;
            comp.dcPred += diff;
            coeff[0] = comp.dcPred * q[0];
            // AC
            let k = 1;
            while (k < 64) {
              const rs = decodeHuffman(br, sc.ac);
              if (rs < 0) throw new Error('corrupt JPEG: bad AC symbol');
              const run = rs >> 4;
              const size = rs & 15;
              if (size === 0) {
                if (run === 15) {
                  k += 16;
                  continue;
                }
                break;
              }
              k += run;
              if (k > 63) break;
              let v = br.bits(size);
              if (v < 1 << (size - 1)) v -= (1 << size) - 1;
              coeff[ZIGZAG[k]] = v * q[ZIGZAG[k]];
              k++;
            }
            idct(coeff, block);
            // Store into the component plane at this block's position.
            const px = (mx * comp.h + bx) * 8;
            const py = (my * comp.v + by) * 8;
            const stride = comp.stride;
            const plane = comp.plane;
            for (let y = 0; y < 8; y++) {
              const row = (py + y) * stride + px;
              const src = y * 8;
              plane[row] = block[src];
              plane[row + 1] = block[src + 1];
              plane[row + 2] = block[src + 2];
              plane[row + 3] = block[src + 3];
              plane[row + 4] = block[src + 4];
              plane[row + 5] = block[src + 5];
              plane[row + 6] = block[src + 6];
              plane[row + 7] = block[src + 7];
            }
          }
        }
      }
      mcuCount++;
    }
  }

  return {
    width,
    height,
    /** YCbCr planes in component order (Y, Cb, Cr for the usual case). */
    components: frame.components.map((c) => ({
      id: c.id,
      h: c.h,
      v: c.v,
      stride: c.stride,
      width: c.stride,
      height: c.planeHeight,
      plane: c.plane,
    })),
    maxH,
    maxV,
  };
}

/**
 * Sample an RGB pixel from a decoded YCbCr image.
 *
 * `x`/`y` are in image pixels; component sampling factors are honoured so this
 * also works for subsampled files even though CMOA does not produce them.
 */
export function sampleRgb(image, x, y, out) {
  const components = image.components;
  const Y = components[0];
  const Cb = components[1];
  const Cr = components[2];
  const ySample = Y.plane[y * Y.stride + x];
  let cbSample;
  let crSample;
  if (image.maxH === 1 && image.maxV === 1 && Cb.h === 1 && Cb.v === 1) {
    // The common 4:4:4 case: chroma is sample-for-sample, so skip the scaling.
    const chromaIndex = y * Cb.stride + x;
    cbSample = Cb.plane[chromaIndex];
    crSample = Cr.plane[chromaIndex];
  } else {
    const cx = Math.floor(x / image.maxH) * Cb.h;
    const cy = Math.floor(y / image.maxV) * Cb.v;
    const chromaIndex = cy * Cb.stride + cx;
    cbSample = Cb.plane[chromaIndex] ?? 128;
    crSample = Cr.plane[chromaIndex] ?? 128;
  }
  const cbv = cbSample - 128;
  const crv = crSample - 128;
  const r = ySample + 1.402 * crv;
  const g = ySample - 0.344136 * cbv - 0.714136 * crv;
  const b = ySample + 1.772 * cbv;
  out[0] = r < 0 ? 0 : r > 255 ? 255 : r;
  out[1] = g < 0 ? 0 : g > 255 ? 255 : g;
  out[2] = b < 0 ? 0 : b > 255 ? 255 : b;
  return out;
}
