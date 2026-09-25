#!/usr/bin/env node
/**
 * Headless ebookjapan page-list extractor.
 *
 *   node page-list.mjs <books-url | viewer-url | publication-code> [--json]
 *
 * e.g. node page-list.mjs https://ebookjapan.yahoo.co.jp/books/846039/A005320156/
 *      node page-list.mjs B00165320156
 *
 * No browser, no Chromium, no cookies, no login. Node's built-in WebCrypto is
 * enough because the module only uses standard crypto.subtle.
 *
 * Pipeline (mirrors the viewer exactly):
 *   1. POST /br_api/open_book  {type, code, light:false}  -> {session_id, payload}
 *   2. GET  /br_api/get_drm?session_id=…                 -> {file_id, code, payload, …}
 *   3. decrypt_session(session_id, code, openPayload, drmPayload)   [wasm]
 *   4. open_param({dpr,limit,size,flag})                            [wasm] -> manifest
 *   5. get_page_name(file_id, n) for n in 0..pages-1                 [wasm]
 */
import { pathToFileURL } from 'node:url';
import { loadGlue, restoreFetch } from './wasm.mjs';

const BASE = 'https://ebookjapan.yahoo.co.jp';
const CDN  = 'https://prod-contents-br-page.akamaized.net';
const CONCURRENCY = 8;

// NOTE: argument parsing must NOT happen at module scope. Importing this file
// (download.mjs does, to reuse collectPages) would otherwise see the importer's
// argv, find no target and exit(2). Parsing lives in main().

/** Derive {type, code, referer} from whatever the user pasted. */
function parseTarget(t) {
  let m;
  if ((m = t.match(/\/viewer\/([^/]+)\/([A-Za-z0-9]+)/))) {
    return { type: m[1], code: m[2], referer: `${BASE}/viewer/${m[1]}/${m[2]}/` };
  }
  if ((m = t.match(/\/books\/(\d+)\/([A-Za-z0-9]+)/))) {
    return { titleId: m[1], publication: m[2], type: null, code: null, referer: t };
  }
  if (/^[A-Za-z]\d+$/.test(t)) {
    // A bare code the user already knows: usable directly, no resolution needed.
    return { type: 'free', code: t, bareViewerCode: true, allowPurchasedFallback: true,
             referer: `${BASE}/viewer/free/${t}/` };
  }
  if (/^https?:/.test(t)) return { referer: t };
  throw new Error(`cannot interpret target: ${t}`);
}

const apiHeaders = referer => ({
  'Content-Type': 'application/json',
  Origin: BASE,
  Referer: referer,
  'X-Requested-With': 'FetchAPI',   // csrfHeaderName/Value from __NUXT__.config.public
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
                '(KHTML, like Gecko) Chrome/131.0 Safari/537.36',
});


/** Find the info-API URL in a page and return a resolved spec from it. */
async function fetchDetail(html) {
  const unescaped = (html || '').replace(/\\u002F/g, '/').replace(/\\\//g, '/');
  const m = unescaped.match(/\/br_api\/books\/(\d+)\/([A-Za-z0-9]+)/);
  if (!m) return null;
  const [, titleId, publication] = m;
  const r = await fetch(`${BASE}/br_api/books/${titleId}/${publication}?device=pc`,
    { headers: apiHeaders(`${BASE}/books/${titleId}/${publication}/`) });
  if (!r.ok) return null;
  const d = (await r.json())?.detail;
  if (!d?.code) return null;
  const isFree = !!(d.isFree || d.isTrialReadableWithBrowser);
  return {
    titleId, publication,
    type: isFree ? 'free' : 'purchased',
    code: d.code,
    trial: d.trial,
    referer: `${BASE}/books/${titleId}/${publication}/`,
  };
}

async function resolveCodes(spec) {
  if (spec.type && spec.code) return spec;

  // Preferred: the JSON API the book page itself uses. It returns both
  // `trial` and `code`; `code` is exactly what the viewer URL uses.
  if (spec.titleId && spec.publication) {
    const r = await fetch(`${BASE}/br_api/books/${spec.titleId}/${spec.publication}?device=pc`,
      { headers: apiHeaders(spec.referer || BASE + '/') });
    if (r.ok) {
      const d = (await r.json())?.detail;
      if (d) {
        const isFree = d.isFree || d.isTrialReadableWithBrowser;
        const code = isFree ? (d.code || d.trial) : (d.code || d.trial);
        if (code) return { ...spec, type: isFree ? 'free' : 'purchased', code };
      }
    }
  }

  // Last resort: read codes out of the page's own JSON payload. Codes appear
  // there as whole array entries ("B00165320156"), which avoids the substring
  // trap you hit with a raw regex (goods codes like "B001653201560036" contain
  // a valid-looking prefix).
  if (spec.referer) {
    const r = await fetch(spec.referer, { headers: { 'User-Agent': apiHeaders(spec.referer)['User-Agent'] } });
    if (r.ok) {
      const html = await r.text();
      const m = html.match(/<script[^>]*id="[^"]*__NUXT_DATA__"[^>]*>([\s\S]*?)<\/script>/)
             || html.match(/window\.__NUXT__\s*=\s*(\{[\s\S]*?);?<\/script>/);
      let codes = [];
      if (m) {
        try {
          const arr = JSON.parse(m[1]);
          codes = arr.filter(v => typeof v === 'string' && /^[A-Z]\d{10}$/.test(v));
        } catch (_) { /* fall through */ }
      }
      if (!codes.length) {
        // whole-string match only (quote or comma delimited), never a prefix
        codes = [...new Set((html.match(/(?:^|["',:\[])([A-Z]\d{10})(?=["',:\]])/g) || [])
          .map(x => x.replace(/[^A-Z0-9]/g, '')))];
      }
      const free = codes.find(c => c.startsWith('B')) || codes.find(c => c.startsWith('A'));
      if (free) return { ...spec, type: 'free', code: free, allowPurchasedFallback: true };

      // The viewer shell has no reading code, but it does carry the
      // publicationCd; use it to ask the info API for the real codes.
      const detail = await fetchDetail(html);
      if (detail) return { ...detail, allowPurchasedFallback: true };
    }
  }
  throw new Error('could not determine the reading code; pass a /viewer/<type>/<code>/ URL');
}

export async function collectPages(target, { quiet = false } = {}) {
  const spec = await resolveCodes(parseTarget(target));
  if (!quiet) process.stderr.write(`type=${spec.type} code=${spec.code} referer=${spec.referer}\n`);

  // 1. session. A bare code could be a free-lending code or a purchased one, so
  // try the free form first and fall back (the free form is the common case).
  const openBook = (type, code) => fetch(`${BASE}/br_api/open_book`, {
    method: 'POST',
    headers: apiHeaders(spec.referer),
    body: JSON.stringify({ type, code, light: false }),
  });

  if (!quiet) process.stderr.write(`  session: open_book type=${spec.type} code=${spec.code}\n`);
  let obRes = await openBook(spec.type, spec.code);
  if (!obRes.ok && spec.type === 'free' && spec.allowPurchasedFallback) {
    const trial = spec.trial && spec.trial !== spec.code ? spec.trial : null;
    const alt = await openBook('purchased', trial || spec.code);
    if (alt.ok) { obRes = alt; spec.type = 'purchased'; spec.code = trial || spec.code; }
  }
  if (!obRes.ok) {
    const body = (await obRes.text()).slice(0, 200);
    if (spec.type === 'purchased') {
      throw new Error(
        `open_book (purchased) ${obRes.status}: ${body}\n` +
        `  This volume is not free, so the API needs your logged-in session cookies.\n` +
        `  Free/novelty-readable volumes work with no authentication at all.`);
    }
    throw new Error(`open_book ${obRes.status}: ${body}`);
  }
  const open = await obRes.json();

  // 2. drm payload
  const drmRes = await fetch(`${BASE}/br_api/get_drm?session_id=${encodeURIComponent(open.session_id)}`,
    { headers: apiHeaders(spec.referer) });
  if (!drmRes.ok) throw new Error(`get_drm ${drmRes.status}: ${(await drmRes.text()).slice(0, 200)}`);
  const drm = await drmRes.json();

  // 2b. Make sure the wasm fetch shim is gone before any real network I/O below.
  restoreFetch();

  // 3. wasm: instantiate, decrypt, read the manifest
  const glue = await loadGlue();
  await glue.decrypt_session(open.session_id, drm.code, open.payload, drm.payload);

  const dpr = 2;
  const manifest = await glue.open_param({ dpr, limit: 2000, size: 1200, flag: 0 });
  const pages = manifest?.pages || [];

  // 4. one name per page
  const names = new Array(pages.length);
  for (let i = 0; i < pages.length; i += CONCURRENCY) {
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, pages.length - i) }, async (_, k) => {
      const n = i + k;
      try { names[n] = await glue.get_page_name(drm.file_id, n); }
      catch (e) { names[n] = null; }
    }));
  }

  const rows = pages.map((p, n) => {
    const name = names[n];
    return {
      page: n,
      name,
      view: p.view ?? null,
      width: p.width ?? null,
      height: p.height ?? null,
      position: p.position ?? null,
      jumps: (p.jumps || []).length,
      // Image base is `/pages` — NOT drm.path (that is the .ddd segment path,
      // and prod-contents-br-page rejects it with 403). Verified live.
      url: name ? `${CDN}/pages/${name.replace(/\.jpg$/, '.webp')}` : null,
    };
  });

  const out = {
    publication: drm.publication,
    fileId: drm.file_id,
    path: drm.path,
    code: drm.code,
    name: drm.name,
    title: drm.title,
    formatId: Number(drm.format_id),
    direction: manifest?.direction ?? null,
    version: manifest?.version ?? null,
    imageTypes: manifest?.image_types ?? null,
    chapters: manifest?.chapters ?? [],
    totalPages: pages.length,
    pages: rows,
  };

  return out;
}

async function main() {
  const args = process.argv.slice(2);
  const asJson = args.includes('--json');
  const target = args.find(a => !a.startsWith('--'));
  if (!target) {
    console.error('usage: node page-list.mjs <books-url | viewer-url | publication-code> [--json]');
    process.exit(2);
  }

  const out = await collectPages(target);
  if (asJson) { console.log(JSON.stringify(out, null, 2)); return; }
  const drm = out, pages = out.pages, rows = pages;
  console.log(`\n${out.name}`);
  console.log(`file_id=${drm.fileId}  path=${drm.path}  format=${drm.formatId}  pages=${pages.length}  direction=${out.direction}`);
  console.log('');
  for (const r of rows) {
    console.log(`${String(r.page).padStart(4)}  ${String(r.width).padStart(5)}x${String(r.height).padEnd(5)}  ${r.name || '(no name)'}`);
  }
  const missing = rows.filter(r => !r.url).length;
  console.log(`\n${rows.length - missing}/${rows.length} pages resolved`);
}

// Only run the CLI when this file is executed directly. Without this guard,
// importing collectPages() (as download.mjs does) also runs the whole CLI.
const isDirectRun = process.argv[1] &&
  pathToFileURL(process.argv[1]).href === import.meta.url;
if (isDirectRun) {
  main().catch(e => { console.error('ERROR:', e.message); process.exit(1); });
}
