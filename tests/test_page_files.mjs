/**
 * Page names and page order.
 *
 * A volume's folder has to start with its first page and end with its last,
 * whichever way a reader sorts it. Two independent things decide that, so both are
 * tested here: the names (fixed width, one-based, so a name sort is reading order)
 * and the modification times (written in reading order, so a date sort agrees).
 *
 * The stores did not agree before this: CMOA wrote a bare `0001.jpg`, ebookjapan
 * wrote `page_00.webp` -- counted from zero and padded to the width of the page
 * count -- and every store wrote its pages as they arrived, so the times were in
 * completion order. A real 35-page download listed `page_07.webp` first.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
    PAGE_PAD,
    adoptLegacyPages,
    legacyPageNames,
    pageFileName,
    stampPageTimes,
} from '../src/download/page-files.js';
import { check, checkEqual, finish } from './_harness.mjs';

checkEqual('the canonical name is one-based and fixed width',
    pageFileName(1, 'jpg'), 'page-0001.jpg');
checkEqual('the canonical name pads past nine', pageFileName(10, 'jpg'), 'page-0010.jpg');
checkEqual('the canonical name carries the extension', pageFileName(7, 'webp'), 'page-0007.webp');
checkEqual('the width holds to four digits', PAGE_PAD, 4);

// A plain sort of canonical names must be reading order. This is the whole point:
// `page-10` sorts before `page-2` when the width is not fixed.
{
    const names = Array.from({ length: 12 }, (_, i) => pageFileName(i + 1, 'jpg'));
    const shuffled = [...names].reverse();
    checkEqual('a name sort is reading order', shuffled.sort(), names);
}

// The shapes that were actually shipped have to be recognised, or an existing
// folder is downloaded again from scratch.
{
    const cmoa = legacyPageNames(1, 'jpg');
    check('the bare CMOA name is recognised', cmoa.includes('0001.jpg'), cmoa.join(','));
    check('the Kindle underscore name is recognised', cmoa.includes('page_0001.jpg'), cmoa.join(','));
    check('the canonical name is not listed as legacy',
        !cmoa.includes('page-0001.jpg'), cmoa.join(','));

    // ebookjapan counted from zero and padded to the width of the page count, so
    // every width has to be accepted. Page 1 was `page_0.webp` in a nine-page
    // sampler and `page_00.webp` in a 35-page one.
    const ebj = legacyPageNames(1, 'webp');
    check('the ebookjapan zero-based name is recognised', ebj.includes('page_0.webp'), ebj.join(','));
    check('and its wider padding too', ebj.includes('page_00.webp'), ebj.join(','));
    checkEqual('the zero-based offset is applied', legacyPageNames(2, 'webp').includes('page_1.webp'), true);
}

// Adoption is what stops a resumed folder holding two schemes at once: `-` sorts
// before `_`, so a folder with both would show every canonical page before every
// legacy one.
{
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mdl-pages-'));
    try {
        // A folder left by ebookjapan: zero-based, underscore, width from the count.
        fs.writeFileSync(path.join(dir, 'page_00.webp'), 'a');
        fs.writeFileSync(path.join(dir, 'page_01.webp'), 'b');
        fs.writeFileSync(path.join(dir, 'page_02.webp'), 'c');

        const found = await adoptLegacyPages(dir, { count: 3, extension: 'webp' });
        const names = fs.readdirSync(dir).sort();
        checkEqual('legacy pages are renamed to the canonical scheme',
            names, ['page-0001.webp', 'page-0002.webp', 'page-0003.webp']);
        checkEqual('the map points at the canonical names',
            [found.get(1), found.get(3)], ['page-0001.webp', 'page-0003.webp']);
        checkEqual('the bytes were moved, not copied',
            fs.readFileSync(path.join(dir, 'page-0002.webp'), 'utf8'), 'b');

        // CMOA's bare names, and a page that is simply missing.
        const other = fs.mkdtempSync(path.join(os.tmpdir(), 'mdl-pages-'));
        fs.writeFileSync(path.join(other, '0001.jpg'), 'x');
        fs.writeFileSync(path.join(other, '0003.jpg'), 'z');
        try {
            const map = await adoptLegacyPages(other, { count: 3, extension: 'jpg' });
            checkEqual('a missing page is left missing', map.has(2), false);
            checkEqual('the bare names are adopted too',
                fs.readdirSync(other).sort(), ['page-0001.jpg', 'page-0003.jpg']);
        } finally {
            fs.rmSync(other, { recursive: true, force: true });
        }

        // Running it twice must not disturb an already-canonical folder.
        await adoptLegacyPages(dir, { count: 3, extension: 'webp' });
        checkEqual('adoption is idempotent',
            fs.readdirSync(dir).sort(), ['page-0001.webp', 'page-0002.webp', 'page-0003.webp']);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
}

// The times are the half that a name sort cannot fix: pages arrive concurrently and
// are written in completion order.
{
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mdl-times-'));
    try {
        const files = Array.from({ length: 5 }, (_, i) => pageFileName(i + 1, 'jpg'));
        // Write them in a scrambled order, and give them times in that same order,
        // exactly as a concurrent download does.
        const arrival = [3, 1, 5, 2, 4];
        let clock = Date.now() - 60_000;
        for (const page of arrival) {
            const file = files[page - 1];
            fs.writeFileSync(path.join(dir, file), 'x');
            fs.utimesSync(path.join(dir, file), clock / 1000, clock / 1000);
            clock += 1000;
        }
        const before = fs.readdirSync(dir)
            .map((n) => ({ n, t: fs.statSync(path.join(dir, n)).mtimeMs }))
            .sort((a, b) => a.t - b.t).map((x) => x.n);
        check('a fresh download really is in arrival order', before[0] !== files[0], before.join(','));

        const stamped = await stampPageTimes(dir, files);
        checkEqual('every page was stamped', stamped, 5);
        const after = fs.readdirSync(dir)
            .map((n) => ({ n, t: fs.statSync(path.join(dir, n)).mtimeMs }))
            .sort((a, b) => a.t - b.t).map((x) => x.n);
        checkEqual('a date sort is now reading order', after, files);
        checkEqual('a name sort is still reading order', fs.readdirSync(dir).sort(), files);

        // Every stamp has to be in the past, or a folder can appear in the future.
        const newest = Math.max(...files.map((f) => fs.statSync(path.join(dir, f)).mtimeMs));
        check('stamps are not in the future', newest <= Date.now() + 1000, String(newest - Date.now()));
        checkEqual('the times are distinct', new Set(files.map((f) => fs.statSync(path.join(dir, f)).mtimeMs)).size, 5);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
}

finish();
