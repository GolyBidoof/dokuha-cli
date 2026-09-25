/**
 * A pool of BookWalker page-normaliser workers.
 *
 * Same shape and reasoning as `vendor/cmoa/src/render_pool.js`: workers are
 * created once and reused, each holds one in-flight page so memory stays
 * bounded, and the result comes back as a transferred ArrayBuffer. The point is
 * the same too — the per-page CPU work must not sit on the event loop that also
 * drives the fetches, or `--bw-concurrency` above a handful buys nothing.
 *
 * Workers start lazily: a plaintext manifest needs no descrambling at all, so a
 * run that never calls `normalize` never spawns a thread.
 */

import { Worker } from 'node:worker_threads';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const WORKER_URL = new URL('../workers/bw-normalize-worker.js', import.meta.url);

/** Every core but one, leaving the main thread to run the fetch loop. */
export function defaultNormalizeWorkers() {
    const cores = os.availableParallelism?.() ?? os.cpus().length ?? 2;
    return Math.max(1, cores - 1);
}

class WorkerSlot {
    constructor(onFree) {
        this.onFree = onFree;
        this.job = null;
        this.nextId = 1;
        this.worker = new Worker(fileURLToPath(WORKER_URL));
        // An unref'd worker still keeps the pool warm but never holds the
        // process open on its own, so a forgotten close() cannot hang a run.
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
            else job.resolve(Buffer.from(message.data));
        }
        this.onFree(this);
    }

    get busy() {
        return this.job !== null;
    }

    submit(job) {
        this.job = job;
        // `Uint8Array.from` copies into a fresh, exact-length, zero-offset
        // buffer; the source bytes stay intact for a retry.
        this.worker.postMessage({
            id: this.nextId++,
            bytes: Uint8Array.from(job.bytes),
            seeds: job.seeds,
        });
    }

    async close() {
        await this.worker.terminate();
    }
}

export class BwNormalizePool {
    constructor(size = defaultNormalizeWorkers()) {
        this.size = Math.max(1, size);
        this.slots = [];
        this.queue = [];
    }

    /** Workers start on the first page that actually needs one. */
    ensureStarted() {
        if (this.slots.length) return;
        for (let i = 0; i < this.size; i++) {
            this.slots.push(new WorkerSlot(() => this.dispatch()));
        }
    }

    /**
     * Decode, un-permute and re-encode one encrypted page.
     *
     * @param {Buffer|Uint8Array} bytes the CDN's scrambled JPEG
     * @param {object} seeds per-page permutation seeds from `bw-crypto.pageSeeds`
     * @returns {Promise<Buffer>} the normalised JPEG
     */
    normalize(bytes, seeds) {
        this.ensureStarted();
        const job = { bytes, seeds, resolve: null, reject: null };
        return new Promise((resolve, reject) => {
            job.resolve = resolve;
            job.reject = reject;
            this.queue.push(job);
            this.dispatch();
        });
    }

    /** Hand queued jobs to idle workers. Called on submit and on every completion. */
    dispatch() {
        for (const slot of this.slots) {
            if (!this.queue.length) return;
            if (!slot.busy) slot.submit(this.queue.shift());
        }
    }

    async close() {
        const pending = this.queue;
        this.queue = [];
        for (const job of pending) job.reject(new Error('normalize pool closed'));
        await Promise.all(this.slots.map((slot) => slot.close()));
        this.slots = [];
    }

    get pending() {
        return this.queue.length + this.slots.filter((slot) => slot.busy).length;
    }
}
