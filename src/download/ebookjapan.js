/**
 * In-process ebookjapan volume downloader.
 *
 * The vendored engine's CLI entry (`vendor/ebookjapan/download.mjs`) is not
 * usable as a library call: it parses `process.argv` at module scope, keeps the
 * result in private constants (`--out`, `--concurrency`, `--force`, ... all
 * become fixed for the life of the module), and never exports `main()`. Its
 * direct-run guard only fires when `process.argv[1]` is the engine's own path,
 * and re-importing it with a cache-busting query to get a second evaluation
 * would break that guard - which would leave every volume sharing whichever
 * output folder happened to be passed first.
 *
 * What the engine *does* export is its real API: `collectPages` for the signed
 * page list and `fetchWithRetry` for the CDN fetch. This module drives those
 * directly and reimplements the surrounding loop (worker pool, skip-if-complete,
 * expired-URL refresh pass, metadata.json) from the engine's behaviour, so that
 * one volume can carry its own output folder, concurrency and progress sink.
 *
 * Descrambling is deliberately out of reach here. `descramble.mjs` exports
 * nothing, runs its whole CLI at module scope, and calls `process.exit(2)` when
 * `--book-dir` is missing - so importing it would terminate the host process on
 * the first call. `ctx.descramble` / `ctx.pdf` therefore fail loudly instead of
 * silently returning scrambled pages.
 */

import fsp from 'node:fs/promises';
import path from 'node:path';
import { collectPages } from '../../vendor/ebookjapan/page-list.mjs';
import { fetchWithRetry } from '../../vendor/ebookjapan/download.mjs';

/** How many times the page list is re-resolved to revive expired signed URLs. */
const REFRESH_PASSES = 2;
/** Attempts after the first, per page. Matches the engine's own default. */
const DEFAULT_RETRIES = 4;
/** Matches DEFAULTS.ebConcurrency in src/options.js. */
const DEFAULT_CONCURRENCY = 32;
/** The engine clamps its own pool the same way. */
const MAX_CONCURRENCY = 256;

/** One path component, with the engine's own sanitiser so folder names match. */
function safeName(s) {
    return (s || 'ebookjapan-volume')
        .normalize('NFC')
        .replace(/[/\\:*?"<>|\u0000-\u001f]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 120) || 'ebookjapan-volume';
}

/**
 * True when `file` is a complete WebP: RIFF/WEBP header plus a RIFF length field
 * that agrees with the real file size. Catches truncated and placeholder files
 * that a bare size check would accept.
 */
async function isCompleteWebp(file, size) {
    let fh;
    try {
        fh = await fsp.open(file, 'r');
        const head = Buffer.alloc(12);
        const { bytesRead } = await fh.read(head, 0, 12, 0);
        if (bytesRead < 12) return false;
        if (head.toString('latin1', 0, 4) !== 'RIFF') return false;
        if (head.toString('latin1', 8, 12) !== 'WEBP') return false;
        // The RIFF length counts everything after the first 8 bytes.
        return head.readUInt32LE(4) + 8 === size;
    } catch {
        return false;
    } finally {
        await fh?.close().catch(() => {});
    }
}

/**
 * Send one progress event, ignoring a sink that throws.
 *
 * `ctx.progress` comes from the caller, so it is untrusted here: the display
 * must never be able to fail a download.
 */
function tell(progress, method, ...args) {
    if (typeof progress?.[method] !== 'function') return;
    try {
        progress[method](...args);
    } catch {
        // Deliberately ignored; see above.
    }
}

/**
 * Download one ebookjapan volume, in this process, without spawning anything.
 *
 * @param {{target: string, key?: string, title?: string}} task
 *   `target` is a books/viewer URL or a bare reading code; `key` is the progress
 *   key (defaults to `target`); `title` seeds the progress label.
 * @param {object} ctx
 *   @param {string} ctx.out parent folder; the volume is written to
 *     `<out>/<title>/`, or straight into `<out>` when `flat` is set.
 *   @param {number} [ctx.concurrency] pages in flight (default 32, capped 256).
 *   @param {number} [ctx.retries] attempts after the first, per page (default 4).
 *   @param {boolean} [ctx.force] re-download pages that are already complete.
 *   @param {boolean} [ctx.flat] write pages straight into `out`, no volume folder.
 *   @param {boolean} [ctx.descramble] unsupported in-process; requesting it throws.
 *   @param {string} [ctx.table] only meaningful to the descrambler, so unused here.
 *   @param {string} [ctx.pdf] unsupported in-process; requesting it throws.
 *   @param {{update: (key: string, patch: object) => void, note: (text: string) => void}} [ctx.progress]
 *     optional sink. `update` receives `{label, total, done, failed, bytes, phase}`
 *     with `phase` one of `downloading` / `uploading` / `ocr` / `finalizing`;
 *     `note` receives an occasional free-form line. Neither is ever required, and
 *     an exception from either is swallowed.
 * @returns {Promise<{store: string, id: string, title: string, folder: string,
 *   totalPages: number, downloaded: number, skipped: number, failed: number,
 *   bytes: number, failures: Array<{file: string, error: string}>}>}
 *   `id` is the volume's publication code (falling back to its reading code);
 *   `downloaded` counts pages written by this call and `skipped` those reused
 *   from disk. Individual page failures are reported in `failures` rather than
 *   thrown, so a partial volume still returns a usable record.
 * @throws {Error} on an unresolvable target, a missing `ctx.out`, an unwritable
 *   folder, a request for `ctx.descramble` / `ctx.pdf`, a volume the API reports
 *   as having no pages, or a volume where not a single page could be downloaded.
 */
export async function downloadEbookjapan(task, ctx = {}) {
    const target = typeof task === 'string' ? task : task?.target;
    if (!target) throw new Error('ebookjapan: no target given');

    const key = task?.key || target;
    const out = ctx.out;
    if (!out) throw new Error('ebookjapan: ctx.out is required');

    // Silently returning scrambled pages, or no PDF at all, would be worse than
    // refusing: the caller asked for a post-process this build cannot perform.
    if (ctx.descramble) {
        throw new Error('ebookjapan: descramble is not available in-process; ' +
            'vendor/ebookjapan/descramble.mjs runs at module scope and cannot be imported');
    }
    if (ctx.pdf) {
        throw new Error('ebookjapan: pdf output needs the descramble CLI, ' +
            'which cannot be loaded in-process');
    }

    // `ebConcurrency` is the store's own key from the CLI; `concurrency` is this
    // function's documented standalone parameter. The store's key wins, because
    // reading only `concurrency` is what made --eb-concurrency a no-op.
    const concurrency = Math.max(1, Math.min(MAX_CONCURRENCY,
        Number(ctx.ebConcurrency ?? ctx.concurrency) || DEFAULT_CONCURRENCY));
    // `null` and `undefined` both mean "use the engine's own default".
    const wanted = ctx.retries === undefined || ctx.retries === null ? DEFAULT_RETRIES : Number(ctx.retries);
    const retries = Number.isFinite(wanted) ? Math.max(0, wanted) : DEFAULT_RETRIES;
    const force = Boolean(ctx.force);
    const progress = ctx.progress;

    tell(progress, 'update', key, {
        label: task?.title || key,
        phase: 'downloading',
        total: 0,
        done: 0,
        failed: 0,
        bytes: 0,
    });

    // Quiet: this is a library call and the caller owns stdout/stderr.
    const book = await collectPages(target, { quiet: true });
    if (!book?.totalPages) throw new Error(`ebookjapan: no pages found for ${target}`);

    const folder = ctx.flat ? out : path.join(out, safeName(book.name));
    await fsp.mkdir(folder, { recursive: true });

    const pad = String(book.totalPages).length;
    const rows = book.pages.map((page, i) => ({
        ...page,
        file: `page_${String(i).padStart(pad, '0')}.webp`,
    }));

    tell(progress, 'update', key, { label: book.name || key, total: rows.length });

    const startedAt = performance.now();
    let next = 0;
    let settled = 0;
    let downloaded = 0;
    let skipped = 0;
    let failed = 0;
    let bytes = 0;

    const claim = () => (next < rows.length ? next++ : -1);

    const worker = async () => {
        for (;;) {
            const i = claim();
            if (i < 0) return;
            const row = rows[i];
            const dest = path.join(folder, row.file);

            if (!force) {
                // A cached page is reused only when it is a structurally valid
                // WebP whose declared length matches the bytes on disk, so a
                // truncated download is re-fetched rather than silently kept.
                const st = await fsp.stat(dest).catch(() => null);
                if (st && st.size > 0 && await isCompleteWebp(dest, st.size)) {
                    row.bytes = st.size;
                    bytes += st.size;
                    skipped++;
                    settled++;
                    tell(progress, 'update', key, { done: settled, skipped, bytes });
                    continue;
                }
            }

            if (!row.url) {
                row.error = 'no url';
                failed++;
            } else {
                try {
                    const buf = await fetchWithRetry(row.url, retries);
                    await fsp.writeFile(dest, buf);
                    row.bytes = buf.length;
                    bytes += buf.length;
                    downloaded++;
                } catch (error) {
                    row.error = error.message;
                    failed++;
                }
            }
            settled++;
            tell(progress, 'update', key, { done: settled, failed, bytes });
        }
    };

    await Promise.all(Array.from({ length: Math.min(concurrency, rows.length) }, worker));

    // The page URLs are signed and expire; a long parallel run outlives them.
    // Re-resolving and retrying is what keeps a fast run from losing its tail.
    for (let pass = 1; pass <= REFRESH_PASSES && failed > 0; pass++) {
        const retryable = rows.filter((row) => row.error);
        if (!retryable.length) break;

        let fresh;
        try {
            fresh = await collectPages(target, { quiet: true });
        } catch {
            // Keep the failures already recorded: the pages on disk are intact.
            break;
        }

        let revived = 0;
        for (const row of retryable) {
            const url = fresh.pages?.[row.page]?.url;
            if (url) {
                row.url = url;
                row.error = '';
                revived++;
            }
        }
        if (!revived) break;

        tell(progress, 'note', `${book.name}: ${retryable.length} page(s) failed, retrying with fresh URLs`);

        let rnext = 0;
        const rclaim = () => (rnext < retryable.length ? rnext++ : -1);
        const retryWorker = async () => {
            for (;;) {
                const i = rclaim();
                if (i < 0) return;
                const row = retryable[i];
                try {
                    const buf = await fetchWithRetry(row.url, retries);
                    await fsp.writeFile(path.join(folder, row.file), buf);
                    row.bytes = buf.length;
                    bytes += buf.length;
                    downloaded++;
                    failed--;
                } catch (error) {
                    row.error = error.message;
                }
                // `settled` does not move: every retryable page was already
                // counted as settled by the pass that failed it.
                tell(progress, 'update', key, { done: settled, failed, bytes, phase: 'downloading' });
            }
        };
        await Promise.all(Array.from({ length: Math.min(concurrency, retryable.length) }, retryWorker));
    }

    const elapsedSeconds = +((performance.now() - startedAt) / 1000).toFixed(2);

    tell(progress, 'update', key, { phase: 'finalizing', done: rows.length, failed, bytes });

    // Same field names as the engine's manifest, so anything that already reads
    // a vendored metadata.json keeps working.
    const manifest = {
        source: target,
        title: book.name,
        publication: book.publication,
        code: book.code,
        fileId: book.fileId,
        direction: book.direction,
        version: book.version,
        imageTypes: book.imageTypes,
        chapters: book.chapters,
        totalPages: book.totalPages,
        concurrency,
        elapsedSeconds,
        bytes,
        pages: rows,
    };
    await fsp.writeFile(path.join(folder, 'metadata.json'), JSON.stringify(manifest, null, 2));

    // The manifest is written before this throw on purpose: it names every page
    // that failed, which is the only on-disk record of what the CDN refused.
    if (!downloaded && !skipped) {
        throw new Error(`ebookjapan: every one of the ${rows.length} pages of ` +
            `"${book.name}" failed to download`);
    }

    return {
        store: 'ebookjapan',
        id: book.publication || book.code || book.fileId || String(target),
        title: book.name || task?.title || String(target),
        folder,
        totalPages: rows.length,
        downloaded,
        skipped,
        failed,
        bytes,
        failures: rows.filter((row) => row.error).map((row) => ({ file: row.file, error: row.error })),
    };
}
