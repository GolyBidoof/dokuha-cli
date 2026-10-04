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

import { contentTypeFor, finalizeWithProgress, isIngestableFolder, pageFiles, pushToBridge, startBridgeSession } from '../src/bridge.js';
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
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dokuha-pages-'));
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
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dokuha-pages2-'));
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
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dokuha-empty-'));
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

// ---------------------------------------------------------------------------
// Finalization reports OCR and upload progress from the stream it is already
// reading, instead of polling /status alongside it
// ---------------------------------------------------------------------------

// `finalize` is the only streaming route the bridge has: it emits a fresh
// `wait_ocr` frame at least every 0.75 s while the OCR queue drains, and an
// `upload_progress` frame per file while a remote destination uploads. That is
// the same information the client used to poll `GET /session/<id>/status` for, at
// a finer interval and for no extra request. This drives a real `BridgeClient`
// against a stub server, so the NDJSON line handling is exercised too -- including
// a malformed frame, which must be skipped rather than abort the upload.
{
    const http = await import('node:http');
    const { BridgeClient } = await import('../vendor/ebookjapan/bridge.mjs');

    const frames = [
        JSON.stringify({ stage: 'wait_ocr', message: 'waiting', pages_ocr_done: 3, pages_received: 10, pages_ocr_pending: 7 }),
        'this is not json',
        JSON.stringify({ stage: 'assemble', message: 'assembling' }),
        JSON.stringify({
            stage: 'upload_progress', message: 'x: 42.5%',
            upload: {
                file: '5巻.cbz', percent: 42.5, current_bytes: 26_000_000,
                total_bytes: 61_094_103, speed_human: '36.00 MiB/s',
            },
        }),
        JSON.stringify({ stage: 'done', status: 'success', output_dir: '/out', pages: 10, pages_ocr_done: 10 }),
    ];

    let received = null;
    const server = http.createServer((req, res) => {
        const chunks = [];
        req.on('data', (c) => chunks.push(c));
        req.on('end', () => {
            received = { url: req.url, body: Buffer.concat(chunks).toString() };
            res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
            res.end(`${frames.join('\n')}\n`);
        });
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const port = server.address().port;

    try {
        const client = new BridgeClient(`http://127.0.0.1:${port}`);
        const updates = [];
        const progress = { update: (key, patch) => updates.push({ key, ...patch }) };

        const result = await finalizeWithProgress(
            client, 'sess-1', 'vol-key',
            { method: 'mega', params: { uploadMethod: 'mega' } },
            { progress },
        );

        checkEqual('the finalize stream result is returned', result?.output_dir, '/out');
        check('the request went to the session finalize route',
            /\/session\/sess-1\/finalize$/.test(received?.url || ''), received?.url);
        check('a remote destination still deletes its local copy',
            /delete_after_upload=true/.test(received?.body || ''), received?.body);
        check('the caller\'s own params are passed through',
            /upload_method=mega/.test(received?.body || ''), received?.body);
        check('a malformed NDJSON frame does not abort the stream',
            result?.status === 'success', JSON.stringify(result));

        const ocr = updates.filter((u) => u.phase === 'ocr');
        check('OCR progress comes off the stream', ocr.length > 0, `${updates.length} update(s)`);
        check('the OCR report counts done, total and pending',
            ocr[0]?.ocr === 3 && ocr[0]?.ocrTotal === 10 && ocr[0]?.ocrPending === 7,
            JSON.stringify(ocr[0]));

        const uploads = updates.filter((u) => u.phase === 'finalizing' && u.uploadFile);
        check('the upload is reported while finalize is in flight',
            uploads.length > 0, `${uploads.length} update(s) of ${updates.length}`);
        check('the report names the file', uploads[0]?.uploadFile === '5巻.cbz', JSON.stringify(uploads[0]));
        check('the report carries the percentage', uploads[0]?.uploadPercent === 42.5, JSON.stringify(uploads[0]));
        check('the report carries the speed', uploads[0]?.uploadSpeed === '36.00 MiB/s', JSON.stringify(uploads[0]));
        check('the report carries the byte counts',
            uploads[0]?.uploadBytes === 26_000_000 && uploads[0]?.uploadBytesTotal === 61_094_103,
            JSON.stringify(uploads[0]));
        check('every update is keyed to the volume', updates.every((u) => u.key === 'vol-key'), 'wrong key');

        // A local destination keeps its file, so the flag must not be sent.
        await finalizeWithProgress(client, 'sess-2', 'k', { method: 'local', params: {} }, { progress: null });
        check('a local destination does not delete the file',
            /delete_after_upload=false/.test(received?.body || ''), received?.body);
        check('a missing progress sink is tolerated', true);
    } finally {
        await new Promise((r) => server.close(r));
    }
}

// `--ocr-wait` still bounds the OCR phase alone. Finalize is one long request, so
// the bound is an abort timer that only fires while the last frame seen was
// `wait_ocr` -- a slow upload must not be mistaken for a slow model.
{
    const http = await import('node:http');
    const { BridgeClient } = await import('../vendor/ebookjapan/bridge.mjs');

    const server = http.createServer((req, res) => {
        req.resume();
        res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
        res.write(`${JSON.stringify({ stage: 'wait_ocr', pages_ocr_done: 1, pages_received: 9, pages_ocr_pending: 8 })}\n`);
        // ...and then deliberately never finishes.
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const port = server.address().port;

    try {
        let message = '';
        try {
            await finalizeWithProgress(
                new BridgeClient(`http://127.0.0.1:${port}`), 's', 'k',
                { method: 'local', params: {} }, { ocrWaitMs: 60 },
            );
        } catch (error) {
            message = error.message;
        }
        check('a stalled OCR phase is stopped by --ocr-wait',
            /--ocr-wait/.test(message) && /1\/9/.test(message), message);
    } finally {
        server.closeAllConnections?.();
        await new Promise((r) => server.close(r));
    }
}

// ---------------------------------------------------------------------------
// Folder ingest: one request per volume instead of one per page
// ---------------------------------------------------------------------------

// The bridge can read a same-machine folder itself (`POST /session/resume` with
// `source_dir`), which is what its own `ocr_folder.py` client does. A whole volume
// then costs two requests -- resume and finalize -- rather than one per page. It
// only applies when the bridge is local and the library is under a root the bridge
// will read from; everything else keeps the upload path.
{
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dokuha-ingest-'));
    fs.writeFileSync(path.join(dir, 'page-0001.jpg'), 'a');
    fs.writeFileSync(path.join(dir, 'page-0002.jpg'), 'b');
    fs.writeFileSync(path.join(dir, 'metadata.json'), '{}');

    check('a library under the temp root is ingestable', isIngestableFolder(dir));
    check('a volume marker is not counted as a page', (await pageFiles(dir)).length, 2);
    check('a library on an external volume is not ingestable',
        !isIngestableFolder('/Volumes/External/library/volume 1'));

    const calls = { resume: 0, start: 0, pages: 0, finalize: 0, source: null };
    const stub = {
        baseUrl: 'http://127.0.0.1:62642',
        async resumeSession(title, source) {
            calls.resume++;
            calls.source = source;
            return { session_id: 'sess-folder', synced_from_source: 2, queued_for_ocr: 2, ocr_cached: 0 };
        },
        async startSession() { calls.start++; return { session_id: 'sess-pages' }; },
        async pushPage() { calls.pages++; },
        async finalize(sessionId, params) {
            calls.finalize++;
            // The real `done` frame carries `pages_ocr_done` but not
            // `pages_ocr_failed`, so the last `wait_ocr` frame is the only place the
            // failure count exists. Shaped exactly as mokuro-bridge 0.6.0 sends it.
            params.onEvent?.({
                stage: 'wait_ocr', pages_ocr_done: 2, pages_received: 2,
                pages_ocr_pending: 0, pages_ocr_failed: 1,
            });
            return { status: 'success', output_dir: '/out', pages: 2, pages_ocr_done: 2 };
        },
    };

    const target = { key: 'k', title: 'Volume 1', folder: dir };
    const record = await pushToBridge(stub, { method: 'local', params: {} }, target,
        { progress: null, pushConcurrency: 4 });

    checkEqual('the bridge reads the folder instead of receiving pages', calls.resume, 1);
    checkEqual('the folder it is given is the volume folder', calls.source, dir);
    checkEqual('no page is uploaded over HTTP', calls.pages, 0);
    checkEqual('a session is not started separately', calls.start, 0);
    checkEqual('finalize is called exactly once', calls.finalize, 1);
    checkEqual('the record says it was ingested from the folder', record.ingest, 'folder');
    checkEqual('it reports the pages the bridge queued', record.pagesQueued, 2);
    checkEqual('it does not claim pages were uploaded', record.pagesUploaded, 0);
    checkEqual('the output directory comes from the stream', record.outputDir, '/out');
    checkEqual('the OCR failure count is read from the last wait_ocr frame', record.ocrFailed, 1);
    checkEqual('the OCR done count still comes from the done frame', record.ocrDone, 2);

    // A bridge that refuses the path -- or whose resume handler throws -- falls back
    // to the per-page path. The 500 case is not hypothetical: mokuro-bridge 0.6.0
    // answered 500 on every folder while its per-page route worked fine, and a
    // volume must not be lost to an optimisation the user never asked for.
    for (const [status, label] of [[403, 'a refused folder'], [404, 'an old bridge'], [500, 'a broken bridge']]) {
        calls.resume = 0; calls.start = 0; calls.pages = 0;
        const refusing = {
            ...stub,
            async resumeSession() {
                calls.resume++;
                const error = new Error(`session/resume ${status}: nope`);
                error.status = status;
                throw error;
            },
        };
        const fallback = await pushToBridge(refusing, { method: 'local', params: {} }, target,
            { progress: null, pushConcurrency: 4 });
        check(`${label} falls back to uploading pages`, calls.pages === 2, JSON.stringify(calls));
        checkEqual(`and the record says which path was taken (${status})`, fallback.ingest, 'pages');
    }

    // A deep store failure is not an excuse to re-upload a library.
    calls.resume = 0; calls.pages = 0;
    let rethrown = '';
    try {
        await pushToBridge({
            ...stub,
            async resumeSession() {
                const error = new Error('session/resume 409: title collision');
                error.status = 409;
                throw error;
            },
        }, { method: 'local', params: {} }, target, { progress: null, pushConcurrency: 4 });
    } catch (error) {
        rethrown = error.message;
    }
    check('a conflict is reported rather than papered over',
        /409/.test(rethrown) && calls.pages === 0, `${rethrown} / ${JSON.stringify(calls)}`);

    // A remote bridge cannot see our filesystem, so it must never be handed a path.
    calls.resume = 0; calls.pages = 0;
    await pushToBridge({ ...stub, baseUrl: 'http://10.0.0.5:62642' },
        { method: 'local', params: {} }, target, { progress: null, pushConcurrency: 4 });
    check('a remote bridge is never asked to read a local path',
        calls.resume === 0 && calls.pages === 2, JSON.stringify(calls));

    // And the whole thing is switchable off.
    calls.resume = 0; calls.pages = 0;
    await pushToBridge(stub, { method: 'local', params: {} }, target,
        { progress: null, pushConcurrency: 4, folderIngest: false });
    check('--no-folder-ingest forces the upload path',
        calls.resume === 0 && calls.pages === 2, JSON.stringify(calls));

    fs.rmSync(dir, { recursive: true, force: true });
}

// A folder with no images is still an error rather than an empty session.
{
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dokuha-ingest-empty-'));
    fs.writeFileSync(path.join(dir, 'readme.txt'), 'x');
    let message = '';
    try {
        await pushToBridge({ baseUrl: 'http://127.0.0.1:62642' }, { method: 'local', params: {} },
            { key: 'k', title: 'v', folder: dir }, { progress: null, pushConcurrency: 4 });
    } catch (error) {
        message = error.message;
    }
    check('an empty folder is reported, not ingested', /no page images found/.test(message), message);
    fs.rmSync(dir, { recursive: true, force: true });
}

finish();
