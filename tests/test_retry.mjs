/**
 * The shared retry policy.
 *
 * The mechanics here were duplicated in several places before this existed, each
 * with its own idea of what to retry and what to call the failure. The checks
 * below pin the parts that were repeatedly got wrong: that a non-retryable error
 * stops immediately, that the transport cause survives, and that backoff is
 * actually jittered rather than a fixed sleep the store can count on.
 */

import { RETRY_STATUS, createBackoff, describeError, isTimeout, isTransportError, retry } from '../src/retry.js';
import { check, checkEqual, finish } from './_harness.mjs';

const noWait = async () => {};

// ---------------------------------------------------------------------------
// retry: when to stop
// ---------------------------------------------------------------------------

{
    let calls = 0;
    const result = await retry(async () => {
        calls += 1;
        if (calls < 3) throw new Error('flaky');
        return 'ok';
    }, { attempts: 5, wait: noWait });
    checkEqual('it keeps trying until the work succeeds', result, 'ok');
    checkEqual('and it stops as soon as it does', calls, 3);
}

{
    let calls = 0;
    const failure = await retry(async () => {
        calls += 1;
        throw new Error('always');
    }, { attempts: 4, wait: noWait }).then(() => null, (e) => e);
    checkEqual('it gives up after the budget', calls, 4);
    checkEqual('and rethrows the last error untouched', failure.message, 'always');
}

{
    // A 401 will not become a 200 by asking again, so the policy has to allow the
    // caller to say so; Kindle relies on this to fail fast on expired cookies.
    let calls = 0;
    const failure = await retry(async () => {
        calls += 1;
        const error = new Error('unauthorised');
        error.status = 401;
        throw error;
    }, {
        attempts: 5,
        wait: noWait,
        isRetryable: (error) => !(error.status === 401 || error.status === 403),
    }).then(() => null, (e) => e);
    checkEqual('a non-retryable error is not retried', calls, 1);
    checkEqual('and it is still reported', failure.message, 'unauthorised');
}

{
    let attemptsSeen = [];
    await retry(async (attempt) => {
        attemptsSeen.push(attempt);
        throw new Error('x');
    }, { attempts: 3, wait: noWait }).catch(() => {});
    checkEqual('the attempt number is passed through, so a timeout can widen',
        attemptsSeen, [0, 1, 2]);
}

{
    let retries = 0;
    await retry(async () => { throw new Error('x'); }, {
        attempts: 3, wait: noWait, onRetry: () => { retries += 1; },
    }).catch(() => {});
    checkEqual('onRetry fires once per retry, not once per attempt', retries, 2);
}

{
    checkEqual('one attempt means one call', await retry(async () => 'once', { attempts: 1 }), 'once');
    checkEqual('zero attempts is treated as one, not as "never run"',
        await retry(async () => 'ran', { attempts: 0 }), 'ran');
}

// ---------------------------------------------------------------------------
// backoff: jittered, bounded, growing
// ---------------------------------------------------------------------------

{
    const waits = [];
    const backoff = createBackoff({ base: 100, cap: 800 });
    const realSetTimeout = globalThis.setTimeout;
    globalThis.setTimeout = (fn) => { fn(); return 0; };

    const started = [];
    for (let attempt = 0; attempt < 5; attempt += 1) {
        const before = Date.now();
        await backoff(attempt);
        started.push(attempt);
    }
    globalThis.setTimeout = realSetTimeout;
    checkEqual('backoff resolves for every attempt', started, [0, 1, 2, 3, 4]);
}

{
    // With jitter off the wait *is* the ceiling, so the doubling and the cap can be
    // asserted exactly. Asserting growth on jittered samples is a mistake: full
    // jitter draws uniformly below the ceiling, so a later wait is legitimately
    // allowed to come out shorter than an earlier one.
    const ceilings = [];
    const realSetTimeout = globalThis.setTimeout;
    globalThis.setTimeout = (fn, ms) => { ceilings.push(ms); fn(); return 0; };

    const exact = createBackoff({ base: 100, cap: 400, jitter: 0 });
    for (let attempt = 0; attempt < 6; attempt += 1) await exact(attempt);

    const jittered = createBackoff({ base: 100, cap: 400, jitter: 1 });
    const draws = [];
    globalThis.setTimeout = (fn, ms) => { draws.push(ms); fn(); return 0; };
    for (let attempt = 0; attempt < 8; attempt += 1) await jittered(attempt);
    globalThis.setTimeout = realSetTimeout;

    checkEqual('the first ceiling is the base', ceilings[0], 100);
    check('the ceiling doubles', ceilings[2] === 400, JSON.stringify(ceilings));
    check('the ceiling is capped', ceilings.every((ms) => ms <= 400), JSON.stringify(ceilings));
    checkEqual('the cap holds for every later attempt', new Set(ceilings.slice(2)).size, 1);

    check('a jittered wait never exceeds its ceiling',
        draws.every((ms) => ms >= 0 && ms <= 400), JSON.stringify(draws));
    check('it is jittered, not a fixed sleep', new Set(draws).size > 1, JSON.stringify(draws));
}

// ---------------------------------------------------------------------------
// describing a failure
// ---------------------------------------------------------------------------

{
    const undici = Object.assign(new TypeError('fetch failed'), {
        cause: Object.assign(new Error('other side closed'), { code: 'ECONNRESET' }),
    });
    checkEqual('the transport code is preferred over "fetch failed"',
        describeError(undici), 'ECONNRESET');

    checkEqual('a cause without a code falls back to its message',
        describeError(Object.assign(new Error('fetch failed'), { cause: new Error('socket hang up') })),
        'socket hang up');
    checkEqual('an abort is named as one',
        describeError(Object.assign(new Error('x'), { name: 'TimeoutError' })), 'TimeoutError');
    checkEqual('a plain error keeps its message', describeError(new Error('boom')), 'boom');
    checkEqual('nothing at all still reads as something', describeError(null), 'unknown error');
}

{
    check('a TimeoutError is a timeout', isTimeout(Object.assign(new Error('x'), { name: 'TimeoutError' })));
    check('an AbortError is a timeout', isTimeout(Object.assign(new Error('x'), { name: 'AbortError' })));
    check('a wrapped ETIMEDOUT is a timeout',
        isTimeout(Object.assign(new Error('fetch failed'), { cause: Object.assign(new Error('y'), { code: 'ETIMEDOUT' }) })));
    check('a 404 is not', !isTimeout(new Error('HTTP 404')));

    check('a connection reset is a transport error',
        isTransportError(Object.assign(new Error('fetch failed'), { cause: Object.assign(new Error('y'), { code: 'ECONNRESET' }) })));
    check('a DNS failure is a transport error',
        isTransportError(Object.assign(new Error('fetch failed'), { cause: Object.assign(new Error('y'), { code: 'ENOTFOUND' }) })));
    check('a bug is not a transport error', !isTransportError(new Error('undefined is not a function')));
}

check('the retryable statuses are the transient ones',
    [429, 500, 502, 503, 504].every((s) => RETRY_STATUS.has(s)) && !RETRY_STATUS.has(404));

finish();
