/**
 * Phase timing: the four phases a volume reports, and the arithmetic that keeps
 * them sound while pages are in flight.
 *
 * The clock is injected so the numbers in these checks are exact rather than
 * "roughly", which matters because the whole point of the feature is that a
 * benchmark can be read off a normal run.
 */

import { PHASES, createPhaseTimer, readPhases, timed } from '../src/phase-timer.js';
import { checkEqual, finish } from './_harness.mjs';

/** A clock that only moves when the test moves it. */
function fakeClock() {
    let now = 0;
    return {
        now: () => now,
        advance: (ms) => { now += ms; },
    };
}

checkEqual('the five phases are the documented contract', PHASES,
    ['handshake', 'prework', 'fetch', 'rebuild', 'write']);

// `prework` is preparation rather than a store round trip, and the adapters that
// cannot separate it from their handshake must simply report nothing for it rather
// than guessing.
{
    const clock = fakeClock();
    const timer = createPhaseTimer(clock.now);
    await timer.in('handshake', async () => { clock.advance(10); });
    await timer.in('prework', async () => { clock.advance(200); });
    checkEqual('prework is its own phase, not folded into handshake',
        timer.read(), { handshake: 10, prework: 200 });
}

{
    const clock = fakeClock();
    const timer = createPhaseTimer(clock.now);

    clock.advance(120);
    await timer.in('handshake', async () => { clock.advance(30); });
    checkEqual('only the section is attributed, not the time before it',
        timer.read(), { handshake: 30 });

    const stop = timer.start();
    clock.advance(7);
    timer.record('fetch', stop());
    checkEqual('a hand-timed step accumulates', timer.read(), { handshake: 30, fetch: 7 });

    clock.advance(1000);
    checkEqual('time between phases belongs to nobody', timer.read(), { handshake: 30, fetch: 7 });
}

{
    // The property that makes this an accumulator rather than a cursor: every
    // store times work inside concurrent page workers, so two sections can be in
    // flight at once. A shared "current phase" would hand one of them the other's
    // time; a scripted clock makes the overlap exact.
    const values = [0, 10, 30, 25];
    let i = 0;
    const timer = createPhaseTimer(() => values[i++]);

    const first = timer.start();
    const second = timer.start();
    timer.record('fetch', first());
    timer.record('rebuild', second());

    checkEqual('overlapping sections do not steal each other\'s time',
        timer.read(), { fetch: 30, rebuild: 15 });
}

{
    const timer = createPhaseTimer(fakeClock().now);
    timer.record('handshake', 5);
    timer.record('nonsense', 5);
    timer.record('fetch', 0);
    timer.record('fetch', -3);
    checkEqual('a misspelled phase is quarantined rather than silently dropped',
        timer.read(), { handshake: 5, other: 5 });
}

{
    const clock = fakeClock();
    const timer = createPhaseTimer(clock.now);
    await timer.in('fetch', async () => {
        clock.advance(9);
        throw new Error('boom');
    }).catch(() => {});
    checkEqual('a failed section is still timed', timer.read(), { fetch: 9 });
}

{
    checkEqual('a run with no timer reports nothing', readPhases(null), null);
    checkEqual('a timer that saw no work reports nothing',
        readPhases(createPhaseTimer(fakeClock().now)), null);
    checkEqual('an adapter with no timer still runs its work',
        await timed(null, 'fetch', async () => 'done'), 'done');
}

finish();
