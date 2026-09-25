/**
 * Worker-thread render pool.
 *
 * Decoding a JPEG, copying tiles and re-encoding is CPU-bound: around 100-200 ms
 * per 1350x1920 page, which dominates the whole download once the CDN is warm
 * (the CDN sustains ~66 MiB/s, so network time is a small fraction). Node's main
 * thread also has to run the fetch loop, so leaving rendering there means
 * `--concurrency` buys almost nothing past a handful of pages.
 *
 * This moves `renderPage` onto `jobs` worker threads. Workers are created once
 * and reused, each holding one in-flight task so memory stays bounded, and the
 * result is handed back as a transferable ArrayBuffer (zero-copy).
 */

import { Worker } from 'node:worker_threads';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const WORKER_URL = new URL('./render-worker.js', import.meta.url);

/** Default worker count: every core but one, leaving the main thread free. */
export function defaultJobCount() {
  const cores = os.availableParallelism?.() ?? os.cpus().length ?? 2;
  return Math.max(1, cores - 1);
}

class WorkerSlot {
  constructor(index, onFree) {
    this.index = index;
    this.onFree = onFree;
    this.job = null;
    this.worker = new Worker(fileURLToPath(WORKER_URL));
    this.worker.unref();
    this.worker.on('message', (message) => this.settle(null, message));
    this.worker.on('error', (error) => this.settle(error, null));
  }

  settle(error, message) {
    const job = this.job;
    this.job = null;
    if (job) {
      if (error) job.reject(error);
      else if (message?.error) job.reject(new Error(message.error));
      else job.resolve(message.result);
    }
    this.onFree(this);
  }

  get busy() {
    return this.job !== null;
  }

  submit(job) {
    this.job = job;
    // `Uint8Array.from` copies: workers cannot read the main thread's memory, and
    // transferring would detach a buffer the caller may still want for a retry.
    this.worker.postMessage({
      bytes: Uint8Array.from(job.bytes),
      coordTable: job.coordTable,
      pieceTable: job.pieceTable,
      format: job.format,
      quality: job.quality,
      subsample: job.subsample,
    });
  }

  async close() {
    await this.worker.terminate();
  }
}

/**
 * A pool of render workers.
 *
 * `render(bytes, tables, options)` resolves to the same shape `renderPage`
 * returns, except `data` is a Buffer wrapping a transferred ArrayBuffer.
 */
export class RenderPool {
  constructor(size = defaultJobCount()) {
    this.size = Math.max(1, size);
    this.slots = [];
    this.queue = [];
  }

  /** Workers start lazily, so a run that needs no rendering pays nothing. */
  ensureStarted() {
    if (this.slots.length) return;
    for (let i = 0; i < this.size; i++) {
      this.slots.push(new WorkerSlot(i, (slot) => this.dispatch(slot)));
    }
  }

  render(bytes, tables, options = {}) {
    this.ensureStarted();
    const job = {
      bytes,
      coordTable: tables.coordTable,
      pieceTable: tables.pieceTable,
      format: options.format ?? 'jpeg',
      quality: options.quality,
      subsample: options.subsample,
      resolve: null,
      reject: null,
    };
    return new Promise((resolve, reject) => {
      job.resolve = resolve;
      job.reject = reject;
      this.queue.push(job);
      this.dispatch();
    });
  }

  /** Give queued jobs to idle workers. Called on submit and on every completion. */
  dispatch(slot = null) {
    if (slot) {
      if (!this.queue.length) return;
      slot.submit(this.queue.shift());
      return;
    }
    for (const s of this.slots) {
      if (!this.queue.length) return;
      if (!s.busy) s.submit(this.queue.shift());
    }
  }

  async close() {
    const pending = this.queue;
    this.queue = [];
    for (const job of pending) job.reject(new Error('render pool closed'));
    await Promise.all(this.slots.map((slot) => slot.close()));
    this.slots = [];
  }

  get pending() {
    return this.queue.length + this.slots.filter((slot) => slot.busy).length;
  }
}
