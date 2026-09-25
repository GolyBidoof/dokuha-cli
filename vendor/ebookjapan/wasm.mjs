/**
 * Loads the ebookjapan viewer's wasm module under plain Node, with no browser
 * and no Chromium. Node's built-in WebCrypto supplies crypto.subtle.
 *
 * The one non-obvious requirement: the module introspects the environment with
 * `globalThis.window instanceof Window` and then reads `window.crypto`. Node has
 * neither a `Window` constructor nor a `window`/`self` global, so we must define
 * a real Window constructor and make our window object an instance of it.
 * Without that, decrypt_session() traps at wasm offset 0x137f5.
 */
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const HERE = new URL('.', import.meta.url);

export function installBrowserGlobals(origin = 'https://ebookjapan.yahoo.co.jp') {
  const g = globalThis;
  if (!g.crypto || !g.crypto.subtle) throw new Error('Node WebCrypto unavailable');

  function Window() {}
  if (typeof g.Window !== 'function') {
    Object.defineProperty(g, 'Window', { value: Window, configurable: true, writable: true });
  }

  const win = Object.create(Window.prototype);
  Object.assign(win, {
    crypto: g.crypto,
    location: { href: origin + '/' },
    screen: { availHeight: 900 },
    devicePixelRatio: 2,
    document: { createElement: () => ({ getContext: () => null }), addEventListener() {} },
    queueMicrotask: cb => Promise.resolve().then(cb),
  });
  for (const k of ['window', 'self']) {
    Object.defineProperty(g, k, { value: win, configurable: true, writable: true });
  }
  for (const k of ['location', 'screen', 'devicePixelRatio', 'document']) g[k] = win[k];
  return win;
}

/**
 * The glue loads its .wasm through the global fetch, so loadGlue() has to swap
 * the global out temporarily. Two things make that safe:
 *   1. `savedFetch` is captured ONCE, so a nested call can never capture the shim
 *      itself (which would permanently poison the global with wasm bytes).
 *   2. loadGlue() is serialised behind a promise chain, so two concurrent loads
 *      cannot interleave their swap/restore and leave the shim installed during
 *      someone else's network I/O.
 * Callers must still call restoreFetch() before doing real network I/O.
 */
let savedFetch = null;
let loadChain = Promise.resolve();

/** Restore the pre-shim fetch. Safe to call repeatedly. */
export function restoreFetch() {
  if (savedFetch) { globalThis.fetch = savedFetch; savedFetch = null; }
}

export function loadGlue() {
  const run = loadChain.then(async () => {
    installBrowserGlobals();
    const wasmBuf = fs.readFileSync(new URL('br_core_bg.BY49krUo.wasm', HERE));
    if (!savedFetch) savedFetch = globalThis.fetch;   // capture the REAL fetch once
    globalThis.fetch = async () =>
      new Response(wasmBuf, { headers: { 'Content-Type': 'application/wasm' } });
    try {
      const mod = await import(new URL('DIKTQ-Ds2.js', HERE).href);
      await mod.default();
      return mod;
    } finally {
      restoreFetch();
    }
  });
  // keep the chain alive even if this load rejects
  loadChain = run.then(() => {}, () => {});
  return run;
}
