
export const KM_MAGIC = 'BCP000';

export const KM_API_URL = 'https://bv.k-manga.jp/public/app/action/bd00.php';

export const KM_WS_URL = 'wss://ws.viewer.k-manga.jp/';

export const KM_PROFILES = ['64kb_QVGA_h', 'apple_h'];

export function buildHeaderRequest({ ticket, obfuid, profile = KM_PROFILES[0] }) {
    if (!ticket || !obfuid) throw new Error('k-manga header request needs a ticket and an obfuid');
    return `REQUEST HEADER\nt=${ticket}&fn=${profile}&o=${obfuid}`;
}

export function buildDataRequest({ ticket, obfuid, name, decryptKey }) {
    if (!ticket || !obfuid) throw new Error('k-manga data request needs a ticket and an obfuid');
    const dk = decryptKey ? `&dk=${decryptKey}` : '';
    return `REQUEST DATA\nt=${ticket}&fn=${name}&o=${obfuid}${dk}`;
}

export function parseFrame(buf) {
    if (!Buffer.isBuffer(buf)) buf = Buffer.from(buf);
    if (buf.length < 6 || buf.toString('latin1', 0, 6) !== KM_MAGIC) {
        throw new Error(`k-manga frame does not start with ${KM_MAGIC}`);
    }

    if (buf.length === 6) return { hello: true };

    if (buf.length < 16) throw new Error(`k-manga frame is ${buf.length} bytes, too short for a length field`);
    const jsonLength = readField(buf, 6, 10, 'JSON length');
    const jsonEnd = 16 + jsonLength;
    if (jsonEnd > buf.length) {
        throw new Error(`k-manga frame claims ${jsonLength} bytes of JSON but only ${buf.length - 16} remain`);
    }
    let body;
    try {
        body = JSON.parse(buf.toString('utf8', 16, jsonEnd));
    } catch (error) {
        throw new Error(`k-manga frame has unparseable JSON: ${error.message}`);
    }

    if (jsonEnd === buf.length) return { hello: false, body, chunks: null };

    const count = readField(buf, jsonEnd, 3, 'chunk count');
    const chunks = [];
    let cursor = jsonEnd + 3;
    for (let i = 0; i < count; i++) {
        if (cursor + 10 > buf.length) throw new Error(`k-manga frame ended inside chunk ${i} of ${count}`);
        const size = readField(buf, cursor, 10, `chunk ${i} length`);
        cursor += 10;
        if (cursor + size > buf.length) {
            throw new Error(`k-manga frame ended inside chunk ${i} of ${count}: wanted ${size} bytes, ${buf.length - cursor} left`);
        }

        chunks.push(buf.subarray(cursor, cursor + size));
        cursor += size;
    }
    if (cursor !== buf.length) {
        throw new Error(`k-manga frame has ${buf.length - cursor} trailing byte(s) after ${count} chunk(s)`);
    }
    return { hello: false, body, chunks };
}

function readField(buf, offset, width, what) {
    const text = buf.toString('latin1', offset, offset + width).trim();
    if (!/^\d+$/.test(text)) {
        throw new Error(`k-manga frame has a non-numeric ${what}: ${JSON.stringify(buf.toString('latin1', offset, offset + width))}`);
    }
    return Number(text);
}

export function parseIndexJsonp(text) {
    const start = String(text).indexOf('(');
    const end = String(text).lastIndexOf(')');
    if (start < 0 || end < start) throw new Error('k-manga index reply is not a JSONP call');
    let rows;
    try {
        rows = JSON.parse(String(text).slice(start + 1, end));
    } catch (error) {
        throw new Error(`k-manga index reply has unparseable JSON: ${error.message}`);
    }
    if (!Array.isArray(rows)) throw new Error('k-manga index reply is not an array');

    const chapters = [];
    const flags = [];
    for (const row of rows) {
        if (!Array.isArray(row)) continue;
        if (row.length === 2 && row[0] && row[1]) {
            const page = Number(row[1]);
            if (Number.isInteger(page) && page > 0) chapters.push({ name: String(row[0]).trim(), page });
        } else if (row.length === 2 && row[0] && !row[1]) {
            flags.push(String(row[0]).trim());
        }
    }
    return { chapters, flags };
}

export function parseViewerUrl(viewerUrl) {
    const url = new URL(viewerUrl);
    const p = new Map(url.searchParams);
    const decode = (key) => {
        const raw = p.get(key);
        if (!raw) return null;
        try {
            return JSON.parse(Buffer.from(raw, 'base64').toString('utf8'));
        } catch {
            return null;
        }
    };
    return {
        url: viewerUrl,
        ticket: p.get('p0') || null,
        obfuid: p.get('p1') || null,
        bookId: p.get('p3') || null,
        sid: p.get('p8') || null,
        accessUuid: p.get('p20') || null,
        config: decode('p5'),
        nextConfig: decode('p9'),
        params: p,
    };
}

export function isScrambled(image) {
    return Number(image?.key) > 0;
}

export function scrambleGeometry({ declaredWidth, declaredHeight, sourceWidth, sourceHeight }) {
    let cell = 32;
    if (declaredWidth > 1000 || declaredHeight > 1000) cell *= 3;
    else if (declaredWidth > 300 || declaredHeight > 300) cell *= 2;

    if (sourceWidth % cell || sourceHeight % cell) {
        throw new Error(
            `k-manga scrambled page is ${sourceWidth}x${sourceHeight}, which is not a whole number of ${cell}px cells`,
        );
    }
    return { cell, block: cell - 2, gridX: sourceWidth / cell, gridY: sourceHeight / cell };
}

export function scrambleOrder({ gridX, gridY, key }) {
    const total = gridX * gridY;
    const remaining = new Array(total);
    for (let i = 0; i < total; i++) remaining[i] = i;

    const order = new Uint32Array(total);
    let value = Number(key) || 0;
    for (let t = 0; t < total; t++) {
        value = (8741 * value + 30873) % 131071;
        const pick = value % remaining.length;
        order[t] = remaining[pick];
        remaining.splice(pick, 1);
    }
    return order;
}

export function readJpegSize(buf) {
    if (!Buffer.isBuffer(buf) || buf.length < 4 || buf[0] !== 0xFF || buf[1] !== 0xD8) return null;
    let i = 2;
    while (i + 9 < buf.length) {
        if (buf[i] !== 0xFF) { i++; continue; }
        const marker = buf[i + 1];

        if (marker === 0xD8 || marker === 0xD9 || (marker >= 0xD0 && marker <= 0xD7)) { i += 2; continue; }
        const size = buf.readUInt16BE(i + 2);
        if (marker >= 0xC0 && marker <= 0xCF && marker !== 0xC4 && marker !== 0xC8 && marker !== 0xCC) {
            return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
        }
        i += 2 + size;
    }
    return null;
}
