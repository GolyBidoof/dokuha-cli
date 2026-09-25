/**
 * BookWalker page normaliser, run off the main thread.
 *
 * One public page is encrypted: the CDN serves a JPEG whose tiles are
 * permuted, and the viewer reassembles it before display. Reproducing that
 * means decode -> un-permute -> re-encode, and the un-permute step used to run
 * in plain JavaScript on the main thread, allocating a second full-frame RGBA
 * buffer per page (~15 MB for a 1600x2400 scan) and copying every tile into it.
 *
 * That is the same mistake the sibling userscript measured and fixed: its
 * comment records "about 46MB of avoidable memory traffic per page, which is
 * what stopped the decoder keeping up with the fetcher. Measured 2.08x on 14
 * cores." There the work moved into Web Workers; here it moves into
 * worker_threads, one page per worker, so the main thread only ever handles the
 * finished JPEG.
 *
 * The descrambler is the vendored one, loaded through `createRequire` rather
 * than reimplemented: `vendor/bookwalker` is CommonJS and its permutation must
 * stay byte-identical to the browser's, which is exactly what
 * `test_descramble_equivalence` pins on the userscript side.
 */

import { createRequire } from 'node:module';
import { parentPort } from 'node:worker_threads';

const require = createRequire(import.meta.url);
const sharp = require('sharp');
const { descramblePage } = require('../../vendor/bookwalker/bw-crypto.js');

// Each worker gets one page at a time, so libvips must not also fan that page
// out across every core: N workers x M libvips threads oversubscribes the CPU
// and made the pool slower than the single-threaded path it replaces.
sharp.concurrency(1);

/** Encode settings, kept identical to the inline path so output does not drift. */
const JPEG_QUALITY = 92;

/**
 * Decode, un-permute and re-encode one page.
 *
 * Returns the encoded bytes as an exact, zero-offset Uint8Array. That matters
 * for the transfer: a Buffer taken from Node's shared pool has a non-zero
 * byteOffset onto a 64 KiB slab, and transferring that slab ships the wrong
 * range and detaches memory other buffers still point at (see the same note in
 * vendor/cmoa/src/render-worker.js).
 */
async function normalize(bytes, seeds) {
    const raw = await sharp(bytes).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    const decoded = descramblePage(
        new Uint8ClampedArray(raw.data),
        raw.info.width,
        raw.info.height,
        seeds,
    );
    const encoded = await sharp(
        Buffer.from(decoded.data.buffer, decoded.data.byteOffset, decoded.data.byteLength),
        { raw: { width: decoded.width, height: decoded.height, channels: 4 } },
    ).jpeg({ quality: JPEG_QUALITY }).toBuffer();
    return Uint8Array.from(encoded);
}

parentPort.on('message', async (message) => {
    try {
        const data = await normalize(message.bytes, message.seeds);
        parentPort.postMessage({ id: message.id, data }, [data.buffer]);
    } catch (error) {
        parentPort.postMessage({ id: message.id, error: error?.stack ?? String(error) });
    }
});
