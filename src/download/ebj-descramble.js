
import { createRequire } from 'node:module';
import os from 'node:os';
import { createPool } from '../serial.js';

let composeSlots = null;

function composePool() {
    if (!composeSlots) {
        const cores = os.cpus()?.length || 4;
        composeSlots = createPool(Math.max(1, Math.min(8, cores)));
    }
    return composeSlots;
}

const QUARTER_TURN = Math.PI / 2;

const WEBP_QUALITY = 90;

const JPEG_QUALITY = 95;

const require = createRequire(import.meta.url);

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
        // Deliberately *not* `sharp.concurrency(1)` here, unlike the BookWalker
        // normaliser. Measured on one 244-page volume with the pool at 8: pinning
        // libvips to a single thread gave 8.65 s, leaving it at its default gave
        // 7.83 s. The two workers have different shapes -- BookWalker runs one
        // operation per page across 128 concurrent requests, this one runs two
        // (decode, encode) across 8 -- so the tuning does not transfer.
        return require('sharp');
    } catch {
        throw new Error(
            'ebookjapan pages are tile-scrambled and rebuilding them needs the optional "sharp" dependency, '
            + 'which is not installed.\n'
            + '  Install it with:  npm install sharp\n'
            + '  Or pass --no-descramble to keep the scrambled mosaic as downloaded.',
        );
    }
}

export function assertSharpAvailable() {
    loadSharp();
}

export function recordShuffle(glue, page, size) {
    const ops = [];
    const unknown = new Set();
    const record = {
        canvas: { width: size.width, height: size.height },
        rotate: (angle) => ops.push({ t: 'rotate', angle: Number(angle) }),
        setTransform: () => ops.push({ t: 'reset' }),
        drawImage: (_image, sx, sy, sw, sh, dx, dy, dw, dh) => ops.push({
            t: 'draw',
            sx: Number(sx), sy: Number(sy), sw: Number(sw), sh: Number(sh),
            dx: Number(dx), dy: Number(dy), dw: Number(dw), dh: Number(dh),
        }),
    };
    const ctx = new Proxy(record, {
        get(target, key) {
            if (key in target) return target[key];

            return (...args) => { unknown.add(`${String(key)}/${args.length}`); };
        },
    });

    glue.shuffle({
        ctx,
        x: 0,
        y: 0,
        data: { image: { width: size.width, height: size.height } },
        autographed: undefined,
        page,
    });
    return { ops, unknown: [...unknown] };
}

function rotatedBounds(draw, turn) {
    const { dx, dy, dw, dh } = draw;
    switch (turn) {
        case 1: return [-(dy + dh), -dy, dx, dx + dw];
        case 2: return [-(dx + dw), -dx, -(dy + dh), -dy];
        case 3: return [dy, dy + dh, -(dx + dw), -dx];
        default: return [dx, dx + dw, dy, dy + dh];
    }
}

export function planComposition(ops) {
    const tiles = [];
    let turn = 0;
    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;

    for (const op of ops) {
        if (op.t === 'rotate') {
            const quarters = Math.round(op.angle / QUARTER_TURN);
            turn = (((turn + quarters) % 4) + 4) % 4;
            continue;
        }
        if (op.t === 'reset') {
            turn = 0;
            continue;
        }
        if (op.t !== 'draw') continue;

        const [x0, x1, y0, y1] = rotatedBounds(op, turn);
        minX = Math.min(minX, x0);
        maxX = Math.max(maxX, x1);
        minY = Math.min(minY, y0);
        maxY = Math.max(maxY, y1);
        tiles.push({ ...op, turn, x0, y0 });
    }

    if (!tiles.length) return { width: 0, height: 0, minX: 0, minY: 0, tiles: [] };
    return { width: maxX - minX, height: maxY - minY, minX, minY, tiles };
}

export function blitTiles(pixels, info, plan, size) {
    const width = size?.width ?? plan.width;
    const height = size?.height ?? plan.height;
    const { minX, minY, tiles } = plan;
    const channels = info.channels;
    const out = Buffer.alloc(width * height * channels);

    for (const tile of tiles) {
        const { sx, sy, dw, dh, turn, x0, y0 } = tile;
        const baseX = x0 - minX;
        const baseY = y0 - minY;
        for (let v = 0; v < dh; v++) {
            const sourceY = sy + v;
            if (sourceY < 0 || sourceY >= info.height) continue;
            for (let u = 0; u < dw; u++) {
                let row;
                let col;
                if (turn === 0) { col = u; row = v; }
                else if (turn === 1) { col = dh - 1 - v; row = u; }
                else if (turn === 2) { col = dw - 1 - u; row = dh - 1 - v; }
                else { col = v; row = dw - 1 - u; }

                const outX = baseX + col;
                const outY = baseY + row;
                if (outX < 0 || outX >= width || outY < 0 || outY >= height) continue;
                const sourceX = sx + u;
                if (sourceX < 0 || sourceX >= info.width) continue;

                const to = (outY * width + outX) * channels;
                const from = (sourceY * info.width + sourceX) * channels;
                for (let c = 0; c < channels; c++) out[to + c] = pixels[from + c];
            }
        }
    }
    return out;
}

export async function composePage(scrambled, ops, box, { format = 'jpeg' } = {}) {
    const plan = planComposition(ops);
    if (!plan.tiles.length) return null;

    const size = box && box.width > 0 && box.height > 0
        ? { width: Math.min(box.width, plan.width), height: Math.min(box.height, plan.height) }
        : { width: plan.width, height: plan.height };

    const sharp = loadSharp();

    const source = await composePool()(() => sharp(scrambled).raw().toBuffer({ resolveWithObject: true }));
    const pixels = blitTiles(source.data, source.info, plan, size);
    // The store serves lossy VP8 WebP. Re-encoding it *losslessly* preserves the
    // compression artefacts at roughly five times the size and fifty times the CPU,
    // so the output codec is chosen to be lossy too. 4:4:4 because the pages are
    // line art on tinted paper, where chroma subsampling bleeds colour into the
    // strokes.
    const data = await composePool()(() => {
        const pipeline = sharp(pixels, {
            raw: { width: size.width, height: size.height, channels: source.info.channels },
        });
        return format === 'webp'
            ? pipeline.webp({ quality: WEBP_QUALITY, effort: 4 }).toBuffer()
            : pipeline.jpeg({ quality: JPEG_QUALITY, chromaSubsampling: '4:4:4' }).toBuffer();
    });

    return { data, width: size.width, height: size.height };
}
