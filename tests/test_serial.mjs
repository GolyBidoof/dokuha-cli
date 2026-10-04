/**
 * The serial queue, and the one engine phase that needs it.
 *
 * `collectPages` in the vendored ebookjapan engine swaps the process-global
 * `fetch` while it loads its WASM glue. Two volumes collected at once poison each
 * other and the loser downloads zero bytes while reporting every page as failed,
 * so the exclusivity is load-bearing rather than a tuning choice. It is tested at
 * both levels: the queue's own ordering, and that the adapter actually routes
 * through it.
 */

import fs from 'node:fs';

import { createPool, createSerialQueue } from '../src/serial.js';
import { check, checkEqual, finish } from './_harness.mjs';

/** Let queued promise callbacks run. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

// Tasks must never overlap, however they are started.
{
    const serialize = createSerialQueue();
    let active = 0;
    let peak = 0;
    const order = [];

    const task = (id, ms) => async () => {
        active++;
        peak = Math.max(peak, active);
        order.push(`start${id}`);
        await new Promise((resolve) => setTimeout(resolve, ms));
        order.push(`end${id}`);
        active--;
        return id;
    };

    // Started in one go, with the first deliberately the slowest: a queue that
    // only happened to work because of timing would still show a peak above 1.
    const results = await Promise.all([
        serialize(task(1, 30)),
        serialize(task(2, 5)),
        serialize(task(3, 1)),
    ]);

    checkEqual('every task runs exactly once, in queue order', order, [
        'start1', 'end1', 'start2', 'end2', 'start3', 'end3',
    ]);
    checkEqual('tasks never overlap', peak, 1);
    checkEqual('results come back to their own caller', results, [1, 2, 3]);
}

// A task that rejects must not wedge the ones behind it.
{
    const serialize = createSerialQueue();
    const ran = [];

    const failed = serialize(async () => { ran.push('a'); throw new Error('boom'); });
    const after = serialize(async () => { ran.push('b'); return 'ok'; });

    let caught = null;
    await failed.catch((error) => { caught = error.message; });

    checkEqual('the rejection reaches its own caller', caught, 'boom');
    checkEqual('the next task still runs', await after, 'ok');
    checkEqual('and it ran after the failure', ran, ['a', 'b']);
}

// Several tasks queued behind a rejected one all still run.
{
    const serialize = createSerialQueue();
    let count = 0;
    const rejected = serialize(async () => { throw new Error('first'); });
    const rest = await Promise.all([1, 2, 3].map(() => serialize(async () => ++count)));
    await rejected.catch(() => {});
    checkEqual('a failure does not drop the queue', rest, [1, 2, 3]);
}

// The queue is per-factory: two queues must not block each other.
{
    const one = createSerialQueue();
    const two = createSerialQueue();
    let active = 0;
    let peak = 0;
    const slow = () => async () => {
        active++;
        peak = Math.max(peak, active);
        await new Promise((resolve) => setTimeout(resolve, 15));
        active--;
    };
    await Promise.all([one(slow()), two(slow())]);
    checkEqual('separate queues are independent', peak, 2);
}

// The adapter must reach the engine's page list only through the queue.
{
    const source = fs.readFileSync(new URL('../src/download/ebookjapan.js', import.meta.url), 'utf8');

    // One direct call is expected -- the helper that wraps it. Any second one is a
    // volume that skipped the queue and can therefore be poisoned by another.
    const direct = [...source.matchAll(/(?<!Serial)\bcollectPages\(/g)];
    checkEqual('collectPages is called directly in exactly one place', direct.length, 1);

    const helper = /function collectPagesSerial\(target[\s\S]*?\n\}/.exec(source);
    check('the one direct call is inside the queueing helper',
        helper !== null && /collectExclusive\(/.test(helper[0]) && /collectPages\(target/.test(helper[0]),
        helper ? helper[0].slice(0, 80) : 'no collectPagesSerial helper');
    check('the adapter builds a serial queue', /createSerialQueue\(\)/.test(source));

    // The draw lists come from module state that `decrypt_session` installed for
    // one specific volume, so recording them has to happen inside the same
    // exclusive section as the collection that installed them.
    check('the tile recording shares the exclusive section',
        helper !== null && /recordShuffle/.test(helper[0]),
        'recording outside the queue would read whichever volume ran most recently');

    // Definition plus both call sites: the initial collection and the refresh pass.
    checkEqual('both collection call sites go through the queue',
        (source.match(/collectPagesSerial\(/g) || []).length, 3);
    // The reason the queue exists is not readable off the code, so it lives in
    // the module. This used to assert against a generated documentation dump,
    // which meant the reason had to be restated somewhere a reader was
    // unlikely to look, and which a regeneration could silently falsify.
    const serial = fs.readFileSync(new URL('../src/serial.js', import.meta.url), 'utf8');
    check('the queue is explained where the queue is',
        /process-global `fetch` shim/.test(serial),
        'createSerialQueue does not say what the shim forces the queue');
}

// ---------------------------------------------------------------------------
// createPool: the bound on the shared, CPU-heavy descrambling step
// ---------------------------------------------------------------------------

{
    let active = 0;
    let peak = 0;
    const pool = createPool(3);
    const order = [];
    const tick = (n) => new Promise((resolve) => setTimeout(() => {
        active++;
        peak = Math.max(peak, active);
        order.push(`start${n}`);
        setTimeout(() => { order.push(`end${n}`); active--; resolve(); }, 5);
    }, 1));

    await Promise.all([1, 2, 3, 4, 5, 6, 7, 8].map((n) => pool(() => tick(n))));
    checkEqual('the pool never exceeds its limit', peak, 3);
    checkEqual('every task still ran', order.filter((o) => o.startsWith('start')).length, 8);
    // A limit of 3 over 8 tasks has to serialise the first three ahead of the
    // fourth, which is what makes this a bound rather than a hint.
    check('tasks past the limit wait for a slot',
        order.indexOf('end1') < order.indexOf('start7'),
        `order was ${order.join(',')}`);
}

// A task that throws has to give its slot back, or the pool wedges after the
// first failure and the rest of the volume is never composed.
{
    let ran = 0;
    const pool = createPool(2);
    const results = await Promise.allSettled([
        pool(() => { throw new Error('boom'); }),
        pool(async () => { await new Promise((r) => setTimeout(r, 2)); ran++; }),
        pool(() => { ran++; return 'ok'; }),
        pool(() => { ran++; return 'ok'; }),
    ]);
    checkEqual('a throwing task rejects only itself', results[0].status, 'rejected');
    checkEqual('later tasks still run after a throw', ran, 3);
}

// A limit below one must not deadlock, since the caller derives it from the core
// count and a single-core machine is a real case.
{
    const pool = createPool(0);
    checkEqual('a limit below one still runs the task', await pool(() => 'ok'), 'ok');
}

// The descrambler must go through the pool rather than calling sharp directly,
// because that is the only thing keeping a five-volume batch from holding
// hundreds of raw page buffers at once.
{
    const descramble = fs.readFileSync(new URL('../src/download/ebj-descramble.js', import.meta.url), 'utf8');
    check('the descrambler bounds its work with the shared pool',
        /createPool\(/.test(descramble), 'the compose step is unbounded');
    checkEqual('both the decode and the encode go through the pool',
        (descramble.match(/composePool\(\)\(/g) || []).length, 2);
    check('the pool size is capped rather than taken from the core count alone',
        /Math\.min\(8, cores\)/.test(descramble), 'the cap of 8 is missing');
}

finish();
