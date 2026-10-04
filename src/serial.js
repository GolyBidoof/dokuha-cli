
/**
 * ebookjapan's page viewer installs a process-global `fetch` shim to reach the
 * CDN. Two volumes collecting pages at once would interleave their swap and
 * restore, and read each other's pages. Queueing is far cheaper than making that
 * shim re-entrant, and a collection is short enough that the queue is rarely
 * contended.
 */
export function createSerialQueue() {
    let tail = Promise.resolve();

    return function serialize(task) {
        const run = tail.then(task);

        tail = run.then(() => {}, () => {});
        return run;
    };
}

export function createPool(limit) {
    const size = Math.max(1, Math.floor(limit) || 1);
    const waiting = [];
    let active = 0;

    const release = () => {
        active--;
        const next = waiting.shift();
        if (next) next();
    };

    return function run(task) {
        return new Promise((resolve, reject) => {
            const start = () => {
                active++;

                Promise.resolve().then(task).then(resolve, reject).finally(release);
            };
            if (active < size) start();
            else waiting.push(start);
        });
    };
}
