/**
 * The worker-pool page normaliser must be indistinguishable from the inline one.
 *
 * BookWalker's public pages are encrypted: the CDN serves a JPEG whose tiles are
 * permuted. `normalizePage` decodes it, un-permutes the frame with the vendored
 * `descramblePage`, and re-encodes to JPEG. That used to happen on the main
 * thread -- a second full-frame RGBA buffer and a tile-by-tile copy per page,
 * inside the same event loop that resolves 128 concurrent fetches.
 *
 * `src/download/bw-normalize-pool.js` moves it into worker_threads. The whole
 * justification is that the *bytes do not change*, so that is what is asserted
 * here: same input, same seeds, byte-identical output, and a decoy
 * configuration proving the seeds are actually being honoured rather than
 * silently dropped on the way through the worker boundary.
 *
 * Runs without network or a bridge.
 */

import { createRequire } from 'node:module';

import { check, checkEqual, finish } from './_harness.mjs';
import { BwNormalizePool, defaultNormalizeWorkers } from '../src/download/bw-normalize-pool.js';

const require = createRequire(import.meta.url);
const sharp = require('sharp');
const { normalizePage, crc32 } = require('../vendor/bookwalker/public-trial.js');
const { A9p } = require('../vendor/bookwalker/bw-crypto.js');

const WIDTH = 192;
const HEIGHT = 192;

/** A deterministic block-permutation seed set with a real tile geometry. */
const SEEDS = { b8A: 64, b6V: 64, B0J: 1, B0K: 2, B0n: 3, B0A: 4, Size: { Width: WIDTH, Height: HEIGHT } };

/** A second permutation, used to prove the seeds reach the worker. */
const DECOY_SEEDS = { b8A: 64, b6V: 64, B0J: 9, B0K: 7, B0n: 5, B0A: 3, Size: { Width: WIDTH, Height: HEIGHT } };

/** Deterministic, high-contrast RGBA content so JPEG round-trips are distinctive. */
function sourceImage() {
    const rgba = Buffer.alloc(WIDTH * HEIGHT * 4);
    for (let y = 0; y < HEIGHT; y++) {
        for (let x = 0; x < WIDTH; x++) {
            const i = (y * WIDTH + x) * 4;
            rgba[i] = (x * 3 + y) & 0xff;
            rgba[i + 1] = (y * 5) & 0xff;
            rgba[i + 2] = (x ^ y) & 0xff;
            rgba[i + 3] = 255;
        }
    }
    return rgba;
}

/** Wrap `normalizePage`'s manifest/job contract around a raw call. */
const plaintextManifest = { decoded: { plaintext: false } };

async function main() {
    check('the tile geometry is non-trivial', A9p(SEEDS, WIDTH, HEIGHT).length > 1,
        A9p(SEEDS, WIDTH, HEIGHT).length + ' tiles');

    const source = await sharp(sourceImage(), { raw: { width: WIDTH, height: HEIGHT, channels: 4 } })
        .jpeg({ quality: 95 })
        .toBuffer();
    check('the fixture is a JPEG', source[0] === 0xff && source[1] === 0xd8);

    // --- reference: the inline path, on this thread ----------------------
    const reference = await normalizePage(source, { seeds: SEEDS }, plaintextManifest);
    check('the inline path returns a JPEG', reference[0] === 0xff && reference[1] === 0xd8);
    check('the inline path produced a real image', reference.length > 512, reference.length + ' bytes');

    // --- the worker path -------------------------------------------------
    const pool = new BwNormalizePool(Math.min(4, defaultNormalizeWorkers()));
    let pooled;
    let decoy;
    try {
        pooled = await pool.normalize(source, SEEDS);
        // A different permutation must give a different picture, which is only
        // true if `seeds` survived structured cloning into the worker.
        decoy = await pool.normalize(source, DECOY_SEEDS);
    } finally {
        await pool.close();
    }

    checkEqual('the worker path is byte-identical to the inline path',
        crc32(pooled), crc32(reference));
    check('the worker path is byte-identical to the inline path (length)',
        pooled.length === reference.length, `${pooled.length} vs ${reference.length}`);
    check('the worker path returns a JPEG', pooled[0] === 0xff && pooled[1] === 0xd8);
    check('the pool honoured the seeds rather than dropping them',
        crc32(decoy) !== crc32(pooled),
        'both permutations produced identical bytes');

    // --- the pass-through guard ------------------------------------------
    // A plaintext manifest, or a page with no seeds, must be handed straight
    // back. This is what keeps an unencrypted volume from paying for a pool.
    const plain = await normalizePage(source, { seeds: SEEDS }, { decoded: { plaintext: true } });
    check('a plaintext manifest is passed through untouched', plain === source);
    const seedless = await normalizePage(source, { seeds: null }, plaintextManifest);
    check('a page with no seeds is passed through untouched', seedless === source);

    // --- pool hygiene ----------------------------------------------------
    // Closing a pool that never ran must not throw, and must not spawn workers:
    // an unencrypted volume constructs one and never uses it.
    const idle = new BwNormalizePool(2);
    check('an unused pool has no workers', idle.slots.length === 0);
    await idle.close();
    check('closing an unused pool is a no-op', idle.slots.length === 0);

    // --- concurrency ------------------------------------------------------
    // Timing is the wrong instrument here: on a small fixture the measurement is
    // dominated by worker startup (spawn + libvips load), which is a real cost
    // the pool pays once but does not describe steady-state behaviour. What must
    // be true is structural: every worker picks up a page at once, and a page
    // beyond the pool size queues rather than being dropped or serialised.
    const size = Math.min(4, defaultNormalizeWorkers());
    const pool2 = new BwNormalizePool(size);
    let measured = null;
    try {
        // Warm the workers so the throughput number below is steady state.
        await pool2.normalize(source, SEEDS);

        const jobs = Array.from({ length: size }, () => pool2.normalize(source, SEEDS));
        check(`all ${size} workers hold a page at once`,
            pool2.slots.filter((slot) => slot.busy).length === size,
            `${pool2.slots.filter((slot) => slot.busy).length} busy of ${size}`);
        check('nothing is queued while workers are free', pool2.queue.length === 0);

        // One more than the pool can hold: it must wait, not be dispatched.
        const overflow = pool2.normalize(source, SEEDS);
        check('a page past the pool size queues instead of overloading a worker',
            pool2.queue.length === 1 && pool2.pending === size + 1,
            `queued=${pool2.queue.length} pending=${pool2.pending}`);

        const batch = await Promise.all([...jobs, overflow]);
        check('every concurrent result is still correct',
            batch.every((b) => crc32(b) === crc32(reference)));
        check('the queue drains and leaves every worker idle',
            pool2.pending === 0 && pool2.slots.every((slot) => !slot.busy),
            `pending=${pool2.pending}`);
    } finally {
        await pool2.close();
    }

    // A realistic page size for the throughput figure: 192x192 is ~1/38th of a
    // 1200x1800 scan, so per-page work barely registers against the fixed costs.
    const BIG = { width: 1200, height: 1800 };
    const bigSeeds = { ...SEEDS, Size: { Width: BIG.width, Height: BIG.height } };
    const bigImage = Buffer.alloc(BIG.width * BIG.height * 4);
    for (let y = 0; y < BIG.height; y++) {
        for (let x = 0; x < BIG.width; x++) {
            const i = (y * BIG.width + x) * 4;
            bigImage[i] = (x * 3 + y) & 0xff;
            bigImage[i + 1] = (y * 5) & 0xff;
            bigImage[i + 2] = (x ^ y) & 0xff;
            bigImage[i + 3] = 255;
        }
    }
    const bigSource = await sharp(bigImage, { raw: { width: BIG.width, height: BIG.height, channels: 4 } })
        .jpeg({ quality: 95 }).toBuffer();
    const pages = 8;
    const bigPool = new BwNormalizePool(size);
    try {
        await bigPool.normalize(bigSource, bigSeeds);          // warm
        const t0 = performance.now();
        await Promise.all(Array.from({ length: pages }, () => bigPool.normalize(bigSource, bigSeeds)));
        const poolMs = performance.now() - t0;

        await normalizePage(bigSource, { seeds: bigSeeds }, plaintextManifest);  // warm
        const t1 = performance.now();
        for (let i = 0; i < pages; i++) {
            await normalizePage(bigSource, { seeds: bigSeeds }, plaintextManifest);
        }
        const inlineMs = performance.now() - t1;

        measured = { poolMs, inlineMs, pages, workers: size };
        // Loose on purpose: this is a correctness suite, and a slower machine
        // should not turn a real speedup into a red build. A serialised pool
        // would sit at ~1.0x; 4 workers should be well past 1.5x.
        check('the pool beats the inline path on real-sized pages',
            inlineMs / poolMs > 1.5,
            `pool ${poolMs.toFixed(0)}ms vs inline ${inlineMs.toFixed(0)}ms ` +
            `(${(inlineMs / poolMs).toFixed(2)}x)`);
    } finally {
        await bigPool.close();
    }

    console.log(`\n  ${measured.pages} pages of ${BIG.width}x${BIG.height}, ${measured.workers} workers` +
        `\n  pool   : ${measured.poolMs.toFixed(0)}ms  (${(measured.poolMs / measured.pages).toFixed(1)}ms/page)` +
        `\n  inline : ${measured.inlineMs.toFixed(0)}ms  (${(measured.inlineMs / measured.pages).toFixed(1)}ms/page)` +
        `\n  speedup: ${(measured.inlineMs / measured.poolMs).toFixed(2)}x`);

    finish();
}

main().catch((error) => {
    console.error('FATAL', error);
    process.exit(1);
});
