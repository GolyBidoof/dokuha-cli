#!/usr/bin/env node
/**
 * Download every page of an ebookjapan volume into a folder named after the
 * manga, sitting next to this script.
 *
 *   node download.mjs <books-url | viewer-url | publication-code> [options]
 *
 * Options
 *   --concurrency N   parallel in-flight requests (default 48)
 *   --retries N       attempts per page before giving up (default 4)
 *   --out DIR         explicit output folder
 *   --force           re-download pages that already exist
 *   --quiet           suppress the per-page progress line
 *   --json            print a machine-readable result summary
 *
 * Writes images byte-for-byte as the CDN serves them, plus metadata.json.
 *
 * Throughput notes
 * ----------------
 * A plain `Promise.all` over fixed batches wastes the connection pool: every
 * batch waits for its slowest member before starting the next. This uses a
 * self-feeding worker pool instead -- a worker immediately claims the next
 * unclaimed page as soon as it finishes, so there is no tail and the request
 * count stays pinned at `concurrency` until the queue drains.
 *
 * The CDN is a single host, so connection reuse matters more than raw socket
 * count. We drive it with a keep-alive https.Agent whose socket ceiling matches
 * `concurrency`, rather than the global fetch, so connection reuse is explicit
 * and there is no per-origin default limit silently serialising us.
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import http from 'node:http';
import { spawnSync } from 'node:child_process';
import https, { Agent as HttpsAgent } from 'node:https';
import { collectPages } from './page-list.mjs';
import { BridgeClient, discoverBridge, resolveDestination, describeDestinations } from './bridge.mjs';
import { Progress, humanBytes, humanTime } from './progress.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------- arg parsing
const argv = process.argv.slice(2);

/** Flags that consume the following token as their value. */
const VALUE_FLAGS = new Set(['--concurrency', '--retries', '--out', '--table', '--pdf',
                             '--bridge', '--local-dir', '--upload-method', '--ocr-wait', '--push-concurrency',
                             '--encoder', '--preset', '--jobs', '--dest', '--dest-folder', '--series', '--overwrite']);
const BOOL_FLAGS  = new Set(['--force', '--quiet', '--json', '--flat', '--descramble',
                             '--mokuro', '--no-progress']);

function opt(name, dflt) {
  const i = argv.indexOf(name);
  if (i < 0) return dflt;
  const v = argv[i + 1];
  return v !== undefined && !v.startsWith('--') ? v : true;
}

/**
 * Every positional token that is neither a flag nor a flag's value. Several may
 * be given back-to-back, e.g.
 *   node download.mjs A/A002205655/ A/A002307819/ --out DIR
 */
function findTargets() {
  const consumed = new Set();
  for (let i = 0; i < argv.length; i++) {
    if (VALUE_FLAGS.has(argv[i])) { consumed.add(i); consumed.add(i + 1); }
    else if (BOOL_FLAGS.has(argv[i])) consumed.add(i);
  }
  return argv.filter((a, i) => !consumed.has(i) && !a.startsWith('--'));
}

// NOTE: no process.exit at module scope — importing this file for fetchWithRetry
// must not terminate the importer.
const CONCURRENCY = Math.max(1, Math.min(256, Number(opt('--concurrency', 48)) || 48));
const RETRIES     = Math.max(0, Number(opt('--retries', 4)) || 0);
const FORCE       = !!opt('--force', false);
const QUIET       = !!opt('--quiet', false);
const AS_JSON     = !!opt('--json', false);
const DESCRAMBLE  = !!opt('--descramble', false);
const DS_TABLE    = typeof opt('--table', null) === 'string' ? opt('--table') : null;
const DS_PDF      = typeof opt('--pdf', null) === 'string' ? opt('--pdf') : null;
// Naming a destination implies wanting the bridge to deliver it there, so
// --dest / --local-dir turn the hand-off on rather than being silently ignored.
const MOKURO      = !!opt('--mokuro', false)
  || typeof opt('--dest', null) === 'string'
  || typeof opt('--dest-folder', null) === 'string'
  || typeof opt('--local-dir', null) === 'string';
const BRIDGE_URL  = typeof opt('--bridge', null) === 'string' ? opt('--bridge') : null;
const LOCAL_DIR   = typeof opt('--local-dir', null) === 'string' ? opt('--local-dir') : null;
const UPLOAD_METHOD = typeof opt('--upload-method', null) === 'string' ? opt('--upload-method') : null;
const DEST        = typeof opt('--dest', null) === 'string' ? opt('--dest') : null;
const OVERWRITE   = typeof opt('--overwrite', null) === 'string' ? opt('--overwrite') : null;
const DEST_FOLDER = typeof opt('--dest-folder', null) === 'string' ? opt('--dest-folder') : null;
/** How many *volumes* to process at once; 1 = strictly serial. */
const SERIES = Math.max(1, Math.min(32, Number(opt('--series', 1)) || 1));
// With a single target runOne owns the JSON on stdout; with several, main does
// (one array), so runOne must stay silent.
let EMIT_JSON = AS_JSON;
// Whether this invocation handles more than one volume (drives the compact
// one-line layout). Set in main(), read inside runOne().
let MULTI_TARGET = false;
const NO_PROGRESS = !!opt('--no-progress', false);
const OCR_WAIT_MS = Math.max(0, Number(opt('--ocr-wait', 60 * 60 * 1000)) || 0);
const DS_ENCODER = typeof opt('--encoder', null) === 'string' ? opt('--encoder') : 'auto';
const DS_PRESET  = typeof opt('--preset', null) === 'string' ? opt('--preset') : null;
const DS_JOBS    = typeof opt('--jobs', null) === 'string' ? opt('--jobs') : null;

// One keep-alive agent for every connection: maxSockets matches our in-flight
// count so the pool is never the bottleneck.
// Two pool shapes: https for the real CDN, http so local test servers work.
const agent = new HttpsAgent({ keepAlive: true, maxSockets: CONCURRENCY, maxFreeSockets: 32 });
const httpAgent = new http.Agent({ keepAlive: true, maxSockets: CONCURRENCY, maxFreeSockets: 32 });

/** GET a URL into a Buffer using the shared keep-alive agent. */
function httpsGet(url, { timeoutMs = 30_000 } = {}) {
  return new Promise((resolve, reject) => {
    const secure = url.startsWith('https:');
    const mod = secure ? https : http;
    const req = mod.get(url, { agent: secure ? agent : httpAgent, headers: { accept: 'image/webp,image/*,*/*' } }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
      res.on('error', reject);
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`timeout after ${timeoutMs}ms`)));
    req.on('error', reject);
  });
}

const clean50 = s => String(s || '').replace(/[\r\n\t]+/g,' ').slice(0, 50);

function safeName(s) {
  return (s || 'ebookjapan-volume')
    .normalize('NFC')
    .replace(/[/\\:*?"<>|\u0000-\u001f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120) || 'ebookjapan-volume';
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

/**
 * Fetch one URL with bounded exponential backoff + jitter.
 * Retries transport errors, 429 and 5xx. Does not retry 4xx (except 429).
 */
export async function fetchWithRetry(url, attempts) {
  let lastErr;

  for (let a = 0; a <= attempts; a++) {
    let res;
    try {
      res = await httpsGet(url);
    } catch (e) {
      // transport-level failure: worth retrying
      lastErr = e;
      if (a >= attempts) break;
      await sleep(Math.min(8000, 200 * 2 ** a) * (0.5 + Math.random()));
      continue;
    }

    if (res.status >= 200 && res.status < 300) {
      const buf = res.body;
      // A CDN error page can arrive with a 200; if we asked for an image and got
      // markup, treat it as a failed fetch.
      if (buf.length < 64 && /^\s*<(\?xml|Error|html)/i.test(buf.subarray(0, 32).toString('latin1'))) {
        lastErr = new Error('CDN returned an error document');
        if (a >= attempts) break;
        await sleep(Math.min(8000, 200 * 2 ** a) * (0.5 + Math.random()));
        continue;
      }
      return buf;
    }

    // Non-2xx. Decide retryability OUTSIDE the try block so this throw is never
    // swallowed by our own catch (which is what previously retried 404s).
    const retryable = res.status === 429 || res.status >= 500;
    lastErr = new Error(`HTTP ${res.status}`);
    if (!retryable || a >= attempts) break;

    const retryAfter = Number(res.headers['retry-after']);
    const backoff = Number.isFinite(retryAfter) && retryAfter > 0
      ? retryAfter * 1000
      : Math.min(8000, 200 * 2 ** a) * (0.5 + Math.random());
    await sleep(backoff);
  }

  throw lastErr;
}

/**
 * True when `file` is a complete WebP: RIFF....WEBP header plus a RIFF length
 * field that agrees with the real file size. Cheap (12 bytes) but catches
 * truncated and placeholder files that a bare size check would accept.
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
    // RIFF length counts everything after the first 8 bytes.
    return head.readUInt32LE(4) + 8 === size;
  } catch {
    return false;
  } finally {
    await fh?.close().catch(() => {});
  }
}

/**
 * Remove the bridge's remote-upload staging dir from a session volume.
 *
 * The bridge stages remote uploads in `<vol_dir>/_mega_upload`, never removes
 * them, and its mokuro generator rejects any image in a subdirectory. So the
 * staging dir left by one finalize makes the next one fail permanently with
 * "nested images are not supported by bridge ingest". Clearing it before a run
 * and after a failed one keeps retries working.
 */
async function clearStaleStaging(volDir) {
  if (!volDir) return null;
  const stale = path.join(volDir, '_mega_upload');
  try {
    if (!fs.existsSync(stale)) return null;
    await fsp.rm(stale, { recursive: true, force: true });
    return stale;
  } catch (e) {
    return `failed to remove ${stale}: ${e.message}`;
  }
}

async function main() {
  const targets = findTargets();
  if (!targets.length) {
    console.error(`usage: node download.mjs <books-url | viewer-url | publication-code> [more...] [options]

  Targets may be repeated back-to-back; each is fetched in turn, e.g.
    node download.mjs https://ebookjapan.yahoo.co.jp/books/677187/A002837461/ \\
                      https://ebookjapan.yahoo.co.jp/books/551865/A002307819/ --out DIR

  --series N            download N volumes at once (default 1 = serial)
  --out DIR             parent dir; each volume gets DIR/<manga name>/
  --flat                write straight into --out with no per-volume subdir
  --concurrency N       parallel image downloads (default 48)
  --retries N           attempts per page on 429/5xx (default 4)
  --force               re-download pages that already exist

  --descramble          reassemble tiles (needs --table)
  --table PATH          pattern table (default ../out/shuffle_patterns.json)
  --encoder auto|cwebp|pillow   descrambler encoder (default auto)
  --preset N            cwebp -z level 0..6 (default 4)
  --jobs N              descramble worker processes (default: cores-1)
  --pdf FILE            also write a PDF

  --mokuro              push pages through mokuro-bridge (upload + OCR)
  --bridge URL          bridge base URL (default: auto-discover :62642)
  --dest DEST           local | mega | drive | onedrive | <provider>:<account>
                        | default  (default: the bridge's own last-used default)
  --overwrite MODE      fail|overwrite|skip when the destination file exists
                        (default: bridge's own 'fail')
  --dest-folder DIR     output dir when --dest local
  --local-dir DIR       alias for --dest local --dest-folder DIR
  --push-concurrency N  parallel page pushes (default 4)
  --ocr-wait MS         max wait for OCR (default 1h)

  --quiet               no progress redraws
  --no-progress         disable the progress block entirely
  --json                machine-readable summary on stdout`);
    process.exit(2);
  }
  // Manually fed as URLs are not "code" IDs: a /books/<title>/<pub>/ URL works
  // directly, and several can be given back-to-back.
  // Targets are independent (own session, own output folder), so they can run
  // concurrently. Serial stays the default because one clean progress block
  // reads better; --series N fans out.
  EMIT_JSON = AS_JSON && targets.length === 1;
  MULTI_TARGET = targets.length > 1;
  const results = new Array(targets.length);
  if (SERIES <= 1 || targets.length === 1) {
    for (let i = 0; i < targets.length; i++) results[i] = await runOne(targets[i]);
  } else {
    let next = 0;
    const lane = async () => {
      for (;;) {
        const i = next++;
        if (i >= targets.length) return;
        try { results[i] = await runOne(targets[i]); }
        catch (e) { results[i] = { target: targets[i], error: e.message }; }
      }
    };
    await Promise.all(Array.from({ length: Math.min(SERIES, targets.length) }, lane));
  }

  if (targets.length > 1) {
    const ok = results.filter(r => r && !r.error).length;
    if (!QUIET && !AS_JSON) process.stderr.write(`${ok}/${targets.length} volumes done\n`);
    // Several volumes: emit one JSON array so stdout stays a single document.
    if (AS_JSON) process.stdout.write(JSON.stringify(results, null, 2) + '\n');
  }
  return results;
}

async function runOne(target) {
  // diagnostics go to stderr so --json keeps stdout machine-readable
  if (!QUIET && !AS_JSON) process.stderr.write(`resolving ${target} …\n`);
  const book = await collectPages(target, { quiet: QUIET || AS_JSON });

  // --out  DIR   -> DIR/<manga name>/   (so several volumes never collide)
  // --flat DIR   -> DIR/                (everything in one folder)
  const outDir = typeof opt('--out', null) === 'string' ? opt('--out') : null;
  const flat   = !!opt('--flat', false);
  const folder = outDir
    ? (flat ? outDir : path.join(outDir, safeName(book.name)))
    : path.join(HERE, safeName(book.name));
  await fsp.mkdir(folder, { recursive: true });

  const pad = String(book.totalPages).length;
  const rows = book.pages.map((p, i) => ({
    ...p,
    file: `page_${String(i).padStart(pad, '0')}.webp`,
  }));

  // ---- progress + optional mokuro bridge -----------------------------------
  const progress = NO_PROGRESS ? null
    : new Progress({ quiet: QUIET || AS_JSON, compact: MULTI_TARGET || SERIES > 1 });
  const volLabel = book.name || book.code;
  progress?.setHeader(`${MOKURO ? 'download + mokuro' : 'download'} ${clean50(volLabel)}`);
  progress?.update(volLabel, { total: rows.length, state: 'downloading' });

  let bridge = null, session = null, destInfo = null, staleStagingError = null;
  if (MOKURO) {
    const found = await discoverBridge(BRIDGE_URL);
    if (!found) {
      throw new Error('no mokuro-bridge found on ' + (BRIDGE_URL || 'the default ports') +
                      '; start it or pass --bridge URL');
    }
    // discoverBridge returns { baseUrl, health }; wrap it in a real client.
    bridge = new BridgeClient(found.baseUrl);
    if (!QUIET && !AS_JSON) progress?.update(volLabel, { storage: `bridge ${found.baseUrl}` });
    // Where should the bridge put the result? local / mega / drive / onedrive /
    // <provider>:<account>, or the bridge's own last-used default.
    destInfo = await resolveDestination(bridge, {
      dest: DEST || UPLOAD_METHOD || null,
      folder: DEST_FOLDER || LOCAL_DIR || null,
    });
    if (!QUIET && !AS_JSON) {
      progress?.update(volLabel, { storage: `dest ${destInfo.method}${destInfo.currentFolder ? ` (${destInfo.currentFolder})` : ''}` });
    }
    session = await bridge.startSession(book.name || book.code, { reuseExisting: true });

    // The bridge stages remote uploads in `<vol_dir>/_mega_upload` but never
    // removes it, and its own ingest validation rejects any image in a
    // subdirectory — so a leftover staging dir from an earlier failed run makes
    // *every* later finalize fail with "nested images are not supported". Clear
    // it while the session is provably idle. The check is on the volume, so a
    // later --dest local run is broken by it too: always clear it.
    {
      const cleared = await clearStaleStaging(session.vol_dir);
      if (cleared && typeof cleared === 'string') {
        // Continuing would repeat 249 uploads only to hit the nested-image rule
        // at finalize, so stop now and name the exact directory to remove.
        staleStagingError = cleared;
        if (!QUIET && !AS_JSON) progress?.update(volLabel, { state: 'error', error: 'stale bridge staging' });
        throw new Error(
          `cannot reach the bridge hand-off: leftover upload staging must be removed first. ` +
          `${cleared}. That _mega_upload directory is transient upload scratch the bridge ` +
          `never deletes; remove it and retry.`);
      } else if (cleared && !QUIET && !AS_JSON) {
        progress?.update(volLabel, { storage: 'cleared stale bridge staging' });
      }
    }
    progress?.update(volLabel, { state: 'uploading' });
  }

  // ---- self-feeding worker pool ------------------------------------------
  let next = 0, done = 0, skipped = 0, stale = 0, failed = 0, bytes = 0, expired = 0;
  const REFRESH_PASSES = 2;
  const t0 = performance.now();

  const claim = () => (next < rows.length ? next++ : -1);

  async function worker() {
    for (;;) {
      const i = claim();
      if (i < 0) return;
      const r = rows[i];
      const dest = path.join(folder, r.file);

      if (!FORCE) {
        const st = await fsp.stat(dest).catch(() => null);
        // A cached page is only reused when it is a structurally valid WEBP
        // whose declared size matches the bytes on disk. That catches truncated
        // downloads, zero-length placeholders and non-image junk; a file left
        // over from a different volume with the same name is indistinguishable
        // by content, so use --force when the resolver's page list changes.
        if (st && st.size > 0 && await isCompleteWebp(dest, st.size)) {
          r.bytes = st.size; bytes += st.size; skipped++; done++;
          progress?.update(volLabel, { downloaded: done, bytes });
          continue;
        }
        if (st) stale++;   // present but not reusable (incl. zero-length)
      }
      if (!r.url) { r.error = 'no url'; failed++; done++; progress?.update(volLabel, { downloaded: done, failed }); continue; }

      try {
        const buf = await fetchWithRetry(r.url, RETRIES);
        await fsp.writeFile(dest, buf);
        r.bytes = buf.length;
        bytes += buf.length;
      } catch (e) {
        r.error = e.message;
        failed++;
        // The page URLs are signed and expire. A long parallel run outlives them
        // (a serial run does not), so note it and let the refresh pass below
        // re-resolve and retry rather than losing the page.
        if (/\b403\b/.test(e.message || '')) expired++;
      }
      done++;
      progress?.update(volLabel, { downloaded: done, failed, bytes });
    }
  }

  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, rows.length) }, worker));

  // ---- refresh pass: re-resolve expired page URLs and retry what failed ------
  for (let attempt = 1; attempt <= REFRESH_PASSES && failed > 0; attempt++) {
    const retryable = rows.filter(r => r.error && !r.done);
    if (!retryable.length) break;
    progress?.update(volLabel, { state: 'refreshing', error: '' });
    let fresh = null;
    try { fresh = await collectPages(target, { quiet: true }); }
    catch { break; }
    // Page order and per-page URL are stable across resolutions, so index by
    // page number (verified: two resolutions of the same volume are identical).
    let revived = 0;
    for (const r of retryable) {
      const url = fresh.pages?.[r.page]?.url;
      if (url) { r.url = url; revived++; }
    }
    if (!revived) break;

    progress?.update(volLabel, { state: 'downloading' });
    let rnext = 0;
    const rclaim = () => (rnext < retryable.length ? rnext++ : -1);
    const retryWorker = async () => {
      for (;;) {
        const i = rclaim();
        if (i < 0) return;
        const r = retryable[i];
        const dest = path.join(folder, r.file);
        try {
          const buf = await fetchWithRetry(r.url, RETRIES);
          await fsp.writeFile(dest, buf);
          r.bytes = buf.length;
          bytes += buf.length;   // this page never counted toward `bytes` before
          r.error = null;
          r.done = true;
          failed--; skipped++;
        } catch (e) {
          r.error = e.message;
        }
        progress?.update(volLabel, { downloaded: done, failed, bytes,
                                     state: 'refreshed' });
      }
    };
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, retryable.length) }, retryWorker));
    if (expired) progress?.update(volLabel, { state: 'downloading' });
  }
  const secs = (performance.now() - t0) / 1000;
  progress?.flush(volLabel, { downloaded: done, failed, bytes, state: 'downloaded' });

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
    concurrency: CONCURRENCY,
    elapsedSeconds: +secs.toFixed(2),
    bytes: bytes,
    pages: rows,
  };
  await fsp.writeFile(path.join(folder, 'metadata.json'), JSON.stringify(manifest, null, 2));

  // ---- optional descramble pass -----------------------------------------
  let descramble = null;
  let descrambledDir = null;
  if (DESCRAMBLE) {
    const table = DS_TABLE || path.join(HERE, '..', 'out', 'shuffle_patterns.json');
    const outDir = path.join(folder, 'descrambled');
    // Prefer the repo's Python tool: it uses libwebp's own CLI encoder (cwebp),
    // which is ~5x faster than Pillow's binding, and it runs one process per
    // core. Measured on a 171x1440x2048 volume that is the ~90% saving; the Node
    // port is the fallback when python3/Pillow is unavailable.
    const py = path.join(HERE, '..', 'tools', 'descramble_book.py');
    const havePil = spawnSync('python3', ['-c', 'import PIL, numpy'], { stdio: 'ignore' }).status === 0;
    let cmd, args, engine;
    if (fs.existsSync(py) && havePil) {
      engine = 'python';
      cmd = 'python3';
      args = [py, '--table', table, '--book-dir', folder, '--out', outDir,
              '--encoder', DS_ENCODER];
      if (DS_PRESET) args.push('--preset', DS_PRESET);
      if (DS_JOBS) args.push('--jobs', DS_JOBS);
      if (DS_PDF) args.push('--pdf', DS_PDF);
    } else {
      engine = 'node';
      cmd = process.execPath;
      args = [path.join(HERE, 'descramble.mjs'),
              '--table', table, '--book-dir', folder, '--out', outDir];
      if (DS_PDF) args.push('--pdf', DS_PDF);
    }
    const r = spawnSync(cmd, args, { encoding: 'utf8', maxBuffer: 1 << 28 });
    descramble = { ok: r.status === 0, engine, table, out: outDir, pdf: DS_PDF || null,
                   encoder: DS_ENCODER,
                   output: (r.stdout || '').trim().split('\n').slice(-6) };
    if (!QUIET && !AS_JSON) progress?.update(volLabel, { state: 'descrambled' });
    if (descramble.ok) descrambledDir = outDir;
    else if (r.stderr) descramble.error = r.stderr.trim().split('\n').slice(-3);
  }

  // ---- optional mokuro bridge hand-off ----------------------------------
  let mokuro = null;
  if (MOKURO && bridge && session) {
    // Upload the best available pixels: descrambled if we have them, else raw.
    const srcDir = descrambledDir || folder;
    const wanted = rows.map((r, i) => ({
      page: i,
      file: path.join(srcDir, `page_${String(i).padStart(String(book.totalPages).length, '0')}.webp`),
      name: `page_${String(i).padStart(String(book.totalPages).length, '0')}.webp`,
    })).filter(x => fs.existsSync(x.file));

    progress?.update(volLabel, { state: 'uploading', uploadDone: 0, uploadFailed: 0 });
    let up = 0, upFailed = 0, upSkipped = 0;
    // Paced pushes: small concurrency + a floor between request starts, with
    // retry/backoff inside the client (see COOLDOWN in bridge.mjs).
    const PUSH_CONC = Math.max(1, Number(opt('--push-concurrency', 4)) || 4);
    for (let i = 0; i < wanted.length; i += PUSH_CONC) {
      const batch = wanted.slice(i, i + PUSH_CONC);
      await Promise.all(batch.map(async x => {
        try {
          await bridge.pushPage(session.session_id, await fsp.readFile(x.file), x.name, x.page);
          up++;
        } catch (e) {
          if (e.alreadyOcr) {
            // The bridge already has this page; nothing to upload or re-OCR.
            upSkipped++;
          } else {
            upFailed++;
            x.error = e.message;
          }
        }
        progress?.update(volLabel, { uploadDone: up, uploadFailed: upFailed, uploadSkipped: upSkipped });
      }));
    }
    progress?.update(volLabel, { uploadDone: up, uploadFailed: upFailed, uploadSkipped: upSkipped });

    // Wait for OCR to drain. The bridge OCRs as pages arrive, so this normally
    // finishes quickly; the wait uses an adaptive cooldown (2s floor, growing to
    // 15s while nothing changes) so we neither spin nor crawl.
    progress?.update(volLabel, { state: 'OCR' });
    const last = await bridge.waitForOcr(session.session_id, {
      deadline: Date.now() + OCR_WAIT_MS,
      onProgress: st => progress?.update(volLabel, {
        ocrDone: st.pages_ocr_done || 0,
        ocrTotal: st.pages_received || wanted.length,
        ocrPending: st.pages_ocr_pending || 0,
      }),
    });

    // Finalize: assemble .mokuro, optionally write locally, then upload.
    progress?.update(volLabel, { state: 'finalizing', storage: 'waiting for bridge…' });
    let finalEvent = null, finalizeError = null;
    try {
      finalEvent = await bridge.finalize(session.session_id, {
      ...destInfo.params,
      deleteAfterUpload: destInfo.method !== 'local',
      onEvent: ev => {
        const stage = ev.stage || '';
        if (stage === 'wait_ocr') {
          progress?.update(volLabel, { state: 'OCR', ocrDone: ev.pages_ocr_done ?? 0,
                                       ocrPending: ev.pages_ocr_pending ?? 0,
                                       ocrTotal: ev.pages_received ?? wanted.length });
        } else if (stage === 'assemble') {
          progress?.update(volLabel, { state: 'assembling', storage: 'assembling .mokuro', storagePct: 20 });
        } else if (stage === 'pack') {
          progress?.update(volLabel, { state: 'packaging', storage: 'packaging CBZ + cover', storagePct: 65 });
        } else if (stage === 'upload' || stage === 'upload_progress') {
          const u = ev.upload || ev;
          progress?.update(volLabel, {
            state: 'uploading output',
            storage: clean50(u.file || ev.message || 'uploading output'),
            storagePct: Number(u.percent) || 0,
          });
        } else if (stage === 'cleanup') {
          progress?.update(volLabel, { state: 'cleaning', storage: 'cleanup', storagePct: 95 });
        } else if (stage === 'done') {
          progress?.update(volLabel, { state: 'complete', storage: ev.output_dir || 'stored', storagePct: 100 });
        } else if (stage === 'error') {
          progress?.update(volLabel, { state: 'error', error: clean50(ev.message || 'bridge error') });
        } else if (ev.message) {
          progress?.update(volLabel, { storage: clean50(ev.message, 60) });
        }
      },
      });
    } catch (e) {
      // A failed hand-off (bridge error, remote upload failure) must not be
      // reported as a successful download-with-mokuro.
      finalizeError = e.message;
      if (staleStagingError) finalizeError += `. Note: could not clear ${staleStagingError}`;
      // Leave no staging dir behind, or the retry fails on the nested-image rule.
      await clearStaleStaging(session.vol_dir);
      progress?.update(volLabel, { state: 'error', error: clean50(e.message, 60) });
    }

    mokuro = {
      bridge: bridge.baseUrl,
      destination: destInfo.method,
      // For local the folder we asked for wins; otherwise show the bridge's
      // configured folder for that account (remote roots are server-side).
      destinationFolder: (destInfo.method === 'local'
        ? (destInfo.params.localDir || destInfo.currentFolder)
        : destInfo.currentFolder),
      outputDir: finalEvent?.output_dir || finalEvent?.outputDir || null,
      sessionId: session.session_id,
      pagesUploaded: up,
      pagesFailed: upFailed,
      pagesAlreadyOcr: upSkipped,
      ocrDone: last?.pages_ocr_done ?? null,
      ocrFailed: last?.pages_ocr_failed ?? null,
      files: finalEvent?.files || null,
      finalizeError,
      source: descrambledDir ? 'descrambled' : 'raw',
    };
  }

  // Settle the volume's final state before the block is torn down.
  if (failed > 0) {
    progress?.update(volLabel, { state: 'error', error: `${failed} page(s) failed` });
  } else if (descramble && descramble.ok === false) {
    progress?.update(volLabel, { state: 'error', error: 'descramble failed' });
  } else if (mokuro && mokuro.finalizeError) {
    progress?.update(volLabel, {
      state: 'error',
      error: `${mokuro.destination} hand-off failed`,
    });
  } else if (mokuro) {
    progress?.update(volLabel, {
      state: 'complete',
      storage: mokuro.destination === 'local'
        ? 'saved locally' : `uploaded to ${mokuro.destination}`,
      path: mokuro.outputDir || mokuro.destinationFolder || '',
    });
  } else {
    progress?.update(volLabel, { state: 'complete', storage: '', path: folder });
  }
  progress?.done();
  const summary = {
    folder,
    descramble,
    mokuro,
    totalPages: rows.length,
    downloaded: done - skipped - failed,
    skipped,
    stale,
    failed,
    bytes,
    elapsedSeconds: +secs.toFixed(2),
    MiBPerSecond: +(bytes / 1048576 / Math.max(secs, 0.001)).toFixed(2),
    failures: rows.filter(r => r.error).map(r => ({ file: r.file, error: r.error })),
  };

  // A non-zero exit is the only signal a caller can rely on: partial page
  // failures, a failed descramble, or a failed bridge hand-off all count.
  const anyFailed = summary.failed > 0
    || (summary.descramble && summary.descramble.ok === false)
    || Boolean(summary.mokuro && summary.mokuro.finalizeError);
  if (anyFailed) process.exitCode = 1;

  if (AS_JSON) {
    if (EMIT_JSON) console.log(JSON.stringify(summary, null, 2));
    return summary;
  }

  // Human output goes to stderr: stdout carries the human summary only when
  // --json is absent, and keeping one stream per purpose means the progress
  // block and this report never fight over the same lines.
  const out = line => process.stderr.write(line + '\n');
  out('');
  out(`${book.name}`);
  const staleNote = summary.stale ? `, ${summary.stale} stale re-fetched` : '';
  out(`  ${summary.downloaded} downloaded, ${summary.skipped} already present${staleNote}, ${summary.failed} failed`);
  out(`  ${(bytes / 1048576).toFixed(1)} MiB in ${secs.toFixed(1)}s  =  ${summary.MiBPerSecond} MiB/s at concurrency ${CONCURRENCY}`);
  if (summary.failures.length) {
    out('  failures:');
    for (const f of summary.failures.slice(0, 10)) out(`    ${f.file}: ${f.error}`);
  }
  if (summary.descramble && summary.descramble.ok === false) {
    out(`  descramble FAILED: ${summary.descramble.error || 'see report'}`);
  }
  if (summary.mokuro && summary.mokuro.finalizeError) {
    out(`  bridge hand-off FAILED (${summary.mokuro.destination}): ${summary.mokuro.finalizeError}`);
  }
  out(`folder: ${folder}`);
}

// Only run the CLI when executed directly (so tests can import fetchWithRetry).
const isDirectRun = process.argv[1] &&
  pathToFileURL(process.argv[1]).href === import.meta.url;
if (isDirectRun) {
  main().catch(e => { console.error('ERROR:', e.message); process.exit(1); });
}
