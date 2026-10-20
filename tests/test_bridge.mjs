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

import { bridgeSessionState, contentTypeFor, finalizeWithProgress, isIngestableFolder, normalizeUploads, pageFiles, pushToBridge, resumeExistingSession, startBridgeSession } from '../src/bridge.js';
import { LiveProgress } from '../src/live-progress.js';
import { resolveDestination } from '../vendor/ebookjapan/bridge.mjs';
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
        sessions: async () => ({ sessions: [{
            session_id: 'active', title: 'volume 1', pages_received: 24,
            pages_ocr_done: 12, pages_ocr_pending: 12, finalizing: true,
        }] }),
        queue: async () => ({ per_session: [{ session_id: 'active', processing: 1 }] }),
    };
    const recovered = await startBridgeSession(finalized, 'volume 1');
    check('a finalizing session is attached instead of duplicated', recovered.existingSession?.session_id === 'active');
    checkEqual('the conflict does not create another bridge session', retried, 1);

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

    // A refusal followed by a bridge that cannot answer the session check must still
    // be a skip. The recovery read the caller's context without taking it as a
    // parameter, so this path threw ReferenceError and failed the volume instead.
    const unavailable = {
        startSession: async () => { const e = new Error('Session is finalizing or already finalized'); e.status = 409; throw e; },
        sessions: async () => { throw new Error('bridge went away'); },
        queue: async () => ({ per_session: [] }),
    };
    let unreachable = null;
    try { unreachable = await startBridgeSession(unavailable, 'volume 1', { ctx: { bridgeResume: new Map() } }); }
    catch (e) { unreachable = e; }
    check('an unreachable session check is a skip, not a crash',
        unreachable?.alreadyHandled === true,
        unreachable instanceof Error ? unreachable.message : String(unreachable));

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
        // A sidecar finishing must not move the number: only the archive drives it, so
        // the cover reaching 100 percent cannot make the bar read as a finished volume.
        JSON.stringify({
            stage: 'upload_progress', message: 'y: 100%',
            upload: {
                file: '5巻.webp', percent: 100, current_bytes: 9000,
                total_bytes: 9000, speed_human: '1.00 MiB/s',
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
        const sidecar = updates.filter((u) => u.uploadFile === '5巻.webp').pop();
        check('a finished sidecar leaves the archive percentage alone',
            sidecar?.uploadPercent === 42.5, JSON.stringify(sidecar));
        // The archive drives the percentage and the sidecars leave it alone. Averaging
        // the trio held the bar at a third and then at two thirds while the real
        // transfer was still running, which read as a stall beside a speed that kept
        // updating.
        check('the archive percentage is reported as the volume percentage',
            uploads[0]?.uploadPercent === 42.5, JSON.stringify(uploads[0]));
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

        // --force means "replace what is at the destination". The bridge's collision
        // policy has no boolean form: a literal `true` is neither `skip` nor
        // `overwrite`, so providers treated it as `fail` and the retry died with
        // "destination already exists" after the OCR work was already done.
        await finalizeWithProgress(client, 'sess-3', 'k',
            { method: 'mega', params: { uploadMethod: 'mega' } }, { progress: null, overwrite: true });
        check('--force sends the bridge\'s overwrite policy',
            /overwrite=overwrite/.test(received?.body || ''), received?.body);
        check('--force is not sent as a boolean',
            /overwrite=true/.test(received?.body || '') === false, received?.body);

        await finalizeWithProgress(client, 'sess-4', 'k',
            { method: 'mega', params: { uploadMethod: 'mega' } }, { progress: null, overwrite: false });
        check('a normal run leaves the collision policy at the bridge default',
            /overwrite=/.test(received?.body || '') === false, received?.body);
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

    const resumed = await pushToBridge({
        baseUrl: 'http://127.0.0.1:62642',
        async resumeSession() { throw new Error('completed receipt should bypass the bridge'); },
        async startSession() { throw new Error('completed receipt should bypass the bridge'); },
        async pushPage() { throw new Error('completed receipt should bypass the bridge'); },
        async finalize() { throw new Error('completed receipt should bypass the bridge'); },
    }, { method: 'local', params: {} }, target, { progress: null, pushConcurrency: 4 });
    checkEqual('a completed identical volume is recognized on rerun', resumed.ingest, 'already-completed');
    checkEqual('a completed rerun does not claim more OCR work', resumed.ocrDone, 2);
    fs.rmSync(path.join(dir, '.dokuha-bridge-completion.json'), { force: true });

    // A bridge that refuses the path -- or whose resume handler throws -- falls back
    // to the per-page path. The 500 case is not hypothetical: mokuro-bridge 0.6.0
    // answered 500 on every folder while its per-page route worked fine, and a
    // volume must not be lost to an optimisation the user never asked for.
    for (const [status, label] of [[403, 'a refused folder'], [404, 'an old bridge'], [500, 'a broken bridge']]) {
        fs.rmSync(path.join(dir, '.dokuha-bridge-completion.json'), { force: true });
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
    fs.rmSync(path.join(dir, '.dokuha-bridge-completion.json'), { force: true });
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
    fs.rmSync(path.join(dir, '.dokuha-bridge-completion.json'), { force: true });
    await pushToBridge({ ...stub, baseUrl: 'http://10.0.0.5:62642' },
        { method: 'local', params: {} }, target, { progress: null, pushConcurrency: 4 });
    check('a remote bridge is never asked to read a local path',
        calls.resume === 0 && calls.pages === 2, JSON.stringify(calls));

    // And the whole thing is switchable off.
    calls.resume = 0; calls.pages = 0;
    fs.rmSync(path.join(dir, '.dokuha-bridge-completion.json'), { force: true });
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

// A duplicate folder resume can race a page already in the bridge OCR worker.
// Wait for that page to leave processing, then retry the idempotent sync rather
// than marking the volume failed on the transient 409.
{
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dokuha-resume-race-'));
    fs.writeFileSync(path.join(dir, 'page_0001.webp'), 'same page bytes');
    let resumeCalls = 0;
    let queueCalls = 0;
    const client = {
        baseUrl: 'http://127.0.0.1:62642',
        async resumeSession() {
            resumeCalls++;
            if (resumeCalls === 1) {
                const error = new Error("session/resume 409: {\"detail\":\"Page is currently being OCR'd: page_0001.webp\"}");
                error.status = 409;
                throw error;
            }
            return { session_id: 'resume-race', synced_from_source: 0, queued_for_ocr: 0, ocr_cached: 1 };
        },
        async sessions() {
            return { sessions: [{ session_id: 'resume-race', title: 'Volume 1', pages_received: 1, pages_ocr_done: 0, pages_ocr_pending: 1 }] };
        },
        async queue() {
            queueCalls++;
            return { per_session: [{ session_id: 'resume-race', processing: queueCalls < 3 ? 1 : 0 }] };
        },
        async status() { return { pages_received: 1, pages_ocr_done: 0, pages_ocr_pending: 1, ingesting: false }; },
        async finalize() { return { status: 'success', pages_ocr_done: 1, output_files: [] }; },
    };
    const record = await pushToBridge(client, { method: 'local', params: {} },
        { key: 'race', title: 'Volume 1', folder: dir },
        { progress: null, pushConcurrency: 1 });
    checkEqual('the OCR-in-progress conflict retries folder resume', resumeCalls, 2);
    checkEqual('the conflict is recovered as a folder session', record.ingest, 'folder');
    checkEqual('the transient page conflict does not fail the volume', record.pagesFailed, 0);
    fs.rmSync(dir, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// Re-runs, finished sessions and the terminal partial-upload status
// ---------------------------------------------------------------------------

// `--force` means "do it again". A completion receipt left by a successful earlier
// run must not short-circuit the hand-off when the user asked to replace the
// destination copies.
{
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dokuha-force-'));
    fs.writeFileSync(path.join(dir, 'page-0001.jpg'), 'a');
    fs.writeFileSync(path.join(dir, 'page-0002.jpg'), 'b');
    const target = { key: 'force', title: 'Volume force', folder: dir };
    const success = {
        baseUrl: 'http://127.0.0.1:62642',
        async resumeSession() {
            return { session_id: 'sess-force', synced_from_source: 2, queued_for_ocr: 2, ocr_cached: 0 };
        },
        async finalize() { return { status: 'success', output_dir: '/out', pages_ocr_done: 2 }; },
    };
    try {
        const first = await pushToBridge(success, { method: 'local', params: {} }, target,
            { progress: null, pushConcurrency: 1 });
        checkEqual('the first hand-off completes normally', first.completed, true);

        // A plain re-run trusts the receipt and never touches the bridge.
        let plainResume = 0;
        const plain = await pushToBridge({
            ...success,
            async resumeSession() { plainResume++; return { session_id: 'x' }; },
        }, { method: 'local', params: {} }, target, { progress: null, pushConcurrency: 1 });
        checkEqual('a plain re-run trusts the completion receipt', plain.ingest, 'already-completed');
        checkEqual('and does not call the bridge', plainResume, 0);

        // --force must re-run it.
        let forcedResume = 0;
        const forced = await pushToBridge({
            ...success,
            async resumeSession() {
                forcedResume++;
                return { session_id: 'sess-force-2', synced_from_source: 2, queued_for_ocr: 0, ocr_cached: 2 };
            },
        }, { method: 'local', params: {} }, target, { progress: null, pushConcurrency: 1, overwrite: true });
        checkEqual('--force re-runs the hand-off instead of trusting the receipt',
            forcedResume, 1);
        checkEqual('--force reports the new hand-off path', forced.ingest, 'folder');
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
}

// A persisted session that reached its terminal state but could not be removed
// answers 400 "Session already finalized" (a 404 is a session that finished and was
// cleaned up). Both mean the work is done; neither may crash the volume.
{
    const files = [{ path: '/nowhere/page_0001.jpg' }];
    const existing = { alreadyHandled: true, existingSession: { session_id: 's-fin' }, queue: null };
    const status400 = {
        baseUrl: 'http://127.0.0.1:62642',
        async status() {
            const error = new Error('status 400: {"detail":"Session already finalized"}');
            error.status = 400;
            throw error;
        },
    };
    const finished = await resumeExistingSession(status400, { method: 'local', params: {} },
        { key: 'k', title: 'Volume fin' }, files, existing, {});
    check('a finalized bridge record is a skip, not a crash',
        finished?.alreadyHandled === true && finished.ingest === 'already-completed',
        JSON.stringify(finished));

    // The same 400 can come back from finalize when another client finalized first.
    const finalizedElsewhere = {
        baseUrl: 'http://127.0.0.1:62642',
        async status() {
            return { pages_received: 2, pages_ocr_done: 2, pages_ocr_pending: 0, ingesting: false, finalizing: false };
        },
        async queue() { return { per_session: [] }; },
        async finalize() {
            const error = new Error('finalize 400: {"detail":"Session already finalized"}');
            error.status = 400;
            throw error;
        },
    };
    const skipped = await resumeExistingSession(finalizedElsewhere, { method: 'local', params: {} },
        { key: 'k', title: 'Volume fin' }, files, { alreadyHandled: true, existingSession: { session_id: 's-fin-2' } }, {});
    check('a session finalized by another client is a skip',
        skipped?.alreadyHandled === true && /another client/.test(skipped.existingState || ''),
        JSON.stringify(skipped));
}

// A terminal `partial_upload` means the volume files arrived but the series index did
// not. The bridge calls that a failure; the client must too, or a folder the reader
// cannot build is reported as a success.
{
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dokuha-partial-'));
    fs.writeFileSync(path.join(dir, 'page-0001.jpg'), 'a');
    try {
        const client = {
            baseUrl: 'http://127.0.0.1:62642',
            async resumeSession() {
                return { session_id: 'sess-partial', synced_from_source: 1, queued_for_ocr: 0, ocr_cached: 1 };
            },
            async finalize() {
                return {
                    status: 'partial_upload',
                    message: 'Could not update series.json: permission denied',
                    pages_ocr_done: 1,
                    uploads: [
                        { file: 'v.webp', bytes: 10, total_bytes: 10, success: true },
                        { file: 'v.cbz', bytes: 20, total_bytes: 20, success: true },
                    ],
                };
            },
        };
        const record = await pushToBridge(client, { method: 'mega', params: { uploadMethod: 'mega' } },
            { key: 'partial', title: 'Partial volume', folder: dir }, { progress: null, pushConcurrency: 1 });
        checkEqual('a partial upload is marked partial', record.partial, true);
        checkEqual('a partial upload keeps the terminal status', record.status, 'partial_upload');
        checkEqual('a partial upload is not completed', record.completed, false);
        checkEqual('the bridge reason is carried with the record',
            record.message, 'Could not update series.json: permission denied');
        checkEqual('remote upload sizes are normalised into the record',
            record.outputFiles.map((item) => item.size), [10, 20]);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
}

// ---------------------------------------------------------------------------
// Destination ids across the bridge's account-alias rename
// ---------------------------------------------------------------------------

// The bridge now reports account aliases (`mega-work`, `webdav`) and accepts the
// historical `mega:work` spelling as input. Validating the raw spelling against the
// reported ids rejected the old form before the bridge ever saw it, so an existing
// multi-account script broke on the alias release. Both spellings must resolve, and
// an unknown account must still fail here rather than after a whole download.
{
    const client = (ids, fallback = 'mega') => ({
        destinations: async () => ({
            upload_method_default: fallback,
            methods: ids.map((id) => ({ id, configured: true, current_folder: id === 'webdav' ? '/dav' : null })),
        }),
    });
    const oldIds = client(['local', 'mega', 'mega:work', 'drive']);
    const aliasIds = client(['local', 'mega', 'mega-work', 'webdav']);
    const resolve = (bridge, dest, folder = null) => resolveDestination(bridge, { dest, folder });

    checkEqual('the historical colon id still resolves against the old bridge',
        (await resolve(oldIds, 'mega:work')).method, 'mega:work');
    checkEqual('the historical colon id resolves to the alias on the new bridge',
        (await resolve(aliasIds, 'mega:work')).method, 'mega-work');
    checkEqual('the alias itself resolves', (await resolve(aliasIds, 'mega-work')).method, 'mega-work');
    checkEqual('provider:default resolves to the bare provider',
        (await resolve(aliasIds, 'mega:default')).method, 'mega');
    checkEqual('a bare provider resolves', (await resolve(aliasIds, 'mega')).method, 'mega');
    checkEqual('a new provider id resolves once configured',
        (await resolve(aliasIds, 'webdav')).method, 'webdav');
    checkEqual('the bridge default is used when no destination is named',
        (await resolve(aliasIds, null)).method, 'mega');
    checkEqual('an alias keeps its bridge folder for display',
        (await resolve(aliasIds, 'webdav')).currentFolder, '/dav');

    // A colon typo must not fall back to the provider's first account: that would
    // silently upload to the wrong account instead of reporting the mistake.
    let unknown = null;
    try { await resolve(aliasIds, 'mega:nope'); } catch (error) { unknown = error; }
    check('an unknown colon account is rejected before the run',
        unknown instanceof Error && /not configured/.test(unknown.message),
        unknown ? unknown.message : 'no error');

    const local = await resolve(aliasIds, 'local', '/tmp/dokuha-out');
    checkEqual('local keeps its folder argument', local.params.localDir, '/tmp/dokuha-out');
    checkEqual('local is passed through unchanged', local.params.uploadMethod, 'local');
    // The bridge ignores local_dir for a remote method; the client must not send it,
    // or a folder argument silently looks applied when it is not.
    const remoteWithFolder = await resolve(aliasIds, 'mega', '/tmp/dokuha-out');
    checkEqual('a remote destination never receives a local folder',
        remoteWithFolder.params.localDir, undefined);

    // A relative --dest-folder used to be sent as-is, so the bridge resolved it
    // against its own working directory instead of the directory dokuha ran in.
    const relative = await resolve(aliasIds, 'local', './out/relative');
    checkEqual('a relative --dest-folder is resolved on this machine',
        relative.params.localDir, path.resolve('./out/relative'));

    // `/upload-methods` reports each account's provider and storage name as well as
    // its alias. That is the only way to resolve the historical `provider:name`
    // spelling once an account's alias was renamed (the alias no longer derives from
    // the name at all), and the bridge turns underscores in a storage name into
    // hyphens in the alias.
    const rows = (entries, fallback = 'mega') => ({
        destinations: async () => ({ upload_method_default: fallback, methods: entries }),
    });
    const renamed = rows([
        { id: 'local', configured: true },
        { id: 'mega', configured: true, provider: 'mega', account: 'default' },
        { id: 'work-archive', configured: true, provider: 'mega', account: 'work' },
        { id: 'mega-my-work', configured: true, provider: 'mega', account: 'my_work' },
        { id: 'drive', configured: false, provider: 'drive', account: 'default' },
    ]);
    checkEqual('a renamed alias still resolves from its historical colon spelling',
        (await resolve(renamed, 'mega:work')).method, 'work-archive');
    checkEqual('an underscore storage name resolves to its hyphenated alias',
        (await resolve(renamed, 'mega:my_work')).method, 'mega-my-work');
    checkEqual('provider:default resolves through the reported account',
        (await resolve(renamed, 'mega:default')).method, 'mega');
    let unconfigured = null;
    try { await resolve(renamed, 'drive'); } catch (error) { unconfigured = error; }
    check('a reported but unconfigured account is still rejected',
        unconfigured instanceof Error && /not configured/.test(unconfigured.message),
        unconfigured ? unconfigured.message : 'no error');
}

// ---------------------------------------------------------------------------
// The finalize stream feeds the footer's size totals
// ---------------------------------------------------------------------------

// Each upload event carries the file's total size, and the terminal `done` frame is
// the only place the per-series series.json size exists. The progress block collects
// both so the footer can total the manga and its artifacts without re-reading disk.
{
    const stream = { isTTY: false, columns: 120, rows: 30, write() {}, on() {}, off() {} };
    const progress = new LiveProgress({ stream, width: 120 });
    progress.add('k', { tag: 'BW', label: 'volume' });

    const doneFrame = {
        stage: 'done',
        status: 'success',
        uploads: [
            { file: 'volume.webp', size: 1000, success: true },
            { file: 'volume.cbz', size: 9000, success: true },
            { file: 'volume.mokuro', size: 500, success: true },
            { file: 'series.json', size: 100, success: true },
        ],
    };
    const client = {
        async finalize(sessionId, { onEvent }) {
            for (const [file, size] of [['volume.webp', 1000], ['volume.cbz', 9000], ['volume.mokuro', 500]]) {
                onEvent({
                    stage: 'upload_progress',
                    upload: { file, total_bytes: size, current_bytes: size, percent: 100, speed_human: '1 MiB/s' },
                });
            }
            onEvent(doneFrame);
            return doneFrame;
        },
    };
    await finalizeWithProgress(client, 'sess', 'k', { method: 'local', params: {} }, { progress });

    const { artifacts, extras } = progress.totals();
    checkEqual('upload events feed the artifact sizes',
        JSON.stringify(artifacts), JSON.stringify({ webp: 1000, cbz: 9000, mokuro: 500, series: 100 }));
    checkEqual('the done frame supplies the series.json size that has no upload event', artifacts.series, 100);
    checkEqual('extras exclude the archive', extras, 1000 + 500 + 100);
    check('the artifact footer line is now produced', progress.footer().length === 3,
        JSON.stringify(progress.footer()));
}

// A remote `done` frame spells the same sizes differently: the summary the bridge
// builds for a remote destination carries `bytes`/`total_bytes` and no `size` at all.
// Reading only `size` dropped the whole artifact footer on exactly the destinations
// that take minutes to upload, including series.json, which has no upload event.
{
    const stream = { isTTY: false, columns: 120, rows: 30, write() {}, on() {}, off() {} };
    const progress = new LiveProgress({ stream, width: 120 });
    progress.add('k', { tag: 'BW', label: 'volume' });

    const doneFrame = {
        stage: 'done',
        status: 'success',
        method: 'mega',
        uploads: [
            { file: 'volume.webp', bytes: 1000, total_bytes: 1000, current_bytes: 1000, percent: 100, success: true },
            { file: 'volume.cbz', bytes: 9000, total_bytes: 9000, current_bytes: 9000, percent: 100, success: true },
            { file: 'volume.mokuro', bytes: 500, total_bytes: 500, current_bytes: 500, percent: 100, success: true },
            { file: 'series.json', bytes: 100, total_bytes: 100, current_bytes: 100, percent: 100, success: true },
        ],
    };
    const client = { async finalize(sessionId, { onEvent }) { onEvent(doneFrame); return doneFrame; } };
    await finalizeWithProgress(client, 'sess', 'k', { method: 'mega', params: { uploadMethod: 'mega' } }, { progress });

    const { artifacts } = progress.totals();
    checkEqual('a remote done frame still totals the artifacts from total_bytes',
        JSON.stringify(artifacts), JSON.stringify({ webp: 1000, cbz: 9000, mokuro: 500, series: 100 }));

    const normalized = normalizeUploads(doneFrame.uploads);
    checkEqual('the record exposes one size spelling',
        normalized.map((item) => item.size), [1000, 9000, 500, 100]);
    checkEqual('a local done frame keeps its size', normalizeUploads([{ file: 'a.cbz', size: 7 }])[0].size, 7);
    checkEqual('a failed entry keeps whatever it reported',
        normalizeUploads([{ file: 'a.cbz', success: false }])[0].size, undefined);
}

// The session snapshot's `upload` object is state, not an activity flag: the bridge
// writes one on the early cover push and leaves `active: false` in it until the
// remote transfer starts. Treating the object as truthy showed a finished cover push
// as "bridge uploading" for the whole OCR phase.
{
    const session = { session_id: 's1', pages_received: 10, pages_ocr_done: 4, pages_ocr_pending: 6 };
    const counts = { per_session: [{ session_id: 's1', processing: 1, pending: 5 }] };
    checkEqual('an inactive upload is not reported as uploading',
        bridgeSessionState({ ...session, upload: { active: false, file: 'v.webp', percent: 100 } }, counts),
        'bridge OCR processing 1 page(s), 6 pending');
    checkEqual('an active upload is reported',
        bridgeSessionState({ ...session, upload: { active: true, file: 'v.cbz' } }, { per_session: [] }),
        'bridge uploading v.cbz');
    checkEqual('a queued session names its queue',
        bridgeSessionState(session, { per_session: [] }),
        'bridge OCR queued 6 page(s)');
    checkEqual('an ingesting session says so',
        bridgeSessionState({ ...session, source_ingesting: true }, null),
        'bridge ingesting');
    checkEqual('a finalizing session says so',
        bridgeSessionState({ ...session, pages_ocr_pending: 0, pages_ocr_done: 10, finalizing: true }, null),
        'bridge assembling/uploading after OCR (10 pages)');
}

finish();
