/**
 * The store-zip CRC and framing.
 *
 * `crc32` used to be a bit-at-a-time loop that ran on the main thread after
 * every page had downloaded: ~1.3s of dead tail on a 244-page volume, and a
 * full event-loop stall for every other volume of a `--series` batch. It is now
 * `zlib.crc32` with a table-driven fallback.
 *
 * The value it produces is a wire format, so it is pinned against the standard
 * CRC-32 check value rather than against itself: a faster function that returns
 * a different number would produce archives that `unzip -t` rejects.
 */

import { createRequire } from 'node:module';
import zlib from 'node:zlib';

import { check, checkEqual, finish } from './_harness.mjs';

const require = createRequire(import.meta.url);
const MODULE_PATH = require.resolve('../vendor/bookwalker/public-trial.js');

/** The standard CRC-32 check value: crc32("123456789") === 0xCBF43926. */
const CHECK_VALUE = 0xCBF43926;
const CHECK_INPUT = Buffer.from('123456789');

const { crc32, buildZip } = require(MODULE_PATH);

// --- native path ----------------------------------------------------------

checkEqual('crc32 matches the standard check value', crc32(CHECK_INPUT), CHECK_VALUE);
checkEqual('crc32 of empty input is 0', crc32(Buffer.alloc(0)), 0);
checkEqual(
    'crc32 agrees with zlib.crc32 on a larger buffer',
    crc32(Buffer.from('the quick brown fox jumps over the lazy dog')),
    zlib.crc32(Buffer.from('the quick brown fox jumps over the lazy dog')),
);

// --- fallback path --------------------------------------------------------
//
// Reachable only on Node < 20.15, so it is exercised by hiding the native
// function before the module is loaded rather than by trusting it is dead code.
// The module is re-required from a cleared cache so it re-evaluates the
// `typeof zlib.crc32` branch.

const savedNative = zlib.crc32;
let fallbackCrc = null;
try {
    delete zlib.crc32;
    delete require.cache[MODULE_PATH];
    fallbackCrc = require(MODULE_PATH).crc32;
} finally {
    zlib.crc32 = savedNative;
    delete require.cache[MODULE_PATH];
}

check('the fallback is a different implementation from the native one',
    typeof fallbackCrc === 'function' && fallbackCrc !== crc32);
checkEqual('the fallback matches the standard check value', fallbackCrc(CHECK_INPUT), CHECK_VALUE);
checkEqual('the fallback handles empty input', fallbackCrc(Buffer.alloc(0)), 0);

// Byte-for-byte agreement over a range of lengths and contents, including the
// 4-byte-aligned and unaligned cases a table-driven loop can get wrong.
{
    let agreed = 0;
    let total = 0;
    for (let length = 0; length <= 512; length += 7) {
        const buffer = Buffer.alloc(length);
        for (let i = 0; i < length; i++) buffer[i] = (i * 31 + length) & 0xff;
        total++;
        if (fallbackCrc(buffer) === zlib.crc32(buffer)) agreed++;
    }
    check('the fallback is bit-identical to the native implementation on 74 buffers',
        agreed === total, `${agreed}/${total} agreed`);
}

// --- buildZip framing -----------------------------------------------------
//
// A store zip has no compression, so the payload can be read straight back out
// of the archive. That makes a full round-trip possible without a zip library:
// header signature, CRC field, method, name, and the stored bytes.

{
    const entries = [
        { name: 'page-0001.jpg', data: Buffer.from('first page bytes') },
        { name: 'page-0002.jpg', data: Buffer.from('second page, a bit longer than the first') },
    ];
    const zip = buildZip(entries);

    checkEqual('the archive starts with a local file header', zip.readUInt32LE(0), 0x04034b50);
    checkEqual('entries are stored, not deflated', zip.readUInt16LE(8), 0);

    const nameLength = zip.readUInt16LE(26);
    checkEqual('the first entry name round-trips',
        zip.subarray(30, 30 + nameLength).toString('utf8'), entries[0].name);
    checkEqual('the first entry CRC is the standard CRC-32 of its bytes',
        zip.readUInt32LE(14), zlib.crc32(entries[0].data));
    checkEqual('the first entry size is recorded',
        zip.readUInt32LE(18), entries[0].data.length);
    checkEqual('the first payload is stored verbatim',
        zip.subarray(30 + nameLength, 30 + nameLength + entries[0].data.length).toString('utf8'),
        entries[0].data.toString('utf8'));

    // The central directory offset in the EOCD must point at a real central
    // header, or every extractor rejects the archive.
    const eocd = zip.length - 22;
    checkEqual('the archive ends with an end-of-central-directory record',
        zip.readUInt32LE(eocd), 0x06054b50);
    checkEqual('the EOCD counts both entries', zip.readUInt16LE(eocd + 10), entries.length);
    const centralOffset = zip.readUInt32LE(eocd + 16);
    checkEqual('the central directory offset points at a central header',
        zip.readUInt32LE(centralOffset), 0x02014b50);
    checkEqual('the central header carries the same CRC as the local header',
        zip.readUInt32LE(centralOffset + 16), zlib.crc32(entries[0].data));
}

// --- degenerate inputs ----------------------------------------------------

{
    const empty = buildZip([{ name: 'page-0001.jpg', data: Buffer.alloc(0) }]);
    checkEqual('a zero-byte entry still gets a header', empty.readUInt32LE(0), 0x04034b50);
    checkEqual('a zero-byte entry has CRC 0', empty.readUInt32LE(14), 0);
    // A zero-entry archive is not something the caller does, but it must not throw.
    const none = buildZip([]);
    checkEqual('an empty archive still terminates correctly',
        none.readUInt32LE(none.length - 22), 0x06054b50);
}

finish();
