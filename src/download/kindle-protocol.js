
import crypto from 'node:crypto';

export const KINDLE_ORIGIN = 'https://read.amazon.co.jp';

export const KINDLE_STORE_ORIGIN = 'https://www.amazon.co.jp';

export function kindleStoreSeriesList(html) {
    const text = String(html || '');
    const seen = new Set();
    const out = [];
    for (const match of text.matchAll(/data-offer-asins="([^"]*)"/g)) {
        for (const raw of match[1].split(',')) {
            const asin = raw.trim().toUpperCase();
            if (!/^B0[0-9A-Z]{8}$/.test(asin) || seen.has(asin)) continue;
            seen.add(asin);
            out.push(asin);
        }
    }
    return out;
}

export function kindleStoreSeriesUrl(seriesAsin) {
    return `${KINDLE_STORE_ORIGIN}/dp/${String(seriesAsin || '').toUpperCase()}`;
}

export function kindleSeriesDescriptor(entry) {
    if (!entry || typeof entry !== 'object') return false;
    if (/^VOLUMES$/i.test(String(entry.seriesType || ''))) return true;
    return Number(entry.seriesSize) > 1;
}

export const KINDLE_RENDER_SETTINGS = {
    version: '3.0',
    fontFamily: 'Bookerly',
    fontSize: '4.95',
    lineHeight: '1.4',
    dpi: '160',
    height: '1270',
    width: '1333',
    marginBottom: '0',
    marginLeft: '9',
    marginRight: '9',
    marginTop: '0',
    maxNumberColumns: '2',
    theme: 'default',
    locationMap: 'true',
    packageType: 'TAR',
    encryptionVersion: 'NONE',
    rasterScale: '2',
};

export const KINDLE_RENDER_BATCH_MAX = 24;
export const KINDLE_RENDER_BATCH_MIN = 2;

export const KINDLE_MAX_WINDOWS = 400;

const KINDLE_TAR_BLOCK = 512;

export const KINDLE_ASIN_RE = /\b(B0[0-9A-Z]{8})\b/i;

function toBytes(value) {
    if (value instanceof Uint8Array) return value;
    if (Buffer.isBuffer(value)) return value;
    return new Uint8Array(value || 0);
}

function tarString(bytes) {
    let end = bytes.length;
    for (let i = 0; i < bytes.length; i++) {
        if (bytes[i] === 0) { end = i; break; }
    }
    let out = '';
    for (let i = 0; i < end; i++) out += String.fromCharCode(bytes[i]);
    return out.replace(/\0+$/, '').trim();
}

export function kindleReadTar(buffer) {
    const all = toBytes(buffer);
    const files = new Map();
    let offset = 0;
    let longName = null;

    while (offset + KINDLE_TAR_BLOCK <= all.length) {
        const header = all.subarray(offset, offset + KINDLE_TAR_BLOCK);

        let blank = true;
        for (let i = 0; i < KINDLE_TAR_BLOCK; i++) {
            if (header[i] !== 0) { blank = false; break; }
        }
        if (blank) break;

        const sizeText = tarString(header.subarray(124, 136));
        const size = sizeText ? parseInt(sizeText, 8) : 0;
        if (!Number.isFinite(size) || size < 0) {
            throw new Error(`the render response is not a tar (bad size field at byte ${offset})`);
        }

        const rawType = header[156];
        const type = rawType === 0 ? '0' : String.fromCharCode(rawType);
        const bodyStart = offset + KINDLE_TAR_BLOCK;
        const bodyEnd = bodyStart + size;
        if (bodyEnd > all.length) break;

        let name = tarString(header.subarray(0, 100));

        const prefix = tarString(header.subarray(345, 500));
        if (prefix) name = `${prefix}/${name}`;
        if (longName !== null) { name = longName; longName = null; }

        if (type === 'L') {
            longName = tarString(all.subarray(bodyStart, bodyEnd));
        } else if (type === '0') {
            files.set(String(name).replace(/^\.\//, ''), all.subarray(bodyStart, bodyEnd));
        }

        offset = bodyStart + Math.ceil(size / KINDLE_TAR_BLOCK) * KINDLE_TAR_BLOCK;
    }

    if (!files.size) throw new Error('the render response is not a tar (no members)');
    return files;
}

export function kindleTarText(files, name) {
    const bytes = files.get(name);
    if (!bytes) return null;
    return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('utf8');
}

export function kindleTarJson(files, name) {
    const text = kindleTarText(files, name);
    if (text == null) return null;
    try {
        return JSON.parse(text);
    } catch {
        return null;
    }
}

export function kindleParseBookInfo(html) {
    const match = /<script[^>]+id="bookInfo"[^>]*>([\s\S]*?)<\/script>/i.exec(String(html ?? ''));
    if (!match) return null;
    try {
        const info = JSON.parse(match[1]);
        return info && typeof info === 'object' ? info : null;
    } catch {
        return null;
    }
}

export function kindleIsVolumeInfo(info) {
    return Boolean(info && info.contentGuid && info.karamelToken && info.karamelToken.token);
}

export function kindleTokenOf(info) {
    const token = String(info?.karamelToken?.token || '');
    const expiresAt = Number(info?.karamelToken?.expiresAt) || 0;
    return { token, expiresAt };
}

export function kindleContentType(info) {
    const sample = info?.isSample === true || /^SAMPLE$/i.test(String(info?.bookAccessMethod || ''));
    return sample ? 'Sample' : 'FullBook';
}

export function kindleRenderUrl({ asin, revision, contentType = 'FullBook', numPage, skipPageCount = 0, startPosition = 1 }) {
    if (!asin) throw new Error('the Kindle volume id is not known yet');
    if (!revision) throw new Error('the Kindle content revision is not known yet');
    const params = new URLSearchParams();
    params.set('version', KINDLE_RENDER_SETTINGS.version);
    params.set('asin', String(asin));
    params.set('contentType', contentType);
    params.set('revision', String(revision));
    for (const [key, value] of Object.entries(KINDLE_RENDER_SETTINGS)) {
        if (key === 'version') continue;
        params.set(key, value);
    }
    params.set('numPage', String(Math.max(1, Number(numPage) || 1)));
    params.set('skipPageCount', String(Math.max(0, Number(skipPageCount) || 0)));
    if (startPosition != null) params.set('startingPosition', String(startPosition));
    params.set('bundleImages', 'false');
    return `${KINDLE_ORIGIN}/renderer/render?${params.toString()}`;
}

export function kindleLooksSigned(value) {
    const text = String(value ?? '').replace(/^\?/, '');
    if (!text || text.slice(0, 4).toLowerCase() === 'null') return false;
    return /(^|&)Signature=/.test(text) && /(^|&)(Policy|Key-Pair-Id)=/.test(text);
}

export function kindlePickAuth(resourceAuth, cdnAuth) {
    if (kindleLooksSigned(resourceAuth)) return String(resourceAuth).replace(/^\?/, '');
    if (kindleLooksSigned(cdnAuth)) return String(cdnAuth).replace(/^\?/, '');
    return null;
}

export function kindleAuthPolicyResource(authParameter) {
    const match = /[?&]Policy=([^&]+)/.exec(`?${String(authParameter ?? '')}`);
    if (!match) return null;
    try {
        let b64 = decodeURIComponent(match[1]).replace(/-/g, '+').replace(/_/g, '/');
        b64 += '='.repeat((4 - (b64.length % 4)) % 4);
        const text = Buffer.from(b64, 'base64').toString('utf8');
        const resource = /"Resource"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(text);
        return resource ? resource[1].replace(/\\(.)/g, '$1') : null;
    } catch {
        return null;
    }
}

export function kindleAuthPolicyIsPrefix(authParameter) {
    const resource = kindleAuthPolicyResource(authParameter);
    return resource === null ? null : /\*$/.test(resource);
}

export function kindleResourceUrl({ baseUrl, path, authParameter, token, expiresAt, omitSession }) {
    if (!path) throw new Error('the Kindle resource descriptor has no path');
    if (!authParameter) {
        throw new Error(`the Kindle manifest carried no CDN signature for ${path}`);
    }
    const base = String(baseUrl || '').replace(/\/+$/, '');
    let url = `${base}/${String(path).replace(/^\/+/, '')}?${authParameter}`;
    const omit = omitSession === undefined
        ? kindleAuthPolicyIsPrefix(authParameter) === false
        : Boolean(omitSession);
    if (!omit && token) url += `&token=${encodeURIComponent(token)}`;
    if (!omit && expiresAt) url += `&expiration=${Number(expiresAt)}`;
    return url;
}

export function kindlePageKey(token, expiresAt) {
    const text = String(token || '');
    if (!text) {
        throw new Error('no Kindle reading token is available, so an encrypted page '
            + 'cannot be read — the session expired, or the volume is not open');
    }
    if (text.length < 100) {

        throw new Error(`the Kindle reading token is truncated (${text.length} characters)`);
    }
    const offset = Math.abs(Math.trunc(Number(expiresAt) || 0)) % 60;
    const key = text.substring(offset, offset + 40);
    if (key.length < 40) {
        throw new Error('the Kindle reading token is too short to cut a 40-character key from');
    }
    return key;
}

export function kindleLooksLikeJpeg(bytes) {
    const b = toBytes(bytes);
    return b.length > 3 && b[0] === 0xFF && b[1] === 0xD8 && b[2] === 0xFF;
}

export function kindleFramedText(bytes) {
    const text = Buffer.from(toBytes(bytes)).toString('utf8').replace(/\s+/g, '');
    if (text.length < 64 || !/^[A-Za-z0-9+/=]+$/.test(text)) return null;
    return text;
}

export function kindleSplitFrame(text) {
    const s = String(text || '');
    if (s.length <= 48) throw new Error('the encrypted Kindle page is too short to carry salt, iv and payload');
    const salt = Buffer.from(s.slice(0, 24), 'base64');
    const iv = Buffer.from(s.slice(24, 48), 'base64');
    const body = Buffer.from(s.slice(48), 'base64');
    if (salt.length !== 16 || iv.length !== 16) {
        throw new Error(`the encrypted Kindle page has a malformed salt/iv header (${salt.length}/${iv.length} bytes)`);
    }
    if (body.length < 17) throw new Error('the encrypted Kindle page carries no GCM tag');
    return { salt, iv, body };
}

export function kindleDecryptPage(bytes, keyMaterial) {
    const text = kindleFramedText(bytes);
    if (!text) throw new Error('the encrypted Kindle page is not base64');
    const { salt, iv, body } = kindleSplitFrame(text);
    const ciphertext = body.subarray(0, body.length - 16);
    const tag = body.subarray(body.length - 16);
    const aes = crypto.createDecipheriv(
        'aes-128-gcm',
        crypto.pbkdf2Sync(keyMaterial, salt, 1000, 16, 'sha256'),
        iv,
    );
    aes.setAAD(Buffer.from(keyMaterial.slice(0, 9), 'utf8'), { plaintextLength: ciphertext.length });
    aes.setAuthTag(tag);
    return Buffer.concat([aes.update(ciphertext), aes.final()]);
}

export function kindleDecodePage(bytes, { isEncrypted = false, token, expiresAt } = {}) {
    const raw = Buffer.from(toBytes(bytes));
    if (!raw.length) throw new Error('the Kindle CDN returned an empty page body');
    if (kindleLooksLikeJpeg(raw)) return raw;

    const key = kindlePageKey(token, expiresAt);
    const attempts = isEncrypted ? ['decrypt', 'base64'] : ['base64', 'decrypt'];
    const failures = [];
    for (const how of attempts) {
        try {
            const out = how === 'decrypt' ? kindleDecryptPage(raw, key) : Buffer.from(kindleFramedText(raw) || '', 'base64');
            if (kindleLooksLikeJpeg(out)) return out;
            failures.push(`${how}: decoded but not a JPEG`);
        } catch (error) {
            failures.push(`${how}: ${error.message}`);
        }
    }
    const head = raw.subarray(0, 24).toString('latin1').replace(/[^\x20-\x7e]/g, '.');
    throw new Error('the Kindle CDN returned something that is not a page image '
        + `(isEncrypted=${Boolean(isEncrypted)}, starts with "${head}"; ${failures.join('; ')})`);
}

export function kindleManifestResources(files) {
    const manifest = kindleTarJson(files, 'manifest.json');
    if (!manifest || !manifest.cdn) return [];
    const baseUrl = String(manifest.cdn.baseUrl || '');
    const isEncrypted = manifest.cdn.isEncrypted === true;
    const cdnAuth = manifest.cdn.authParameter;
    const list = Array.isArray(manifest.cdnResources) ? manifest.cdnResources : [];
    const out = [];
    for (const resource of list) {
        if (!resource || !resource.url) continue;
        const authParameter = kindlePickAuth(resource.authParameter, cdnAuth);
        if (!authParameter) continue;
        out.push({
            path: String(resource.url),
            type: String(resource.type || ''),
            authParameter,
            baseUrl,
            isEncrypted,
        });
    }
    return out;
}

export function kindleWindowPages(files) {
    const pages = [];
    const names = [...files.keys()].filter((name) => name.startsWith('page_data_')).sort();
    for (const name of names) {
        const list = kindleTarJson(files, name);
        if (!Array.isArray(list)) continue;
        for (const page of list) {
            if (!page || page.sectionId == null) continue;
            pages.push(page);
        }
    }
    pages.sort((a, b) => Number(a.sectionId) - Number(b.sectionId));

    const out = [];
    for (const page of pages) {
        for (const child of page.children || []) {
            const ref = String(child?.imageReference || '');
            if (!ref) continue;
            if (child.type && child.type !== 'image') continue;
            out.push({
                sectionId: Number(page.sectionId),
                endPositionId: Number(page.endPositionId) || 0,
                imageReference: ref,
            });
        }
    }
    return out;
}

export function kindleWindowViewCount(files) {
    let views = 0;
    for (const name of files.keys()) {
        if (!name.startsWith('page_data_')) continue;
        const list = kindleTarJson(files, name);
        if (Array.isArray(list)) views += list.length;
    }
    return views;
}

export function kindleWindowMeta(files) {
    const metadata = kindleTarJson(files, 'metadata.json') || {};
    const locationMap = kindleTarJson(files, 'location_map.json');
    const manifest = kindleTarJson(files, 'manifest.json') || {};
    const locations = Array.isArray(locationMap?.locations) ? locationMap.locations : [];
    return {
        title: String(metadata.bookTitle || ''),
        authors: Array.isArray(metadata.authors) ? metadata.authors.map(String) : [],
        direction: String(metadata.progressionDirection || metadata.direction || ''),
        lang: String(metadata.lang || ''),
        lastPositionId: Number(metadata.lastPositionId) || 0,

        pageCount: locations.length ? locations.length - 1 : 0,
        revision: String(manifest.revision || ''),
    };
}

export function kindlePageResolution(page) {
    for (const child of page?.children || []) {
        const rect = child?.rect;
        if (!rect) continue;
        const w = Math.round(Number(rect.right) - Number(rect.left));
        const h = Math.round(Number(rect.bottom) - Number(rect.top));
        if (w > 0 && h > 0) return `${w} × ${h}`;
    }
    return null;
}

export function kindleWindowAtEnd(pages, lastPositionId) {
    if (!lastPositionId) return false;
    for (const page of pages) {
        if (page.endPositionId >= lastPositionId) return true;
    }
    return false;
}

function balancedObjectAt(text, open) {
    if (text[open] !== '{') return null;
    let depth = 0;
    let quote = null;
    let escaped = false;
    for (let i = open; i < text.length; i += 1) {
        const ch = text[i];
        if (quote) {
            if (escaped) escaped = false;
            else if (ch === '\\') escaped = true;
            else if (ch === quote) quote = null;
            continue;
        }
        if (ch === '"' || ch === "'") { quote = ch; continue; }
        if (ch === '{') depth += 1;
        else if (ch === '}') {
            depth -= 1;
            if (depth === 0) return text.slice(open, i + 1);
        }
    }
    return null;
}

function literalField(text, name) {
    const match = new RegExp(`["']${name}["']\\s*:\\s*(?:"([^"]*)"|'([^']*)')`, 'i').exec(text);
    if (!match) return '';
    return String(match[1] ?? match[2] ?? '');
}

export function kindleUnlimitedOffer(html) {
    const text = String(html || '');
    const marker = text.indexOf('KU-DP-BottomSheet-Context');
    if (marker < 0) return null;

    const widget = text.indexOf('widgetContext', marker);
    let literal = widget >= 0
        ? balancedObjectAt(text, text.indexOf('{', widget))
        : null;
    if (!literal) literal = balancedObjectAt(text, text.indexOf('{', marker));
    if (!literal) return null;

    const asin = literalField(literal, 'ASIN').toUpperCase();
    if (!KINDLE_ASIN_RE.test(asin)) return null;
    return {
        asin,
        program: literalField(literal, 'PROGRAM').toUpperCase(),
        channel: literalField(literal, 'CHANNEL').toUpperCase(),
        borrowSubType: literalField(literal, 'BORROW_SUB_TYPE').toUpperCase(),
        csrfToken: literalField(literal, 'CSRF_TOKEN'),
    };
}

export function kindleBorrowPayload(asin, offer) {
    return JSON.stringify([{
        asin: String(asin || offer?.asin || '').toUpperCase(),
        program: String(offer?.program || 'KINDLE_UNLIMITED'),
        channel: String(offer?.channel || 'ALL_YOU_CAN_READ'),
        loanId: '',
    }]);
}

export function kindleBorrowResult(payload) {
    let data = payload;
    if (typeof data === 'string') {
        try {
            data = JSON.parse(data);
        } catch {
            return { ok: false, code: '' };
        }
    }
    const succeeded = Array.isArray(data?.succeededResults) ? data.succeededResults : [];
    const failed = Array.isArray(data?.failedResults) ? data.failedResults : [];
    const first = failed[0] || succeeded[0] || null;
    return {
        ok: succeeded.length > 0 && failed.length === 0,
        code: String(first?.workflowResponse?.resultCode || ''),
    };
}

export function kindleLibraryQuery() {
    return {
        query: 'query ccGetCustomerLibraryBooks { getCustomerLibrary { books('
            + 'sortBy: {sortField: RECENCY, sortOrder: DESCENDING}, '
            + 'selectionCriteria: {tags: [], query: ""}) { '
            + 'pageInfo {hasNextPage endCursor} totalCount {number relation} '
            + 'edges { node { asin acquisitionId relationshipType relationshipSubType __typename '

            + '... on CustomerLibraryBorrowedSingleBookNode { activeBorrow } }}}}}',
    };
}

export function kindleLoansFromLibrary(payload) {
    let data = payload;
    if (typeof data === 'string') {
        try {
            data = JSON.parse(data);
        } catch {
            return [];
        }
    }
    const edges = data?.data?.getCustomerLibrary?.books?.edges;
    if (!Array.isArray(edges)) return [];
    const out = [];
    for (const edge of edges) {
        const node = edge?.node;
        const asin = String(node?.asin || '').toUpperCase();
        const loanId = String(node?.acquisitionId || '');
        if (!asin || !loanId) continue;
        out.push({
            asin,
            loanId,

            active: node.activeBorrow !== false,

            unlimited: Array.isArray(node.relationshipSubType)
                ? node.relationshipSubType.includes('KindleUnlimited')
                : /Borrowed/i.test(String(node.__typename || '')),
        });
    }
    return out;
}

export function kindleReturnMutation(items) {
    const input = (Array.isArray(items) ? items : [])
        .filter((item) => item && item.asin && item.loanId)
        .map((item) => `{contentId: ${JSON.stringify(String(item.asin).toUpperCase())}, `
            + `contentType: "EBook", returnType: "KU", loanId: ${JSON.stringify(String(item.loanId))}}`)
        .join(', ');
    return {
        query: `mutation BulkReturnBorrowMutation { mycdBulkReturnBorrow(input: [${input}]) { success } }`,
        operationName: 'BulkReturnBorrowMutation',
    };
}

export function kindleReaderApiToken(html) {
    const text = String(html || '');
    const pick = (attribute) => {
        for (const tag of text.matchAll(/<meta\b[^>]*>/gi)) {
            if (!attribute.test(tag[0])) continue;
            const content = /\bcontent="([^"]*)"/i.exec(tag[0]);
            if (content) return content[1];
        }
        return null;
    };
    return pick(/\bid="kindle-reader-api"/i) ?? pick(/\bname="anti-csrftoken-a2z"/i);
}
