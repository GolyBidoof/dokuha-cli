/**
 * One CPU budget, shared by every store that re-encodes pages.
 *
 * Four of the five stores do per-page CPU work: CMOA renders through a worker
 * pool, BookWalker seam-carves, ebookjapan and k-manga descramble. Each of them
 * used to size itself independently, which meant they did not size themselves
 * against each other -- CMOA could take `cores` threads and BookWalker could take
 * `cores` workers in the same run, and ebookjapan ran thirty-two page workers each
 * calling into `sharp` with nothing bounding them at all.
 *
 * The unit of admission here is a *thread*, not a lane. A store asks for a share
 * of the machine and gets a number of workers; `cpuLane`/`netLane` in `run.js`
 * remains the thing that decides *when* a volume starts, which is a scheduling
 * question rather than a resource one.
 *
 * This is deliberately a plain allocation function rather than a live pool. Making
 * it live means a store must be able to shrink while it runs, and the only store
 * whose engine can do that is CMOA's; the others take a worker count once and keep
 * it. The allocation is therefore recomputed every time a volume starts, so a
 * volume that begins after another has finished sees the freed capacity.
 */

/** How much of the machine a store wants when it is the only one running. */
export const STORE_WEIGHTS = {
    cmoa: 1,
    bookwalker: 0.8,
    ebookjapan: 0.6,
    kmanga: 0.6,
    kindle: 0.3,
};

/**
 * How many worker threads each CPU-heavy store may run right now.
 *
 * Two stores take a share: CMOA's render pool, which is ordinary JavaScript
 * workers and responds to admission control, and BookWalker's seam-carving pool,
 * which is the same. ebookjapan and k-manga are given no worker count here. Their
 * descrambling is `sharp`, and libvips already threads internally; capping the
 * callers was measured at 37.0 s against 28.5 s over three runs each, a 30 % loss,
 * because an outer queue only adds latency to work that was already saturating the
 * machine. See docs/phase-timing.md for the numbers.
 *
 * They are not absent from the *denominator*, though. STORE_WEIGHTS still carries
 * ebookjapan and k-manga at 0.6 and kindle at 0.3, so a store named in `active`
 * counts towards `totalWeight` whether or not it is handed a thread back: naming
 * one of them would shrink CMOA's and BookWalker's share without giving that store
 * anything. What prevents it is the caller, not this module. `run.js` builds
 * `active` from the platforms that declare a `workerKey`, and only cmoa and
 * bookwalker do, so ebookjapan, k-manga and Kindle never reach it.
 *
 * @param {object} options
 * @param {number} options.cores  usable cores, from `defaultJobCount()`
 * @param {Record<string, number>} options.active  how many volumes of each store
 *   the caller is accounting for. `run.js` passes every task it has discovered,
 *   finished ones included, so a store holds its share for the rest of the run.
 *   A store with no volumes must report zero, not a floor of one: a floor would
 *   admit it to `running` and dilute everyone else.
 * @param {number} options.renderJobs  an explicit `--jobs`, which overrides the
 *   CMOA share rather than being divided by it
 * @returns {{renderJobs: number, normalizeWorkers: number}}
 */
export function allocateCpu({ cores, active = {}, renderJobs = null }) {
    const budget = Math.max(1, Math.floor(cores));

    // Only stores the caller reports at all take a share, so a CMOA-only run gets the
    // whole machine instead of reserving capacity for stores that never start.
    const running = Object.entries(active)
        .filter(([store, count]) => count > 0 && STORE_WEIGHTS[store])
        .map(([store, count]) => ({ store, count, weight: STORE_WEIGHTS[store] }));

    if (!running.length) {
        return { renderJobs: renderJobs ?? budget, normalizeWorkers: Math.max(1, budget) };
    }

    const totalWeight = running.reduce((sum, entry) => sum + entry.weight * entry.count, 0);
    const share = (store) => {
        const entry = running.find((r) => r.store === store);
        if (!entry) return 0;
        const fraction = (entry.weight * entry.count) / totalWeight;
        // Each volume of a store splits that store's share, so two CMOA volumes
        // get half each rather than each taking the full share.
        return Math.max(1, Math.floor((budget * fraction) / entry.count));
    };

    const cmoaVolumes = running.find((r) => r.store === 'cmoa')?.count ?? 0;
    const bookwalkerVolumes = running.find((r) => r.store === 'bookwalker')?.count ?? 0;

    // CMOA's own pool is the one engine that takes a thread count directly, and a
    // single pool serves the whole volume, so the share is per volume.
    const cmoaShare = cmoaVolumes ? share('cmoa') : 0;

    return {
        renderJobs: renderJobs ?? (cmoaVolumes ? cmoaShare : Math.max(1, Math.floor(budget / 2))),
        normalizeWorkers: bookwalkerVolumes ? share('bookwalker') : 0,
    };
}
