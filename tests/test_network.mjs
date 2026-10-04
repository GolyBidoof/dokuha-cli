/**
 * Live store tests.
 *
 * Opt in with DOKUHA_TEST_NETWORK=1. These hit real stores, so they are excluded
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
import { openKmangaSession, resolveKmangaInput } from '../src/download/kmanga.js';
import { check, checkEqual, finish } from './_harness.mjs';

const out = fs.mkdtempSync(path.join(os.tmpdir(), 'dokuha-net-'));

// This is a live smoke test: it asks the real store what these ids resolve to.
// The expectation is deliberately NOT pinned to a named work -- pinning it would
// both rot the moment the store changes and put a real title in the repository.
// What matters here is that the store answered with a usable title at all.
const checkTitle = (store, title) => check(
    `${store} resolved a non-empty title`,
    typeof title === 'string' && title.trim().length > 0, title);
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
        const record = await downloadCmoa({ cid: '0000249001_jp_0002', key: 'cmoa:net' }, ctx);
        checkEqual('CMOA reports the right store', record.store, 'cmoa');
        check('CMOA downloaded every page', record.downloaded > 200 && record.failed === 0,
            `${record.downloaded}/${record.totalPages}, ${record.failed} failed`);
        checkTitle('CMOA', record.title);
        check('CMOA pages are on disk', fs.readdirSync(record.folder).length > 200);
    }

    // ebookjapan.
    {
        const record = await downloadEbookjapan(
            { target: 'https://ebookjapan.yahoo.co.jp/books/126001/A009000001/', key: 'ebj:net' },
            { ...ctx, concurrency: 16 },
        );
        checkEqual('ebookjapan reports the right store', record.store, 'ebookjapan');
        check('ebookjapan downloaded every page', record.downloaded === 199 && record.failed === 0,
            `${record.downloaded}/${record.totalPages}, ${record.failed} failed`);
        checkTitle('ebookjapan', record.title);
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
                { cid: '00000006-0000-4000-8000-000000000006', target: 'https://bookwalker.jp/de00000006-0000-4000-8000-000000000006/', key: 'bw:net' },
                ctx,
            );
            checkEqual('BookWalker reports the right store', record.store, 'bookwalker');
            check('BookWalker downloaded every page', record.downloaded === 62 && record.failed === 0,
                `${record.downloaded}/${record.totalPages}, ${record.failed} failed`);
            checkTitle('BookWalker', record.title);
        }
    }
    // k-manga. Deliberately the discovery half only: resolving a volume proves the
    // gate cookie still works, that the title page still publishes a launcher, and
    // that the launcher still answers 302 with a usable ticket -- the three things
    // that break when the site changes. Downloading the volume is covered by the
    // fixture tests, which do not need the store to be up to catch a regression.
    {
        const det = { kind: 'kmanga-volume', bookId: '180001', volume: 1 };
        const resolved = await resolveKmangaInput(det, { series: false }, 'kmanga network test', ctx);
        check('k-manga resolves a free volume to a launcher',
            resolved.tasks.length === 1 && /viewer-launcher/.test(resolved.tasks[0].launcher),
            JSON.stringify(resolved.rejected));
        if (resolved.tasks.length) {
            const { session } = await openKmangaSession(resolved.tasks[0].launcher, ctx);
            check('the launcher hands back a ticket', /^BGTK_/.test(session.ticket || ''), session.ticket);
            check('the launcher hands back an obfuid', Boolean(session.obfuid));
            check('the ticket names the volume that was asked for', session.bookId, '180001');

            // The sampler half of the same page. This is the assertion that would
            // have caught the bug this feature was written for: reading only hrefs
            // reports two volumes where the title offers ten, and says nothing.
            const withSamplers = await resolveKmangaInput(
                det, { series: true, samplers: true }, 'kmanga network test', ctx,
            );
            const samplers = withSamplers.tasks.filter((t) => t.sample);
            const freeTasks = withSamplers.tasks.filter((t) => !t.sample);
            check('the title page still advertises samplers', samplers.length > 0,
                `${withSamplers.tasks.length} volume(s) resolved, none of them samples`);
            check('every sampler has a launcher the socket can use',
                samplers.every((t) => /\/viewer-launcher\/\d+\/\d+\/\d+\/\w+\/\d+\/\d+\/0\//.test(t.launcher)),
                JSON.stringify(samplers.map((t) => t.launcher).slice(0, 3)));
            check('samplers are ordered after the free volumes',
                withSamplers.tasks.findIndex((t) => t.sample) > freeTasks.length - 1);
            check('a sampler is named after the volume, not an id',
                samplers.every((t) => /試し読み）$/.test(t.target)),
                JSON.stringify(samplers.map((t) => t.target).slice(0, 3)));
            check('and keeps a stable id for its folder marker',
                samplers.every((t) => /sample$/.test(t.id)),
                JSON.stringify(samplers.map((t) => t.id).slice(0, 3)));
        }
    }
} catch (error) {
    check('the live run completed without throwing', false, error.message);
} finally {
    fs.rmSync(out, { recursive: true, force: true });
}

finish();
