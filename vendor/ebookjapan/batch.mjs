#!/usr/bin/env node
/**
 * Download several volumes at once, each into its own manga-named folder.
 *
 *   node batch.mjs <links.txt | listing-url | books-url...> [options]
 *
 * Options
 *   --series N        volumes downloaded in parallel (default 8)
 *   --concurrency N   images in flight *per volume* (default 32)
 *   --out DIR         parent folder (default: next to this script)
 *   --force           re-download existing pages
 *   --quiet           only print the final summary
 *   --json            machine-readable summary
 *
 * Accepts:
 *   - a text file containing one URL per line
 *   - a listing page URL, e.g. .../free/books/?browserSpecialFreeCountOver=3&useTitle=1
 *   - one or more /books/<titleId>/<publication>/ URLs on the command line
 *
 * The viewer code is NOT derivable from the publication code (A00…→B0016… is not
 * a substitution); it comes from the info API's `detail.code`, which is what
 * collectPages() already does.
 *
 * Parallelism note: the wasm phase of collectPages() (open_book/get_drm/decrypt)
 * touches a process-global fetch shim, so those are serialised deliberately.
 * Only the image transfers run in parallel, which is where the time actually is.
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);

const VALUE_FLAGS = new Set(['--series', '--concurrency', '--out', '--table', '--pdf', '--bridge', '--local-dir', '--upload-method']);
const BOOL_FLAGS  = new Set(['--force', '--quiet', '--json', '--descramble', '--mokuro']);
function opt(name, dflt) {
  const i = argv.indexOf(name);
  if (i < 0) return dflt;
  const v = argv[i + 1];
  return v !== undefined && !v.startsWith('--') ? v : true;
}

const SERIES      = Math.max(1, Number(opt('--series', 8)) || 8);
const CONCURRENCY = Math.max(1, Number(opt('--concurrency', 32)) || 32);
const OUT         = typeof opt('--out', null) === 'string' ? opt('--out') : HERE;
const FORCE       = !!opt('--force', false);
const QUIET       = !!opt('--quiet', false);
const AS_JSON     = !!opt('--json', false);
// Pass-through flags forwarded to each per-volume download.
const PASS = ['--descramble', '--mokuro', '--force', '--table', '--pdf',
              '--bridge', '--local-dir', '--upload-method', '--dest', '--dest-folder'];
const passthrough = [];
for (const f of PASS) {
  const v = opt(f, undefined);
  if (v === undefined || v === false) continue;
  passthrough.push(f);
  if (v !== true) passthrough.push(String(v));
}

// ------------------------------------------------------------------ inputs
const consumed = new Set();
for (let i = 0; i < argv.length; i++) {
  if (VALUE_FLAGS.has(argv[i])) { consumed.add(i); consumed.add(i + 1); }
  else if (BOOL_FLAGS.has(argv[i])) consumed.add(i);
}
const inputs = argv.filter((a, i) => !consumed.has(i) && !a.startsWith('--'));
// No top-level exit: importing this module (for tests) must not terminate.
const USAGE = `usage: node batch.mjs <links.txt | listing-url | books-url...> [options]

  --series N        volumes downloaded in parallel (default 8)
  --concurrency N   images in flight PER volume (default 32)
  --out DIR         parent dir; each volume gets DIR/<manga name>/
  --force           re-download existing pages

  Any download.mjs option is passed through to every volume, e.g.
  --descramble, --table PATH, --encoder, --preset, --jobs,
  --mokuro, --bridge URL, --local-dir DIR

  --quiet / --json  output control

Inputs may be a text file of URLs, a listing page URL, or /books/... URLs.`;

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36';
const BOOK_RE = /\/books\/\d+\/[A-Za-z]\d{6,}(?![0-9])/g;

export async function expand(input) {
  // a file of links?
  try {
    const st = await fsp.stat(input);
    if (st.isFile()) {
      const text = await fsp.readFile(input, 'utf8');
      return [...new Set(text.match(BOOK_RE) || [])];
    }
  } catch { /* not a file */ }

  if (!/^https?:/.test(input)) return [input];

  // A concrete volume URL is used as-is. Do NOT scrape it: a book page carries
  // links to every other volume of the series, which would silently turn one
  // requested volume into dozens.
  const direct = input.match(/\/books\/\d+\/[A-Za-z]\d{6,}/);
  if (direct) return [direct[0]];

  // Otherwise treat it as a listing/search page and collect its volume links.
  const res = await fetch(input, { headers: { 'User-Agent': UA } });
  if (!res.ok) throw new Error(`listing ${res.status}`);
  const html = await res.text();
  const found = [...new Set(html.match(BOOK_RE) || [])];
  if (found.length) return found;
  throw new Error('no volume links found on that page');
}

// ------------------------------------------------------------------- runner
function runOne(link) {
  return new Promise(resolve => {
    const child = spawn(process.execPath, [
      path.join(HERE, 'download.mjs'), link,
      '--concurrency', String(CONCURRENCY),
      '--out', OUT,
      ...passthrough,
      '--quiet', '--no-progress', '--json',
    ], { stdio: ['ignore', 'pipe', 'pipe'] });

    let out = '', err = '';
    child.stdout.on('data', d => out += d);
    child.stderr.on('data', d => err += d);
    child.on('close', code => {
      if (code === 0) {
        try { resolve({ link, ok: true, ...JSON.parse(out) }); }
        catch { resolve({ link, ok: false, error: 'unparseable output' }); }
      } else {
        const msg = (err.match(/ERROR: (.*)/) || [, err.trim().split('\n').pop()])[1];
        resolve({ link, ok: false, error: msg || `exit ${code}` });
      }
    });
  });
}

// --------------------------------------------------------------------- main
async function main() {
  if (!inputs.length) { console.error(USAGE); process.exit(2); }

  const links = [];
  for (const input of inputs) {
    try { links.push(...await expand(input)); }
    catch (e) { console.error(`  ! ${input}: ${e.message}`); }
  }
  const unique = [...new Set(links)];
  if (!unique.length) { console.error('no volume links found'); process.exit(1); }

  if (!QUIET && !AS_JSON) console.log(`downloading ${unique.length} volumes (${SERIES} at a time, ${CONCURRENCY} images each)\n`);

  const results = [];
  let next = 0, finished = 0;
  const t0 = performance.now();

  async function worker() {
    for (;;) {
      const i = next++;
      if (i >= unique.length) return;
      const link = unique[i];
      const r = await runOne(link);
      results[i] = r;
      finished++;
      const label = r.folder ? path.basename(r.folder) : link;
      const short = label.length > 46 ? label.slice(0, 45) + '…' : label;
      if (!QUIET && !AS_JSON) {
        const status = r.ok ? `${r.totalPages}p ${r.failed ? `(${r.failed} failed)` : ''}` : `FAILED ${r.error}`;
        console.log(`  [${String(finished).padStart(3)}/${unique.length}] ${short}  ${status}`);
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(SERIES, unique.length) }, worker));

  const secs = (performance.now() - t0) / 1000;
  const ok = results.filter(r => r && r.ok);
  const summary = {
    volumes: unique.length,
    succeeded: ok.length,
    failed: results.filter(r => r && !r.ok).length,
    pages: ok.reduce((a, r) => a + (r.downloaded || 0), 0),
    bytes: ok.reduce((a, r) => a + (r.bytes || 0), 0),
    elapsedSeconds: +secs.toFixed(2),
    seriesParallel: SERIES,
    perVolumeParallel: CONCURRENCY,
    results: results.map(r => r ? {
      link: r.link, ok: r.ok, folder: r.folder, totalPages: r.totalPages,
      downloaded: r.downloaded, failed: r.failed, error: r.error,
    } : { link: null, ok: false, error: 'not attempted' }),
  };

  if (AS_JSON) { console.log(JSON.stringify(summary, null, 2)); process.exit(summary.failed ? 1 : 0); }

  console.log(`\n${summary.succeeded}/${summary.volumes} volumes, ${summary.pages} pages, ` +
              `${(summary.bytes / 1048576).toFixed(1)} MiB in ${secs.toFixed(1)}s`);

  const bad = results.filter(r => r && !r.ok);
  if (bad.length) {
    // Group by cause; the common one is a login/browser-only volume, which is not
    // a bug in this tool and cannot be retried headlessly.
    const locked = bad.filter(r => /purchased|ResourceNotFound|401|403/.test(r.error || ''));
    const other  = bad.filter(r => !locked.includes(r));
    if (locked.length) {
      console.log(`\n${locked.length} volume(s) are login/browser-only and were skipped:`);
      for (const r of locked.slice(0, 5)) console.log(`  ${r.link}`);
      if (locked.length > 5) console.log(`  … and ${locked.length - 5} more`);
      console.log('  (these need session cookies; free volumes without that flag download fine)');
    }
    if (other.length) {
      console.log(`\n${other.length} other failure(s):`);
      for (const r of other) console.log(`  ${r.link}: ${r.error}`);
    }
  }
  process.exit(summary.failed ? 1 : 0);
}

// Only run the CLI when executed directly; importing this file (for tests)
// must not start a download.
const isDirectRun = process.argv[1] &&
  pathToFileURL(process.argv[1]).href === import.meta.url;
if (isDirectRun) {
  main().catch(e => { console.error('ERROR:', e.message); process.exit(1); });
}
