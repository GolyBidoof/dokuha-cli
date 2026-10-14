
import fsp from 'node:fs/promises';
import path from 'node:path';

export const PAGE_PAD = 4;

export function pageFileName(index, extension = 'jpg') {
    return `page-${String(index).padStart(PAGE_PAD, '0')}.${extension}`;
}

// Page names must survive every target filesystem, Windows being the worst case:
// `cleanTitle`-style removal of the characters it forbids, trailing dots/spaces
// (NTFS drops them silently), reserved device names, and a code-point cap so a
// deep extraction path stays inside the legacy 260-char limit.
const FORBIDDEN_PAGE_CHARS = /[\\/:*?"<>|\u0000-\u001f]/g;
const RESERVED_DEVICE_NAME = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9]|conin\$|conout\$)(?:\..*)?$/i;
const MAX_PAGE_STEM_POINTS = 190;
const MAX_PAGE_NAME_BYTES = 255;

/** Reduce `value` to a filesystem-safe page stem, or '' when nothing is left. */
export function sanitizePageStem(value) {
    let stem = String(value ?? '').replace(FORBIDDEN_PAGE_CHARS, '').trim();
    stem = stem.replace(/[. ]+$/, '');
    if (!stem || stem === '.' || stem === '..') return '';
    if (RESERVED_DEVICE_NAME.test(stem)) stem = `_${stem}`;
    const points = Array.from(stem);
    if (points.length > MAX_PAGE_STEM_POINTS) {
        stem = points.slice(0, MAX_PAGE_STEM_POINTS).join('').replace(/[. ]+$/, '');
    }
    return stem;
}

/**
 * BookWalker page name: `0001 sourcestem.jpg`.
 *
 * The published manifest names each page after the EPUB source it was built
 * from, so keeping that stem puts the book's own chapter/cover filename in the
 * folder instead of an opaque ordinal. The ordinal stays first and fixed width,
 * so a plain name sort is reading order, and the stem is truncated by encoded
 * length rather than character count so the whole entry fits 255 UTF-8 bytes.
 *
 * The source may carry a query/fragment and a nested path; only the basename
 * matters. `bookWalkerPageName(index, '', 'jpg')` is `0001.jpg`.
 */
export function bookWalkerPageName(index, source, extension = 'jpg') {
    const raw = String(source ?? '').split(/[?#]/)[0];
    const base = raw.slice(raw.lastIndexOf('/') + 1);
    const stem = sanitizePageStem(base.replace(/\.(?:x?html?)$/i, ''));
    const prefix = String(index).padStart(PAGE_PAD, '0');
    const suffix = `.${extension}`;
    const budget = MAX_PAGE_NAME_BYTES - Buffer.byteLength(`${prefix} ${suffix}`, 'utf8');
    let name = '';
    let bytes = 0;
    for (const char of stem) {
        const size = Buffer.byteLength(char, 'utf8');
        if (bytes + size > budget) break;
        name += char;
        bytes += size;
    }
    return prefix + (name ? ` ${name}` : '') + suffix;
}

// ZIP entries are ordered by the ordinal in the name, whatever scheme wrote it.
// The new shape starts with it (`0001 source.jpg`); the pre-naming-convention
// shape carried it after `page-`.
const ZIP_ORDINAL = /^(\d+)(?=[ .])/;
const ZIP_LEGACY_ORDINAL = /page-(\d+)\./i;

/** Page number encoded in a file name or ZIP entry path, or Infinity. */
export function zipEntryNumber(entry) {
    const name = String(entry ?? '').split('/').pop();
    const match = name.match(ZIP_ORDINAL) || name.match(ZIP_LEGACY_ORDINAL);
    return match ? Number(match[1]) : Infinity;
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

export const IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif']);

async function readTail(handle, size, length) {
    const tail = Buffer.alloc(length);
    await handle.read(tail, 0, length, size - length);
    return tail;
}

/**
 * True when `file` is a whole image of the format its extension names. A resume
 * that trusts a half-written page serves a broken page forever, so every
 * completeness check in the tree goes through here rather than counting files.
 */
export async function isCompleteImageFile(file) {
    const extension = path.extname(String(file)).toLowerCase();
    if (!IMAGE_EXTENSIONS.has(extension)) return false;
    let handle;
    try {
        handle = await fsp.open(file, 'r');
        const { size } = await handle.stat();
        if (size < 4) return false;
        const head = Buffer.alloc(12);
        const { bytesRead } = await handle.read(head, 0, 12, 0);
        if (bytesRead < 3) return false;

        if (extension === '.png') {
            const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
            if (bytesRead < 8 || !signature.every((byte, i) => head[i] === byte) || size < 12) return false;
            const tail = await readTail(handle, size, 8);
            return tail.toString('latin1').includes('IEND');
        }
        if (extension === '.webp') {
            if (bytesRead < 12) return false;
            if (head.toString('latin1', 0, 4) !== 'RIFF' || head.toString('latin1', 8, 12) !== 'WEBP') return false;
            return head.readUInt32LE(4) + 8 === size;
        }
        if (extension === '.gif') {
            const signature = head.toString('latin1', 0, 6);
            return signature === 'GIF87a' || signature === 'GIF89a';
        }
        if (head[0] !== 0xff || head[1] !== 0xd8 || head[2] !== 0xff) return false;
        if (size < 5) return false;
        const tail = await readTail(handle, size, 2);
        return tail[0] === 0xff && tail[1] === 0xd9;
    } catch {
        return false;
    } finally {
        await handle?.close().catch(() => {});
    }
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
