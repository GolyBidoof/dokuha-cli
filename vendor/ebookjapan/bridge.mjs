/**
 * Minimal client for a local mokuro-bridge server.
 *
 * Mirrors the protocol used by bookwalker-native-downloader/cli/bridge-client.js
 * so both tools speak to the same bridge:
 *
 *   GET  /health
 *   POST /session/start            (multipart: title, reuse_existing)
 *   POST /session/{id}/page        (multipart: page=<bytes>, filename, page_num)
 *   GET  /session/{id}/status      -> pages_received / pages_ocr_done / pages_ocr_pending
 *   POST /session/{id}/finalize    -> NDJSON stream of {stage, message, ...}
 *
 * No browser, no cookies: plain HTTP against 127.0.0.1.
 */
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';

/**
 * Client-side politeness. The bridge throttles itself with semaphores rather
 * than returning 429, so pacing is our job. These are deliberately conservative:
 * the measured cost of a push is only a few ms, so a small inter-request cooldown
 * costs almost nothing in wall time while keeping us from hammering the server.
 */
export const COOLDOWN = {
  minIntervalMs: 60,      // floor between consecutive bridge requests
  pushConcurrency: 4,     // parallel page pushes
  retryBaseMs: 250,       // backoff base for 429/5xx
  retryMaxMs: 15000,
  retries: 4,
  pollMinMs: 2000,        // OCR status poll floor
  pollMaxMs: 15000,       // grows to this while nothing changes
};

const DEFAULT_CANDIDATES = [
  'http://127.0.0.1:62642',
  'http://127.0.0.1:63442',
  'http://127.0.0.1:63443',
];

export function bridgeCandidates(explicit) {
  const list = [
    explicit,
    process.env.BWDD_BRIDGE_URL,
    process.env.MOKURO_BRIDGE_URL,
    ...DEFAULT_CANDIDATES,
  ].filter(v => typeof v === 'string' && v.length);
  return [...new Set(list.map(v => v.replace(/\/+$/, '')))];
}

/** Pick the first candidate whose /health reports ok. */
export async function discoverBridge(explicit, { timeoutMs = 3000 } = {}) {
  for (const baseUrl of bridgeCandidates(explicit)) {
    try {
      const r = await request(baseUrl, 'GET', '/health', { timeoutMs, json: true });
      if (r.status === 200 && r.json && (r.json.status === 'ok' || r.json.app === 'mokuro-bridge')) {
        return { baseUrl, health: r.json };
      }
    } catch { /* try the next candidate */ }
  }
  return null;
}

// One keep-alive pool per protocol: the bridge is a single local host, so
// reusing sockets matters more than parallelism.
const httpAgent = new http.Agent({ keepAlive: true, maxSockets: 8, maxFreeSockets: 4 });
const httpsAgent = new https.Agent({ keepAlive: true, maxSockets: 8, maxFreeSockets: 4 });

/** Serialises request starts so we never exceed COOLDOWN.minIntervalMs. */
let lastRequestAt = 0;
let gate = Promise.resolve();
function pace() {
  const p = gate.then(async () => {
    const wait = COOLDOWN.minIntervalMs - (Date.now() - lastRequestAt);
    if (wait > 0) await new Promise(r => setTimeout(r, wait));
    lastRequestAt = Date.now();
  });
  gate = p.catch(() => {});
  return p;
}

const sleepMs = ms => new Promise(r => setTimeout(r, ms));

function request(baseUrl, method, pathname, opts = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(pathname, baseUrl + '/');
    const mod = url.protocol === 'https:' ? https : http;
    const headers = { ...(opts.headers || {}) };
    if (opts.body) headers['Content-Length'] = Buffer.byteLength(opts.body);

    const req = mod.request(url, {
      method, headers,
      agent: opts.agent || (url.protocol === 'https:' ? httpsAgent : httpAgent),
    }, res => {
      const chunks = [];
      res.setEncoding(opts.stream ? undefined : 'utf8');
      if (opts.stream) {
        // streaming NDJSON: hand the raw response to the caller
        resolve({ status: res.statusCode, headers: res.headers, stream: res });
        return;
      }
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const text = chunks.join('');
        let json = null;
        if (opts.json) { try { json = JSON.parse(text); } catch { /* leave null */ } }
        resolve({ status: res.statusCode, headers: res.headers, text, json });
      });
      res.on('error', reject);
    });
    req.setTimeout(opts.timeoutMs || 30_000, () => req.destroy(new Error(`bridge timeout after ${opts.timeoutMs}ms`)));
    req.on('error', reject);
    if (opts.body) req.write(opts.body);
    req.end();
  });
}

/** multipart/form-data body from simple fields (strings) and files (Buffers). */
function multipart(fields, files) {
  const boundary = '----ebj' + Math.random().toString(16).slice(2) + Date.now().toString(16);
  const parts = [];
  for (const [name, value] of Object.entries(fields || {})) {
    parts.push(Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`));
  }
  for (const f of files || []) {
    parts.push(Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="${f.name}"; filename="${f.filename}"\r\n` +
      `Content-Type: ${f.contentType || 'application/octet-stream'}\r\n\r\n`));
    parts.push(f.data);
    parts.push(Buffer.from('\r\n'));
  }
  parts.push(Buffer.from(`--${boundary}--\r\n`));
  return { body: Buffer.concat(parts), contentType: `multipart/form-data; boundary=${boundary}` };
}

/**
 * Run `fn` under the pacing gate, retrying 429/5xx with exponential backoff and
 * jitter (honouring Retry-After when the bridge sends one).
 */
async function retrying(label, fn) {
  let lastErr;
  for (let a = 0; a <= COOLDOWN.retries; a++) {
    await pace();
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      const m = /\b(429|5\d\d)\b/.exec(e.message || '');
      const retryable = Boolean(m) || /ECONNRESET|EPIPE|socket hang up|timeout/i.test(e.message || '');
      if (!retryable || a >= COOLDOWN.retries) break;
      const backoff = Math.min(COOLDOWN.retryMaxMs, COOLDOWN.retryBaseMs * 2 ** a) * (0.5 + Math.random());
      await sleepMs(backoff);
    }
  }
  // Re-throw the original error with context, so callers keep custom flags
  // such as alreadyOcr (a rebuilt Error would silently drop them).
  if (lastErr instanceof Error) {
    lastErr.message = `${label}: ${lastErr.message}`;
    throw lastErr;
  }
  throw new Error(`${label}: ${lastErr}`);
}

export class BridgeClient {
  constructor(baseUrl) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
  }

  async health(opts) { return request(this.baseUrl, 'GET', '/health', { ...opts, json: true }); }

  /** Configured upload destinations + which one the bridge considers default. */
  async destinations({ timeoutMs = 5000 } = {}) {
    const r = await request(this.baseUrl, 'GET', '/upload-methods', { timeoutMs, json: true });
    if (r.status !== 200) throw new Error(`upload-methods ${r.status}`);
    return r.json;
  }

  /**
   * Start (or resume) a volume session.
   *
   * `reuseExisting` resumes a session that already holds pages — which is what
   * makes re-runs cheap, since the bridge caches OCR per page. A session that is
   * mid-finalize or already finalized cannot be resumed (the bridge answers 400
   * "Session is finalizing or already finalized"), so retry once without reuse.
   */
  async startSession(title, { reuseExisting = false, timeoutMs = 15000 } = {}) {
    const post = async reuse => {
      const { body, contentType } = multipart(
        { title: String(title || 'manga'), reuse_existing: reuse ? 'true' : 'false' });
      return request(this.baseUrl, 'POST', '/session/start',
        { body, headers: { 'Content-Type': contentType }, timeoutMs, json: true });
    };
    let r = await post(reuseExisting);
    if (reuseExisting && r.status === 400 && /finalizing or already finalized/i.test(r.text || '')) {
      r = await post(false);   // fresh session
    }
    if (r.status !== 200) throw new Error(`session/start ${r.status}: ${(r.text || '').slice(0, 200)}`);
    return r.json;
  }

  async pushPage(sessionId, data, filename, pageNumber, { timeoutMs = 60000, contentType = 'image/webp' } = {}) {
    const safe = String(filename || `page_${String(pageNumber).padStart(3, '0')}.webp`).replace(/[^A-Za-z0-9._-]/g, '_');
    const { body, contentType: ct } = multipart(
      { filename: safe, page_num: String(pageNumber || 0) },
      [{ name: 'page', filename: safe, data, contentType }]);
    return retrying(`page ${pageNumber}`, async () => {
      const r = await request(this.baseUrl, 'POST', `/session/${encodeURIComponent(sessionId)}/page`,
        { body, headers: { 'Content-Type': ct }, timeoutMs, json: true });
      if (r.status !== 200 && r.status !== 201) {
        // Re-pushing a page the bridge has already OCR'd is an idempotent
        // no-op, not a failure: mark it so callers can count it as cached.
        if (r.status === 409 && /already has completed OCR/i.test(r.text || '')) {
          const e = new Error(`page ${pageNumber} already OCR'd`);
          e.alreadyOcr = true;
          throw e;
        }
        throw new Error(`${r.status}: ${(r.text || '').slice(0, 160)}`);
      }
      return r.json;
    });
  }

  /** Poll status until OCR has no pending pages, with a growing cooldown. */
  async waitForOcr(sessionId, { onProgress, deadline = Infinity, minMs = COOLDOWN.pollMinMs, maxMs = COOLDOWN.pollMaxMs } = {}) {
    let interval = minMs;
    let lastKey = '';
    for (;;) {
      let st = null;
      try { st = await this.status(sessionId); } catch { /* transient */ }
      if (st) {
        if (onProgress) onProgress(st);
        const pending = st.pages_ocr_pending || 0;
        if (pending === 0 && (st.pages_ocr_done || 0) > 0) return st;
        if (pending === 0 && (st.pages_ocr_failed || 0) > 0) return st;
        // Back off while nothing is changing, snap back when progress happens.
        const key = `${st.pages_ocr_done}/${st.pages_received}`;
        interval = key === lastKey ? Math.min(maxMs, Math.round(interval * 1.5)) : minMs;
        lastKey = key;
      }
      if (Date.now() > deadline) return st;
      await sleepMs(interval);
    }
  }

  async status(sessionId, { timeoutMs = 5000 } = {}) {
    const r = await request(this.baseUrl, 'GET', `/session/${encodeURIComponent(sessionId)}/status`,
      { timeoutMs, json: true });
    if (r.status !== 200) throw new Error(`status ${r.status}`);
    return r.json;
  }

  /**
   * Stream the NDJSON finalize progress. Calls onEvent for each {stage,...}.
   * Resolves with the final `done` event.
   */
  finalize(sessionId, { localDir, uploadMethod, forceMega, deleteAfterUpload = true, overwrite = null, timeoutMs = 60 * 60 * 1000, onEvent, signal } = {}) {
    const form = new URLSearchParams();
    if (uploadMethod) form.set('upload_method', String(uploadMethod));
    if (localDir) form.set('local_dir', String(localDir));
    if (forceMega) form.set('upload_to_mega', 'true');
    form.set('delete_after_upload', deleteAfterUpload === false ? 'false' : 'true');
    // Bridge default is "fail", which makes any retry die with "destination
    // already exists"; expose it so re-runs can be idempotent.
    if (overwrite) form.set('overwrite', String(overwrite));
    const body = Buffer.from(form.toString());

    return new Promise((resolve, reject) => {
      const url = new URL(`/session/${encodeURIComponent(sessionId)}/finalize`, this.baseUrl + '/');
      const mod = url.protocol === 'https:' ? https : http;
      const req = mod.request(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Content-Length': body.length,
          Accept: 'application/x-ndjson',
        },
      }, res => {
        if (res.statusCode !== 200) {
          const chunks = [];
          res.on('data', c => chunks.push(c));
          res.on('end', () => reject(new Error(`finalize ${res.statusCode}: ${Buffer.concat(chunks).toString().slice(0, 300)}`)));
          return;
        }
        let buf = '';
        let done = null;
        res.setEncoding('utf8');
        res.on('data', chunk => {
          buf += chunk;
          const lines = buf.split(/\r?\n/);
          buf = lines.pop() || '';
          for (const line of lines) handle(line);
        });
        res.on('end', () => { if (buf.trim()) handle(buf); resolve(done); });
        const handle = line => {
          if (!line.trim()) return;
          let ev; try { ev = JSON.parse(line); } catch { return; }
          if (onEvent) try { onEvent(ev); } catch { /* renderer errors must not kill the stream */ }
          if (ev.stage === 'error') reject(new Error(ev.message || ev.error || 'bridge finalize failed'));
          if (ev.stage === 'done') done = ev;
        };
      });
      req.setTimeout(timeoutMs, () => req.destroy(new Error(`finalize timeout after ${timeoutMs}ms`)));
      req.on('error', reject);
      if (signal) signal.addEventListener('abort', () => req.destroy(new Error('cancelled')), { once: true });
      req.write(body);
      req.end();
    });
  }
}

export function readFileBuffer(p) { return fs.readFileSync(p); }

/**
 * Resolve a user-facing destination into finalize parameters.
 *
 *   dest "local"          -> keep on disk (local_dir = folder, or bridge default)
 *   dest "mega"           -> MEGA default account
 *   dest "drive"          -> Google Drive
 *   dest "onedrive"       -> OneDrive
 *   dest "mega:work"      -> a named account (per-account roots are server-side)
 *   dest "default"|null   -> whatever the bridge was last told to use
 *
 * The bridge owns folders/roots per account, so we only choose the *method*; the
 * only client-side folder is `local_dir`, which must sit under $HOME or $TMPDIR.
 */
export async function resolveDestination(client, { dest = null, folder = null } = {}) {
  const info = await client.destinations();
  const methods = info.methods || [];
  const configured = methods.filter(m => m.configured).map(m => m.id);
  const fallback = info.upload_method_default || 'local';

  let method = (dest || 'default').trim().toLowerCase();
  if (method === 'default' || method === 'last' || method === 'bridge') method = fallback;

  // "mega" / "local" / "drive:main" / "onedrive:uni-2"
  const base = method.split(':')[0];
  if (base !== 'local' && !configured.includes(method)) {
    throw new Error(
      `destination "${dest}" is not configured on the bridge ` +
      `(available: ${configured.join(', ') || 'none'})`);
  }
  if (base === 'local' && !configured.includes('local')) {
    throw new Error('the bridge has no local output configured');
  }

  const params = { uploadMethod: method === 'local' ? 'local' : method };
  if (method === 'local' && folder) params.localDir = folder;
  return { method, params, available: configured, defaultMethod: fallback,
           currentFolder: (methods.find(m => m.id === method) || {}).current_folder || null };
}

/** One-line human summary of the destinations the bridge offers. */
export function describeDestinations(info) {
  const methods = (info && info.methods) || [];
  const def = (info && (info.upload_method_selected || info.upload_method_default)) || 'local';
  return methods
    .filter(m => m.configured)
    .map(m => `${m.id}${m.id === def ? '*' : ''}${m.current_folder ? ` (${m.current_folder})` : ''}`)
    .join(', ');
}
