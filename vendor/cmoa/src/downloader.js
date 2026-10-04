/**
 * CMOA volume downloader.
 *
 * Reproduces the viewer's request sequence without a browser:
 *
 *   1. generateK(cid)               local token, no server round-trip
 *   2. bibGetCntntInfo.php          ContentsServer, ViewMode, p, scramble tables
 *   3. decodeTables()               recover the tables from the cid + k key
 *   4. sbcGetCntnt.php              ttx -> the landscape page list
 *   5. sbcGetImg.php per page       the scrambled JPEG
 *   6. descramble + re-encode       the page as the reader displays it
 *
 * Pages are written in order and skipped when they already exist, so an
 * interrupted run can simply be repeated.
 */

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

import { generateK, decodeTables, selectScramble } from './protocol.js';
import { parsePageList, parseBookMeta } from './pagelist.js';
import { renderPage, normaliseFormat, extensionFor, inspectPage } from './codec.js';
import { fetchJson, fetchWithRetry, HttpError } from './http.js';
import { RenderPool } from './render_pool.js';

const INFO_URL = 'https://www.cmoa.jp/bib/sws/bibGetCntntInfo.php';
const VIEWER_BASE = 'https://www.cmoa.jp/bib/speedreader/';

/**
 * Accept a full speed-reader URL, a bare cid, or a cid with extra query params.
 * Returns the cid plus any query parameters the viewer forwarded (u0, u1, ...).
 */
export function parseTarget(target) {
  const text = String(target).trim();
  if (!text) throw new Error('empty target');

  let cid = null;
  const params = new URLSearchParams();
  const looksLikeUrl = /^[a-z][a-z0-9+.-]*:\/\//i.test(text) || text.startsWith('/');
  if (looksLikeUrl) {
    const url = new URL(text, VIEWER_BASE);
    cid = url.searchParams.get('cid');
    for (const [key, value] of url.searchParams) {
      // `cid` is re-sent explicitly, and the rest of the viewer's own params are
      // meaningless to the API.
      if (key === 'cid' || key === 'k' || key === 'dmytime' || key === 'rurl') continue;
      params.set(key, value);
    }
    if (!cid) throw new Error(`no cid in ${text}`);
  } else if (text.includes('=')) {
    const search = new URLSearchParams(text.replace(/^\?/, ''));
    cid = search.get('cid');
    for (const [key, value] of search) {
      if (key === 'cid' || key === 'k' || key === 'dmytime' || key === 'rurl') continue;
      params.set(key, value);
    }
    if (!cid) throw new Error(`no cid in ${text}`);
  } else {
    cid = text;
  }
  // The viewer always sends u0; the API rejects requests without it.
  if (!params.has('u0')) params.set('u0', '1');
  return { cid, params, viewerUrl: `${VIEWER_BASE}?cid=${encodeURIComponent(cid)}` };
}

/**
 * Resolve a target into everything needed to download it.
 *
 * @param {string} target  speed-reader URL or cid
 * @param {{retries?: number, timeoutMs?: number, log?: Function}} [options]
 */
export async function openVolume(target, options = {}) {
  const log = options.log ?? (() => {});
  const { cid, params, viewerUrl } = parseTarget(target);
  const k = generateK(cid);
  const infoParams = new URLSearchParams(params);
  infoParams.set('cid', cid);
  infoParams.set('k', k);
  infoParams.set('dmytime', String(Date.now()));

  const infoUrl = `${INFO_URL}?${infoParams.toString()}`;
  log(`fetching content info for ${cid}`);
  const info = await fetchJson(infoUrl, {
    referer: viewerUrl,
    retries: options.retries,
    timeoutMs: options.timeoutMs,
  });
  if (info.result !== 1) {
    throw new Error(
      `bibGetCntntInfo returned result=${info.result}; the content is ` +
        `unavailable, expired, or the cid is wrong`,
    );
  }
  const item = info.items?.[0];
  if (!item) throw new Error('bibGetCntntInfo returned no items');

  const tables = decodeTables(cid, k, item);
  const servers = String(item.ContentsServer ?? '').replace(/\/+$/, '');
  if (!servers) throw new Error('bibGetCntntInfo returned no ContentsServer');
  const viewMode = String(item.ViewMode);
  const contentDate = String(item.ContentDate ?? '');
  const requestToken = item.p ?? null;

  const contentUrl = `${servers}/sbcGetCntnt.php?${new URLSearchParams({
    cid,
    ...(requestToken ? { p: requestToken } : {}),
    vm: viewMode,
    dmytime: contentDate || String(Date.now()),
    ...Object.fromEntries(params),
  }).toString()}`;

  log('fetching page list');
  const content = await fetchJson(contentUrl, {
    referer: viewerUrl,
    retries: options.retries,
    timeoutMs: options.timeoutMs,
  });
  if (content.result !== 1) {
    throw new Error(`sbcGetCntnt returned result=${content.result}`);
  }
  const pages = parsePageList(content.ttx);
  if (!pages.length) throw new Error('the page list is empty');

  const meta = parseBookMeta(content.ttx);
  const volume = {
    cid,
    viewerUrl,
    params,
    servers,
    viewMode,
    contentDate,
    requestToken,
    tables,
    pages,
    meta,
    imageClass: content.ImageClass ?? item.ImageClass ?? '',
    title: item.Title || meta.title || cid,
    subtitle: item.SubTitle || '',
    author: (item.Authors ?? []).map((a) => a.Name).filter(Boolean).join(', '),
    publisher: item.Publisher || '',
    pageCount: pages.length,
    /** Build the CDN URL for one page. */
    imageUrl(page, quality = '1') {
      const query = new URLSearchParams({
        cid,
        src: page.src,
        ...(requestToken ? { p: requestToken } : {}),
        q: String(quality),
        vm: viewMode,
        dmytime: contentDate,
        ...Object.fromEntries(params),
      });
      return `${servers}/sbcGetImg.php?${query.toString()}`;
    },
    /** Scramble tables selected for one page. */
    tablesFor(page) {
      const { coordTable, pieceTable } = selectScramble(page.src, tables);
      return { coordTable, pieceTable };
    },
    async fetchPage(page, options2 = {}) {
      return fetchWithRetry(volume.imageUrl(page, options2.quality), {
        ...options2,
        binary: true,
        referer: viewerUrl,
      });
    },
  };
  return volume;
}

/**
 * Filesystem-safe directory name for a volume.
 *
 * The default is the cid: titles are long, mixed-language and full of
 * separators, which makes an unusable directory name. `useTitle` opts into the
 * title for anyone who would rather browse by name.
 */
export function volumeName(volume, useTitle = false) {
  if (!useTitle) return volume.cid;
  const base = (volume.title || volume.cid)
    .replace(/[\\/:*?"<>|]+/g, '_')
    .replace(/\s+/g, ' ')
    .trim();
  return base.slice(0, 80).replace(/[. ]+$/, '') || volume.cid;
}

/**
 * The page file name.
 *
 * `page-0001.jpg`, one-based and always four digits, so a plain name sort is
 * reading order. It used to be a bare `0001.jpg`, which sorted correctly but did
 * not match what the other stores write, so a mixed library had no one order.
 *
 * `legacyPageFileName` is the bare form, kept only so an existing folder is
 * recognised and not downloaded a second time.
 */
function pageFileName(index, extension) {
  return `page-${String(index + 1).padStart(4, '0')}.${extension}`;
}

function legacyPageFileName(index, extension) {
  return `${String(index + 1).padStart(4, '0')}.${extension}`;
}

/**
 * Rewrite the folder's modification times into reading order.
 *
 * Pages are fetched concurrently and land in completion order, so without this a
 * reader sorting by date shows the volume scrambled. One second apart, ending at
 * roughly now, so every stamp stays in the past. Best effort: a timestamp is a
 * convenience and must never fail a download whose bytes are already written.
 */
async function stampPageTimes(outDir, files) {
  const ordered = files.filter(Boolean);
  if (ordered.length < 2) return;
  const base = Date.now() - ordered.length * 1000;
  for (let i = 0; i < ordered.length; i++) {
    const seconds = (base + i * 1000) / 1000;
    try {
      await fsp.utimes(path.join(outDir, ordered[i]), seconds, seconds);
    } catch { /* best effort */ }
  }
}

/**
 * Download every page of a volume.
 *
 * Uses a self-feeding worker pool rather than fixed batches: each worker claims
 * the next unclaimed page as soon as it finishes, so there is no tail while the
 * slowest member of a batch completes and the in-flight count stays pinned at
 * `concurrency` until the queue drains.
 *
 * Rendering is the expensive part (see src/render_pool.js), so it is handed to a
 * worker pool while this function's main thread stays on the network. Pass
 * `jobs: 0` to render inline instead, which is only sensible for a handful of
 * pages or for debugging.
 *
 * @param {object} volume                from openVolume()
 * @param {{outDir: string, concurrency?: number, jobs?: number, format?: string,
 *          quality?: number, force?: boolean, limit?: number,
 *          onProgress?: Function, log?: Function}} options
 */
export async function downloadVolume(volume, options) {
  const {
    outDir,
    concurrency = 6,
    jobs = 1,
    force = false,
    limit = 0,
    onProgress = () => {},
    log = () => {},
  } = options;
  const format = normaliseFormat(options.format ?? 'jpeg');
  const quality = options.quality;
  // With `original`, a page that needed no descrambling is kept in the CDN's own
  // encoding while a descrambled page is written in the normal format, so the
  // extension is only known per page. Probing an existing file means checking
  // both candidates.
  const defaultExtension = extensionFor(format === 'original' ? 'jpeg' : format);
  const extensionCandidates =
    format === 'original' ? ['jpg', 'png'] : [defaultExtension];

  await fsp.mkdir(outDir, { recursive: true });

  const total = limit > 0 ? Math.min(limit, volume.pages.length) : volume.pages.length;
  const pending = [];
  const onDisk = new Array(total).fill(null);
  for (let i = 0; i < total; i++) {
    let existing = null;
    if (!force) {
      for (const extension of extensionCandidates) {
        // The canonical name first, then the bare one an older version wrote. A
        // legacy hit is renamed rather than re-fetched, so a folder resumed now
        // does not end up holding both schemes at once.
        const canonical = path.join(outDir, pageFileName(i, extension));
        if (fs.existsSync(canonical)) {
          existing = canonical;
          break;
        }
        const legacy = path.join(outDir, legacyPageFileName(i, extension));
        if (fs.existsSync(legacy)) {
          try {
            fs.renameSync(legacy, canonical);
            existing = canonical;
          } catch {
            existing = legacy;
          }
          break;
        }
      }
    }
    if (existing) {
      onDisk[i] = path.basename(existing);
      onProgress({ index: i, total, skipped: true, file: existing });
      continue;
    }
    onDisk[i] = pageFileName(i, defaultExtension);
    pending.push({ index: i, file: path.join(outDir, pageFileName(i, defaultExtension)) });
  }

  const failures = [];
  let next = 0;
  let completed = total - pending.length;
  let bytes = 0;
  const startedAt = Date.now();

  // One pool for the whole run: starting a worker costs more than a small page
  // takes to render, so per-page pools would lose more than they gain.
  const pool = jobs > 0 ? new RenderPool(jobs) : null;
  const render = pool
    ? (raw, tables) =>
        pool.render(raw, tables, {
          format,
          quality: options.jpegQuality,
          subsample: options.subsample,
        })
    : async (raw, tables) =>
        renderPage(raw, tables, {
          format,
          quality: options.jpegQuality,
          subsample: options.subsample,
        });

  const claim = () => {
    if (next >= pending.length) return null;
    return pending[next++];
  };

  const worker = async () => {
    for (;;) {
      const job = claim();
      if (!job) return;
      const page = volume.pages[job.index];
      const started = Date.now();
      try {
        // Retries are forwarded so the caller's budget applies to page fetches
        // too, not only to the metadata calls in openVolume.
        const raw = await volume.fetchPage(page, { quality, retries: options.retries });
        const fetchedAt = Date.now();
        const tables = volume.tablesFor(page);
        const rendered = await render(raw, tables);
        const renderedAt = Date.now();
        // `original` may hand back either the CDN bytes or a re-encoded page, so
        // take the final extension from the result rather than assuming.
        const finalFile = job.file.replace(/\.[a-z0-9]+$/i, `.${rendered.extension}`);
        // Write via a temporary name so an interrupted run never leaves a
        // half-written page behind that resume would then trust.
        const tmp = `${finalFile}.part`;
        await fsp.writeFile(tmp, rendered.data);
        await fsp.rename(tmp, finalFile);
        const writtenAt = Date.now();
        completed++;
        bytes += rendered.data.length;
        onProgress({
          index: job.index,
          total,
          skipped: false,
          file: finalFile,
          bytes: rendered.data.length,
          elapsedMs: Date.now() - started,
          // The two halves separately, so a caller can tell rendering from waiting.
          fetchMs: fetchedAt - started,
          renderMs: renderedAt - fetchedAt,
          writeMs: writtenAt - renderedAt,
          kind: rendered.kind,
          format: rendered.format,
          descrambled: rendered.changed,
          ...(options.inspect ? inspectPage(raw, tables) : {}),
        });
      } catch (error) {
        const message =
          error instanceof HttpError ? `HTTP ${error.status}` : (error?.message ?? String(error));
        failures.push({ index: job.index, error: message });
        onProgress({ index: job.index, total, error: message, file: job.file });
      }
    }
  };

  const workers = Array.from({ length: Math.max(1, Math.min(concurrency, pending.length || 1)) }, worker);
  try {
    await Promise.all(workers);
  } finally {
    if (pool) await pool.close();
  }

  const elapsedMs = Date.now() - startedAt;
  const meta = {
    cid: volume.cid,
    title: volume.title,
    subtitle: volume.subtitle,
    author: volume.author,
    publisher: volume.publisher,
    viewerUrl: volume.viewerUrl,
    pages: total,
    downloaded: completed,
    failed: failures.length,
    format,
    extension: defaultExtension,
    source: {
      contentsServer: volume.servers,
      viewMode: volume.viewMode,
      contentDate: volume.contentDate,
    },
    pageList: volume.pages.slice(0, total).map((p, i) => ({
      index: i,
      id: p.id,
      src: p.src,
      orgwidth: p.orgwidth,
      orgheight: p.orgheight,
      pageSpread: p.pageSpread,
    })),
    ...(failures.length ? { failures } : {}),
  };
  await fsp.writeFile(path.join(outDir, 'metadata.json'), `${JSON.stringify(meta, null, 2)}\n`);

  // Only when this run actually wrote pages: a folder that was already complete
  // is left exactly as it was found.
  if (completed > total - pending.length) await stampPageTimes(outDir, onDisk);

  return {
    total,
    downloaded: completed,
    skipped: total - pending.length,
    failed: failures.length,
    failures,
    bytes,
    elapsedMs,
    outDir,
  };
}
