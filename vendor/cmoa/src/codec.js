/**
 * Page reassembly: scrambled JPEG in, finished page out.
 *
 * The viewer's approach is decode -> copy tiles on a canvas -> re-encode. This
 * does the same thing but stays in the JPEG's own YCbCr planes until the final
 * colour conversion, which avoids a needless RGB round-trip and keeps tile seams
 * free of chroma bleed.
 */

import { createRequire } from 'node:module';
import { decodeJpeg, readJpegSize, sampleRgb } from './jpeg.js';
import { encodeJpeg } from './jpeg_encode.js';
import { encodePng } from './png.js';
import { compileDescrambler } from './descrambler.js';

/** Supported output formats. */
export const FORMATS = ['png', 'jpeg', 'jpg', 'original'];

export function normaliseFormat(format) {
  const f = String(format ?? 'jpeg').toLowerCase();
  if (f === 'jpg') return 'jpeg';
  if (!FORMATS.includes(f)) {
    throw new Error(`unknown format "${format}" (expected one of ${FORMATS.join(', ')})`);
  }
  return f;
}

export function extensionFor(format) {
  const f = normaliseFormat(format);
  if (f === 'jpeg') return 'jpg';
  if (f === 'original') return 'jpg';
  return 'png';
}

export function contentTypeFor(format) {
  const f = normaliseFormat(format);
  return f === 'jpeg' || f === 'original' ? 'image/jpeg' : 'image/png';
}

/**
 * Decode one page and return it as RGB together with its visible size.
 *
 * @param {Uint8Array|Buffer} bytes  the JPEG as served by sbcGetImg.php
 * @param {string} coordTable        decoded ctbl entry for this page
 * @param {string} pieceTable        decoded ptbl entry for this page
 */
function decodePage(bytes, coordTable, pieceTable) {
  const image = decodeJpeg(bytes);
  const descrambler = compileDescrambler(coordTable, pieceTable);
  const source = { width: image.width, height: image.height };
  const regions = descrambler.regions(source.width, source.height);
  const size = descrambler.displaySize(source.width, source.height);
  return { image, descrambler, regions, size, source };
}

/** Convert YCbCr planes to an interleaved RGB buffer, applying `regions`. */
function toRgb(page) {
  const { image, regions, size } = page;
  const rgb = Buffer.alloc(size.width * size.height * 3);
  const out = [0, 0, 0];

  if (!regions) {
    for (let y = 0; y < size.height; y++) {
      for (let x = 0; x < size.width; x++) {
        sampleRgb(image, x, y, out);
        const o = (y * size.width + x) * 3;
        rgb[o] = out[0];
        rgb[o + 1] = out[1];
        rgb[o + 2] = out[2];
      }
    }
    return rgb;
  }

  for (const r of regions) {
    // Clip to the output canvas: the last column/row can extend a pixel or two
    // past `displaySize` when the stored grid is slightly larger than declared.
    const w = Math.min(r.width, size.width - r.xdest);
    const h = Math.min(r.height, size.height - r.ydest);
    if (w <= 0 || h <= 0) continue;
    for (let y = 0; y < h; y++) {
      const sy = r.ysrc + y;
      if (sy >= image.height) break;
      const rowOut = (r.ydest + y) * size.width + r.xdest;
      for (let x = 0; x < w; x++) {
        const sx = r.xsrc + x;
        if (sx >= image.width) break;
        sampleRgb(image, sx, sy, out);
        const o = (rowOut + x) * 3;
        rgb[o] = out[0];
        rgb[o + 1] = out[1];
        rgb[o + 2] = out[2];
      }
    }
  }
  return rgb;
}

/**
 * Reassemble and re-encode one page.
 *
 * @param {Uint8Array|Buffer} bytes
 * @param {{coordTable: string, pieceTable: string}} tables
 * @param {{format?: string, quality?: number, subsample?: boolean}} [options]
 * @returns {{data: Buffer, width: number, height: number, format: string,
 *            kind: string, changed: boolean}}
 */
let sharpLoader;

/**
 * libvips, if it is installed. `undefined` means "not asked yet", `null` "not there".
 *
 * The engine is deliberately dependency-free pure JavaScript, and stays that way:
 * this returns null on a checkout without `sharp` and every caller falls back to the
 * JavaScript codec below. When it *is* present it is roughly eight times faster at
 * decoding and four times at encoding, which is where the bulk of a CMOA page's
 * time goes -- the tile geometry forbids the DCT-domain shortcuts that would
 * otherwise avoid the decode entirely.
 */
function loadSharp() {
  if (sharpLoader !== undefined) return sharpLoader;
  try {
    const require = createRequire(import.meta.url);
    const sharp = require('sharp');
    // libvips threads internally, and this runs in thirteen workers at once.
    // Thirteen pools of libvips threads is the oversubscription that the
    // BookWalker normaliser already guards against the same way.
    sharp.concurrency(1);
    sharpLoader = sharp;
  } catch {
    sharpLoader = null;
  }
  return sharpLoader;
}

/**
 * Move the regions' rectangles into a fresh canvas, one row at a time.
 *
 * This is the descrambling step, and it has to happen on pixels: the tiles sit at
 * arbitrary offsets such as (4,4) and are not multiples of the 8- or 16-pixel
 * boundaries that JPEG's variable-length MCUs would need for any cheaper
 * compressed-domain move. With full-resolution RGB in hand it is a straight
 * rectangle copy -- no per-pixel colour conversion, which the JavaScript path needs
 * only because it holds subsampled YCbCr planes rather than RGB.
 */
function scatterRgb(src, info, regions, size) {
  const channels = info.channels;
  const out = Buffer.alloc(size.width * size.height * channels);
  const rowBytes = (w) => w * channels;

  if (!regions || !regions.length) {
    const w = Math.min(info.width, size.width);
    for (let y = 0; y < Math.min(info.height, size.height); y++) {
      const from = y * info.width * channels;
      src.copy(out, y * size.width * channels, from, from + rowBytes(w));
    }
    return out;
  }

  for (const r of regions) {
    const w = Math.min(r.width, size.width - r.xdest);
    const h = Math.min(r.height, size.height - r.ydest);
    if (w <= 0 || h <= 0) continue;
    const span = Math.min(w, info.width - r.xsrc);
    if (span <= 0) continue;
    for (let y = 0; y < h; y++) {
      const sy = r.ysrc + y;
      if (sy >= info.height) break;
      const from = (sy * info.width + r.xsrc) * channels;
      const to = ((r.ydest + y) * size.width + r.xdest) * channels;
      src.copy(out, to, from, from + rowBytes(span));
    }
  }
  return out;
}

async function renderPageSharp(sharp, bytes, tables, options, format) {
  const { data: src, info } = await sharp(bytes).raw().toBuffer({ resolveWithObject: true });
  const descrambler = compileDescrambler(tables.coordTable, tables.pieceTable);
  const regions = descrambler.regions(info.width, info.height);
  const size = descrambler.displaySize(info.width, info.height);
  const changed = changesAnything(regions);

  if (format === 'original' && !changed) {
    return {
      data: Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes),
      width: info.width,
      height: info.height,
      format: 'original',
      extension: extensionFor('original'),
      kind: descrambler.kind,
      changed: false,
    };
  }

  const rgb = scatterRgb(src, info, regions, size);
  const raw = { width: size.width, height: size.height, channels: info.channels };
  const quality = options.quality ?? 92;
  // `subsample` is the JS encoder's spelling of 4:2:0; keep its default of on.
  const chromaSubsampling = options.subsample === false ? '4:4:4' : '4:2:0';

  const data = format === 'png'
    ? await sharp(rgb, { raw }).png().toBuffer()
    : await sharp(rgb, { raw }).jpeg({ quality, chromaSubsampling }).toBuffer();

  return {
    data,
    width: size.width,
    height: size.height,
    format: format === 'png' ? 'png' : 'jpeg',
    extension: extensionFor(format === 'png' ? 'png' : 'jpeg'),
    kind: descrambler.kind,
    changed,
  };
}

export async function renderPage(bytes, tables, options = {}) {
  const sharp = loadSharp();
  if (sharp) return renderPageSharp(sharp, bytes, tables, options, normaliseFormat(options.format ?? 'jpeg'));
  return renderPageJs(bytes, tables, options);
}

function renderPageJs(bytes, tables, options = {}) {
  const format = normaliseFormat(options.format ?? 'jpeg');

  // Whether any tile moves is a property of the coordinate and piece tables and the
  // page's dimensions -- not of its pixels. Asking `decodePage` first therefore spent
  // a full JPEG decode (hundreds of milliseconds for a 1350x1920 page) to discover
  // that there was nothing to do, which is the common case for a volume the CDN
  // serves already assembled. Read the size from the frame header instead, and only
  // decode once something actually has to move.
  if (format === 'original') {
    const size = readJpegSize(bytes);
    const descrambler = compileDescrambler(tables.coordTable, tables.pieceTable);
    const regions = descrambler.regions(size.width, size.height);
    if (!changesAnything(regions)) {
      return {
        data: Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes),
        width: size.width,
        height: size.height,
        format: 'original',
        extension: extensionFor('original'),
        kind: descrambler.kind,
        changed: false,
      };
    }
  }

  const page = decodePage(bytes, tables.coordTable, tables.pieceTable);
  const changed = changesAnything(page.regions);

  if (format === 'original' && !changed) {
    // Nothing was permuted, so the served bytes already are the page. Keep them
    // verbatim rather than paying a decode/re-encode generation of quality.
    return {
      data: Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes),
      width: page.image.width,
      height: page.image.height,
      format: 'original',
      extension: extensionFor('original'),
      kind: page.descrambler.kind,
      changed: false,
    };
  }

  const rgb = toRgb(page);
  let data;
  let outFormat;
  if (format === 'png') {
    outFormat = 'png';
    data = encodePng(rgb, page.size.width, page.size.height, { level: options.level });
  } else {
    outFormat = 'jpeg';
    data = encodeJpeg(rgb, page.size.width, page.size.height, {
      quality: options.quality,
      subsample: options.subsample,
    });
  }
  return {
    data,
    width: page.size.width,
    height: page.size.height,
    format: outFormat,
    extension: extensionFor(outFormat),
    kind: page.descrambler.kind,
    changed,
  };
}

/** True when at least one region actually moves pixels. */
function changesAnything(regions) {
  if (!regions) return false;
  return regions.some((r) => r.xsrc !== r.xdest || r.ysrc !== r.ydest);
}

/** Inspect a page without writing it: sizes, layout and whether tiles move. */
export function inspectPage(bytes, tables) {
  const page = decodePage(bytes, tables.coordTable, tables.pieceTable);
  const moved = page.regions
    ? page.regions.filter((r) => r.xsrc !== r.xdest || r.ysrc !== r.ydest).length
    : 0;
  return {
    kind: page.descrambler.kind,
    stored: { width: page.image.width, height: page.image.height },
    visible: page.size,
    tiles: page.regions ? page.regions.length : 0,
    tilesMoved: moved,
  };
}
