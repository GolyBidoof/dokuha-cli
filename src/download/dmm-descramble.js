import { createRequire } from 'node:module';
import os from 'node:os';

import { createPool } from '../serial.js';

/**
 * DMMブックス page descrambling.
 *
 * The store's viewer (`publus-viewer.js`) does not decrypt anything, but it
 * does not serve a finished page either: `configuration_pack.json` names a page
 * JPEG whose pixels are a 64×64 tile shuffle, and the viewer rearranges them in
 * a canvas before display. The geometry below is a direct port of its `Wu` and
 * `Dl` routines, including their deliberately confusing source/destination
 * names, so the two implementations can be compared line by line.
 *
 * `Dl` derives the permutation from the page's own path:
 *
 *     sum(charCode(file + "/" + Page.No)) % 4 + 1
 *
 * and `Wu(width, height, pattern)` returns one rectangle per tile. The page
 * carries `DummyWidth`/`DummyHeight`; the CDN image is padded by that much and
 * the clean page is the image minus the padding. `DummyWidth` is typically 4
 * (the CDN rounds to a 64-pixel grid), so the clean page is 900×1280 while the
 * JPEG on the wire is 904×1280.
 */

const require = createRequire(import.meta.url);

export const DMM_TILE = 64;

let pageSlots = null;
function pagePool() {
    if (!pageSlots) {
        // Decode and encode are both libvips work. Size the outer pool from the
        // machine rather than a fixed four: measured on real 1304x2048 DMM pages
        // a pool of 4 sustains ~98 pages/s, which is eight times a 10 MB/s link,
        // and more slots only matter above that. The cap keeps a many-core box
        // from asking libvips for dozens of full-size frames at once; libvips
        // still runs its own threads inside each slot.
        const cores = typeof os.availableParallelism === 'function'
            ? os.availableParallelism() : (os.cpus()?.length || 4);
        pageSlots = createPool(Math.max(2, Math.min(8, cores)));
    }
    return pageSlots;
}

export function sharpAvailable() {
    try {
        require('sharp');
        return true;
    } catch {
        return false;
    }
}

function loadSharp() {
    try {
        return require('sharp');
    } catch {
        throw new Error(
            'DMM pages are tile-scrambled and rebuilding them needs the optional "sharp" dependency, '
            + 'which is not installed.\n'
            + '  Install it with:  npm install sharp\n'
            + '  Or pass --no-descramble to keep the scrambled mosaic as downloaded.',
        );
    }
}

export function assertSharpAvailable() {
    loadSharp();
}

function vn(index, split, remainder, tile) {
    return index * tile + (index >= split ? remainder : 0);
}

function fu(index, count, pattern) {
    return (index + 61 * pattern) % count;
}

function qi(index, split, splitY, countY, pattern) {
    const odd = pattern % 2 === 1;
    let start;
    let span;
    let before;
    before = index < split ? odd : !odd;
    if (before) {
        span = splitY;
        start = 0;
    } else {
        span = countY - splitY;
        start = splitY;
    }
    return (index + 53 * pattern + 59 * splitY) % span + start;
}

function es(index, splitX, splitY, countX, pattern) {
    const odd = pattern % 2 === 1;
    let start;
    let span;
    let before;
    before = index < splitY ? odd : !odd;
    if (before) {
        span = countX - splitX;
        start = splitX;
    } else {
        span = splitX;
        start = 0;
    }
    return (index + 67 * pattern + splitX + 71) % span + start;
}

function xu(index, count, pattern) {
    return (index + 73 * pattern) % count;
}

/**
 * The viewer's `Wu`: rectangle list for a scrambled page. `sx`/`sy` name the
 * source in the scrambled JPEG, `dx`/`dy` the destination in the clean page.
 * The naming is inverted from the viewer's own fields on purpose (see the
 * module comment): `drawImage(c, F.destX, F.destY, ..., F.srcX, F.srcY, ...)`
 * means the viewer's `destX` is the source and its `srcX` is the destination.
 */
export function dmmTileRects(width, height, pattern, block = DMM_TILE) {
    const cols = Math.floor(width / block);
    const rows = Math.floor(height / block);
    if (cols <= 0 || rows <= 0) return [];
    const remX = width % block;
    const remY = height % block;
    const rects = [];

    let splitX = cols - (43 * pattern) % cols;
    splitX = splitX % cols === 0 ? (cols - 4) % cols : splitX;
    splitX = splitX === 0 ? cols - 1 : splitX;

    let splitY = rows - (47 * pattern) % rows;
    splitY = splitY % rows === 0 ? (rows - 4) % rows : splitY;
    splitY = splitY === 0 ? rows - 1 : splitY;

    const push = (sx, sy, dx, dy, w, h) => {
        if (w > 0 && h > 0) rects.push({ sx, sy, dx, dy, w, h });
    };

    if (remX > 0 && remY > 0) {
        push(splitX * block, splitY * block, splitX * block, splitY * block, remX, remY);
    }

    if (remY > 0) {
        for (let x = 0; x < cols; x++) {
            const targetX = fu(x, cols, pattern);
            const targetY = qi(targetX, splitX, splitY, rows, pattern);
            push(
                vn(targetX, splitX, remX, block),
                targetY * block,
                vn(x, splitX, remX, block),
                splitY * block,
                block,
                remY,
            );
        }
    }

    if (remX > 0) {
        for (let y = 0; y < rows; y++) {
            const targetY = xu(y, rows, pattern);
            const targetX = es(targetY, splitX, splitY, cols, pattern);
            push(
                targetX * block,
                vn(targetY, splitY, remY, block),
                splitX * block,
                vn(y, splitY, remY, block),
                remX,
                block,
            );
        }
    }

    for (let x = 0; x < cols; x++) {
        for (let y = 0; y < rows; y++) {
            const targetX = (x + 29 * pattern + 31 * y) % cols;
            const targetY = (y + 37 * pattern + 41 * targetX) % rows;
            const shiftX = targetX >= es(targetY, splitX, splitY, cols, pattern) ? remX : 0;
            const shiftY = targetY >= qi(targetX, splitX, splitY, rows, pattern) ? remY : 0;
            push(
                targetX * block + shiftX,
                targetY * block + shiftY,
                x * block + (x >= splitX ? remX : 0),
                y * block + (y >= splitY ? remY : 0),
                block,
                block,
            );
        }
    }

    return rects;
}

export function dmmPattern(file, no) {
    const key = `${file}/${no}`;
    let sum = 0;
    for (let i = 0; i < key.length; i++) sum += key.charCodeAt(i);
    return sum % 4 + 1;
}

/**
 * Copy the tiles into the clean page. Pure Buffer work, so tests can exercise
 * the full geometry without a JPEG codec.
 */
export function dmmDescramblePixels(data, info, page) {
    const width = info.width;
    const height = info.height;
    const channels = info.channels;
    const cleanWidth = Math.max(1, width - (Number(page.dummyWidth) || 0));
    const cleanHeight = Math.max(1, height - (Number(page.dummyHeight) || 0));
    const pattern = Number.isInteger(page.pattern) ? page.pattern : dmmPattern(page.file, page.no);
    const out = Buffer.alloc(cleanWidth * cleanHeight * channels);

    for (const rect of dmmTileRects(width, height, pattern)) {
        const w = Math.min(rect.w, cleanWidth - rect.dx, width - rect.sx);
        const h = Math.min(rect.h, cleanHeight - rect.dy, height - rect.sy);
        if (w <= 0 || h <= 0) continue;
        const rowBytes = w * channels;
        for (let row = 0; row < h; row++) {
            const from = ((rect.sy + row) * width + rect.sx) * channels;
            const to = ((rect.dy + row) * cleanWidth + rect.dx) * channels;
            data.copy(out, to, from, from + rowBytes);
        }
    }

    return { data: out, width: cleanWidth, height: cleanHeight, channels };
}

export async function descrambleDmmPage(jpeg, page, { format = 'jpeg' } = {}) {
    const sharp = loadSharp();
    const source = await pagePool()(() => sharp(jpeg).raw().toBuffer({ resolveWithObject: true }));
    // The manifest states the clean Size and the padding the CDN added. A file
    // whose real dimensions disagree would be rearranged against the wrong grid,
    // so fail the page loudly instead of writing a plausible-looking mosaic.
    if (Number(page.width) > 0 && Number(page.height) > 0) {
        const encodedWidth = Number(page.width) + (Number(page.dummyWidth) || 0);
        const encodedHeight = Number(page.height) + (Number(page.dummyHeight) || 0);
        if (source.info.width !== encodedWidth || source.info.height !== encodedHeight) {
            throw new Error(`DMM page ${page.file}/${page.no} is ${source.info.width}x${source.info.height}, `
                + `expected ${encodedWidth}x${encodedHeight} from the manifest`);
        }
    }
    const clean = dmmDescramblePixels(source.data, source.info, page);
    const encoded = await pagePool()(() => {
        const pipeline = sharp(clean.data, {
            raw: { width: clean.width, height: clean.height, channels: clean.channels },
        });
        return format === 'webp'
            ? pipeline.webp({ quality: 95, effort: 4 }).toBuffer()
            : pipeline.jpeg({ quality: 95, chromaSubsampling: '4:4:4' }).toBuffer();
    });
    return { data: encoded, width: clean.width, height: clean.height };
}
