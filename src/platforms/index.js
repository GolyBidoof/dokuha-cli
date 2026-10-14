/**
 * The platform registry.
 *
 * Every store is one descriptor here: what URLs it answers to, what a progress
 * row calls it, which scheduling lane it runs on, how a title URL expands into
 * volumes, and how one volume is fetched. Adding a store means adding a
 * descriptor, not teaching the driver a new branch.
 *
 * `PLATFORMS` is ordered, and the order is the detection order: the first
 * platform whose patterns match an input owns it.
 */

import { platform as bookwalker } from '../download/bookwalker.js';
import { platform as cmoa } from '../download/cmoa.js';
import { platform as ebookjapan } from '../download/ebookjapan.js';
import { platform as kindle } from '../download/kindle.js';
import { platform as kmanga } from '../download/kmanga.js';
import { USER_AGENT } from '../user-agent.js';

export { USER_AGENT };
import { reject } from '../series.js';

export const PLATFORMS = [kindle, cmoa, ebookjapan, bookwalker, kmanga];

const BY_KIND = new Map();
for (const entry of PLATFORMS) {
    // A series walk publishes tasks under the store id (`kmanga`), while a pasted
    // URL is detected under a pattern kind (`kmanga-volume`). Both have to resolve
    // to the adapter, or the store is reachable by URL and not by series.
    BY_KIND.set(entry.id, entry);
    for (const pattern of entry.patterns) {
        if (pattern.kind !== 'unknown') BY_KIND.set(pattern.kind, entry);
    }
}

export const STORE_LABELS = Object.fromEntries(PLATFORMS.map((entry) => [entry.id, entry.label]));

export const KINDLE_UNLIMITED_LABEL = 'KDUL';

const SERIES_PAGE_KINDS = new Set(
    PLATFORMS.flatMap((entry) => entry.patterns.filter((p) => p.kind.endsWith('-title')
        || p.kind.endsWith('-series')).map((p) => p.kind)),
);

export function platformFor(kind) {
    return BY_KIND.get(kind) || null;
}

/**
 * The cross-cutting tuning a store may declare on its descriptor.
 *
 * `tuning` is optional, and a store that declares none gets no per-store flag
 * and no share of the CPU budget: that is the sensible default for a store with
 * nothing to tune. The shape the consumers read is:
 *
 *   tuning: {
 *       concurrency,   // per-store page concurrency default
 *       contextKey,    // the ctx field the adapter reads that value from
 *       cpuWeight,     // share of the shared CPU budget
 *       cpuSlot,       // which allocateCpu output its worker count fills
 *       flag: { name, help, hint, order, max },
 *   }
 *
 * The consumers live in `options.js` (the flag and its default), `run.js` (the
 * context field the adapter reads) and `cpu-budget.js` (the weight and the
 * slot). None of them names a store, so a store is one descriptor.
 */

export function tunedPlatforms(platforms = PLATFORMS) {
    return platforms.filter((entry) => entry.tuning && typeof entry.tuning === 'object');
}

function concurrencyFlag(entry) {
    return entry.tuning?.flag?.name ?? null;
}

/** The config field a store's flag parses into, for example `cmConcurrency`. */
export function concurrencyKey(entry) {
    const name = concurrencyFlag(entry);
    return name ? name.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase()) : null;
}

export function concurrencyPlatforms(platforms = PLATFORMS) {
    return tunedPlatforms(platforms)
        .filter((entry) => entry.tuning.concurrency != null && concurrencyFlag(entry));
}

export function concurrencyDefaults(platforms = PLATFORMS) {
    return Object.fromEntries(concurrencyPlatforms(platforms)
        .map((entry) => [concurrencyKey(entry), entry.tuning.concurrency]));
}

/** The store context fields that carry each store's resolved concurrency. */
export function concurrencyContext(config, platforms = PLATFORMS) {
    const out = {};
    for (const entry of concurrencyPlatforms(platforms)) {
        const key = entry.tuning.contextKey;
        const value = config[concurrencyKey(entry)];
        if (key && value != null) out[key] = value;
    }
    return out;
}

function urlHost(raw) {
    try {
        const url = new URL(raw);
        if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
        return url.hostname.toLowerCase();
    } catch {
        return null;
    }
}

function ownsHost(entry, host) {
    return entry.hosts.some((own) => host === own || host.endsWith(`.${own}`));
}

export function detectSource(input) {
    const raw = String(input ?? '').trim();
    if (!raw) return { kind: 'unknown', reason: 'empty input', url: raw };

    // An absolute URL is owned by one store, decided by its host. Testing every
    // store's unanchored pattern against it lets a link to store B inside store
    // A's query string hand the URL to B's adapter.
    const host = urlHost(raw);
    if (host) {
        const owner = PLATFORMS.find((entry) => ownsHost(entry, host));
        if (!owner) return { kind: 'unknown', reason: `not a ${storeNames()} URL`, url: raw };
        for (const pattern of owner.patterns) {
            const m = pattern.re.exec(raw);
            if (m) return pattern.build(m, raw);
        }
        return { kind: 'unknown', reason: `this ${owner.name} URL is not one this tool can read`, url: raw };
    }

    // A bare code, or something that is not a URL at all.
    for (const entry of PLATFORMS) {
        for (const pattern of entry.patterns) {
            const m = pattern.re.exec(raw);
            if (m) return pattern.build(m, raw);
        }
    }
    return { kind: 'unknown', reason: `not a ${storeNames()} URL`, url: raw };
}

function storeNames() {
    return PLATFORMS.map((entry) => entry.name).join(', ');
}

export function isSeriesPage(det) {
    return SERIES_PAGE_KINDS.has(det.kind);
}

export function canExpandSeries(det) {
    return platformFor(det.kind) !== null;
}

export function rowLabel(task) {
    if (task.kind === 'cmoa') return task.target;
    if (task.kind === 'bookwalker') return task.cid || task.target;
    if (task.kind === 'kindle') return task.asin || task.target;
    if (task.kind === 'kmanga') return task.target;
    return task.target.replace(/^https?:\/\/[^/]+/, '');
}

export function laneOf(task) {
    return platformFor(task.kind)?.lane === 'cpu' ? 'cpu' : 'net';
}

export function callAdapter(task, ctx) {
    const platform = platformFor(task.kind);
    if (!platform) throw new Error(`no platform is registered for "${task.kind}"`);
    return platform.download(task, ctx);
}

export async function resolveSeries(det, input, options = {}) {
    const platform = platformFor(det.kind);
    if (!platform?.series) return reject(input, det.reason || 'unsupported input');

    const ctx = {
        fetchImpl: options.fetchImpl || globalThis.fetch,
        userAgent: options.userAgent || USER_AGENT,
        signal: options.signal,
        config: options.config || {},
        samplers: options.config?.downloadSamplers === true,
    };
    try {
        return await platform.series(det, input, { ...ctx, ...options });
    } catch (error) {
        return reject(input, error.message);
    }
}
