#!/usr/bin/env node
/**
 * Benchmark the image CDN and the local decode/encode pipeline separately, then
 * the whole downloader, so it is clear which one is the bottleneck.
 *
 *   node bench.mjs [--cid CID] [--concurrency 1,4,16,64] [--pages 64]
 *                  [--format original|jpeg|png] [--cpu-only] [--max-connections N]
 *
 * The image URLs are resolved once through the normal API, then reused across
 * every concurrency level. That matters: resolving the page list 8 times would
 * fold API latency into the network numbers and make runs incomparable.
 */

import fs from 'node:fs';
import { installSocketPool } from './src/http.js';

import { openVolume } from './src/downloader.js';
import { renderPage } from './src/codec.js';

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
};
const has = (name) => args.includes(`--${name}`);

const cid = flag('cid', '0000249510_jp_0001');
const pageCount = Number(flag('pages', 64));
const concurrencyLevels = String(flag('concurrency', '1,4,16,64,128'))
  .split(',')
  .map((n) => Number(n.trim()))
  .filter((n) => Number.isFinite(n) && n > 0);
const format = flag('format', 'original');
const maxConnections = Number(flag('max-connections', 0));
const cpuOnly = has('cpu-only');

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

if (maxConnections > 0) {
  installSocketPool(maxConnections);
  console.log(`using a node:https pool with maxSockets=${maxConnections}`);
}

function human(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1048576) return `${(n / 1024).toFixed(0)} KiB`;
  return `${(n / 1048576).toFixed(1)} MiB`;
}

const volume = await openVolume(cid);
const pages = volume.pages.slice(0, Math.min(pageCount, volume.pageCount));
console.log(`volume: ${volume.title}`);
console.log(`pages:  ${pages.length} of ${volume.pageCount}`);
console.log(`node:   ${process.version}\n`);

async function fetchOne(page) {
  const url = volume.imageUrl(page, '1');
  const started = performance.now();
  const response = await fetch(url, {
    headers: { 'User-Agent': UA, Referer: volume.viewerUrl, Accept: 'image/*,*/*;q=0.8' },
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const buffer = new Uint8Array(await response.arrayBuffer());
  return { bytes: buffer.length, ms: performance.now() - started, buffer, page };
}

/**
 * Self-feeding pool: a worker claims the next index the moment it finishes, so
 * the in-flight count stays pinned at `concurrency` with no batch tail.
 */
async function runPool(items, concurrency, worker) {
  let next = 0;
  const stats = { bytes: 0, times: [], error: 0 };
  const run = async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      try {
        const result = await worker(items[i]);
        stats.bytes += result.bytes ?? 0;
        if (result.ms) stats.times.push(result.ms);
      } catch {
        stats.error++;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, run));
  return stats;
}

const networkResults = [];
if (!cpuOnly) {
  console.log('--- CDN throughput (raw bytes, no decoding) ---');
  console.log('conc   wall    MiB    MB/s    req/s   p50ms   p95ms   errors');
  for (const concurrency of concurrencyLevels) {
    const started = performance.now();
    const stats = await runPool(pages, concurrency, fetchOne);
    const wall = (performance.now() - started) / 1000;
    stats.times.sort((a, b) => a - b);
    const p = (q) => stats.times[Math.min(stats.times.length - 1, Math.floor(stats.times.length * q))] ?? 0;
    const mib = stats.bytes / 1048576;
    console.log(
      `${String(concurrency).padStart(4)}  ${wall.toFixed(2)}s  ${mib.toFixed(1).padStart(6)}  ` +
        `${(mib / wall).toFixed(1).padStart(6)}  ${(pages.length / wall).toFixed(0).padStart(6)}  ` +
        `${p(0.5).toFixed(0).padStart(6)}  ${p(0.95).toFixed(0).padStart(6)}  ${String(stats.error).padStart(6)}`,
    );
    networkResults.push({ concurrency, wall, mib, mbps: mib / wall, rps: pages.length / wall, error: stats.error });
  }
}

// --- worker-thread scaling ------------------------------------------------
console.log('\n--- render throughput vs worker threads ---');
{
  const { RenderPool } = await import('./src/render_pool.js');
  const sampleForPool = [];
  for (let i = 0; i < Math.min(48, pages.length); i++) sampleForPool.push(await fetchOne(pages[i]));
  console.log('jobs   pages/s   ms/page');
  for (const jobs of [0, 1, 2, 4, 8, 16]) {
    const rendered = [];
    const started = performance.now();
    if (jobs === 0) {
      for (const s of sampleForPool) {
        rendered.push(renderPage(s.buffer, volume.tablesFor(s.page), { format }));
      }
    } else {
      const pool = new RenderPool(jobs);
      try {
        const out = await Promise.all(
          sampleForPool.map((s) => pool.render(s.buffer, volume.tablesFor(s.page), { format })),
        );
        rendered.push(...out);
      } finally {
        await pool.close();
      }
    }
    const elapsed = (performance.now() - started) / 1000;
    console.log(
      `${String(jobs).padStart(4)}  ${(sampleForPool.length / elapsed).toFixed(2).padStart(8)}  ` +
        `${((elapsed * 1000) / sampleForPool.length).toFixed(1).padStart(7)}`,
    );
  }
}

// --- local pipeline, no network -------------------------------------------
console.log('\n--- local decode + descramble + encode (single core) ---');
const sampleSize = Math.min(24, pages.length);
const sample = [];
for (let i = 0; i < sampleSize; i++) {
  sample.push(await fetchOne(pages[i]));
}
const totalRaw = sample.reduce((a, b) => a + b.bytes, 0);
for (const fmt of ['original', 'jpeg', 'png']) {
  const started = performance.now();
  let outBytes = 0;
  let descrambled = 0;
  for (const s of sample) {
    const tables = volume.tablesFor(s.page);
    const rendered = renderPage(s.buffer, tables, { format: fmt });
    outBytes += rendered.data.length;
    if (rendered.changed) descrambled++;
  }
  const elapsed = (performance.now() - started) / 1000;
  console.log(
    `${fmt.padEnd(9)} ${elapsed.toFixed(2)}s for ${sample.length} pages  ` +
      `${(sample.length / elapsed).toFixed(1)} pages/s  ` +
      `${((totalRaw / 1048576) / elapsed).toFixed(1)} MiB/s in  ` +
      `${((outBytes / 1048576) / elapsed).toFixed(1)} MiB/s out  ` +
      `(${descrambled}/${sample.length} needed descrambling)`,
  );
}

// Extrapolate: total wall time for the whole volume at the best network rate.
if (networkResults.length) {
  const best = networkResults.reduce((a, b) => (b.mbps > a.mbps ? b : a));
  const totalMiB = (networkResults[0].mib / pages.length) * volume.pageCount;
  console.log(
    `\nbest network rate: ${best.mbps.toFixed(1)} MiB/s at concurrency ${best.concurrency}\n` +
      `whole volume (${volume.pageCount} pages, ~${totalMiB.toFixed(0)} MiB): ` +
      `~${(totalMiB / best.mbps).toFixed(0)}s network alone`,
  );
}
