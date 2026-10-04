import fsp from 'node:fs/promises';
import path from 'node:path';

export const VOLUME_MARKER = 'metadata.json';

export const SAMPLE_SUFFIX = '（試し読み）';

const MAX_TITLE_LENGTH = 80;

export function safeFolderName(value, fallback = 'volume') {
    const base = String(value ?? '')
        .replace(/[/\\:*?"<>|]+/g, '_')
        .replace(/\s+/g, ' ')
        .trim();
    return base.slice(0, MAX_TITLE_LENGTH).replace(/[. ]+$/, '') || fallback;
}

export async function readVolumeMarker(folder) {
    const text = await fsp.readFile(path.join(folder, VOLUME_MARKER), 'utf8').catch(() => null);
    if (!text) return null;
    try {
        return JSON.parse(text);
    } catch {
        return null;
    }
}

export async function writeVolumeMarker(folder, marker) {
    await fsp.writeFile(path.join(folder, VOLUME_MARKER), `${JSON.stringify(marker, null, 2)}\n`);
}

export async function resolveVolumeFolder(out, title, id, options = {}) {
    const clean = options.sanitize || safeFolderName;
    const suffix = options.sample ? SAMPLE_SUFFIX : '';
    const base = clean(title, id);
    const direct = path.join(out, base + suffix);
    const existing = await readVolumeMarker(direct);

    if (!existing || !id) return direct;

    const owner = existing.id ?? existing.publication ?? existing.code ?? null;
    if (owner === null) return direct;
    if (String(owner) === String(id)) return direct;
    return path.join(out, clean(`${base} (${id})`, id) + suffix);
}

export function volumeFolder(ctx, { title, id, sample = false, sanitize } = {}) {
    if (ctx.flat) return ctx.out;
    if (ctx.titleDir === false) {
        return path.join(ctx.out, safeFolderName(id) + (sample ? SAMPLE_SUFFIX : ''));
    }
    return resolveVolumeFolder(ctx.out, title, id, { sample, sanitize });
}
