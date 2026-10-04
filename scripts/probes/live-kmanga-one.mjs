// End-to-end validation of the shipped k-manga path on one real sampler volume.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { downloadKmanga, resolveKmangaInput } from '../../src/download/kmanga.js';

const out = fs.mkdtempSync(path.join(os.tmpdir(), 'dokuha-km-live-'));
const resolved = await resolveKmangaInput({ kind: 'kmanga-title', bookId: '167001' }, { series: true, samplers: true }, 'probe', {});
const task = resolved.tasks.find((t) => t.sample) || resolved.tasks[0];
console.error(`task: ${task.title} pages=? launcher=${task.launcher}`);
const record = await downloadKmanga(task, { out, force: true, retries: 2 });
const files = fs.readdirSync(record.folder).filter((f) => f.endsWith('.jpg'));
const sizes = files.map((f) => fs.statSync(path.join(record.folder, f)).size);
console.log(JSON.stringify({ ...record, failures: record.failures.length, filesOnDisk: files.length, minBytes: Math.min(...sizes), maxBytes: Math.max(...sizes) }));
