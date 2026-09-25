/**
 * Page reassembly: scrambled JPEG in, finished page out.
 *
 * The viewer's approach is decode -> copy tiles on a canvas -> re-encode. This
 * does the same thing but stays in the JPEG's own YCbCr planes until the final
 * colour conversion, which avoids a needless RGB round-trip and keeps tile seams
 * free of chroma bleed.
 */

import { decodeJpeg, sampleRgb } from './jpeg.js';
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
export function decodePage(bytes, coordTable, pieceTable) {
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
export function renderPage(bytes, tables, options = {}) {
  const format = normaliseFormat(options.format ?? 'jpeg');
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
