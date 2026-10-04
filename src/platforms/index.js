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

export function detectSource(input) {
    const raw = String(input ?? '').trim();
    if (!raw) return { kind: 'unknown', reason: 'empty input', url: raw };

    for (const entry of PLATFORMS) {
        for (const pattern of entry.patterns) {
            const m = pattern.re.exec(raw);
            if (m) return pattern.build(m, raw);
        }
    }
    return {
        kind: 'unknown',
        reason: `not a ${PLATFORMS.map((entry) => entry.name).join(', ')} URL`,
        url: raw,
    };
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
