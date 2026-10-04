/** The one result shape every store produces. `sample` used to be reported by only
 * some of them (CMOA, ebookjapan and k-manga all have samplers; only Kindle filled the
 * field), so anything reading `--json` across stores had to feature-test per store.
 */

/** Always present on every result. Nothing outside this list is guaranteed. */
export const RESULT_CORE = [
    'store', 'id', 'title', 'folder', 'sample',
    'totalPages', 'downloaded', 'skipped', 'failed', 'bytes', 'failures',
];

const count = (value) => {
    const n = Number(value);
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
};

export function normalizeStoreResult(record, task = {}) {
    if (!record || typeof record !== 'object') {
        throw new Error(`${task.kind || 'adapter'} returned no result record for ${task.target || '?'}`);
    }

    const fallbackId = task.target ?? task.cid ?? task.asin ?? null;
    const fallbackTitle = task.title || task.name || fallbackId || '';

    return {
        ...record,

        store: String(record.store || task.kind || 'unknown'),
        id: record.id == null ? fallbackId : String(record.id),
        title: record.title || fallbackTitle,
        folder: record.folder || null,

        // A sampler is a property of the request, not of a store: any adapter that
        // did not say gets the answer the task already carries.
        sample: record.sample === true || task.sample === true,

        totalPages: count(record.totalPages),
        downloaded: count(record.downloaded),
        skipped: count(record.skipped),
        failed: count(record.failed),
        bytes: count(record.bytes),
        failures: Array.isArray(record.failures) ? record.failures : [],
    };
}
