/**
 * Un-shuffling a real page.
 *
 * The oracle here is not "does it decode" -- a wrongly un-shuffled page decodes
 * perfectly, it is just a mosaic of unrelated fragments. It is the seam energy:
 * the scramble moves 94px blocks around a 96px grid, so a page that is still
 * shuffled has a sharp discontinuity every 94 pixels and a page that has been put
 * back does not. Measured on this fixture, the correct key reads ~1.1x the interior
 * gradient and a key off by one reads ~5x, which is what the assertions below pin.
 *
 * The pure permutation checks run always; the image ones only when the optional
 * `sharp` dependency is present, since that is the dependency the store needs to
 * produce a readable page at all.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { descrambleJpeg, sharpAvailable } from '../src/download/kmanga.js';
import { parseFrame, scrambleOrder, readJpegSize } from '../src/download/kmanga-protocol.js';
import { check, checkEqual, finish } from './_harness.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const pageFrame = fs.readFileSync(path.join(HERE, 'fixtures', 'kmanga-page8.bcp'));
const parsed = parseFrame(pageFrame);
const image = parsed.body.scenes[0].images[0];
const jpeg = parsed.chunks[0];

/**
 * Mean absolute horizontal gradient on block boundaries, over the same gradient
 * everywhere else. 1.0 means the seams are invisible; a shuffled page cannot get
 * near it, because neighbouring blocks come from unrelated parts of the page.
 */
async function seamRatio(buffer, step) {
    const sharp = (await import('sharp')).default;
    const { data, info } = await sharp(buffer).toColourspace('srgb').removeAlpha().raw()
        .toBuffer({ resolveWithObject: true });
    const { width, height, channels } = info;
    let seam = 0;
    let seamCount = 0;
    let inner = 0;
    let innerCount = 0;
    for (let y = 0; y < height; y++) {
        for (let x = 1; x < width; x++) {
            const a = (y * width + x) * channels;
            const b = (y * width + x - 1) * channels;
            let delta = 0;
            for (let c = 0; c < 3; c++) delta += Math.abs(data[a + c] - data[b + c]);
            if (x % step === 0) { seam += delta; seamCount++; } else { inner += delta; innerCount++; }
        }
    }
    return (seam / seamCount) / (inner / innerCount);
}

// A bijection that is stable for the fixture's seed: the same draw the capture
// produced, and the same one every run.
{
    const order = scrambleOrder({ gridX: 9, gridY: 13, key: image.key });
    checkEqual('the fixture key draws 117 blocks', order.length, 117);
    checkEqual('each block lands exactly once', new Set(order).size, 117);
    check('the draw starts with the capture\u2019s blocks',
        Array.from(order.slice(0, 4)).join(',') === '77,64,47,99', Array.from(order.slice(0, 4)).join(','));
}

if (!sharpAvailable()) {
    // Still a passing file: the pure checks above are the ones that must hold on
    // every machine. The image stage is reported rather than silently skipped,
    // because a green suite that never un-shuffled anything is misleading.
    process.stdout.write('NOTE  sharp is not installed; the image stage was not run\n');
} else {
    const fixed = await descrambleJpeg(jpeg, {
        key: image.key,
        declaredWidth: image.width,
        declaredHeight: image.height,
    });
    const size = readJpegSize(fixed);
    check('the rebuilt page is a JPEG', size !== null);
    checkEqual('it is the declared page box, not the padded grid', [size.width, size.height], [846, 1200]);

    const correct = await seamRatio(fixed, 94);
    const wrong = await seamRatio(await descrambleJpeg(jpeg, {
        key: image.key + 1,
        declaredWidth: image.width,
        declaredHeight: image.height,
    }), 94);
    check('the seams are gone with the right key', correct < 1.6, `seam ratio ${correct.toFixed(2)}`);
    check('they are still there with the wrong key', wrong > 3, `seam ratio ${wrong.toFixed(2)}`);
    check('so the key actually decides the page', wrong / correct > 2.5, `${(wrong / correct).toFixed(2)}x apart`);
}

// An unscrambled image must come back untouched: the viewer skips the whole
// shuffle at key 0, and seeding the generator with 0 would shuffle a plain page.
{
    const order = scrambleOrder({ gridX: 1, gridY: 1, key: 0 });
    checkEqual('a single-block grid is a no-op whatever the key', Array.from(order), [0]);
}

finish();
