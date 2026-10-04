
import { createRequire } from 'node:module';
import { parentPort } from 'node:worker_threads';

const require = createRequire(import.meta.url);
const sharp = require('sharp');
const { descramblePage } = require('../../vendor/bookwalker/bw-crypto.js');

sharp.concurrency(1);

const JPEG_QUALITY = 92;

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
