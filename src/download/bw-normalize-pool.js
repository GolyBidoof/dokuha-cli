import { Worker } from 'node:worker_threads';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const WORKER_URL = new URL('../workers/bw-normalize-worker.js', import.meta.url);

export function defaultNormalizeWorkers() {
    const cores = os.availableParallelism?.() ?? os.cpus().length ?? 2;
    return Math.max(1, cores - 1);
}

class WorkerSlot {
    constructor(onFree) {
        this.onFree = onFree;
        this.job = null;
        this.nextId = 1;
        this.dead = false;
        this.worker = new Worker(fileURLToPath(WORKER_URL));

        this.worker.unref();
        this.worker.on('message', (message) => this.settle(null, message));
        this.worker.on('error', (error) => this.settle(error, null));
        this.worker.on('exit', (code) => {
            if (this.job) this.settle(new Error(`normalize worker exited with code ${code}`), null);
        });
    }

    settle(error, message) {
        if (this.dead && !this.job) return;
        const job = this.job;
        this.job = null;
        if (job) {
            if (error) job.reject(error);
            else if (message?.error) job.reject(new Error(message.error));
            else job.resolve(Buffer.from(message.data));
        }
        if (error) this.retire();
        else this.onFree(this);
    }

    get busy() {
        return this.job !== null;
    }

    submit(job) {
        this.job = job;
        this.worker.postMessage({
            id: this.nextId++,
            bytes: Uint8Array.from(job.bytes),
            seeds: job.seeds,
        });
    }

    retire() {
        if (this.dead) return;
        this.dead = true;
        this.onFree(this);
    }

    async close() {
        this.dead = true;
        await this.worker.terminate();
    }
}

export class BwNormalizePool {
    constructor(size = defaultNormalizeWorkers()) {
        this.size = Math.max(1, size);
        this.slots = [];
        this.queue = [];
    }

    ensureStarted() {
        while (this.slots.length < this.size) {
            const slot = new WorkerSlot(() => this.onSlotFree(slot));
            this.slots.push(slot);
        }
    }

    onSlotFree(slot) {
        if (slot.dead) this.slots = this.slots.filter((entry) => entry !== slot);
        this.dispatch();
    }

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

    dispatch() {
        for (const slot of this.slots) {
            if (!this.queue.length) return;
            if (!slot.busy && !slot.dead) slot.submit(this.queue.shift());
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
