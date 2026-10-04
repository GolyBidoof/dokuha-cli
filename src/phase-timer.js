/**
 * The phases every adapter may report, in the order they happen.
 *
 * `handshake` is opening the session: licence, login, token, ticket.
 * `prework` is getting ready to fetch pages: the manifest, the page list, the
 *   render-window walk, loading the descrambler's WASM module, building the
 *   per-page shuffle table. It is store preparation, not a store round trip.
 * `fetch` is page bytes off the CDN.
 * `rebuild` is turning those bytes into a page: descrambling, seam-carving, JPEG.
 * `write` is putting a page on disk.
 *
 * `handshake` is serial, so it is wall time. The rest are summed across concurrent
 * page workers and are therefore aggregates, not a partition of the run -- see
 * docs/phase-timing.md.
 */
export const PHASES = ['handshake', 'prework', 'fetch', 'rebuild', 'write'];

const OTHER = 'other';

export function createPhaseTimer(now = () => performance.now()) {
    const totals = new Map();

    const add = (name, ms) => {
        if (!(ms > 0)) return;
        const key = PHASES.includes(name) ? name : OTHER;
        totals.set(key, (totals.get(key) || 0) + ms);
    };

    const start = () => {
        const from = now();
        return () => now() - from;
    };

    const timer = {
        add,
        start,
        async in(name, fn) {
            const stop = start();
            try {
                return await fn();
            } finally {
                add(name, stop());
            }
        },
        record(name, ms) {
            add(name, ms);
        },
        read() {
            const out = {};
            for (const name of [...PHASES, OTHER]) {
                const ms = totals.get(name);
                if (ms) out[name] = Math.round(ms);
            }
            return out;
        },
    };
    return timer;
}

export function timed(timer, name, fn) {
    return timer ? timer.in(name, fn) : fn();
}

export function readPhases(timer) {
    if (!timer || typeof timer.read !== 'function') return null;
    const phases = timer.read();
    return Object.keys(phases).length ? phases : null;
}
