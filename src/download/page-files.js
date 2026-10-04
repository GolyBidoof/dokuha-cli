
import fsp from 'node:fs/promises';
import path from 'node:path';

export const PAGE_PAD = 4;

export function pageFileName(index, extension = 'jpg') {
    return `page-${String(index).padStart(PAGE_PAD, '0')}.${extension}`;
}

export function legacyPageNames(index, extension) {
    const names = [];
    const oneBased = String(index).padStart(PAGE_PAD, '0');
    names.push(`page_${oneBased}.${extension}`);
    names.push(`${oneBased}.${extension}`);

    if (extension === 'webp') {
        for (let width = 1; width <= PAGE_PAD; width++) {
            names.push(`page_${String(index - 1).padStart(width, '0')}.${extension}`);
        }
    }
    return names;
}

export async function stampPageTimes(dir, files) {
    const ordered = files.filter(Boolean);
    if (ordered.length < 2) return 0;
    const base = Date.now() - ordered.length * 1000;
    let stamped = 0;
    for (let i = 0; i < ordered.length; i++) {
        const seconds = (base + i * 1000) / 1000;
        try {
            await fsp.utimes(path.join(dir, ordered[i]), seconds, seconds);
            stamped++;
        } catch {  }
    }
    return stamped;
}

export async function adoptLegacyPage(dest, candidates, validate = null) {
    for (const name of candidates) {
        const from = path.join(path.dirname(dest), name);
        if (validate) {
            if (!await validate(from).catch(() => false)) continue;
        } else {
            try {
                await fsp.access(from);
            } catch {
                continue;
            }
        }
        try {
            await fsp.rename(from, dest);
            return true;
        } catch {
            return false;
        }
    }
    return false;
}

export async function adoptLegacyPages(dir, { count, extension }) {
    const found = new Map();
    for (let index = 1; index <= count; index++) {
        const canonical = pageFileName(index, extension);
        try {
            await fsp.access(path.join(dir, canonical));
            found.set(index, canonical);
            continue;
        } catch {  }
        for (const legacy of legacyPageNames(index, extension)) {
            try {
                await fsp.access(path.join(dir, legacy));
            } catch {
                continue;
            }

            try {
                await fsp.rename(path.join(dir, legacy), path.join(dir, canonical));
                found.set(index, canonical);
            } catch {
                found.set(index, legacy);
            }
            break;
        }
    }
    return found;
}
