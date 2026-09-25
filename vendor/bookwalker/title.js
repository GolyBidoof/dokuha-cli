'use strict';

const RESERVED_DEVICE = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9]|conin\$|conout\$)(?:\..*)?$/i;

function cleanTitle(value) {
    if (!value) return '';
    let title = String(value).replace(/^【[^】]*】\s*/g, '').trim();
    title = title.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '').trim();
    return title;
}

function fsSafePath(value) {
    let name = cleanTitle(value);
    if (!name) return '';
    name = name.replace(/[. ]+$/, '').trim();
    if (!name || name === '.' || name === '..') return '';
    if (RESERVED_DEVICE.test(name)) name = `_${name}`;
    const characters = Array.from(name);
    if (characters.length > 190) name = characters.slice(0, 190).join('').replace(/[. ]+$/, '');
    return name;
}

function archiveDefaultName(value, cid = '') {
    let name = String(value || '').trim();
    name = name.replace(/【[^】]*】/g, ' ');
    name = name.replace(/[ \t　]+/g, ' ').trim();
    name = fsSafePath(name);
    return name || (cid ? `book_${cid}` : 'book');
}

module.exports = {
    archiveDefaultName,
    cleanTitle,
    fsSafePath
};
