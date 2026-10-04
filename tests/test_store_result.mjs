/**
 * The one result shape every store produces.
 *
 * The point of the normaliser is that a consumer can read `--json` without
 * knowing which store answered. These checks take the real record each adapter
 * returns -- copied from the adapters, so a change there is caught here -- and
 * assert they all come out with the same core.
 */

import { RESULT_CORE, normalizeStoreResult } from '../src/store-result.js';
import { check, checkEqual, finish } from './_harness.mjs';

// What each adapter actually returns, as of the five `return { … }` blocks.
const RAW = {
    cmoa: {
        store: 'cmoa',
        id: '0000249001_jp_0001',
        title: 'サンプル作品 1',
        subtitle: '第1巻',
        folder: '/tmp/out/vol1',
        totalPages: 228,
        downloaded: 228,
        skipped: 0,
        failed: 0,
        bytes: 100,
        failures: [],
    },
    ebookjapan: {
        store: 'ebookjapan',
        id: 'A009000012',
        title: 'サンプル作品 （1）',
        folder: '/tmp/out/vol1',
        totalPages: 244,
        downloaded: 244,
        skipped: 0,
        failed: 0,
        bytes: 200,
        failures: [],
    },
    bookwalker: {
        store: 'bookwalker',
        id: 'f5a00001',
        title: 'サンプル作品 1',
        folder: '/tmp/out/vol1',
        totalPages: 244,
        downloaded: 244,
        skipped: 0,
        failed: 0,
        bytes: 0,
        failures: [],
        route: 'public',
        mode: 'trial',
    },
    kindle: {
        store: 'kindle',
        id: 'B090000001',
        title: 'サンプル作品 1',
        folder: '/tmp/out/vol1',
        totalPages: 240,
        walkedPages: 240,
        downloaded: 233,
        skipped: 0,
        failed: 7,
        bytes: 300,
        failures: [{ file: 'page-0007.jpg', error: 'timeout' }],
        seriesAsin: 'B090000003',
        accessMethod: 'FULL_BOOK',
        sample: false,
        isSample: false,
    },
    kmanga: {
        store: 'kmanga',
        id: '167001',
        bookId: '167001',
        volume: 1,
        title: 'サンプル作品 1',
        folder: '/tmp/out/vol1',
        totalPages: 220,
        downloaded: 220,
        skipped: 0,
        failed: 0,
        bytes: 400,
        failures: [],
        sample: false,
        descrambled: true,
    },
};

const TASKS = {
    cmoa: { kind: 'cmoa', target: '0000249001_jp_0001' },
    ebookjapan: { kind: 'ebookjapan', target: 'A009000012' },
    bookwalker: { kind: 'bookwalker', target: 'f5a00001' },
    kindle: { kind: 'kindle', target: 'B090000001' },
    kmanga: { kind: 'kmanga', target: '167001' },
};

const normalized = Object.fromEntries(
    Object.entries(RAW).map(([name, raw]) => [name, normalizeStoreResult(raw, TASKS[name])]),
);

// The whole point: the core is the same keys with the same types, whichever store
// answered. Store-specific fields may sit beside it, but nothing in the core moves.
{
    const cores = Object.values(normalized)
        .map((r) => RESULT_CORE.map((key) => `${key}:${Array.isArray(r[key]) ? 'array' : typeof r[key]}`).join(','));
    check('every store normalises to the same core shape',
        new Set(cores).size === 1, `saw ${new Set(cores).size} distinct cores`);

    for (const [name, record] of Object.entries(normalized)) {
        const missing = RESULT_CORE.filter((key) => !(key in record));
        check(`${name} carries the whole core`, missing.length === 0, `missing ${missing.join(', ')}`);
    }
}

// Types are stable, so `record.failures.length` is always safe.
{
    for (const [name, record] of Object.entries(normalized)) {
        check(`${name} reports failures as an array`, Array.isArray(record.failures));
        for (const key of ['totalPages', 'downloaded', 'skipped', 'failed', 'bytes']) {
            check(`${name}.${key} is a number`, Number.isFinite(record[key]), `${typeof record[key]}`);
        }
        check(`${name}.sample is a boolean`, typeof record.sample === 'boolean');
    }
}

// Samplers are a fact about the request, so a store that stays silent still
// answers: this is the gap §1b found, where only Kindle reported it.
{
    const asSampler = normalizeStoreResult(RAW.cmoa, { kind: 'cmoa', target: 'x', sample: true });
    checkEqual('a sampler task sets sample for a store that omits it', asSampler.sample, true);
    const asFull = normalizeStoreResult(RAW.cmoa, { kind: 'cmoa', target: 'x' });
    checkEqual('a non-sampler task leaves it false', asFull.sample, false);
    const explicit = normalizeStoreResult({ ...RAW.kindle, sample: true }, TASKS.kindle);
    checkEqual('a store that does report it is believed', explicit.sample, true);
}

// Store-specific fields are not lost; they simply are not promised.
{
    checkEqual('BookWalker keeps its route', normalized.bookwalker.route, 'public');
    checkEqual('kindle keeps its series', normalized.kindle.seriesAsin, 'B090000003');
    checkEqual('k-manga keeps its volume number', normalized.kmanga.volume, 1);
    checkEqual('CMOA keeps its subtitle', normalized.cmoa.subtitle, '第1巻');
}

// A missing or malformed number becomes 0 rather than undefined, so arithmetic on
// a record cannot produce NaN.
{
    const sparse = normalizeStoreResult({ store: 'cmoa', id: 'x', title: 't', folder: '/f' }, TASKS.cmoa);
    checkEqual('absent counts read as zero',
        [sparse.totalPages, sparse.downloaded, sparse.skipped, sparse.failed, sparse.bytes],
        [0, 0, 0, 0, 0]);
    checkEqual('absent failures read as an empty list', sparse.failures, []);
    const junk = normalizeStoreResult({ ...RAW.cmoa, downloaded: 'many', bytes: null }, TASKS.cmoa);
    checkEqual('a non-numeric count reads as zero', junk.downloaded, 0);
    checkEqual('a null count reads as zero', junk.bytes, 0);
}

// An adapter that forgets to return anything is a bug, and saying so beats
// emitting a record full of zeroes that reads like a successful empty volume.
{
    let thrown = null;
    try {
        normalizeStoreResult(null, TASKS.cmoa);
    } catch (error) {
        thrown = error;
    }
    check('a missing record is an error', thrown instanceof Error, String(thrown));
    check('the error names the store', /cmoa/.test(thrown?.message || ''), thrown?.message);
}

finish();
