/**
 * Baseline JPEG encoder, enough to write descrambled CMOA pages.
 *
 * Written from scratch so the tool has no native image dependency: Node already
 * provides zlib for PNG, and the only other piece needed to ship sane file sizes
 * is a JPEG writer. Output is baseline sequential (SOF0), 8-bit, 4:2:0, with the
 * standard Annex K quantisation and Huffman tables.
 *
 * 4:2:0 rather than the source's 4:4:4 is deliberate: these are greyscale-ish
 * manga pages, so a full-resolution chroma pair would multiply the file size
 * for no visible gain. Pass `quality: 100` and `subsample: false` if exact
 * fidelity matters more than size.
 */

const ZIGZAG = new Int32Array([
  0, 1, 8, 16, 9, 2, 3, 10, 17, 24, 32, 25, 18, 11, 4, 5, 12, 19, 26, 33, 40, 48, 41, 34, 27, 20,
  13, 6, 7, 14, 21, 28, 35, 42, 49, 56, 57, 50, 43, 36, 29, 22, 15, 23, 30, 37, 44, 51, 58, 59, 52,
  45, 38, 31, 39, 46, 53, 60, 61, 54, 47, 55, 62, 63,
]);

const STD_LUM_QUANT = [
  16, 11, 10, 16, 24, 40, 51, 61, 12, 12, 14, 19, 26, 58, 60, 55, 14, 13, 16, 24, 40, 57, 69, 56, 14,
  17, 22, 29, 51, 87, 80, 62, 18, 22, 37, 56, 68, 109, 103, 77, 24, 35, 55, 64, 81, 104, 113, 92, 49,
  64, 78, 87, 103, 121, 120, 101, 72, 92, 95, 98, 112, 100, 103, 99,
];
const STD_CHROM_QUANT = [
  17, 18, 24, 47, 99, 99, 99, 99, 18, 21, 26, 66, 99, 99, 99, 99, 24, 26, 56, 99, 99, 99, 99, 99, 47,
  66, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99,
  99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99,
];

const STD_DC_LUM_BITS = [0, 1, 5, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0];
const STD_DC_LUM_VALS = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11];
const STD_AC_LUM_BITS = [0, 2, 1, 3, 3, 2, 4, 3, 5, 5, 4, 4, 0, 0, 1, 0x7d];
const STD_AC_LUM_VALS = [
  0x01, 0x02, 0x03, 0x00, 0x04, 0x11, 0x05, 0x12, 0x21, 0x31, 0x41, 0x06, 0x13, 0x51, 0x61, 0x07,
  0x22, 0x71, 0x14, 0x32, 0x81, 0x91, 0xa1, 0x08, 0x23, 0x42, 0xb1, 0xc1, 0x15, 0x52, 0xd1, 0xf0,
  0x24, 0x33, 0x62, 0x72, 0x82, 0x09, 0x0a, 0x16, 0x17, 0x18, 0x19, 0x1a, 0x25, 0x26, 0x27, 0x28,
  0x29, 0x2a, 0x34, 0x35, 0x36, 0x37, 0x38, 0x39, 0x3a, 0x43, 0x44, 0x45, 0x46, 0x47, 0x48, 0x49,
  0x4a, 0x53, 0x54, 0x55, 0x56, 0x57, 0x58, 0x59, 0x5a, 0x63, 0x64, 0x65, 0x66, 0x67, 0x68, 0x69,
  0x6a, 0x73, 0x74, 0x75, 0x76, 0x77, 0x78, 0x79, 0x7a, 0x83, 0x84, 0x85, 0x86, 0x87, 0x88, 0x89,
  0x8a, 0x92, 0x93, 0x94, 0x95, 0x96, 0x97, 0x98, 0x99, 0x9a, 0xa2, 0xa3, 0xa4, 0xa5, 0xa6, 0xa7,
  0xa8, 0xa9, 0xaa, 0xb2, 0xb3, 0xb4, 0xb5, 0xb6, 0xb7, 0xb8, 0xb9, 0xba, 0xc2, 0xc3, 0xc4, 0xc5,
  0xc6, 0xc7, 0xc8, 0xc9, 0xca, 0xd2, 0xd3, 0xd4, 0xd5, 0xd6, 0xd7, 0xd8, 0xd9, 0xda, 0xe1, 0xe2,
  0xe3, 0xe4, 0xe5, 0xe6, 0xe7, 0xe8, 0xe9, 0xea, 0xf1, 0xf2, 0xf3, 0xf4, 0xf5, 0xf6, 0xf7, 0xf8,
  0xf9, 0xfa,
];
const STD_DC_CHR_BITS = [0, 3, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0];
const STD_DC_CHR_VALS = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11];
const STD_AC_CHR_BITS = [0, 2, 1, 2, 4, 4, 3, 4, 7, 5, 4, 4, 0, 1, 2, 0x77];
const STD_AC_CHR_VALS = [
  0x00, 0x01, 0x02, 0x03, 0x11, 0x04, 0x05, 0x21, 0x31, 0x06, 0x12, 0x41, 0x51, 0x07, 0x61, 0x71,
  0x13, 0x22, 0x32, 0x81, 0x08, 0x14, 0x42, 0x91, 0xa1, 0xb1, 0xc1, 0x09, 0x23, 0x33, 0x52, 0xf0,
  0x15, 0x62, 0x72, 0xd1, 0x0a, 0x16, 0x24, 0x34, 0xe1, 0x25, 0xf1, 0x17, 0x18, 0x19, 0x1a, 0x26,
  0x27, 0x28, 0x29, 0x2a, 0x35, 0x36, 0x37, 0x38, 0x39, 0x3a, 0x43, 0x44, 0x45, 0x46, 0x47, 0x48,
  0x49, 0x4a, 0x53, 0x54, 0x55, 0x56, 0x57, 0x58, 0x59, 0x5a, 0x63, 0x64, 0x65, 0x66, 0x67, 0x68,
  0x69, 0x6a, 0x73, 0x74, 0x75, 0x76, 0x77, 0x78, 0x79, 0x7a, 0x82, 0x83, 0x84, 0x85, 0x86, 0x87,
  0x88, 0x89, 0x8a, 0x92, 0x93, 0x94, 0x95, 0x96, 0x97, 0x98, 0x99, 0x9a, 0xa2, 0xa3, 0xa4, 0xa5,
  0xa6, 0xa7, 0xa8, 0xa9, 0xaa, 0xb2, 0xb3, 0xb4, 0xb5, 0xb6, 0xb7, 0xb8, 0xb9, 0xba, 0xc2, 0xc3,
  0xc4, 0xc5, 0xc6, 0xc7, 0xc8, 0xc9, 0xca, 0xd2, 0xd3, 0xd4, 0xd5, 0xd6, 0xd7, 0xd8, 0xd9, 0xda,
  0xe2, 0xe3, 0xe4, 0xe5, 0xe6, 0xe7, 0xe8, 0xe9, 0xea, 0xf2, 0xf3, 0xf4, 0xf5, 0xf6, 0xf7, 0xf8,
  0xf9, 0xfa,
];

/**
 * Forward DCT basis: `COS_F[u * 8 + x] = cos((2x+1)u*pi/16)`, with the
 * normalisation factor `C(u)` hoisted into `COS_U`.
 */
const COS_F = new Float64Array(64);
const COS_U = new Float64Array(8);
for (let u = 0; u < 8; u++) {
  for (let x = 0; x < 8; x++) COS_F[u * 8 + x] = Math.cos(((2 * x + 1) * u * Math.PI) / 16);
  COS_U[u] = u === 0 ? Math.SQRT1_2 : 1;
}

/** Build canonical code/size lookup tables for one Huffman specification. */
function buildEncodeTable(bits, values) {
  const codes = new Uint16Array(256);
  const sizes = new Uint8Array(256);
  let code = 0;
  let k = 0;
  for (let len = 1; len <= 16; len++) {
    for (let i = 0; i < bits[len - 1]; i++) {
      codes[values[k]] = code;
      sizes[values[k]] = len;
      code++;
      k++;
    }
    code <<= 1;
  }
  return { codes, sizes };
}

const LUM_DC = buildEncodeTable(STD_DC_LUM_BITS, STD_DC_LUM_VALS);
const LUM_AC = buildEncodeTable(STD_AC_LUM_BITS, STD_AC_LUM_VALS);
const CHR_DC = buildEncodeTable(STD_DC_CHR_BITS, STD_DC_CHR_VALS);
const CHR_AC = buildEncodeTable(STD_AC_CHR_BITS, STD_AC_CHR_VALS);

class BitWriter {
  constructor() {
    this.chunks = [];
    this.buffer = Buffer.alloc(65536);
    this.length = 0;
    this.bitBuf = 0;
    this.bitCount = 0;
  }

  ensure(n) {
    if (this.length + n <= this.buffer.length) return;
    this.chunks.push(this.buffer.subarray(0, this.length));
    const size = Math.max(65536, n);
    this.buffer = Buffer.alloc(size);
    this.length = 0;
  }

  writeBits(value, size) {
    if (size === 0) return;
    this.bitBuf = (this.bitBuf << size) | (value & ((1 << size) - 1));
    this.bitCount += size;
    while (this.bitCount >= 8) {
      this.bitCount -= 8;
      const byte = (this.bitBuf >>> this.bitCount) & 0xff;
      this.flushByte(byte);
    }
  }

  flushByte(byte) {
    this.ensure(2);
    this.buffer[this.length++] = byte;
    // Byte stuffing: a literal 0xFF must be followed by 0x00.
    if (byte === 0xff) {
      this.ensure(1);
      this.buffer[this.length++] = 0x00;
    }
  }

  flush() {
    if (this.bitCount > 0) {
      this.writeBits((1 << (8 - this.bitCount)) - 1, 8 - this.bitCount);
    }
    this.chunks.push(this.buffer.subarray(0, this.length));
    return Buffer.concat(this.chunks);
  }
}

/** Number of bits needed to represent |v|, and the magnitude-coded value. */
function magnitude(v) {
  let size = 0;
  let temp = Math.abs(v);
  while (temp) {
    size++;
    temp >>= 1;
  }
  return size === 0 ? 0 : size;
}
function amplitude(v, size) {
  return v >= 0 ? v : v + (1 << size) - 1;
}

function quantTable(base, quality) {
  // The usual IJG scaling, clamped to [1, 255].
  const q = Math.max(1, Math.min(100, quality));
  const scale = q < 50 ? Math.floor(5000 / q) : 200 - q * 2;
  const out = new Int32Array(64);
  for (let i = 0; i < 64; i++) {
    out[i] = Math.max(1, Math.min(255, Math.floor((base[i] * scale + 50) / 100)));
  }
  return out;
}

/**
 * Forward DCT of one 8x8 block of samples (already level-shifted by -128).
 * Writes quantised coefficients into `out` in *zigzag* order.
 *
 * Separable: two passes of 64 multiply-adds instead of a direct 4096, which is
 * what makes encoding a full page cheap enough to do per tile.
 */
const DCT_TMP = new Float64Array(64);
const DCT_NAT = new Float64Array(64);
function forwardDct(samples, quant, out) {
  // Pass 1: 1-D DCT across x for every row y, producing frequency index u.
  // The cosine row must be `u * 8 + x`, paired with sample `y * 8 + x`. Writing
  // `y * 8 + x` on the cosine side instead is invisible for u = 0 and u = 1
  // (those rows are symmetric or constant) and silently wrong for u >= 2.
  for (let y = 0; y < 8; y++) {
    const base = y * 8;
    for (let u = 0; u < 8; u++) {
      const cosRow = u * 8;
      let sum = 0;
      for (let x = 0; x < 8; x++) sum += samples[base + x] * COS_F[cosRow + x];
      DCT_TMP[base + u] = sum * COS_U[u];
    }
  }
  // Pass 2: 1-D DCT down y for every frequency index v, then scale.
  //
  // Results are written into a natural-order scratch buffer and de-zigzagged on
  // the way out. Quantising directly in zigzag order would be equivalent
  // mathematically but not bit-for-bit: dividing by the quantisation step before
  // rotating the coefficients changes which side of a rounding boundary values
  // near .5 land on.
  for (let v = 0; v < 8; v++) {
    const cosRow = v * 8;
    for (let u = 0; u < 8; u++) {
      let sum = 0;
      for (let y = 0; y < 8; y++) sum += DCT_TMP[y * 8 + u] * COS_F[cosRow + y];
      DCT_NAT[v * 8 + u] = sum * COS_U[v] * 0.25;
    }
  }
  for (let p = 0; p < 64; p++) {
    const z = ZIGZAG[p];
    out[p] = Math.round(DCT_NAT[z] / quant[z]);
  }
}

function writeBlock(writer, coeffs, prevDc, dcTable, acTable) {
  const diff = coeffs[0] - prevDc;
  const size = magnitude(diff);
  writer.writeBits(dcTable.codes[size], dcTable.sizes[size]);
  if (size > 0) writer.writeBits(amplitude(diff, size), size);

  let run = 0;
  for (let i = 1; i < 64; i++) {
    const value = coeffs[i];
    if (value === 0) {
      run++;
      continue;
    }
    while (run > 15) {
      writer.writeBits(acTable.codes[0xf0], acTable.sizes[0xf0]);
      run -= 16;
    }
    const n = magnitude(value);
    const symbol = (run << 4) | n;
    writer.writeBits(acTable.codes[symbol], acTable.sizes[symbol]);
    writer.writeBits(amplitude(value, n), n);
    run = 0;
  }
  if (run > 0) writer.writeBits(acTable.codes[0], acTable.sizes[0]);
  return coeffs[0];
}

function segment(marker, payload) {
  const out = Buffer.alloc(4 + payload.length);
  out[0] = 0xff;
  out[1] = marker;
  out.writeUInt16BE(2 + payload.length, 2);
  payload.copy(out, 4);
  return out;
}

/**
 * Encode an interleaved 8-bit RGB buffer as a baseline JPEG.
 *
 * @param {Uint8Array|Buffer} rgb
 * @param {number} width
 * @param {number} height
 * @param {{quality?: number, subsample?: boolean}} [options]
 */
export function encodeJpeg(rgb, width, height, options = {}) {
  const quality = options.quality ?? 92;
  const subsample = options.subsample ?? true;
  const source = Buffer.isBuffer(rgb) ? rgb : Buffer.from(rgb.buffer, rgb.byteOffset, rgb.byteLength);

  const lumQuant = quantTable(STD_LUM_QUANT, quality);
  const chrQuant = quantTable(STD_CHROM_QUANT, quality);

  const hY = subsample ? 2 : 1;
  const vY = subsample ? 2 : 1;
  const mcuW = 8 * hY;
  const mcuH = 8 * vY;
  const mcusX = Math.ceil(width / mcuW);
  const mcusY = Math.ceil(height / mcuH);

  // Planes at component resolution; the JS encoder reads them directly.
  const yStride = mcusX * hY * 8;
  const yHeight = mcusY * vY * 8;
  const cStride = mcusX * 8;
  const cHeight = mcusY * 8;
  const planeY = new Uint8Array(yStride * yHeight);
  const planeCb = new Uint8Array(cStride * cHeight);
  const planeCr = new Uint8Array(cStride * cHeight);

  // RGB -> YCbCr. Chroma is box-averaged when subsampling.
  const chromaStride = subsample ? 2 : 1;
  for (let y = 0; y < yHeight; y++) {
    const sy = Math.min(height - 1, y);
    for (let x = 0; x < yStride; x++) {
      const sx = Math.min(width - 1, x);
      const o = (sy * width + sx) * 3;
      const r = source[o];
      const g = source[o + 1];
      const b = source[o + 2];
      planeY[y * yStride + x] = Math.max(
        0,
        Math.min(255, 0.299 * r + 0.587 * g + 0.114 * b + 0.5),
      );
    }
  }
  for (let cy = 0; cy < cHeight; cy++) {
    for (let cx = 0; cx < cStride; cx++) {
      let sumCb = 0;
      let sumCr = 0;
      let n = 0;
      for (let dy = 0; dy < chromaStride; dy++) {
        for (let dx = 0; dx < chromaStride; dx++) {
          const sx = Math.min(width - 1, cx * chromaStride + dx);
          const sy = Math.min(height - 1, cy * chromaStride + dy);
          const o = (sy * width + sx) * 3;
          const r = source[o];
          const g = source[o + 1];
          const b = source[o + 2];
          sumCb += -0.168736 * r - 0.331264 * g + 0.5 * b + 128;
          sumCr += 0.5 * r - 0.418688 * g - 0.081312 * b + 128;
          n++;
        }
      }
      planeCb[cy * cStride + cx] = Math.max(0, Math.min(255, sumCb / n + 0.5));
      planeCr[cy * cStride + cx] = Math.max(0, Math.min(255, sumCr / n + 0.5));
    }
  }

  const writer = new BitWriter();
  const block = new Float64Array(64);
  const coeffs = new Int32Array(64);
  let dcY = 0;
  let dcCb = 0;
  let dcCr = 0;

  const encodePlaneBlock = (plane, stride, bx, by, quant, prev, dcT, acT) => {
    for (let y = 0; y < 8; y++) {
      const row = (by * 8 + y) * stride + bx * 8;
      const base = y * 8;
      for (let x = 0; x < 8; x++) block[base + x] = plane[row + x] - 128;
    }
    // Must be cleared: `forwardDct` only writes the coefficients that survive
    // quantisation, so anything left from the previous block would leak in.
    coeffs.fill(0);
    forwardDct(block, quant, coeffs);
    return writeBlock(writer, coeffs, prev, dcT, acT);
  };

  for (let my = 0; my < mcusY; my++) {
    for (let mx = 0; mx < mcusX; mx++) {
      for (let by = 0; by < vY; by++) {
        for (let bx = 0; bx < hY; bx++) {
          dcY = encodePlaneBlock(
            planeY,
            yStride,
            mx * hY + bx,
            my * vY + by,
            lumQuant,
            dcY,
            LUM_DC,
            LUM_AC,
          );
        }
      }
      dcCb = encodePlaneBlock(planeCb, cStride, mx, my, chrQuant, dcCb, CHR_DC, CHR_AC);
      dcCr = encodePlaneBlock(planeCr, cStride, mx, my, chrQuant, dcCr, CHR_DC, CHR_AC);
    }
  }

  const scan = writer.flush();

  const dqtPayload = Buffer.alloc(2 + 128);
  dqtPayload[0] = 0x00;
  for (let i = 0; i < 64; i++) dqtPayload[1 + i] = lumQuant[ZIGZAG[i]];
  dqtPayload[65] = 0x01;
  for (let i = 0; i < 64; i++) dqtPayload[66 + i] = chrQuant[ZIGZAG[i]];
  const dqt = segment(0xdb, dqtPayload);

  const sof = Buffer.alloc(6 + 9);
  sof[0] = 8;
  sof.writeUInt16BE(height, 1);
  sof.writeUInt16BE(width, 3);
  sof[5] = 3;
  sof[6] = 1;
  sof[7] = (hY << 4) | vY;
  sof[8] = 0;
  sof[9] = 2;
  sof[10] = 0x11;
  sof[11] = 1;
  sof[12] = 3;
  sof[13] = 0x11;
  sof[14] = 1;

  const dht = Buffer.concat([
    segment(0xc4, Buffer.concat([Buffer.from([0x00]), Buffer.from(STD_DC_LUM_BITS), Buffer.from(STD_DC_LUM_VALS)])),
    segment(0xc4, Buffer.concat([Buffer.from([0x10]), Buffer.from(STD_AC_LUM_BITS), Buffer.from(STD_AC_LUM_VALS)])),
    segment(0xc4, Buffer.concat([Buffer.from([0x01]), Buffer.from(STD_DC_CHR_BITS), Buffer.from(STD_DC_CHR_VALS)])),
    segment(0xc4, Buffer.concat([Buffer.from([0x11]), Buffer.from(STD_AC_CHR_BITS), Buffer.from(STD_AC_CHR_VALS)])),
  ]);

  const sos = segment(0xda, Buffer.from([3, 1, 0x00, 2, 0x11, 3, 0x11, 0, 63, 0]));

  return Buffer.concat([
    Buffer.from([0xff, 0xd8]),
    Buffer.from([0xff, 0xe0, 0x00, 0x10]),
    Buffer.from('JFIF\0', 'latin1'),
    Buffer.from([0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00]),
    dqt,
    segment(0xc0, sof),
    dht,
    sos,
    scan,
    Buffer.from([0xff, 0xd9]),
  ]);
}

/** Default quality used when only "--format jpeg" is given. */
export const DEFAULT_JPEG_QUALITY = 92;
