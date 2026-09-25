/**
 * BookWalker viewer protocol — crypto & descramble primitives.
 *
 * A faithful Node port of the tile-descramble + configuration_pack.json
 * decryption from GolyBidoof/bookwalker-native-downloader (MIT), which itself
 * was validated byte-for-byte against live HAR captures. Identifier names
 * (A8j, A3b, B2y, a3f, A9p, …) are the original minified-viewer names,
 * preserved verbatim to avoid silent drift.
 *
 * Three pieces:
 *   1. decodeConfig(text)  — decrypt the custom-base64 configuration_pack.json
 *                            envelope → page manifest JSON (+ k1/k2/k3 keys).
 *   2. pageSeeds(...)      — per-page descramble seeds from the manifest.
 *   3. descramblePage(rgba, w, h, seeds) — reverse the 32×32 tile shuffle on
 *                            raw RGBA pixels; crop to the declared Size.
 *   4. b8gNo(pageId, k1, k2, k3, no) — CDN image filename token.
 *
 * Pure functions only — no DOM, no fetch. Block moves run on typed arrays, so
 * this is safe in plain Node.
 */

'use strict';

// --- Shared helpers ---------------------------------------------------------

function arraySwap(arr, a, b) {
    const t = arr[a];
    arr[a] = arr[b];
    arr[b] = t;
}

// --- Custom base64 decode (A8j) --------------------------------------------
// BookWalker's base64 alphabet is the standard A-Z a-z 0-9 + / set, but the
// decode uses shifted bit masks per byte position.
const ARR1 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'.split('');
const ARR2 = ARR1.map((c) => c.charCodeAt(0));
const v4 = [], v5 = [], v6 = [], v7 = [], v8 = [], v9 = [], vak = [];
for (let i = 0; i < 64; i++) {
    const ch = ARR2[i];
    v4[ch] = i; v5[ch] = i << 2; v6[ch] = (i << 4) & 255;
    v7[ch] = (i << 6) & 255; v8[ch] = i >> 2; v9[ch] = i >> 4; vak[ch] = true;
}
const A8f = [v4, v5, v6, v7, v8, v9, vak];

// Decode the custom base64 payload between dataOffset..dataEndOffset.
// Returns [decodedBytes, decodedLength, key1, key2, key3] where the keys are
// the first 128 chars split into three 32-byte registers.
function A8j(content, dataOffset, dataEndOffset) {
    const arrayLength = 32, keyDataLength = 128;
    const payloadOffset = dataOffset + keyDataLength;
    const payloadLength = dataEndOffset - payloadOffset;
    if (payloadLength & 3) throw new Error('Invalid A8j payload length');
    const k1 = new Array(arrayLength), k2 = new Array(arrayLength), k3 = new Array(arrayLength);
    for (let i = dataOffset, active = k1, ai = 0; i < payloadOffset;) {
        const a = content.charCodeAt(i++), b = content.charCodeAt(i++), c = content.charCodeAt(i++), d = content.charCodeAt(i++);
        if (!(A8f[6][a] && A8f[6][b] && A8f[6][c] && A8f[6][d])) throw new Error('Corrupted A8j characters');
        active[ai++] = A8f[1][a] | A8f[5][b];
        if (i === dataOffset + 88) { active = k3; ai = 0; }
        active[ai++] = A8f[2][b] | A8f[4][c];
        if (i === dataOffset + 44) { active = k2; ai = 0; }
        active[ai++] = A8f[3][c] | A8f[0][d];
    }
    if (payloadLength === 0) return [new Uint8Array(0), 0, k1, k2, k3];
    let resultLength = (payloadLength * 3) >> 2;
    if (content.charCodeAt(dataEndOffset - 2) === 61) resultLength -= 2;
    else if (content.charCodeAt(dataEndOffset - 1) === 61) resultLength -= 1;
    const result = new Uint8Array(resultLength);
    let off = payloadOffset, idx = 0;
    for (; off < dataEndOffset - 4;) {
        const c1 = content.charCodeAt(off++), c2 = content.charCodeAt(off++), c3 = content.charCodeAt(off++), c4 = content.charCodeAt(off++);
        if (!(A8f[6][c1] && A8f[6][c2] && A8f[6][c3] && A8f[6][c4])) throw new Error('A8j char failure');
        result[idx++] = A8f[1][c1] | A8f[5][c2];
        result[idx++] = A8f[2][c2] | A8f[4][c3];
        result[idx++] = A8f[3][c3] | A8f[0][c4];
    }
    const u = content.charCodeAt(off++), v = content.charCodeAt(off++), w = content.charCodeAt(off++), x = content.charCodeAt(off++);
    if (!A8f[6][u] || !A8f[6][v]) throw new Error('A8j tail parsing error');
    result[idx++] = A8f[1][u] | A8f[5][v];
    if (A8f[6][w]) {
        result[idx++] = A8f[2][v] | A8f[4][w];
        if (A8f[6][x]) result[idx++] = A8f[3][w] | A8f[0][x];
        else if (x !== 61) throw new Error('A8j tail alignment error');
    } else if (w !== 61 || x !== 61) throw new Error('A8j tail padding error');
    return [result, resultLength, k1, k2, k3];
}

// --- RC4-variant key schedule (A3b / B0p / A7L / A6I / A2F / B0L / tB0l) ----

function a0F(input) {
    const result = new Array(256).fill(0).map((_, i) => i);
    const get = typeof input === 'string' ? input.charCodeAt.bind(input) : (i) => input[i];
    for (let c = 0, i = 0; i < 256; i++) {
        c = (c + result[i] + get(i % input.length)) % 256;
        arraySwap(result, i, c);
    }
    return result;
}

function a0g(key, b) {
    const result = [], g = a0F(b);
    for (let i = 0, c = 0, d = 0; i < key.length; i++) {
        c = (c + 1) % 256;
        d = (d + g[c]) % 256;
        arraySwap(g, c, d);
        result.push(key[i] ^ g[(g[c] + g[d]) % 256]);
    }
    return result;
}

const v_qmi = (p1, p2, p3) => a0F([...p1, ...p2, ...p3]);
const v_smi = (content, p1, p2, p3) => a0g(content, [...p1, ...p2, ...p3]);

function step(v7, v8, i, key, content) {
    v7 = (v7 + 1) % 256;
    v8 = (v8 + key[v7]) % 256;
    arraySwap(key, v7, v8);
    content[i] ^= key[(key[v7] + key[v8]) % 256];
    return [v7, v8];
}

function processContentStep(st, key, i) {
    const [content, clen, k1, k2, k3] = st;
    let v7 = 0, v8 = 0;
    for (; i >= 0; i -= 2) [v7, v8] = step(v7, v8, i, key, content);
    return [content, clen, k1, k2, k3];
}

function check1(n, m) { return (n & m) === m; }

function process1(v0, v1, key) {
    for (let i = 0; i < 32; i++) { v0 = (v0 + key[i]) & 255; v1 ^= key[i]; }
    return [v0, v1];
}

function process2(y, u, g) {
    for (let v = y; u > y; u--, v--) arraySwap(g, u, v);
}

function A3b(of, st) {
    let [content, clen, k1, k2, k3] = st;
    let jki, kki, lki, mki, nki;
    switch (of) {
        case 3: jki = k1; kki = 32; lki = k2; mki = k3; nki = null; break;
        case 2: jki = k2; kki = 32; lki = k1; mki = k3; nki = null; break;
        case 1: jki = k3; kki = 32; lki = k1; mki = k2; nki = null; break;
        default: jki = content; kki = clen; lki = k1; mki = k2; nki = k3;
    }
    let [w0, x1] = process1(0, 0, lki);
    [w0, x1] = process1(w0, x1, mki);
    if (nki) [w0, x1] = process1(w0, x1, nki);
    const f2 = !check1(w0, 2), f4 = !check1(w0, 4), f8 = !check1(w0, 8);
    const s5 = x1 >>> 5, s6 = 8 - s5;
    let p7 = 0;
    const gli = [];
    for (let pli, qli, rli, sli, tli, uli, wli, xli, zli; p7 < kki;) {
        for (
            pli = p7 + 32, qli = pli > kki,
                qli ? ((pli = kki), (rli = pli - p7)) : (rli = 32),
                wli = w0, xli = x1, tli = 0, uli = p7;
            tli < rli;
        ) {
            sli = jki[uli++];
            if (f2) sli = ((sli & 85) << 1) | ((sli >>> 1) & 85);
            if (f4) sli = ((sli & 51) << 2) | ((sli >>> 2) & 51);
            if (f8) sli = ((sli & 15) << 4) | ((sli >>> 4) & 15);
            gli[tli++] = sli;
            wli = (wli + sli) & 255;
            xli ^= sli;
        }
        for (let j = 0; j < rli; j++) {
            for (let i = 1; i <= 6; i++) {
                const a = Math.pow(2, i);
                if (!check1(j, a - 1)) break;
                if (!check1(wli, a)) process2(j - Math.pow(2, i - 1), j, gli);
            }
        }
        zli = xli >>> 3;
        qli ? (zli %= rli) : (zli &= 31);
        if (s5 === 0) {
            for (let i = p7, j = rli - zli; i < pli;) {
                if (j === rli) j = 0;
                jki[i++] = gli[j++];
            }
        } else {
            for (let i = p7, j = rli - zli - 1; i < pli;) {
                sli = gli[j] << s6;
                if (++j === rli) j = 0;
                sli |= gli[j] >>> s5;
                jki[i++] = sli & 255;
            }
        }
        p7 = pli;
    }
    return [content, clen, k1, k2, k3];
}

function B0p(fk, st) {
    const [content, clen, k1, k2, k3] = st;
    const key = v_qmi(k2, fk, k3);
    for (let off = 0, omi = 0; off < clen; omi %= 256) content[off++] ^= key[omi++];
    return [content, clen, k1, k2, k3];
}

function A7L(fk, st) {
    const [content, clen, k1, k2, k3] = st;
    const i = (clen | 1) - 2;
    const key = v_qmi(fk, k1, k2);
    return processContentStep([content, clen, k1, k2, k3], key, i);
}

function A6I(fk, st) {
    const [content, clen, k1, k2, k3] = st;
    const i = (clen - 1) & -2;
    const key = v_qmi(k3, fk, k1);
    return processContentStep([content, clen, k1, k2, k3], key, i);
}

function A2F(st) {
    const [content, clen, k1, k2, k3] = st;
    const dmi = Math.min(32, clen);
    let a, b;
    for (let i = 0; i < dmi; i++) {
        const x = content[i] ^ k1[i] ^ k2[i] ^ k3[i];
        switch (x & 12) { case 0: a = k1[i]; break; case 4: a = k2[i]; break; case 8: a = k3[i]; break; case 12: a = content[i]; }
        switch (x & 3) {
            case 0: b = k1[i]; k1[i] = a; break;
            case 1: b = k2[i]; k2[i] = a; break;
            case 2: b = k3[i]; k3[i] = a; break;
            case 3: b = content[i]; content[i] = a;
        }
        switch (x & 12) { case 0: k1[i] = b; break; case 4: k2[i] = b; break; case 8: k3[i] = b; break; case 12: content[i] = b; }
        switch (x & 192) { case 0: a = k1[i]; break; case 64: a = k2[i]; break; case 128: a = k3[i]; break; case 192: a = content[i]; }
        switch (x & 48) {
            case 0: b = k1[i]; k1[i] = a; break;
            case 16: b = k2[i]; k2[i] = a; break;
            case 32: b = k3[i]; k3[i] = a; break;
            case 48: b = content[i]; content[i] = a;
        }
        switch (x & 192) { case 0: k1[i] = b; break; case 64: k2[i] = b; break; case 128: k3[i] = b; break; case 192: content[i] = b; }
    }
    return [content, clen, k1, k2, k3];
}

function B0L(fk, st) {
    let [content, clen, k1, k2, k3] = st;
    k3 = v_smi(k3, k2, k1, fk);
    k2 = v_smi(k2, k1, fk, k3);
    k1 = v_smi(k1, fk, k3, k2);
    return [content, clen, k1, k2, k3];
}

function tB0l(fk, st) {
    const [content, clen, k1, k2, k3] = st;
    const key = v_qmi(k3, k2, fk);
    let v7 = 0, v8 = 0;
    for (let i = 0; i < clen; i++) [v7, v8] = step(v7, v8, i, key, content);
    return [content, clen, k1, k2, k3];
}

function processFilename(filename) { return Array.from(new TextEncoder().encode(filename)); }

function A6e(st) {
    const [content, clen] = st;
    return [new TextDecoder('utf-8').decode(content.slice(0, clen))];
}

/**
 * Decrypt the configuration_pack.json envelope.
 * Returns { config, k1, k2, k3, plaintext } — `config` is the parsed page
 * manifest; k1/k2/k3 are the 32-byte key registers (needed for page seeds +
 * CDN filename tokens). `plaintext` is true when the pack was already plain
 * JSON (trial/sample viewer) with no keys.
 */
function decodeConfig(content) {
    if (typeof content !== 'string' || !content.trim()) {
        throw new Error('Empty configuration pack');
    }
    // Trial/sample packs can arrive as plain JSON (no encrypted envelope).
    if (content.trim().startsWith('{') && !content.includes('"data":"')) {
        try {
            return { config: JSON.parse(content), k1: null, k2: null, k3: null, plaintext: true };
        } catch (e) {
            throw new Error(`Configuration pack is not valid JSON: ${e.message}`);
        }
    }
    const DATA_STR = '"data":"';
    const dataOffset = content.indexOf(DATA_STR) + DATA_STR.length;
    const dataEndOffset = content.indexOf('"', dataOffset);
    if (dataEndOffset - dataOffset < 128) throw new Error('Configuration pack format invalid or truncated.');
    const fk = processFilename('configuration_pack.json');
    let st = A8j(content, dataOffset, dataEndOffset);
    st = A3b(0, st); st = B0p(fk, st); st = A7L(fk, st); st = A6I(fk, st); st = A2F(st);
    st = B0L(fk, st); st = A3b(1, st); st = A3b(2, st); st = A3b(3, st); st = tB0l(fk, st);
    const [jsonStr] = A6e(st);
    const [contentBytes, , k1, k2, k3] = st;
    void contentBytes;
    return { config: JSON.parse(jsonStr), k1, k2, k3, plaintext: false };
}

// --- Tile shuffle & descramble arithmetic (A9p) -----------------------------

const B2Y_TRIPLES = JSON.parse('[[1,3,10],[1,5,16],[1,5,19],[1,9,29],[1,11,6],[1,11,16],[1,19,3],[1,21,20],[1,27,27],[2,5,15],[2,5,21],[2,7,7],[2,7,9],[2,7,25],[2,9,15],[2,15,17],[2,15,25],[2,21,9],[3,1,14],[3,3,26],[3,3,28],[3,3,29],[3,5,20],[3,5,22],[3,5,25],[3,7,29],[3,13,7],[3,23,25],[3,25,24],[3,27,11],[4,3,17],[4,3,27],[4,5,15],[5,3,21],[5,7,22],[5,9,7],[5,9,28],[5,9,31],[5,13,6],[5,15,17],[5,17,13],[5,21,12],[5,27,8],[5,27,21],[5,27,25],[5,27,28],[6,1,11],[6,3,17],[6,17,9],[6,21,7],[6,21,13],[7,1,9],[7,1,18],[7,1,25],[7,13,25],[7,17,21],[7,25,12],[7,25,20],[8,7,23],[8,9,23],[9,5,14],[9,5,25],[9,11,19],[9,21,16],[10,9,21],[10,9,25],[11,7,12],[11,7,16],[11,17,13],[11,21,13],[12,9,23],[13,3,17],[13,3,27],[13,5,19],[13,17,15],[14,1,15],[14,13,15],[15,1,29],[17,15,20],[17,15,23],[17,15,26]]');

const XSHIFT = [
    (p1, p2, p3, p4) => { p1 ^= p1 << p2; p1 ^= p1 >>> p3; p1 ^= p1 << p4; return p1; },
    (p1, p2, p3, p4) => { p1 ^= p1 << p4; p1 ^= p1 >>> p3; p1 ^= p1 << p2; return p1; },
    (p1, p2, p3, p4) => { p1 ^= p1 >>> p2; p1 ^= p1 << p3; p1 ^= p1 >>> p4; return p1; },
    (p1, p2, p3, p4) => { p1 ^= p1 >>> p4; p1 ^= p1 << p3; p1 ^= p1 >>> p2; return p1; },
    (p1, p2, p3, p4) => { p1 ^= p1 << p2; p1 ^= p1 << p4; p1 ^= p1 >>> p3; return p1; },
    (p1, p2, p3, p4) => { p1 ^= p1 >>> p2; p1 ^= p1 >>> p4; p1 ^= p1 << p3; return p1; },
];

const B2Y_SEED = 2463534242;

class B2y {
    constructor() {
        this.vk = 0; this.j = B2Y_SEED;
        this.l = B2Y_TRIPLES[74][this.vk++];
        this.m = B2Y_TRIPLES[74][this.vk++];
        this.n = B2Y_TRIPLES[74][this.vk++];
        this.f = XSHIFT[0];
    }
    b9es(E, L) {
        this.j = B2Y_SEED;
        const p = B2Y_TRIPLES[E];
        this.l = p[0]; this.m = p[1]; this.n = p[2]; this.f = XSHIFT[L];
    }
    B0o(p1) {
        const r = p1 >>> 0;
        this.j = r || B2Y_SEED;
    }
    b4K(p1) {
        if (p1 <= 1) return 0;
        const vv = 4294967295 - p1;
        let u = this.j, t, s;
        do {
            u = this.f(u, this.l, this.m, this.n) >>> 0;
            t = u - 1;
            s = t % p1;
        } while (vv < t - s);
        this.j = u;
        return s;
    }
}
B2y.b6o = B2Y_TRIPLES.length;
B2y.b6b = XSHIFT.length;
B2y.b4v = B2y.b6o * B2y.b6b;

function v_mqg(fn, total) {
    const o = [];
    for (let i = 0; i < total; i++) { const n = fn(i + 1); o[i] = o[n]; o[n] = i; }
    return o;
}

function v_6qg(fn, v) { return v < 4 ? fn(v + 1) : fn(v - 1) + 1; }

function v_7qg(fn, ye, ee) { if (ee <= 0) return 0; const r = fn(ee); return r < ye ? r : r + 1; }

function v_9qg(fn, p2, p3, p4, p5, p6, p7) {
    for (let a, b, c, d = p6, e = p7, f = p4, g = p5, h = 0, i = 0, j = -1; d + e > 0;) {
        const k = 0, l = j;
        a = fn(d + e);
        if (a < d) {
            if (a < f) {
                for (b = i; b > k && !(h >= p2[b + l]); b--);
                for (c = i + e; c < p7 && !(h >= p2[c]); c++);
                p3[h] = fn(c - b) + b;
                h++; f--;
            } else {
                for (b = i; b > k && !(h + d <= p2[b + l]); b--);
                for (c = i + e; c < p7 && !(h + d <= p2[c]); c++);
                p3[h + d + l] = fn(c - b) + b;
            }
            d--;
        } else {
            if (a - d < g) {
                for (b = h; b > k && !(i >= p3[b + l]); b--);
                for (c = h + d; c < p6 && !(i >= p3[c]); c++);
                p2[i] = fn(c - b) + b;
                i++; g--;
            } else {
                for (b = h; b > k && !(i + e <= p3[b + l]); b--);
                for (c = h + d; c < p6 && !(i + e <= p3[c]); c++);
                p2[i + e + l] = fn(c - b) + b;
            }
            e--;
        }
    }
}

function v_qpg(p1, p2, p3, p4, p5, p6, p7, p8, p9, p10, p11, p12, p13) {
    const result = [], q1 = p1 + 1, q2 = p2 + 1, q3 = q1 << 1, q4 = q2 << 1;
    for (let v = 0; v < p1; v++) for (let w = 0; w < p2; w++) {
        const z = p3[v + w * p1], x = z % p1, y = (z - x) / p1;
        const r = v < p11[w] ? v : v + q1;
        const s = w < p10[v] ? w : w + q2;
        const t = x < p7[y] ? x : x + q1;
        const u = y < p6[x] ? y : y + q2;
        result.push(u * q3 + r);
        result.push(t * q4 + s);
    }
    result.push(p9 * q3 + p12);
    result.push(p8 * q4 + p13);
    for (let v = 0; v < p1; v++) {
        const x = p4[v], r = v < p12 ? v : v + q1, t = x < p8 ? x : x + q1;
        result.push(p6[x] * q3 + r);
        result.push(t * q4 + p10[v]);
    }
    for (let w = 0; w < p2; w++) {
        const y = p5[w], s = w < p13 ? w : w + q2, u = y < p9 ? y : y + q2;
        result.push(u * q3 + p11[w]);
        result.push(p7[y] * q4 + s);
    }
    return result;
}

function a3f(p1, p2, p3, p4) {
    const tog = new B2y();
    const uog = p2 ^ p3 ^ p4;
    const vog = Math.floor(p1 / 65536);
    const wog = Math.floor(p2 / 65536);
    const xog = Math.floor(p3 / 65536);
    const yog = Math.floor(p4 / 65536);
    const zo = B2y.b6o, zp = B2y.b6b;
    let q1 = wog ^ xog ^ yog, q2 = vog ^ yog, q3 = p1 ^ p2, q4 = p1 ^ p3, q5 = p1 ^ p4;
    q1 >>>= 16;
    const r6 = q1 % zp, r7 = ((q1 - r6) / zp) % zo;
    const b4k = tog.b4K.bind(tog);
    tog.b9es(r7, r6);
    tog.B0o(uog);
    const r9 = b4k(65536) | (b4k(65536) << 16);
    const apg = b4k(512);
    const bpg = wog >>> 16, cpg = xog >>> 16;
    q2 = (q2 >>> 16) ^ apg;
    q3 = (q3 ^ r9) >>> 0;
    q4 = (q4 ^ r9) >>> 0;
    q5 = (q5 ^ r9) >>> 0;
    const dpg = q2 % zp, epg = ((q2 - dpg) / zp) % zo;
    tog.b9es(epg, dpg);
    tog.B0o(q3);
    const fpg = v_mqg(b4k, bpg * cpg);
    tog.B0o(q4);
    const gpg = v_6qg(b4k, bpg), hpg = v_6qg(b4k, cpg);
    const ipg = v_7qg(b4k, gpg, bpg), jpg = v_7qg(b4k, hpg, cpg);
    tog.B0o(q5);
    const kpg = [], lpg = [];
    v_9qg(b4k, kpg, lpg, gpg, hpg, bpg, cpg);
    const mpg = v_mqg(b4k, bpg), npg = v_mqg(b4k, cpg);
    const opg = [], ppg = [];
    v_9qg(b4k, ppg, opg, ipg, jpg, bpg, cpg);
    return v_qpg(bpg, cpg, fpg, mpg, npg, opg, ppg, ipg, jpg, lpg, kpg, gpg, hpg);
}

/**
 * Compute the block-move list to reassemble one scrambled page.
 * page: { b8A: BlockWidth, b6V: BlockHeight, B0J, B0K, B0n, B0A }
 * width/height: the actual decoded bitmap size.
 * Returns [{ srcX, srcY, destX, destY, width, height }].
 */
function A9p(page, width, height) {
    const bw = page.b8A, bh = page.b6V;
    const r = page.B0J, s = page.B0K, t = page.B0n, u = page.B0A;
    const vo = B2y.b6o, wo = B2y.b6b;
    const bx = Math.floor(width / bw), by = Math.floor(height / bh);
    const lbw = width % bw, lbh = height % bh;
    const d14 = (bx + 1) << 1, d24 = (by + 1) << 1;
    const lxvs = (bx + 1) * bw - lbw, lyvs = (by + 1) * bh - lbh;
    const b54 = new B2y();
    const b64 = u ^ bx ^ by;
    const b74 = b64 % wo, b84 = ((b64 - b74) / wo) % vo;
    const out = [];
    b54.b9es(b84, b74);
    b54.B0o(r ^ s ^ t);
    const b94 = b54.b4K(65536) + b54.b4K(65536) * 65536 + b54.b4K(512) * 4294967296;
    const a4j = bx * 4294967296 + r, b4j = by * 4294967296 + s, c4j = u * 4294967296 + t;
    const d4j = a3f(b94, a4j, b4j, c4j);
    const e4j = (index, total, sbw, sbh) => {
        if (sbw !== 0 && sbh !== 0) for (; index < total;) {
            const f = d4j[index++], g = d4j[index++];
            const h = f % d14, i = g % d24;
            const j = (g - i) / d24, k = (f - h) / d14;
            out.push({
                srcX: h * bw - (h > bx ? lxvs : 0),
                srcY: i * bh - (i > by ? lyvs : 0),
                destX: j * bw - (j > bx ? lxvs : 0),
                destY: k * bh - (k > by ? lyvs : 0),
                width: sbw, height: sbh,
            });
        }
    };
    let x = 0, y = bx * by * 2;
    e4j(x, y, bw, bh);
    x = y; y += 2;
    e4j(x, y, lbw, lbh);
    x = y; y += bx * 2;
    e4j(x, y, bw, lbh);
    x = y; y += by * 2;
    e4j(x, y, lbw, bh);
    return out;
}

// --- Per-page seeds ---------------------------------------------------------

function xorHash(key) {
    let nhf = 0, ohf = key.length & -4;
    if (ohf > 32) ohf = 32;
    for (let phf = 0; phf < ohf;) {
        nhf ^= key[phf++] << 24;
        nhf ^= key[phf++] << 16;
        nhf ^= key[phf++] << 8;
        nhf ^= key[phf++] << 0;
    }
    return nhf >>> 0;
}

/**
 * Derive per-page descramble seeds from the manifest.
 * pageId: the contents[].file key (e.g. '../shared/xxx' or 'OEBPS/text/...').
 * pageConfig: config[pageId] manifest section.
 * k1/k2/k3: the 32-byte keys from decodeConfig (null for plaintext/trial).
 * no: page index within the section.
 * Returns { B0A, B0J, B0K, B0n, b8A, b6V, Size, noDescramble }.
 */
function pageSeeds(pageId, pageConfig, k1, k2, k3, no) {
    const list = pageConfig.FileLinkInfo.PageLinkInfoList;
    const Page = (list[no] && list[no].Page) || list[0].Page;
    const NS = Page.NS, PS = Page.PS, RS = Page.RS, No = Page.No;
    let v0 = 47;
    for (let i = 0; i < pageId.length; i++) v0 += pageId.charCodeAt(i);
    const fn = String(no == null ? 0 : no);
    for (let i = 0; i < fn.length; i++) v0 += fn.charCodeAt(i);
    v0 += k1 ? k1.reduce((a, b) => a + b, 0) : 0;
    v0 += k2 ? k2.reduce((a, b) => a + b, 0) : 0;
    v0 += k3 ? k3.reduce((a, b) => a + b, 0) : 0;
    let v9 = v0 & 255;
    v9 |= v9 << 8;
    v9 |= v9 << 16;
    const noDescramble = NS === null || NS === undefined || PS === null || PS === undefined || RS === null || RS === undefined;
    return {
        B0A: v0 % B2y.b4v,
        B0J: (v9 ^ (k1 ? xorHash(k1) : 0) ^ (NS || 0)) >>> 0,
        B0K: (v9 ^ (k2 ? xorHash(k2) : 0) ^ (PS || 0)) >>> 0,
        B0n: (v9 ^ (k3 ? xorHash(k3) : 0) ^ (RS || 0)) >>> 0,
        b8A: Page.BlockWidth,
        b6V: Page.BlockHeight,
        Size: Page.Size,
        noDescramble,
    };
}

/**
 * Reassemble a scrambled page's raw RGBA (Uint8ClampedArray, w*h*4) into a
 * new Uint8ClampedArray of the same size, then optionally crop to the page's
 * declared Size. Returns { data, width, height }.
 */
function descramblePage(rgba, width, height, seeds) {
    const src = rgba;
    const out = new Uint8ClampedArray(src.length);
    if (seeds && !seeds.noDescramble) {
        const tiles = A9p(seeds, width, height);
        const stride = width * 4;
        for (const t of tiles) {
            const sx = t.destX, sy = t.destY, dx = t.srcX, dy = t.srcY;
            const tw = t.width, th = t.height;
            const srcRow = sy * stride + sx * 4;
            const dstRow = dy * stride + dx * 4;
            const len = tw * 4;
            for (let r = 0; r < th; r++) {
                out.set(src.subarray(srcRow + r * stride, srcRow + r * stride + len), dstRow + r * stride);
            }
        }
    } else {
        out.set(src);
    }
    let data = out, w = width, h = height;
    const S = seeds && seeds.Size;
    if (S && S.Width && S.Height && (w !== S.Width || h !== S.Height)) {
        // Crop to declared size: draw the (descrambled) full frame onto a
        // S.Width×S.Height canvas — same as the reference's cropToSize.
        const dw = S.Width, dh = S.Height;
        const cropped = new Uint8ClampedArray(dw * dh * 4);
        const copyW = Math.min(dw, w), copyH = Math.min(dh, h);
        for (let y = 0; y < copyH; y++) {
            cropped.set(
                data.subarray(y * w * 4, y * w * 4 + copyW * 4),
                y * dw * 4
            );
        }
        data = cropped;
        w = dw;
        h = dh;
    }
    return { data, width: w, height: h };
}

// --- CDN image filename token (b8gNo) --------------------------------------

function v_jdf(filename) {
    const n = parseInt(filename, 10);
    if (!isNaN(n) && n >= 0 && n <= 1152921504606847000) {
        const h = n.toString(16);
        return h.length.toString(16) + h;
    }
    return '0' + filename;
}

function v_hdf(k1, k2, k3) {
    const out = [];
    out.length = Math.max(k1.length, k2.length, k3.length);
    for (let i = 0; i < out.length; i++) out[i] = 0;
    for (let i = 0; i < k1.length; i++) out[i] ^= k1[i];
    for (let i = 0; i < k2.length; i++) out[i] ^= k2[i];
    for (let i = 0; i < k3.length; i++) out[i] ^= k3[i];
    return out;
}

const vval = (value) => (value < 10 ? 48 : 87) + value;

function v_ndf(b9w, pageId, fileName) {
    const parentFolder = pageId + '/';
    const pathLength = parentFolder.length + fileName.length;
    const v_bef = (1 + pathLength) << 1;
    const cef = new Array(v_bef);
    cef[0] = 0; cef[1] = 59;
    const def = String.prototype.charCodeAt.bind(parentFolder + fileName);
    for (let p = 2, o = 0; o < pathLength; o++) {
        const s = def(o);
        cef[p++] = s >>> 8;
        cef[p++] = s % 256;
    }
    let fef = 3;
    for (let eef = (fileName.length << 1) + v_bef + v_bef; eef < 256; fef++) eef += v_bef;
    let jef = 1670739, kef = 1282576, lef = 2237221;
    for (let i = (1 + parentFolder.length) << 1, j = 0, k = 0; k < fef; k++, i = 0) {
        for (; i < v_bef;) {
            lef ^= cef[i++] ^ b9w[j++];
            const ief = 435 * lef;
            const hef = 435 * kef + ((lef & 7) << 18) + (ief >>> 22);
            const gef = 435 * jef + ((kef & 3) << 19) + ((lef & 4194296) >>> 3) + (hef >>> 21);
            lef = ief & 4194303;
            kef = hef & 2097151;
            jef = gef & 2097151;
            j >= b9w.length && (j = 0);
        }
    }
    const mef = new Array(16);
    const pval = (idx, value) => { mef[idx] = vval(value >>> 4); mef[idx + 1] = vval(value & 15); };
    pval(0, (jef >>> 13) ^ b9w[0]);
    pval(2, ((jef >>> 5) & 255) ^ b9w[1]);
    pval(4, (((jef & 31) << 3) | (kef >>> 18)) ^ b9w[2]);
    pval(6, ((kef >>> 10) & 255) ^ b9w[3]);
    pval(8, ((kef >>> 2) & 255) ^ b9w[4]);
    pval(10, (((kef & 3) << 6) | (lef >>> 16)) ^ b9w[5]);
    pval(12, ((lef >>> 8) & 255) ^ b9w[6]);
    pval(14, (lef & 255) ^ b9w[7]);
    return String.fromCharCode(...mef);
}

/** Full-edition CDN relative path for page `no` (e.g. 'OEBPS/text/p-0001.xhtml/8123ab…jpeg'). */
function b8gNo(pageId, k1, k2, k3, no) {
    const fname = String(no == null ? 0 : no);
    return pageId + '/' + v_jdf(fname) + v_ndf(v_hdf(k1, k2, k3), pageId, fname) + '.jpeg';
}

module.exports = {
    decodeConfig,
    pageSeeds,
    descramblePage,
    A9p,
    b8gNo,
    // exposed for testing/debugging
    _internals: { A8j, A3b, B0p, A7L, A6I, A2F, B0L, tB0l, B2y, a3f, v_qpg },
};
