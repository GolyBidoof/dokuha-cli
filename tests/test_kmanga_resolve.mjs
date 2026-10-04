/**
 * Turning a k-manga URL into downloads, without the network.
 *
 * `resolveKmangaInput` takes its fetch from the context, so the whole selection
 * rule can be driven from a saved page: which volumes are free, which are samplers,
 * what order they come in, and what a volume URL means under `--series`.
 *
 * That last one is not a detail. Every other store treats a volume URL as an entry
 * point under `--series` -- paste volume 5, walk the series -- and this resolver
 * filtered to the pasted volume instead while still reporting the whole series in
 * its note, so the summary and the work disagreed. These checks pin both readings:
 * one volume when one volume was asked for, the series when `--series` was.
 */

import path from 'node:path';
import os from 'node:os';
import fsp from 'node:fs/promises';

import { resolveKmangaInput } from '../src/download/kmanga.js';
import { readVolumeMarker, resolveVolumeFolder, writeVolumeMarker } from '../src/download/volume-folder.js';
import { check, checkEqual, finish } from './_harness.mjs';

const tmpRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'km-resolve-'));

const TITLEJS = `<script id="titlejs" data-book="180001" data-format-type="pv"
    data-fcipath="1" data-viewer-id-pc="3" data-quality-default="1"></script>`;

/** A free volume: a real link, read type 4. */
const free = (n) => `<a href="/viewer-launcher/3/1/180001/pv/${n}/1/4/0/0"
    class="book-chapter--btn book-chapter--btn__jikkuri gaevent-detail-notlogin-btn-free" rel="nofollow">無料で読む</a>`;

/** A sampler: a button the page's script turns into a URL, read type 0. */
const sample = (n) => `<a class="btn book-chapter--btn__sample x-invoke-viewer--btn__selector"
    data-chapter-exid="${n}" data-chapter-fcipath="1" data-chapter-readType="0"
    data-chapter-fcid="0" data-chapter-fcupdated="0" rel="nofollow">試し読み</a>`;

const NAME_LD = `<script type="application/ld+json">{"@type":"ProductGroup","name":"サンプル作品"}</script>`;

/** Two free volumes, then two sample-only ones -- the live shape, shrunk. */
const PAGE = `${NAME_LD}${TITLEJS}${free(1)}${free(2)}${sample(3)}${sample(4)}`;

let asked = [];
const ctx = {
    userAgent: 'test',
    fetchImpl: async (url) => {
        asked.push(String(url));
        return new Response(PAGE, { status: 200 });
    },
};
const title = { kind: 'kmanga-title', bookId: '180001', url: 'https://comic.k-manga.jp/title/180001/pv' };
const volume = (n) => ({ kind: 'kmanga-volume', bookId: '180001', volume: n, url: `https://comic.k-manga.jp/title/180001/vol/${n}` });

const targets = (result) => result.tasks.map((t) => t.target);
const ids = (result) => result.tasks.map((t) => t.id);

/** The folder a task will write into, resolved the way the adapter resolves it. */
async function folderFor(task, root) {
    return resolveVolumeFolder(root, task.title, task.id, { sample: task.sample === true });
}

// `--series` on a title page: the free volumes only, unless samplers were asked for.
{
    const plain = await resolveKmangaInput(title, { series: true }, 'title', ctx);
    checkEqual('a series run takes the free volumes', targets(plain), ['サンプル作品 (1)', 'サンプル作品 (2)']);
    check('and says how many samplers it left behind',
        /--download-samplers/.test(plain.notes.join(' ')), plain.notes.join(' '));

    const withSamplers = await resolveKmangaInput(title, { series: true, samplers: true }, 'title', ctx);
    checkEqual('samplers are appended after the free volumes', targets(withSamplers), [
        'サンプル作品 (1)', 'サンプル作品 (2)', 'サンプル作品 (3)（試し読み）', 'サンプル作品 (4)（試し読み）',
    ]);
    checkEqual('each volume still carries a stable id behind the name', ids(withSamplers), [
        '180001vol1', '180001vol2', '180001vol3sample', '180001vol4sample',
    ]);
    checkEqual('a sampler is flagged as one', withSamplers.tasks.slice(2).map((t) => t.sample), [true, true]);
    checkEqual('a free volume is not', withSamplers.tasks.slice(0, 2).map((t) => t.sample), [false, false]);
    check('the note counts both', /2 free volume\(s\), plus 2/.test(withSamplers.notes.join(' ')), withSamplers.notes.join(' '));
    checkEqual('every task names the series', withSamplers.tasks[0].title, 'サンプル作品 (1)');
    check('a sampler launcher is the rebuilt one',
        withSamplers.tasks[2].launcher === 'https://comic.k-manga.jp/viewer-launcher/3/1/180001/pv/3/1/0/0/0',
        withSamplers.tasks[2].launcher);
}

// Without `--series`, one volume was asked for, so one volume comes back -- and a
// sampler-only volume is a legitimate answer.
{
    const one = await resolveKmangaInput(volume(2), { series: false }, 'vol2', ctx);
    checkEqual('a volume URL outside --series is that volume', targets(one), ['サンプル作品 (2)']);

    const sampled = await resolveKmangaInput(volume(3), { series: false }, 'vol3', ctx);
    checkEqual('a sampler-only volume resolves to its sampler', targets(sampled), ['サンプル作品 (3)（試し読み）']);
    checkEqual('and is flagged', sampled.tasks[0].sample, true);
    checkEqual('and keeps the whole-volume name underneath', sampled.tasks[0].title, 'サンプル作品 (3)');

    // The point of the split: the reader sees the name, the folder is the name, and
    // only the marker keeps the id.
    const task = sampled.tasks[0];
    const folder = await folderFor(task, tmpRoot);
    checkEqual('the sampler folder is the volume name plus the sampler suffix',
        path.basename(folder), 'サンプル作品 (3)（試し読み）');

    // Round-trip what a finished download writes, then resolve again: the same
    // folder has to come back, or a resumed run would start a second copy.
    await fsp.mkdir(folder, { recursive: true });
    await writeVolumeMarker(folder, {
        store: 'kmanga', id: task.id, bookId: task.bookId, volume: task.volume,
        title: task.target, sample: task.sample,
    });
    const marker = await readVolumeMarker(folder);
    checkEqual('the marker is written under the name the reader saw', marker.title, 'サンプル作品 (3)（試し読み）');
    checkEqual('while the stable id is what tells folders apart', marker.id, '180001vol3sample');
    checkEqual('and the sampler flag is recorded', marker.sample, true);
    checkEqual('re-resolving lands in the same folder', await folderFor(task, tmpRoot), folder);

    // A different volume whose name cleans up the same must not join it.
    const clash = await resolveVolumeFolder(tmpRoot, 'サンプル作品 (3)', '180001vol9sample', { sample: true });
    check('a same-named folder owned by another id is not reused', clash !== folder, clash);
    check('and the id is what disambiguates it', clash.includes('180001vol9sample'), clash);
}

// Under `--series` the volume number is only the entry point, which is what every
// other store means by it.
{
    const walked = await resolveKmangaInput(volume(1), { series: true, samplers: true }, 'vol1', ctx);
    checkEqual('--series walks the series from whatever volume was pasted', ids(walked), [
        '180001vol1', '180001vol2', '180001vol3sample', '180001vol4sample',
    ]);

    const fromSample = await resolveKmangaInput(volume(4), { series: true }, 'vol4', ctx);
    checkEqual('even pasting a sampler volume walks the free ones', ids(fromSample), ['180001vol1', '180001vol2']);
}

// A volume the page offers nothing for is rejected with a reason, not silently
// dropped or turned into an empty download.
{
    const missing = await resolveKmangaInput(volume(9), { series: false }, 'vol9', ctx);
    checkEqual('a volume with no offer produces no task', missing.tasks.length, 0);
    check('and says why', /no reading entry point/.test(missing.rejected[0]?.error || ''), missing.rejected[0]?.error);
}

// One request per input: the title page is fetched once and parsed once.
{
    asked = [];
    await resolveKmangaInput(title, { series: true, samplers: true }, 'title', ctx);
    checkEqual('the title page is fetched exactly once', asked.length, 1);
    check('from the title URL for that book', /\/title\/180001\/pv$/.test(asked[0]), asked[0]);
}

finish();
