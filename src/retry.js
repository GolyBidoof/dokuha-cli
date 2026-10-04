/**
 * One retry policy, and one way to describe why a request failed.
 *
 * Before this, every place that retried invented its own rules. Kindle retried
 * page fetches six times and control-plane calls not at all; ebookjapan retried
 * four times inside its vendored engine and again in a refresh pass; BookWalker
 * had an internal loop; CMOA forwarded a budget into the engine; k-manga counted
 * reconnects separately. The budgets still differ -- they are tuned per store -- but
 * the mechanics and the diagnostics no longer do.
 *
 * The vendored engines keep their own loops. They are third-party code driven as
 * a unit, and reaching into them to replace a retry would be a larger deviation
 * than the problem justifies; `vendor/README.md` records what they do.
 */

/** Statuses worth trying again: the request was rejected, not refused. */
export const RETRY_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

/** Statuses that mean the credentials or the licence are wrong, not the network. */
export const RESTRICTED_STATUS = new Set([401, 403]);

/**
 * Exponential backoff with full-ish jitter.
 *
 * The jitter matters more than the base: a batch that fails together would
 * otherwise retry together, and the store would see the same spike twice.
 */
export function createBackoff({ base = 400, cap = 8000, jitter = 0.5 } = {}) {
    return (attempt) => {
        const ceiling = Math.min(cap, base * (2 ** attempt));
        const floor = ceiling * (1 - jitter);
        return new Promise((resolve) => {
            setTimeout(resolve, floor + Math.random() * (ceiling - floor));
        });
    };
}

export const defaultBackoff = createBackoff();

/**
 * Why a request failed, in the terms the store would describe it.
 *
 * `fetch` rejects with a bare `TypeError: fetch failed` and hides the useful part
 * in `error.cause` -- `ECONNRESET`, `ENOTFOUND`, or a timeout. Reporting only the
 * outer message is how a year of connection resets was diagnosed as "fetch
 * failed" in this project's own logs.
 */
export function describeError(error) {
    if (!error) return 'unknown error';
    const cause = error.cause;
    if (cause?.code) return String(cause.code);
    if (cause?.message) return String(cause.message);
    if (error.name && error.name !== 'Error') return String(error.name);
    return String(error.message || 'fetch failed');
}

/** A timeout, however it was spelled: AbortSignal, undici, or a raw ETIMEDOUT. */
export function isTimeout(error) {
    if (!error) return false;
    if (error.name === 'TimeoutError' || error.name === 'AbortError') return true;
    if (error.code === 'ETIMEDOUT' || error.code === 'UND_ERR_CONNECT_TIMEOUT') return true;
    return Boolean(error.cause && isTimeout(error.cause));
}

/** True when a thrown value looks like a transport failure rather than a bug. */
export function isTransportError(error) {
    if (!error) return false;
    if (isTimeout(error)) return true;
    const code = error.cause?.code || error.code;
    return typeof code === 'string' && /^(ECONN|ENOTFOUND|EAI_|ETIMEDOUT|EPIPE|UND_ERR)/.test(code);
}

/**
 * Run `fn` until it resolves, or until the attempts run out.
 *
 * `fn` receives the attempt number, so a caller can widen its own timeout as the
 * attempts accumulate -- which is the difference between retrying a request that
 * was merely queued behind a throttled CDN and retrying it into the same wall.
 */
export async function retry(fn, {
    attempts = 3,
    wait = defaultBackoff,
    isRetryable = () => true,
    onRetry = null,
} = {}) {
    const limit = Math.max(1, attempts);
    let last = null;

    for (let attempt = 0; attempt < limit; attempt += 1) {
        try {
            return await fn(attempt);
        } catch (error) {
            last = error;
            if (attempt + 1 >= limit || !isRetryable(error, attempt)) break;
            if (onRetry) onRetry(error, attempt);
            await wait(attempt);
        }
    }
    throw last;
}
