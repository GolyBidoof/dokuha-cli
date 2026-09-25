'use strict';

const http = require('http');
const https = require('https');
const { StringDecoder } = require('string_decoder');
const { BridgeError, errorMessage, isAbortError } = require('./errors');

const DEFAULT_HEALTH_TIMEOUT_MS = 3000;
const DEFAULT_FINALIZE_TIMEOUT_MS = 60 * 60 * 1000;
const MAX_ERROR_BODY_BYTES = 64 * 1024;

function errorDetailFromBody(body) {
    if (!body) return null;
    try {
        const value = JSON.parse(body);
        return value && (value.detail || value.message) ? String(value.detail || value.message) : value;
    } catch (_) {
        return body.slice(0, 2000);
    }
}

class BridgeClient {
    constructor(options = {}) {
        this.baseUrl = String(options.baseUrl || 'http://127.0.0.1:62642').replace(/\/+$/, '');
        this.healthTimeoutMs = options.healthTimeoutMs || DEFAULT_HEALTH_TIMEOUT_MS;
        this.finalizeTimeoutMs = options.finalizeTimeoutMs || DEFAULT_FINALIZE_TIMEOUT_MS;
        this.requestFactory = options.requestFactory || null;
    }

    _transport(url) {
        if (this.requestFactory) return this.requestFactory;
        return url.protocol === 'https:' ? https : http;
    }

    _send(options, responseHandler) {
        const url = new URL(options.path, `${this.baseUrl}/`);
        const timeoutMs = options.timeoutMs || DEFAULT_HEALTH_TIMEOUT_MS;
        const transport = this._transport(url);
        const controller = new AbortController();
        let timedOut = false;
        let settled = false;

        return new Promise((resolve, reject) => {
            let timer;
            const externalSignal = options.signal;
            const cleanup = () => {
                clearTimeout(timer);
                if (externalSignal) externalSignal.removeEventListener('abort', onExternalAbort);
            };
            const fail = error => {
                if (settled) return;
                settled = true;
                cleanup();
                if (timedOut) {
                    reject(new BridgeError(`Mokuro bridge request timed out after ${timeoutMs} ms.`, null, { url: url.toString() }));
                } else if (isAbortError(error)) {
                    reject(error);
                } else {
                    reject(error);
                }
            };
            const succeed = value => {
                if (settled) return;
                settled = true;
                cleanup();
                resolve(value);
            };
            const onExternalAbort = () => {
                const error = new Error('Bridge request cancelled.');
                error.name = 'AbortError';
                controller.abort(error);
            };

            if (externalSignal && externalSignal.aborted) {
                onExternalAbort();
                fail(externalSignal.reason instanceof Error ? externalSignal.reason : new Error('Bridge request cancelled.'));
                return;
            }
            if (externalSignal) externalSignal.addEventListener('abort', onExternalAbort, { once: true });
            timer = setTimeout(() => {
                timedOut = true;
                const error = new Error('Bridge request timed out.');
                error.name = 'AbortError';
                controller.abort(error);
            }, timeoutMs);

            const headers = Object.assign({}, options.headers || {});
            const requestOptions = {
                method: options.method || 'GET',
                headers,
                signal: controller.signal
            };
            if (options.body != null) {
                headers['Content-Length'] = Buffer.byteLength(options.body);
            }

            const request = transport.request(url, requestOptions, response => {
                const status = response.statusCode || 0;
                if (status < 200 || status >= 300) {
                    let size = 0;
                    const chunks = [];
                    response.on('data', chunk => {
                        size += chunk.length;
                        if (size <= MAX_ERROR_BODY_BYTES) chunks.push(chunk);
                    });
                    response.on('end', () => {
                        const body = Buffer.concat(chunks).toString('utf8');
                        const detail = errorDetailFromBody(body);
                        const suffix = detail == null ? '' :
                            ` ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`;
                        fail(new BridgeError(
                            `Mokuro bridge returned HTTP ${status} for ${options.path}.${suffix}`,
                            status,
                            detail
                        ));
                    });
                    response.on('error', fail);
                    return;
                }

                Promise.resolve(responseHandler(response, controller.signal)).then(succeed, error => {
                    try { response.destroy(); } catch (_) { /* already closed */ }
                    fail(error);
                });
            });
            request.on('error', fail);
            if (options.body != null) request.write(options.body);
            request.end();
        });
    }

    _json(response) {
        return new Promise((resolve, reject) => {
            const chunks = [];
            response.on('data', chunk => chunks.push(chunk));
            response.on('end', () => {
                const body = Buffer.concat(chunks).toString('utf8');
                try {
                    resolve(JSON.parse(body));
                } catch (error) {
                    reject(new BridgeError('Mokuro bridge returned invalid JSON.', response.statusCode, body.slice(0, 2000)));
                }
            });
            response.on('error', reject);
        });
    }

    async _fetchJson(pathname, options = {}, timeoutMs = 30000, externalSignal = null) {
        const url = new URL(pathname, `${this.baseUrl}/`);
        const controller = new AbortController();
        let timer = null;
        let timedOut = false;
        const onAbort = () => controller.abort();
        if (externalSignal) {
            if (externalSignal.aborted) controller.abort();
            else externalSignal.addEventListener('abort', onAbort, { once: true });
        }
        timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
        try {
            const response = await fetch(url, Object.assign({}, options, { signal: controller.signal }));
            const body = await response.text();
            if (!response.ok) {
                throw new BridgeError(`Mokuro bridge returned HTTP ${response.status} for ${pathname}.${body ? ` ${body.slice(0, 500)}` : ''}`, response.status, body.slice(0, 2000));
            }
            try { return JSON.parse(body); }
            catch (error) { throw new BridgeError('Mokuro bridge returned invalid JSON.', response.status, body.slice(0, 2000)); }
        } catch (error) {
            if (timedOut) throw new BridgeError(`Mokuro bridge request timed out after ${timeoutMs} ms.`, null, { path: pathname });
            throw error;
        } finally {
            clearTimeout(timer);
            if (externalSignal) externalSignal.removeEventListener('abort', onAbort);
        }
    }

    startSession(title, options = {}) {
        const form = new FormData();
        form.append('title', String(title || 'manga'));
        form.append('reuse_existing', options.reuseExisting ? 'true' : 'false');
        return this._fetchJson('/session/start', { method: 'POST', body: form }, options.timeoutMs || 15000, options.signal);
    }

    pushPageBuffer(sessionId, data, filename, pageNumber, options = {}) {
        const id = String(sessionId || '').trim();
        if (!id) throw new BridgeError('A bridge session ID is required for page upload.');
        const safeName = String(filename || `page-${String(pageNumber || 1).padStart(4, '0')}.jpg`).replace(/[^A-Za-z0-9._-]/g, '_');
        const form = new FormData();
        form.append('page', new Blob([data], { type: 'image/jpeg' }), safeName);
        form.append('filename', safeName);
        form.append('page_num', String(pageNumber || 1));
        return this._fetchJson(`/session/${encodeURIComponent(id)}/page`, { method: 'POST', body: form }, options.timeoutMs || 60000, options.signal);
    }

    health(options = {}) {
        return this._send({
            path: '/health',
            method: 'GET',
            headers: { Accept: 'application/json' },
            timeoutMs: options.timeoutMs || this.healthTimeoutMs,
            signal: options.signal
        }, response => this._json(response));
    }

    sessionStatus(sessionId, options = {}) {
        const id = String(sessionId || '').trim();
        if (!id) throw new BridgeError('A bridge session ID is required for status.');
        return this._send({
            path: `/session/${encodeURIComponent(id)}/status`,
            method: 'GET',
            headers: { Accept: 'application/json' },
            timeoutMs: options.timeoutMs || this.healthTimeoutMs,
            signal: options.signal
        }, response => this._json(response));
    }

    async finalize(sessionId, finalizeOptions = {}, callbacks = {}) {
        const id = String(sessionId || '').trim();
        if (!id) throw new BridgeError('A bridge session ID is required for finalization.');

        const form = new URLSearchParams();
        if (finalizeOptions.uploadMethod) form.set('upload_method', String(finalizeOptions.uploadMethod));
        if (finalizeOptions.localDir) form.set('local_dir', String(finalizeOptions.localDir));
        if (finalizeOptions.forceMega) form.set('upload_to_mega', 'true');
        form.set('delete_after_upload', finalizeOptions.deleteAfterUpload === false ? 'false' : 'true');
        const body = form.toString();

        let result = null;
        const events = [];
        await this._send({
            path: `/session/${encodeURIComponent(id)}/finalize`,
            method: 'POST',
            headers: {
                Accept: 'application/x-ndjson',
                'Content-Type': 'application/x-www-form-urlencoded'
            },
            body,
            timeoutMs: callbacks.timeoutMs || this.finalizeTimeoutMs,
            signal: callbacks.signal
        }, async (response, signal) => {
            const decoder = new StringDecoder('utf8');
            let buffer = '';

            const processLine = line => {
                if (!line.trim()) return;
                let event;
                try {
                    event = JSON.parse(line);
                } catch (error) {
                    throw new BridgeError('Mokuro bridge finalize stream contained invalid NDJSON.', response.statusCode, {
                        line: line.slice(0, 500),
                        parseError: errorMessage(error)
                    });
                }
                events.push(event);
                if (typeof callbacks.onEvent === 'function') callbacks.onEvent(event);
                if (event && event.stage === 'error') {
                    throw new BridgeError(
                        errorMessage(event.message || event.error || 'Mokuro bridge finalization failed.'),
                        response.statusCode,
                        event
                    );
                }
                if (event && event.stage === 'done') result = event;
            };

            for await (const chunk of response) {
                if (signal.aborted) {
                    const error = new Error('Bridge finalization cancelled.');
                    error.name = 'AbortError';
                    throw error;
                }
                buffer += decoder.write(chunk);
                const lines = buffer.split(/\r?\n/);
                buffer = lines.pop() || '';
                for (const line of lines) processLine(line);
            }
            buffer += decoder.end();
            if (buffer.trim()) processLine(buffer);
            if (!result) {
                throw new BridgeError('Mokuro bridge closed finalize without a done event.', response.statusCode, { events });
            }
            return result;
        });

        return { result, events };
    }
}

module.exports = {
    BridgeClient,
    DEFAULT_FINALIZE_TIMEOUT_MS,
    DEFAULT_HEALTH_TIMEOUT_MS
};
