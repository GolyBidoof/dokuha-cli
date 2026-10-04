export const MAX_SERIES_PAGES = 50;

const EBJ_MAX_SEEDS = 8;

export const EBJ_ORIGIN = 'https://ebookjapan.yahoo.co.jp';

export function reject(input, error) {
    return { tasks: [], rejected: [{ input, error }], notes: [] };
}

export async function mapLimit(items, limit, fn) {
    const results = new Array(items.length);
    let next = 0;
    const worker = async () => {
        for (;;) {
            const index = next++;
            if (index >= items.length) return;
            results[index] = await fn(items[index]);
        }
    };
    await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
    return results;
}

export async function fetchText(url, ctx) {
    const response = await ctx.fetchImpl(url, {
        headers: {
            'User-Agent': ctx.userAgent,
            Accept: 'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8',
            'Accept-Language': 'ja-JP,ja;q=0.9,en-US;q=0.8',
            Referer: `${new URL(url).origin}/`,
        },
        ...(ctx.signal ? { signal: ctx.signal } : {}),
    });
    if (!response.ok) {
        await response.body?.cancel();
        throw new Error(`HTTP ${response.status} from ${url}`);
    }
    return response.text();
}

export function dedupeBy(entries, keyOf) {
    const seen = new Set();
    const out = [];
    for (const entry of entries) {
        const key = keyOf(entry);
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(entry);
    }
    return out;
}

export function parseEbookjapanSeriesPage(html) {
    const codes = [];
    for (const m of String(html ?? '').matchAll(/"([A-Z]\d{6,})"/g)) {
        if (!codes.includes(m[1])) codes.push(m[1]);
    }
    return codes;
}

export function ebookjapanVolumes(body) {
    const list = [body?.detail, ...(Array.isArray(body?.series) ? body.series : [])].filter(Boolean);
    const byOrder = new Map();
    for (const entry of list) {
        if (!entry || !entry.code) continue;
        const key = entry.order ?? entry.publication;
        const current = byOrder.get(key);

        if (!current
            || (current.isFree !== true && entry.isFree === true)
            || (entry.isFree === current.isFree && entry.branch === 0 && current.branch !== 0)) {
            byOrder.set(key, entry);
        }
    }
    return [...byOrder.values()].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
}

const ebookjapanTask = (entry) => ({
    order: entry.order ?? null,
    name: entry.name || entry.publication,
    code: entry.code,
    publication: entry.publication,
});

export function parseEbookjapanFreeVolumes(body) {
    return ebookjapanVolumes(body)
        .filter((entry) => entry.isFree === true)
        .map(ebookjapanTask);
}

export function parseEbookjapanSamplerVolumes(body) {
    return ebookjapanVolumes(body)
        .filter((entry) => entry.isFree !== true && entry.trial)
        .map((entry) => ebookjapanTask({ ...entry, code: entry.trial }));
}

export async function fetchEbookjapanDetail(titleId, publication, ctx) {
    const referer = `${EBJ_ORIGIN}/books/${titleId}/${publication}/`;
    const url = `${EBJ_ORIGIN}/br_api/books/${titleId}/${publication}?device=pc`;
    const response = await ctx.fetchImpl(url, {
        headers: {
            Accept: 'application/json',
            'User-Agent': ctx.userAgent,
            Origin: EBJ_ORIGIN,
            Referer: referer,

            'X-Requested-With': 'FetchAPI',
        },
        ...(ctx.signal ? { signal: ctx.signal } : {}),
    });
    if (!response.ok) return null;
    const body = await response.json().catch(() => null);
    return body?.detail ? body : null;
}

export function parseBookwalkerSeriesId(html) {
    const m = /bookwalker\.jp\/series\/(\d+)/i.exec(String(html ?? ''));
    return m ? m[1] : null;
}

export function parseBookwalkerSeriesList(html) {
    const items = [];
    for (const block of String(html ?? '').split(/<div class="m-book-item[ "]/).slice(1)) {
        const uuid = (/data-uuid="([0-9a-f-]{36})"/i.exec(block) || [])[1];
        if (!uuid) continue;
        items.push({
            uuid: uuid.toLowerCase(),

            free: /a-icon-btn--free/.test(block),
            sample: /a-icon-btn--trial/.test(block),
            title: (/title="([^"]*)"/.exec(block) || [])[1] || '',
        });
    }
    return items;
}

export function parseBookwalkerNextPage(html) {
    const m = /<link[^>]+rel="next"[^>]+href="([^"]+)"/i.exec(String(html ?? ''));
    return m ? m[1] : null;
}

export function parseVolumeNumber(title) {
    const text = String(title ?? '');

    const m = /[（(]\s*([0-9０-９]+)\s*[)）]/.exec(text)
        || /第\s*([0-9０-９]+)\s*巻/.exec(text)
        || /(?<!全)\s([0-9０-９]+)\s*巻/.exec(text)

        || /[\s\u3000]([0-9０-９]+)[\s\u3000]*$/.exec(text);
    if (!m) return null;
    const digits = m[1].replace(/[０-９]/g, (d) => String('０１２３４５６７８９'.indexOf(d)));
    const value = Number(digits);
    return Number.isInteger(value) && value > 0 ? value : null;
}

export function dedupeBookwalkerVolumes(items) {
    const seen = new Set();
    const out = [];
    for (const item of items) {
        const volume = parseVolumeNumber(item.title);
        if (volume != null) {
            if (seen.has(volume)) continue;
            seen.add(volume);
        }
        out.push(item);
    }
    return out;
}
