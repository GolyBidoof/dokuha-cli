// Live validation of the folder-ingest + stream-driven finalize path.
//
//   node scripts/probes/live-bridge-ingest.mjs [folder]
//
// Points at the running mokuro-bridge, hands it an already-downloaded volume
// folder, and finalizes to a temporary local directory. Nothing is uploaded to a
// remote destination. Two requests are expected for the whole volume however many
// pages it has; `--no-folder-ingest` is the control arm.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { connectBridge, pushToBridge, pageFiles } from '../../src/bridge.js';
import { resolveDestination, describeDestinations } from '../../vendor/ebookjapan/bridge.mjs';

const folder = path.resolve(process.argv[2]
    || path.join(process.cwd(), 'library', 'サンプル作品【期間限定無料】 1'));
const noIngest = process.argv.includes('--no-folder-ingest');
const title = `dokuha probe ${noIngest ? 'pages' : 'folder'} ${Date.now()}`;

const files = await pageFiles(folder);
const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dokuha-bridge-out-'));
console.error(`folder: ${folder}`);
console.error(`pages:  ${files.length}`);
console.error(`title:  ${title}`);
console.error(`out:    ${outDir}`);

const bridge = await connectBridge(
    { bridge: null, dest: 'local', localDir: outDir, destFolder: null },
    { resolveDestination, describeDestinations },
);
console.error(`bridge: ${bridge.baseUrl} dest=${bridge.destInfo.method}`);

const started = performance.now();
let last = '';
const progress = {
    update(key, patch) {
        const line = JSON.stringify(patch);
        if (line !== last) {
            last = line;
            console.error(`  ${line}`);
        }
    },
    note(message) { console.error(message); },
};

const record = await pushToBridge(
    bridge.client,
    bridge.destInfo,
    { key: 'probe', id: 'probe', title, folder },
    { pushConcurrency: 4, progress, folderIngest: !noIngest },
);

console.log(JSON.stringify({
    ...record,
    failures: record.failures?.length ?? 0,
    wall: +((performance.now() - started) / 1000).toFixed(2),
    pages: files.length,
}, null, 2));
