/**
 * The whole-volume "already present" gate.
 *
 * This module caused a release blocker: it counted image files and compared the
 * count to the expected pages, so a truncated page made a folder look complete and
 * the adapter's own per-page recovery never ran. These checks pin the contract it
 * has to keep: validate every page, report the bytes on disk, and carry `sample`
 * like every other result.
 */

import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { check, checkEqual, finish } from './_harness.mjs';
import { existingVolume } from '../src/download/existing-volume.js';
import { writeVolumeMarker } from '../src/download/volume-folder.js';

const jpeg = (payload) => Buffer.concat([
    Buffer.from([0xff, 0xd8, 0xff]),
    Buffer.alloc(payload, 0x20),
    Buffer.from([0xff, 0xd9]),
]);

const out = await fsp.mkdtemp(path.join(os.tmpdir(), 'dokuha-existing-'));
const title = 'Synthetic Volume';
const id = 'B000000001';
const folder = path.join(out, title);
const page = (n) => path.join(folder, `page-${String(n).padStart(4, '0')}.jpg`);
const sizes = { 1: 1000, 2: 2000, 3: 3000 };

await fsp.mkdir(folder, { recursive: true });
await writeVolumeMarker(folder, { store: 'kindle', id, title });
for (const [n, size] of Object.entries(sizes)) await fsp.writeFile(page(n), jpeg(size));
const onDisk = Object.values(sizes).reduce((sum, n) => sum + n + 5, 0);

const ctx = { out, titleDir: true, config: {} };
const ask = (extra = {}) => existingVolume(ctx, {
    store: 'kindle', title, id, expectedPages: 3, folder, ...extra,
});

{
    const hit = await ask({ sample: true });
    check('a complete volume is recognised', hit !== null);
    checkEqual('every page counts as skipped', hit.skipped, 3);
    checkEqual('the byte total is what is on disk, not zero', hit.bytes, onDisk);
    checkEqual('the marker owner is echoed back', hit.id, id);
    checkEqual('sample survives the skip path', hit.sample, true);
    checkEqual('the destination is reported as local', hit.existingDestination.method, 'local');
}

{
    // The blocker: a page that is not a whole image must fall through so the
    // adapter refetches it, however many files are present.
    await fsp.writeFile(page(2), Buffer.from([0xff, 0xd8, 0xff, 0x00]));
    checkEqual('a truncated page stops the whole-volume skip', await ask(), null);
    await fsp.writeFile(page(2), jpeg(sizes[2]));
}

{
    checkEqual('a different owner is not this volume', await existingVolume(ctx, {
        store: 'kindle', title, id: 'B000000999', expectedPages: 3, folder,
    }), null);
}

{
    const forced = await existingVolume({ ...ctx, force: true }, {
        store: 'kindle', title, id, expectedPages: 3, folder,
    });
    checkEqual('ctx.force ignores what is on disk', forced, null);
    const overwritten = await existingVolume({ ...ctx, config: { overwrite: true } }, {
        store: 'kindle', title, id, expectedPages: 3, folder,
    });
    checkEqual('config.overwrite ignores what is on disk', overwritten, null);
}

{
    const extra = path.join(folder, 'page-0004.jpg');
    await fsp.writeFile(extra, jpeg(4000));
    checkEqual('a page count above the expectation is not a match', await ask(), null);
    await fsp.rm(extra);
}

{
    // The remote branch asks the bridge; it has no bytes to add, but it must still
    // carry the core fields, `sample` included.
    const remoteCtx = {
        out, titleDir: true, config: {},
        destinationCheck: async () => ({ exists: true, method: 'mega', file: 'x.mokuro', remote_dir: '/x' }),
    };
    const hit = await existingVolume(remoteCtx, {
        store: 'cmoa', title, id, expectedPages: 12, sample: true, checkRemote: true, checkLocal: false,
    });
    check('a remote destination short-circuits the download', hit !== null);
    checkEqual('the remote record carries sample', hit.sample, true);
    checkEqual('the remote record carries the page count', hit.totalPages, 12);
    checkEqual('the remote method is reported', hit.existingDestination.method, 'mega');
}

{
    const missing = await existingVolume({ ...ctx, bridge: {} }, {
        store: 'kindle', title, id, expectedPages: 3, folder, checkRemote: false, checkLocal: false,
    });
    checkEqual('a bridge run does not use the local skip', missing, null);
}

await fsp.rm(out, { recursive: true, force: true });
finish();
