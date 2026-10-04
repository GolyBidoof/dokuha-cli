import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { ensureAssets } from './bundles.mjs';

function installBrowserGlobals(origin = 'https://ebookjapan.yahoo.co.jp') {
    const g = globalThis;
    if (!g.crypto || !g.crypto.subtle) throw new Error('Node WebCrypto unavailable');

    function Window() {}
    if (typeof g.Window !== 'function') {
        Object.defineProperty(g, 'Window', { value: Window, configurable: true, writable: true });
    }

    const win = Object.create(Window.prototype);
    Object.assign(win, {
        crypto: g.crypto,
        location: { href: `${origin}/` },
        screen: { availHeight: 900 },
        devicePixelRatio: 2,
        document: { createElement: () => ({ getContext: () => null }), addEventListener() {} },
        queueMicrotask: (cb) => Promise.resolve().then(cb),
    });
    for (const k of ['window', 'self']) {
        Object.defineProperty(g, k, { value: win, configurable: true, writable: true });
    }
    for (const k of ['location', 'screen', 'devicePixelRatio', 'document']) g[k] = win[k];
    return win;
}

let savedFetch = null;
let loadChain = Promise.resolve();

export function restoreFetch() {
    if (savedFetch) {
        globalThis.fetch = savedFetch;
        savedFetch = null;
    }
}

export function loadGlue({ onNote, fetchImpl } = {}) {
    const run = loadChain.then(async () => {
        installBrowserGlobals();
        const assets = await ensureAssets({ fetchImpl, onNote });
        const wasmBuf = fs.readFileSync(path.join(assets.dir, assets.wasm));
        if (!savedFetch) savedFetch = globalThis.fetch;
        globalThis.fetch = async () => new Response(wasmBuf, {
            headers: { 'Content-Type': 'application/wasm' },
        });
        try {
            const mod = await import(pathToFileURL(path.join(assets.dir, assets.glue)).href);
            await mod.default();
            return mod;
        } finally {
            restoreFetch();
        }
    });
    loadChain = run.then(() => {}, () => {});
    return run;
}
