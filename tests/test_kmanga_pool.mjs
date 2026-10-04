/**
 * The k-manga viewer-socket pool, end to end through `downloadKmanga`.
 *
 * A single socket is paced by the store, so a long volume spreads its pages over
 * several. What is under test is not the throughput (that is measured live in
 * `scripts/probes/probe-kmanga.mjs`) but the bookkeeping the pool introduces: every
 * page still lands on disk exactly once, each socket is asked only for its own
 * share, the decrypt key is taken from the first socket's header reply, a socket
 * that dies only costs its own shard, and a short volume opens one socket rather
 * than four.
 *
 * The store is faked at both seams the adapter already exposes -- `ctx.fetchImpl`
 * for the launcher and the index, and `ctx.connectSocket` for the viewer -- so no
 * network and no `sharp` are involved.
 */

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { downloadKmanga } from '../src/download/kmanga.js';
import { check, checkEqual, finish } from './_harness.mjs';

const MAGIC = 'BCP000';
const BOOK_ID = '167001';

/** A minimal JPEG with a real SOF0, which is all `readJpegSize` looks for. */
function jpeg(fill) {
    return Buffer.from([
        0xFF, 0xD8,
        0xFF, 0xC0, 0x00, 0x11, 0x08, 0x00, 0x02, 0x00, 0x02, 0x03,
        0x01, 0x11, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01,
        0xFF, 0xD9,
        fill,
    ]);
}

function frame(json, chunks = null) {
    const body = Buffer.from(JSON.stringify(json), 'utf8');
    const head = Buffer.concat([Buffer.from(MAGIC, 'latin1'), Buffer.from(String(body.length).padStart(10))]);
    if (!chunks) return Buffer.concat([head, body]);
    const tail = Buffer.from(`${String(chunks.length).padStart(3)}`
        + chunks.map((c) => String(c.length).padStart(10)).join(''));
    return Buffer.concat([head, body, tail, ...chunks]);
}

const HELLO = Buffer.from(MAGIC, 'latin1');

/**
 * One fake viewer socket.
 *
 * `pages` is the whole manifest; the socket answers the header request with it and
 * then one data reply per name it is asked for. `dead` makes every data reply a
 * closed socket rather than an answer.
 */
class FakeSocket {
    constructor(pages, { byName, index, log, dead = false }) {
        this.pages = pages;
        this.byName = byName;
        this.index = index;
        this.log = log;
        this.dead = dead;
        this.queue = [HELLO];
        this.requests = [];
        this.closed = false;
    }

    send(text) {
        if (this.closed) throw new Error('sent on a closed fake socket');
        this.log.push({ socket: this.index, text });
        if (text.startsWith('REQUEST HEADER')) {
            this.queue.push(frame({ dk: 'DECRYPT-KEY', contentInfos: this.pages }));
            return;
        }
        const name = decodeURIComponent(/fn=([^&]*)/.exec(text)[1]);
        this.requests.push(name);
        if (this.dead) {
            this.queue.push({ closed: true });
            return;
        }
        const entry = this.byName.get(name);
        if (!entry) {
            throw new Error(`fake socket ${this.index} was asked for unknown page ${name}`);
        }
        this.queue.push(frame({
            version: '2.00',
            scenes: [{
                sceneNo: entry.startSceneNo,
                sceneImagePartition: 1,
                images: [{ format: 'jpeg', key: 0, width: 2, height: 2 }],
            }],
        }, [jpeg(entry.fill)]));
    }

    next() {
        if (!this.queue.length) return Promise.reject(new Error('fake socket ran dry'));
        const reply = this.queue.shift();
        if (!Buffer.isBuffer(reply)) return Promise.reject(new Error('fake socket closed'));
        return Promise.resolve({ opcode: 2, payload: reply });
    }

    close() { this.closed = true; }
}

function manifestFor(count) {
    return Array.from({ length: count }, (_, i) => ({
        name: String(i),
        startSceneNo: i + 1,
        fill: i % 251,
    }));
}

/** A `fetch` that answers the launcher redirect and the index JSONP. */
function fakeFetch() {
    return async (url) => {
        if (String(url).includes('viewer-launcher') || String(url).includes('/title/')) {
            return new Response(null, {
                status: 302,
                headers: {
                    location: `${'https://comic.k-manga.jp'}/viewer?p0=TICKET&p1=OBFUID&p3=${BOOK_ID}`,
                    'set-cookie': 'isIPad=off; Path=/',
                },
            });
        }
        return new Response('cb([["第1話",1]])', { status: 200, headers: { 'content-type': 'text/javascript' } });
    };
}

function run(count, { sockets, deadSockets = [], out }) {
    const pages = manifestFor(count);
    const byName = new Map(pages.map((p) => [p.name, p]));
    const log = [];
    const created = [];
    let nextIndex = 0;
    const ctx = {
        out,
        flat: true,
        force: true,
        descramble: false,
        kmConcurrency: 16,
        retries: 1,
        fetchImpl: fakeFetch(),
        connectSocket: async () => {
            const index = nextIndex++;
            const socket = new FakeSocket(pages, {
                byName, index, log, dead: deadSockets.includes(index),
            });
            created.push(socket);
            return socket;
        },
    };
    const task = {
        input: 'probe',
        kind: 'kmanga',
        target: `テスト (1)`,
        id: `${BOOK_ID}vol1`,
        bookId: BOOK_ID,
        volume: 1,
        launcher: `https://comic.k-manga.jp/viewer-launcher/1/2/${BOOK_ID}/3/1/1/0/0`,
        title: 'テスト (1)',
        sample: false,
    };
    return downloadKmanga(task, ctx).then((record) => ({ record, created, log, pages }));
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dokuha-kmanga-pool-'));

// ---------------------------------------------------------------------------
// 1. A long volume spreads over several sockets, and every page lands once.
// ---------------------------------------------------------------------------
{
    const { record, created, log, pages } = await run(40, { out: path.join(root, 'long') });
    checkEqual('a 40-page volume downloads every page', record.downloaded, 40);
    checkEqual('and nothing is reported failed', record.failed, 0);
    checkEqual('the byte total is every page', record.bytes, pages.reduce((n, p) => n + jpeg(p.fill).length, 0));

    const names = (await fsp.readdir(path.join(root, 'long'))).filter((f) => f.endsWith('.jpg')).sort();
    checkEqual('every page is on disk, one file each', names.length, 40);
    checkEqual('the first page keeps its name', names[0], 'page-0001.jpg');
    checkEqual('the last page keeps its name', names[39], 'page-0040.jpg');

    // ceil(40 / 32) = 2
    checkEqual('a 40-page sheet opens two sockets', created.length, 2);
    const perSocket = created.map((s, i) => log.filter((l) => l.socket === i && l.text.startsWith('REQUEST DATA')).length);
    check('both sockets are actually asked for pages', perSocket.every((n) => n > 0), JSON.stringify(perSocket));
    checkEqual('the two splits add up to the whole volume', perSocket.reduce((a, b) => a + b, 0), 40);

    const headerCalls = log.filter((l) => l.text.startsWith('REQUEST HEADER')).length;
    checkEqual('every socket authenticates with its own header request', headerCalls, 2);
    checkEqual('every opened socket is closed again', created.filter((s) => s.closed).length, 2);
}

// ---------------------------------------------------------------------------
// 2. A short volume stays on one socket: the handshake is not worth multiplying.
// ---------------------------------------------------------------------------
{
    const { record, created } = await run(10, { out: path.join(root, 'short') });
    checkEqual('a 10-page sampler downloads every page', record.downloaded, 10);
    checkEqual('a short sheet opens exactly one socket', created.length, 1);
}

// ---------------------------------------------------------------------------
// 3. A dead socket costs its own shard, and the retry reopens the pool and
//    finishes the pages the other sockets had already written.
// ---------------------------------------------------------------------------
{
    const { record, created } = await run(40, { out: path.join(root, 'dead'), deadSockets: [1] });
    checkEqual('a dead shard is retried rather than failing the volume', record.downloaded, 40);
    checkEqual('nothing is left failed', record.failed, 0);
    const names = (await fsp.readdir(path.join(root, 'dead'))).filter((f) => f.endsWith('.jpg'));
    checkEqual('the retry still writes one file per page', names.length, 40);
    check('the pool is re-opened for the retry', created.length > 2, String(created.length));
}

finish();
