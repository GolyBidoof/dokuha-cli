import fsp from 'node:fs/promises';
import path from 'node:path';
import { volumeFolder, readVolumeMarker } from './volume-folder.js';
import { IMAGE_EXTENSIONS, isCompleteImageFile } from './page-files.js';

/**
 * Return a completed result when the destination already has this volume.
 *
 * A local match must validate every page, not merely count files: a truncated
 * page left by an interrupted run would otherwise be trusted forever, and the
 * adapter's own per-page recovery would never run. The byte total is the sum of
 * what is on disk, so a resumed run reports the same size as the first one.
 */
export async function existingVolume(ctx, {
    store, title, id, sample = false, expectedPages = 0, folder = null,
    checkRemote = true, checkLocal = true, markerCheck = null,
} = {}) {
    if (!title || !id || ctx.config?.overwrite) return null;

    if (checkRemote && ctx.destinationCheck) {
        const check = await ctx.destinationCheck(title).catch(() => null);
        if (check?.exists) {
            return {
                store,
                id: String(id),
                title,
                folder: null,
                sample: sample === true,
                totalPages: expectedPages,
                downloaded: 0,
                skipped: expectedPages,
                failed: 0,
                bytes: 0,
                failures: [],
                existingDestination: {
                    method: check.method,
                    file: check.file,
                    remoteDir: check.remote_dir || null,
                },
            };
        }
    }

    if (ctx.bridge || !checkLocal || ctx.force) return null;
    const resolvedFolder = folder || await volumeFolder(ctx, { title, id, sample });
    const marker = await readVolumeMarker(resolvedFolder);
    if (!marker) return null;
    if (typeof markerCheck === 'function' && !markerCheck(marker)) return null;
    const owner = marker.id ?? marker.publication ?? marker.code ?? null;
    if (owner == null || String(owner) !== String(id)) return null;

    const expected = Number(expectedPages || marker.expectedPages || marker.pages || marker.totalPages) || 0;
    if (expected <= 0) return null;

    let entries;
    try {
        entries = await fsp.readdir(resolvedFolder, { withFileTypes: true });
    } catch {
        return null;
    }
    const complete = (result) => ({
        store,
        id: String(id),
        title,
        folder: resolvedFolder,
        sample: sample === true,
        totalPages: expected,
        downloaded: 0,
        skipped: expected,
        failed: 0,
        bytes: 0,
        failures: [],
        existingDestination: { method: 'local', folder: resolvedFolder },
        ...result,
    });

    if (ctx.zip && entries.some((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.zip'))) {
        return complete({});
    }

    const files = entries
        .filter((entry) => entry.isFile() && IMAGE_EXTENSIONS.has(path.extname(entry.name).toLowerCase()))
        .map((entry) => path.join(resolvedFolder, entry.name));
    if (files.length !== expected) return null;

    let bytes = 0;
    for (const file of files) {
        if (!await isCompleteImageFile(file)) return null;
        bytes += (await fsp.stat(file)).size;
    }
    return complete({ bytes });
}
