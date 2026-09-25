/**
 * Bridge helpers.
 *
 * These are tested because two of them caused real bugs: page ordering decides
 * OCR order, and the session-reuse fallback is the only thing standing between a
 * re-run and a hard failure on an already-finalized session.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { contentTypeFor, pageFiles, startBridgeSession } from '../src/bridge.js';
import { check, checkEqual, finish } from './_harness.mjs';

// Content types must cover every extension an engine can write, and must never
// guess for an unknown one.
{
    checkEqual('a .jpg is a jpeg', contentTypeFor('a.jpg'), 'image/jpeg');
    checkEqual('a .jpeg is a jpeg', contentTypeFor('a.jpeg'), 'image/jpeg');
    checkEqual('a .png is a png', contentTypeFor('a.png'), 'image/png');
    checkEqual('a .webp is a webp', contentTypeFor('a.webp'), 'image/webp');
    checkEqual('an uppercase extension still matches', contentTypeFor('A.JPG'), 'image/jpeg');
    checkEqual('an unknown extension is octet-stream', contentTypeFor('a.bin'), 'application/octet-stream');
    checkEqual('no extension is octet-stream', contentTypeFor('plain'), 'application/octet-stream');
}

// Page order is the OCR order, so it must be numeric rather than lexicographic:
// a plain string sort puts page 10 before page 2.
{
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'manga-dl-pages-'));
    try {
        for (const name of ['page_0001.jpg', 'page_0002.jpg', 'page_0010.jpg', 'notes.txt', 'page_0003.png']) {
            fs.writeFileSync(path.join(dir, name), 'x');
        }
        const files = await pageFiles(dir);

        checkEqual('non-images are ignored', files.length, 4);
        checkEqual('pages come back in numeric order',
            files.map((f) => f.path.split('/').pop()),
            ['page_0001.jpg', 'page_0002.jpg', 'page_0003.png', 'page_0010.jpg']);
        checkEqual('indices are zero-based and contiguous', files.map((f) => f.index), [0, 1, 2, 3]);

        // The bridge names its output from the filenames it is handed, so every
        // name must be normalised to the same shape regardless of what the store
        // wrote.
        check('names are normalised to page_NNNN.ext',
            files.every((f, i) => f.name === `page_${String(i + 1).padStart(4, '0')}${path.extname(f.path).toLowerCase()}`),
            JSON.stringify(files.map((f) => f.name)));
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
}

// Store engines write wildly different names; order must still be page order.
{
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'manga-dl-pages2-'));
    try {
        for (const name of ['0001.jpg', '0002.jpg', '0003.jpg']) fs.writeFileSync(path.join(dir, name), 'x');
        const files = await pageFiles(dir);
        checkEqual('zero-padded numeric names sort correctly',
            files.map((f) => f.path.split('/').pop()), ['0001.jpg', '0002.jpg', '0003.jpg']);
        checkEqual('their normalised names are page_0001 upwards',
            files.map((f) => f.name), ['page_0001.jpg', 'page_0002.jpg', 'page_0003.jpg']);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
}

// A folder with no images must yield an empty list, so the caller can produce a
// clear "no page images found" error rather than pushing nothing.
{
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'manga-dl-empty-'));
    try {
        fs.writeFileSync(path.join(dir, 'readme.txt'), 'x');
        checkEqual('a folder with no images yields nothing', (await pageFiles(dir)).length, 0);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
}

// Session reuse: a plain success must not be retried, and a refusal that has
// nothing to do with reuse must not be swallowed.
{
    let calls = 0;
    const ok = { startSession: async () => { calls++; return { session_id: 's1' }; } };
    const session = await startBridgeSession(ok, 'volume 1');
    checkEqual('a successful reuse is returned as-is', session.session_id, 's1');
    checkEqual('a successful reuse is attempted once', calls, 1);

    let retried = 0;
    const finalized = {
        startSession: async (title, opts) => {
            retried++;
            if (opts.reuseExisting) {
                const error = new Error('Session is finalizing or already finalized');
                error.status = 400;
                throw error;
            }
            return { session_id: 'fresh' };
        },
    };
    const recovered = await startBridgeSession(finalized, 'volume 1');
    checkEqual('a finalizing session falls back to a fresh one', recovered.session_id, 'fresh');
    checkEqual('the fallback costs exactly two calls', retried, 2);

    let other = null;
    const unrelated = {
        startSession: async () => { const e = new Error('boom'); e.status = 500; throw e; },
    };
    try { await startBridgeSession(unrelated, 'volume 1'); } catch (e) { other = e; }
    check('an unrelated failure is not retried or hidden', other?.message === 'boom', String(other));

    let auth = null;
    const unauthorised = {
        startSession: async () => { const e = new Error('unauthorised'); e.status = 401; throw e; },
    };
    try { await startBridgeSession(unauthorised, 'volume 1'); } catch (e) { auth = e; }
    check('a 401 is not mistaken for a refusal', auth?.status === 401);

    // Reuse is only skipped when it was actually requested.
    let asked = null;
    const noReuse = {
        startSession: async (title, opts) => { asked = opts; return { session_id: 'x' }; },
    };
    await startBridgeSession(noReuse, 'volume 1', { reuseExisting: false });
    check('reuseExisting can be switched off', asked.reuseExisting === false, JSON.stringify(asked));
}

// Uploads must not be serialised by the client's start-rate floor.
//
// COOLDOWN.minIntervalMs is a floor between *consecutive request starts*, so if
// it is applied per page the whole process is capped at 1000/minIntervalMs pages
// per second no matter what --push-concurrency says. That is what it used to do:
// 60 ms/page measured, i.e. 15 s of dead time before OCR could begin on a
// 244-page volume. This pins the fix behaviourally against a stub bridge, so it
// fails if anyone ever puts pushPage back under the gate.
{
    const http = await import('node:http');
    const { BridgeClient, COOLDOWN } = await import('../vendor/ebookjapan/bridge.mjs');

    const seen = [];
    const server = http.createServer((req, res) => {
        seen.push(req.url);
        req.resume();
        req.on('end', () => {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end('{"ok":true}');
        });
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const port = server.address().port;

    try {
        const client = new BridgeClient(`http://127.0.0.1:${port}`);
        const N = 24;
        const floor = N * COOLDOWN.minIntervalMs;   // what a paced run would cost
        const body = Buffer.alloc(4096, 7);

        const t0 = performance.now();
        const results = await Promise.all(
            Array.from({ length: N }, (_, i) =>
                client.pushPage('s1', body, `page_${i}.webp`, i).then(() => true).catch(() => false)),
        );
        const ms = performance.now() - t0;

        check('every page in the unpaced batch is still accepted',
            results.every(Boolean), JSON.stringify(results.filter((r) => !r).length) + ' failed');
        check('every page reached the bridge',
            seen.filter((u) => /\/page$/.test(u)).length === N,
            seen.length + ' request(s) seen');
        // Loose by a wide margin: the point is that N requests do not cost N
        // floors, not that the stub is fast. A paced run cannot beat this bound.
        check('page uploads are not serialised by the start-rate floor',
            ms < floor / 2,
            `${N} pushes in ${ms.toFixed(0)}ms; a paced run would need ${floor}ms`);
    } finally {
        await new Promise((r) => server.close(r));
    }
}

finish();
