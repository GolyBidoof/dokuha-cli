import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const ORIGIN = 'https://ebookjapan.yahoo.co.jp';
const ASSETS = `${ORIGIN}/_nuxt/`;
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 '
    + '(KHTML, like Gecko) Chrome/131.0 Safari/537.36';

/**
 * The viewer's WASM glue chunk.
 *
 * A Vite build hash, so it changes when the store redeploys the viewer. It is the
 * only name that has to be known up front: the glue names its own imports and its
 * own `.wasm`, both of which are read out of the file once it arrives. Refreshing
 * it after a redeploy is documented under "ebookjapan viewer assets" in `vendor/README.md`.
 *
 * A missing chunk is reported as an explicit, actionable error rather than a
 * download that fails one page at a time.
 */
const GLUE_CHUNK = 'DIKTQ-Ds2.js';

/** `BWDD_EBOOKJAPAN_GLUE` overrides the chunk name, so a redeploy needs no code edit. */
function glueChunk(env = process.env) {
    const override = String(env.BWDD_EBOOKJAPAN_GLUE || '').trim();
    return override || GLUE_CHUNK;
}

const RELATIVE_IMPORT = /(?:from|import)\s*["'`]\.\/([A-Za-z0-9_$.-]+\.js)["'`]/g;
const WASM_NAME = /br_core_bg\.[A-Za-z0-9_-]+\.wasm/;
const MAX_MODULES = 16;

function assetsDir(env = process.env, home = os.homedir()) {
    return env.BWDD_EBOOKJAPAN_ASSETS || path.join(home, '.bwdd-cli', 'ebookjapan-assets');
}

function once(sink) {
    let said = false;
    return (line) => {
        if (said) return;
        said = true;
        if (typeof sink === 'function') sink(line);
        else process.stderr.write(`${line}\n`);
    };
}

async function get(url, { binary = false, fetchImpl = globalThis.fetch } = {}) {
    const response = await fetchImpl(url, { headers: { 'User-Agent': UA, Accept: '*/*' } });
    if (!response.ok) {
        const hint = response.status === 404
            ? `\n  The store has probably redeployed its viewer, so ${glueChunk()} no longer exists.`
                + '\n  See "ebookjapan viewer assets" in vendor/README.md for how to refresh that name.'
            : '';
        throw new Error(`ebookjapan assets: HTTP ${response.status} for ${url}${hint}`);
    }
    return binary ? Buffer.from(await response.arrayBuffer()) : response.text();
}

async function readCache(dir) {
    const manifest = await fsp.readFile(path.join(dir, 'manifest.json'), 'utf8')
        .then(JSON.parse, () => null);
    if (!manifest?.glue || !manifest?.wasm || !Array.isArray(manifest.files)) return null;
    for (const name of [...manifest.files, manifest.wasm, manifest.glue]) {
        const stat = await fsp.stat(path.join(dir, name)).catch(() => null);
        if (!stat?.size) return null;
    }
    return manifest;
}

async function collect(glueName, fetchImpl) {
    const glueText = await get(ASSETS + glueName, { fetchImpl });
    const wasm = WASM_NAME.exec(glueText)?.[0];
    if (!wasm) {
        throw new Error(`ebookjapan assets: ${glueName} named no WASM module; the viewer build has changed shape`);
    }
    const files = new Map([[glueName, glueText]]);
    const queue = [...glueText.matchAll(RELATIVE_IMPORT)].map((match) => match[1]);
    while (queue.length && files.size < MAX_MODULES) {
        const name = queue.shift();
        if (files.has(name)) continue;
        const text = await get(ASSETS + name, { fetchImpl }).catch(() => null);
        if (text == null) continue;
        files.set(name, text);
        for (const match of text.matchAll(RELATIVE_IMPORT)) {
            if (!files.has(match[1])) queue.push(match[1]);
        }
    }
    const wasmBytes = await get(ASSETS + wasm, { binary: true, fetchImpl });
    return { glue: glueName, wasm, files, wasmBytes };
}

export async function ensureAssets({ fetchImpl = globalThis.fetch, onNote, refresh = false } = {}) {
    const dir = assetsDir();
    const cached = refresh ? null : await readCache(dir);
    if (cached) return { dir, glue: cached.glue, wasm: cached.wasm };

    const say = once(onNote);
    say(`ebookjapan: fetching the viewer's WASM module into ${dir} (one time)`);
    const fetched = await collect(glueChunk(), fetchImpl);
    await fsp.mkdir(dir, { recursive: true });
    for (const [name, text] of fetched.files) {
        await fsp.writeFile(path.join(dir, name), text);
    }
    await fsp.writeFile(path.join(dir, fetched.wasm), fetched.wasmBytes);
    await fsp.writeFile(path.join(dir, 'manifest.json'), `${JSON.stringify({
        origin: ASSETS,
        glue: fetched.glue,
        wasm: fetched.wasm,
        files: [...fetched.files.keys()],
        fetchedAt: new Date().toISOString(),
    }, null, 2)}\n`);
    return { dir, glue: fetched.glue, wasm: fetched.wasm };
}

