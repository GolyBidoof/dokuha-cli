
import net from 'node:net';
import tls from 'node:tls';
import crypto from 'node:crypto';

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

const OPCODE = { CONTINUATION: 0x0, TEXT: 0x1, BINARY: 0x2, CLOSE: 0x8, PING: 0x9, PONG: 0xA };

export async function connectWebSocket(url, options = {}) {
    const parsed = new URL(url);
    const secure = parsed.protocol === 'wss:';
    if (!secure && parsed.protocol !== 'ws:') throw new Error(`unsupported WebSocket scheme ${parsed.protocol}`);

    const port = Number(parsed.port) || (secure ? 443 : 80);
    const key = crypto.randomBytes(16).toString('base64');
    const expected = crypto.createHash('sha1').update(key + WS_GUID).digest('base64');

    const socket = secure
        ? tls.connect({ host: parsed.hostname, port, servername: parsed.hostname })
        : net.connect({ host: parsed.hostname, port });

    const handshake = [
        `GET ${parsed.pathname}${parsed.search} HTTP/1.1`,
        `Host: ${parsed.host}`,
        'Upgrade: websocket',
        'Connection: Upgrade',
        `Sec-WebSocket-Key: ${key}`,
        'Sec-WebSocket-Version: 13',
        ...(options.origin ? [`Origin: ${options.origin}`] : []),
        ...(options.userAgent ? [`User-Agent: ${options.userAgent}`] : []),
        ...Object.entries(options.headers || {}).map(([name, value]) => `${name}: ${value}`),
        '',
        '',
    ].join('\r\n');

    const timeoutMs = options.timeoutMs ?? 20_000;

    return new Promise((resolve, reject) => {
        let buffer = Buffer.alloc(0);
        let settled = false;
        const timer = setTimeout(() => {
            if (settled) return;
            settled = true;
            socket.destroy();
            reject(new Error(`WebSocket handshake with ${parsed.host} timed out after ${timeoutMs} ms`));
        }, timeoutMs);

        const fail = (error) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            socket.destroy();
            reject(error);
        };

        socket.once('error', fail);

        const onReady = () => socket.write(handshake);
        socket.once(secure ? 'secureConnect' : 'connect', onReady);

        const onData = (chunk) => {
            buffer = Buffer.concat([buffer, chunk]);
            if (settled) return;

            const end = buffer.indexOf('\r\n\r\n');
            if (end < 0) {

                if (buffer.length > 64 * 1024) fail(new Error('WebSocket handshake response headers are too large'));
                return;
            }
            const head = buffer.subarray(0, end).toString('latin1');
            const lines = head.split('\r\n');
            const status = lines[0] || '';
            if (!/^HTTP\/1\.1 101\b/.test(status)) {
                fail(new Error(`WebSocket upgrade refused: ${status || 'no status line'}`));
                return;
            }
            const headers = new Map();
            for (const line of lines.slice(1)) {
                const colon = line.indexOf(':');
                if (colon > 0) headers.set(line.slice(0, colon).trim().toLowerCase(), line.slice(colon + 1).trim());
            }
            if (headers.get('sec-websocket-accept') !== expected) {
                fail(new Error('WebSocket handshake returned the wrong Sec-WebSocket-Accept'));
                return;
            }

            settled = true;
            clearTimeout(timer);
            socket.removeListener('error', fail);
            socket.removeListener('data', onData);
            const client = new KmSocket(socket, buffer.subarray(end + 4));
            resolve(client);
        };
        socket.on('data', onData);
    });
}

export class KmSocket {
    constructor(socket, initial = Buffer.alloc(0)) {
        this.socket = socket;
        this.buffer = initial;
        this.queue = [];
        this.waiters = [];
        this.closed = false;
        this.closeReason = null;
        this.fragments = [];
        this.fragmentOpcode = null;

        socket.on('data', (chunk) => {
            this.buffer = Buffer.concat([this.buffer, chunk]);
            this.#drain();
        });
        socket.on('error', (error) => this.#shutdown(`socket error: ${error.message}`));
        socket.on('close', () => this.#shutdown(this.closeReason || 'socket closed'));
        this.#drain();
    }

    send(text) {
        this.#sendFrame(OPCODE.TEXT, Buffer.from(text, 'utf8'));
    }

    next(timeoutMs = 30_000) {
        if (this.queue.length) return Promise.resolve(this.queue.shift());
        if (this.closed) return Promise.reject(new Error(this.closeReason || 'socket closed'));
        return new Promise((resolve, reject) => {
            const waiter = { resolve, reject, timer: null };
            waiter.timer = setTimeout(() => {
                const index = this.waiters.indexOf(waiter);
                if (index >= 0) this.waiters.splice(index, 1);
                reject(new Error(`WebSocket read timed out after ${timeoutMs} ms`));
            }, timeoutMs);
            this.waiters.push(waiter);
        });
    }

    close() {
        if (this.closed) return;
        try {
            this.#sendFrame(OPCODE.CLOSE, Buffer.alloc(0));
        } catch {

        }
        this.closed = true;
        this.socket.end();
    }

    #shutdown(reason) {
        this.closed = true;
        this.closeReason = this.closeReason || reason;
        for (const waiter of this.waiters.splice(0)) {
            clearTimeout(waiter.timer);
            waiter.reject(new Error(this.closeReason));
        }
    }

    #drain() {
        try {
            for (;;) {
                const header = this.#readHeader();
                if (!header) return;
                const { fin, opcode, masked, length } = header;
                if (this.buffer.length < header.total) return;
                const start = header.total - length;
                let payload = this.buffer.subarray(start, start + length);
                if (masked) payload = unmask(payload, header.mask);
                this.buffer = this.buffer.subarray(start + length);
                this.#handleFrame(fin, opcode, payload);
            }
        } catch (error) {

            this.socket.destroy();
            this.#shutdown(`WebSocket protocol error: ${error.message}`);
        }
    }

    #readHeader() {
        const buf = this.buffer;
        if (buf.length < 2) return null;
        const fin = (buf[0] & 0x80) !== 0;
        const opcode = buf[0] & 0x0f;
        const masked = (buf[1] & 0x80) !== 0;
        let length = buf[1] & 0x7f;
        let offset = 2;
        if (length === 126) {
            if (buf.length < offset + 2) return null;
            length = buf.readUInt16BE(offset);
            offset += 2;
        } else if (length === 127) {
            if (buf.length < offset + 8) return null;
            const big = buf.readBigUInt64BE(offset);

            if (big > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('WebSocket frame length is out of range');
            length = Number(big);
            offset += 8;
        }
        let mask = null;
        if (masked) {
            if (buf.length < offset + 4) return null;
            mask = buf.subarray(offset, offset + 4);
            offset += 4;
        }
        return { fin, opcode, masked, mask, length, total: offset + length };
    }

    #handleFrame(fin, opcode, payload) {
        if (opcode === OPCODE.PING) {
            this.#sendFrame(OPCODE.PONG, payload);
            return;
        }
        if (opcode === OPCODE.PONG) return;
        if (opcode === OPCODE.CLOSE) {
            this.closeReason = 'server closed the connection';
            this.closed = true;
            this.socket.end();
            for (const waiter of this.waiters.splice(0)) {
                clearTimeout(waiter.timer);
                waiter.reject(new Error(this.closeReason));
            }
            return;
        }
        if (opcode === OPCODE.CONTINUATION) {
            if (this.fragmentOpcode === null) return;
            this.fragments.push(payload);
        } else {
            this.fragmentOpcode = opcode;
            this.fragments = [payload];
        }
        if (!fin) return;
        const message = { opcode: this.fragmentOpcode, payload: Buffer.concat(this.fragments) };
        this.fragmentOpcode = null;
        this.fragments = [];
        const waiter = this.waiters.shift();
        if (waiter) {
            clearTimeout(waiter.timer);
            waiter.resolve(message);
        } else {
            this.queue.push(message);
        }
    }

    #sendFrame(opcode, payload) {
        if (this.socket.destroyed) throw new Error('WebSocket is closed');
        const mask = crypto.randomBytes(4);
        const length = payload.length;
        let header;
        if (length < 126) {
            header = Buffer.alloc(6);
            header[1] = 0x80 | length;
        } else if (length < 65536) {
            header = Buffer.alloc(8);
            header[1] = 0x80 | 126;
            header.writeUInt16BE(length, 2);
        } else {
            header = Buffer.alloc(14);
            header[1] = 0x80 | 127;
            header.writeBigUInt64BE(BigInt(length), 2);
        }
        header[0] = 0x80 | opcode;
        mask.copy(header, header.length - 4);
        this.socket.write(Buffer.concat([header, Buffer.from(unmask(payload, mask))]));
    }
}

function unmask(payload, mask) {
    const out = Buffer.allocUnsafe(payload.length);
    for (let i = 0; i < payload.length; i++) out[i] = payload[i] ^ mask[i & 3];
    return out;
}
