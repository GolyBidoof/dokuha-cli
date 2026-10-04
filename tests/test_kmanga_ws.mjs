/**
 * The WebSocket client, driven by a server written here.
 *
 * This is the only way to test it without a network: the store's own socket
 * refuses a handshake that is not exactly right, and a live failure tells you only
 * that it timed out. The local server checks the parts that are easy to get wrong
 * and that a real server would reject silently -- the masked client frames, the
 * two extended length encodings, fragmented replies, and the pong that has to come
 * back for a ping.
 */

import net from 'node:net';
import crypto from 'node:crypto';

import { connectWebSocket } from '../src/download/kmanga-ws.js';
import { check, checkEqual, finish } from './_harness.mjs';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

/** Encode one unmasked server frame. */
function frame(opcode, payload, fin = true) {
    const body = Buffer.from(payload);
    const head = [];
    head.push((fin ? 0x80 : 0x00) | opcode);
    if (body.length < 126) head.push(body.length);
    else if (body.length < 65536) head.push(126, body.length >> 8, body.length & 0xff);
    else {
        head.push(127);
        const big = Buffer.alloc(8);
        big.writeBigUInt64BE(BigInt(body.length));
        head.push(...big);
    }
    return Buffer.concat([Buffer.from(head), body]);
}

/** Decode a client frame, which is always masked. */
function decodeClientFrame(buf) {
    const opcode = buf[0] & 0x0f;
    const masked = (buf[1] & 0x80) !== 0;
    let length = buf[1] & 0x7f;
    let offset = 2;
    if (length === 126) { length = buf.readUInt16BE(offset); offset += 2; } else if (length === 127) {
        length = Number(buf.readBigUInt64BE(offset)); offset += 8;
    }
    const mask = buf.subarray(offset, offset + 4);
    offset += 4;
    const payload = Buffer.alloc(length);
    for (let i = 0; i < length; i++) payload[i] = buf[offset + i] ^ mask[i & 3];
    return { opcode, masked, payload, total: offset + length };
}

/** One scripted peer, reporting what it saw back through `result`. */
function startServer(result) {
    const server = net.createServer((socket) => {
        let buffer = Buffer.alloc(0);
        let upgraded = false;

        socket.on('data', (chunk) => {
            buffer = Buffer.concat([buffer, chunk]);

            if (!upgraded) {
                const end = buffer.indexOf('\r\n\r\n');
                if (end < 0) return;
                const head = buffer.subarray(0, end).toString('latin1');
                buffer = buffer.subarray(end + 4);
                upgraded = true;

                result.requestLine = head.split('\r\n')[0];
                for (const line of head.split('\r\n').slice(1)) {
                    const colon = line.indexOf(':');
                    if (colon > 0) result.headers[line.slice(0, colon).trim().toLowerCase()] = line.slice(colon + 1).trim();
                }
                const accept = crypto.createHash('sha1').update(`${result.headers['sec-websocket-key']}${GUID}`).digest('base64');
                socket.write([
                    'HTTP/1.1 101 Switching Protocols',
                    'Upgrade: websocket',
                    'Connection: Upgrade',
                    `Sec-WebSocket-Accept: ${accept}`,
                    '', '',
                ].join('\r\n'));

                socket.write(frame(0x1, 'hello'));
                socket.write(frame(0x2, Buffer.alloc(300, 7)));
                socket.write(frame(0x1, 'part1', false));
                socket.write(frame(0x0, 'part2', true));
                socket.write(frame(0x9, 'ping-me'));
                socket.write(frame(0x1, 'after-ping'));
            }

            for (;;) {
                if (buffer.length < 2) return;
                const need = (() => {
                    const len7 = buffer[1] & 0x7f;
                    return 2 + (len7 === 126 ? 2 : len7 === 127 ? 8 : 0) + (((buffer[1] & 0x80) !== 0) ? 4 : 0);
                })();
                if (buffer.length < need) return;
                const peek = decodeClientFrame(buffer);
                if (buffer.length < peek.total) return;
                const got = decodeClientFrame(buffer);
                buffer = buffer.subarray(got.total);
                if (got.opcode === 0xA) result.pongs.push(got.payload.toString('utf8'));
                else result.messages.push({ opcode: got.opcode, masked: got.masked, text: got.payload.toString('utf8'), length: got.payload.length });
            }
        });
        socket.on('error', () => {});
    });
    return server;
}

const result = { headers: {}, messages: [], pongs: [], requestLine: '' };
const server = startServer(result);
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;

const client = await connectWebSocket(`ws://127.0.0.1:${port}/socket`, {
    origin: 'https://comic.k-manga.jp',
    userAgent: 'dokuha-test',
});

checkEqual('the request line asks for the path', result.requestLine, 'GET /socket HTTP/1.1');
checkEqual('the upgrade is declared once', result.headers.upgrade, 'websocket');
checkEqual('the origin is forwarded', result.headers.origin, 'https://comic.k-manga.jp');
checkEqual('the user agent is forwarded', result.headers['user-agent'], 'dokuha-test');
checkEqual('version 13 is the only one offered', result.headers['sec-websocket-version'], '13');
check('permessage-deflate is never offered, so frames stay raw',
    result.headers['sec-websocket-extensions'] === undefined);

const first = await client.next(5000);
checkEqual('a text frame arrives as text', first.payload.toString('utf8'), 'hello');
checkEqual('its opcode is text', first.opcode, 0x1);

const binary = await client.next(5000);
checkEqual('a 300-byte frame uses the 16-bit length and arrives whole', binary.payload.length, 300);
checkEqual('its opcode is binary', binary.opcode, 0x2);

const joined = await client.next(5000);
checkEqual('a fragmented message is reassembled', joined.payload.toString('utf8'), 'part1part2');

const afterPing = await client.next(5000);
checkEqual('a ping is not delivered as a message', afterPing.payload.toString('utf8'), 'after-ping');

client.send('from-client');
// Longer than any single frame the store sends, so this pins the 16-bit encoder.
client.send('x'.repeat(70000));
await new Promise((resolve) => setTimeout(resolve, 200));

checkEqual('the ping was answered with a pong', result.pongs, ['ping-me']);
checkEqual('both sends reached the peer', result.messages.length, 2);
checkEqual('a short send is one text frame', [result.messages[0]?.text, result.messages[0]?.opcode], ['from-client', 0x1]);
checkEqual('every client frame is masked', result.messages.every((m) => m.masked), true);
checkEqual('a 70,000-byte send survives the 64-bit length path', result.messages[1]?.length, 70000);

// A read that nothing answers has to give up rather than hang the run.
let timedOut = false;
try { await client.next(60); } catch (error) { timedOut = /timed out/.test(error.message); }
check('an unanswered read times out', timedOut);

client.close();
await new Promise((resolve) => setTimeout(resolve, 100));
server.close();

// A server that answers with the wrong accept value must be refused: negotiating a
// socket with the wrong peer would silently read someone else's stream.
{
    const bad = net.createServer((socket) => {
        socket.on('data', () => {
            socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nSec-WebSocket-Accept: wrong\r\n\r\n');
        });
        socket.on('error', () => {});
    });
    await new Promise((resolve) => bad.listen(0, '127.0.0.1', resolve));
    let refused = '';
    try {
        await connectWebSocket(`ws://127.0.0.1:${bad.address().port}/`, { timeoutMs: 2000 });
    } catch (error) {
        refused = error.message;
    }
    check('a wrong Sec-WebSocket-Accept is refused', /Sec-WebSocket-Accept/.test(refused), refused);
    bad.close();
}

finish();
