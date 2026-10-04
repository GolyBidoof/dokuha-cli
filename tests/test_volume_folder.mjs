/**
 * The volume-folder contract.
 *
 * One function decides which folder a volume writes into, and it does so by
 * reading a marker the previous run left behind. Two volumes whose titles clean up
 * to the same name have to end up in different folders, and a folder written
 * before the marker carried an owner must not be mistaken for someone else's.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { resolveVolumeFolder, readVolumeMarker, writeVolumeMarker, safeFolderName } from '../src/download/volume-folder.js';
import { check, checkEqual, finish } from './_harness.mjs';

const out = fs.mkdtempSync(path.join(os.tmpdir(), 'dokuha-folder-'));

// A fresh name is used directly and is not disambiguated.
checkEqual('an unused name is used as-is',
    path.basename(await resolveVolumeFolder(out, 'Test Title', 'ID1')), 'Test Title');

// The same volume resolving again must find the same folder, not a second one.
await fs.promises.mkdir(path.join(out, 'Test Title'), { recursive: true });
await writeVolumeMarker(path.join(out, 'Test Title'), { store: 'cmoa', id: 'ID1', title: 'Test Title' });
checkEqual('the owning volume reuses its folder',
    path.basename(await resolveVolumeFolder(out, 'Test Title', 'ID1')), 'Test Title');

// A different volume with the same cleaned title must not be merged into it.
checkEqual('a different volume is given its own folder',
    path.basename(await resolveVolumeFolder(out, 'Test Title', 'ID2')), 'Test Title (ID2)');
check('the disambiguated folder is a sibling, not nested',
    (await resolveVolumeFolder(out, 'Test Title', 'ID2')).startsWith(out));

// A marker from before the field existed — ebookjapan used to keep its page
// manifest here, which has no `id`. Renaming every such folder on the next run
// would split one volume across two directories, so it is taken as this volume's.
await fs.promises.mkdir(path.join(out, 'Legacy'), { recursive: true });
await fs.promises.writeFile(path.join(out, 'Legacy', 'metadata.json'),
    JSON.stringify({ title: 'Legacy', publication: 'A000000001', pages: [] }));
checkEqual('an ownerless marker is not treated as another volume',
    path.basename(await resolveVolumeFolder(out, 'Legacy', 'A000000001')), 'Legacy');
checkEqual('the legacy marker is still readable as a marker',
    (await readVolumeMarker(path.join(out, 'Legacy'))).publication, 'A000000001');

// A sampler shares the full volume's name but is a different book.
check('a sampler folder says which it holds',
    path.basename(await resolveVolumeFolder(out, 'Test Title', 'ID1', { sample: true })).includes('試し読み'));

// A store with its own naming rules keeps them while still going through the
// same owner check.
const sanitize = (value) => String(value).replace(/\//g, ' ').slice(0, 120);
checkEqual('a caller can keep its own folder naming',
    path.basename(await resolveVolumeFolder(out, 'A/B', 'ID3', { sanitize })), 'A B');

checkEqual('names are trimmed at 80 columns and never end in a dot',
    safeFolderName(`${'x'.repeat(90)}.`), 'x'.repeat(80));

finish();
