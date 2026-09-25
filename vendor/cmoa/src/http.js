/**
 * HTTP helpers.
 *
 * Node's global fetch is enough for every CMOA endpoint; what is missing is
 * retry/backoff, a request timeout, and control over the connection pool.
 *
 * On the pool: Node's fetch runs through its own undici pool, and undici is not
 * a public module in current Node, so its per-origin connection cap cannot be
 * raised directly. `installSocketPool` is therefore an escape hatch: it builds a
 * plain `node:https` agent with an explicit `maxSockets`, and every subsequent
 * request goes through `https.request` instead. Callers that never install one
 * keep using fetch.
 *
 * Only transient failures are retried. A 403 in particular means the request
 * token was rejected and retrying it unchanged is pointless.
 */

import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

export class HttpError extends Error {
  constructor(status, url, body) {
    super(`HTTP ${status} for ${url}`);
    this.name = 'HttpError';
    this.status = status;
    this.url = url;
    this.body = body;
  }
}

const DEFAULT_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  Accept: 'application/json, text/plain, */*',
  'Accept-Language': 'ja,en-US;q=0.9,en;q=0.8',
};

let socketPool = null;

/**
 * Install an HTTPS connection pool with `maxSockets` sockets per origin.
 * Must be called before any request to take effect.
 *
 * @param {number} maxSockets
 * @param {{keepAliveMsecs?: number}} [options]
 */
export function installSocketPool(maxSockets, options = {}) {
  const https = require('node:https');
  socketPool = {
    maxSockets,
    agent: new https.Agent({
      keepAlive: true,
      keepAliveMsecs: options.keepAliveMsecs ?? 15000,
      maxSockets,
      maxFreeSockets: Math.min(maxSockets, 128),
      scheduling: 'lifo',
    }),
  };
  return socketPool.agent;
}

export function socketPoolInfo() {
  return socketPool ? { maxSockets: socketPool.maxSockets } : null;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** True for failures worth another attempt (network hiccups, 5xx, 429). */
function isTransient(error) {
  if (error instanceof HttpError) {
    return error.status === 429 || error.status >= 500;
  }
  return true;
}

/** One request through the installed pool. */
function pooledRequest(url, headers, binary) {
  const https = require('node:https');
  const http = require('node:http');
  const target = new URL(url);
  const transport = target.protocol === 'http:' ? http : https;
  return new Promise((resolve, reject) => {
    const request = transport.request(
      url,
      { headers, agent: transport === https ? socketPool.agent : undefined },
      (response) => {
        const chunks = [];
        response.on('data', (chunk) => chunks.push(chunk));
        response.on('end', () => {
          const body = Buffer.concat(chunks);
          if (response.statusCode < 200 || response.statusCode >= 300) {
            reject(
              new HttpError(
                response.statusCode,
                url,
                binary ? '' : body.toString('utf8').slice(0, 200),
              ),
            );
            return;
          }
          resolve(binary ? new Uint8Array(body) : body.toString('utf8'));
        });
      },
    );
    request.on('error', reject);
    request.end();
  });
}

async function fetchOnce(url, headers, binary, timeoutMs) {
  const response = await fetch(url, {
    headers,
    signal: AbortSignal.timeout(timeoutMs),
    redirect: 'follow',
  });
  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new HttpError(response.status, url, body.slice(0, 200));
  }
  return binary ? new Uint8Array(await response.arrayBuffer()) : await response.text();
}

/**
 * Fetch a URL with retries.
 *
 * @param {string} url
 * @param {{referer?: string, binary?: boolean, retries?: number,
 *          timeoutMs?: number, headers?: object}} [options]
 */
export async function fetchWithRetry(url, options = {}) {
  const retries = options.retries ?? 3;
  const timeoutMs = options.timeoutMs ?? 45000;
  const headers = { ...DEFAULT_HEADERS };
  if (options.referer) headers.Referer = options.referer;
  if (options.binary) headers.Accept = 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8';
  if (options.headers) Object.assign(headers, options.headers);

  let lastError = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) await sleep(Math.min(4000, 250 * 2 ** (attempt - 1)));
    try {
      return socketPool
        ? await pooledRequest(url, headers, options.binary)
        : await fetchOnce(url, headers, options.binary, timeoutMs);
    } catch (error) {
      if (error instanceof HttpError && !isTransient(error)) throw error;
      lastError = error;
      if (attempt === retries) break;
    }
  }
  throw lastError ?? new Error(`request failed: ${url}`);
}

/** Fetch JSON with retries. */
export async function fetchJson(url, options = {}) {
  const text = await fetchWithRetry(url, options);
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`expected JSON from ${url}: ${String(text).slice(0, 120)}`);
  }
}

export { sleep };
