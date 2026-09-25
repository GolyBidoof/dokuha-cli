/**
 * Live store tests.
 *
 * Opt in with MANGA_DL_TEST_NETWORK=1. These hit real stores, so they are excluded
 * from the default suite: `npm test` must stay fast, offline and deterministic.
 *
 * They exist because the two bugs that mattered most in this codebase were both
 * invisible to unit tests: a doubled `de` prefix that 404'd every BookWalker route,
 * and a manifest URL missing a path segment that answered 403 from the CDN.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { downloadCmoa, probeCmoaVolume } from '../src/download/cmoa.js';
import { downloadEbookjapan } from '../src/download/ebookjapan.js';
import { downloadBookwalker, assertSharpAvailable } from '../src/download/bookwalker.js';
import { check, checkEqual, finish } from './_harness.mjs';

const out = fs.mkdtempSync(path.join(os.tmpdir(), 'manga-dl-net-'));
const ctx = {
    out,
    titleDir: false,
    progress: null,
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36',
    concurrency: 8,
    jobs: 4,
    force: false,
    format: 'original',
    quality: null,
    bridge: null,
    config: { titleDir: false, bwCookies: [], bwNoState: false, bwCr: null, bwNoCr: false, bwU1: null, bwSample: false, bwEntry: null, bwState: null, bwConcurrency: 8, pushConcurrency: 2 },
};

try {
    // A volume that does not exist must be reported as absent rather than thrown,
    // because that is how series scanning detects the end of a series.
    {
        const absent = await probeCmoaVolume('0000000000_jp_0001');
        checkEqual('a non-existent CMOA volume probes as absent', absent, null);
    }

    // CMOA.
    {
        const record = await downloadCmoa({ cid: '0000249510_jp_0002', key: 'cmoa:net' }, ctx);
        checkEqual('CMOA reports the right store', record.store, 'cmoa');
        check('CMOA downloaded every page', record.downloaded > 200 && record.failed === 0,
            `${record.downloaded}/${record.totalPages}, ${record.failed} failed`);
        check('CMOA resolved a real title', /スーパーの裏でヤニ吸う/.test(record.title || ''), record.title);
        check('CMOA pages are on disk', fs.readdirSync(record.folder).length > 200);
    }

    // ebookjapan.
    {
        const record = await downloadEbookjapan(
            { target: 'https://ebookjapan.yahoo.co.jp/books/126344/A000065415/', key: 'ebj:net' },
            { ...ctx, concurrency: 16 },
        );
        checkEqual('ebookjapan reports the right store', record.store, 'ebookjapan');
        check('ebookjapan downloaded every page', record.downloaded === 199 && record.failed === 0,
            `${record.downloaded}/${record.totalPages}, ${record.failed} failed`);
        check('ebookjapan resolved a real title', /夏目友人帳/.test(record.title || ''), record.title);
    }

    // BookWalker. Skipped rather than failed when sharp is absent, because sharp
    // is an optional dependency and its absence is a legitimate configuration.
    {
        let sharpMissing = false;
        try { assertSharpAvailable(); } catch { sharpMissing = true; }
        if (sharpMissing) {
            check('BookWalker is skipped without sharp, not failed', true);
        } else {
            const record = await downloadBookwalker(
                { cid: 'f45047f5-6b90-4d4f-84f7-bd8263daee70', target: 'https://bookwalker.jp/def45047f5-6b90-4d4f-84f7-bd8263daee70/', key: 'bw:net' },
                ctx,
            );
            checkEqual('BookWalker reports the right store', record.store, 'bookwalker');
            check('BookWalker downloaded every page', record.downloaded === 62 && record.failed === 0,
                `${record.downloaded}/${record.totalPages}, ${record.failed} failed`);
            check('BookWalker resolved a real title', /さんかく窓/.test(record.title || ''), record.title);
        }
    }
} catch (error) {
    check('the live run completed without throwing', false, error.message);
} finally {
    fs.rmSync(out, { recursive: true, force: true });
}

finish();
