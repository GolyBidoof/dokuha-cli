/**
 * The pipelined fetch loop, against a fake socket.
 *
 * Pipelining is only safe because every reply names its own scene, so a reply can
 * be matched to the request that asked for it instead of trusting arrival order.
 * That is exactly the property these checks pin: replies delivered out of order
 * must still land on the right page, a reply nobody asked for must abort rather
 * than be written somewhere, and a page that fails to rebuild must be one bad page
 * rather than a dead connection.
 *
 * No socket and no `sharp` are involved: `onPage` here is a stub, because what is
 * under test is the scheduling, not the image work.
 */

import { drainPages } from '../src/download/kmanga.js';
import { check, checkEqual, finish } from './_harness.mjs';

const MAGIC = 'BCP000';

/** Build one content reply: framing, a one-scene body, and one image chunk. */
function replyFor(sceneNo, payload = Buffer.from(`scene-${sceneNo}`)) {
    const body = JSON.stringify({
        version: '2.00',
        scenes: [{ sceneNo, sceneImagePartition: 1, images: [{ format: 'jpeg', key: 0, width: 2, height: 2 }] }],
    });
    const json = Buffer.from(body, 'utf8');
    const head = Buffer.concat([Buffer.from(MAGIC, 'latin1'), Buffer.from(String(json.length).padStart(10))]);
    const tail = Buffer.from(`${String(1).padStart(3)}${String(payload.length).padStart(10)}`);
    return Buffer.concat([head, json, tail, payload]);
}

/**
 * A socket that answers requests from a script.
 *
 * `order` decides which waiting request is answered next; the default answers the
 * oldest, which is what the store was measured doing.
 */
class FakeSocket {
    constructor(order = 'fifo', nameToScene = new Map()) {
        this.order = order;
        this.nameToScene = nameToScene;
        this.waiting = [];
        this.outstanding = 0;
        this.maxOutstanding = 0;
        this.sent = [];
        this.payloads = new Map();
    }

    /**
     * The scene a request asks for.
     *
     * The request carries the content entry's *name*, which is not its scene
     * number (`contentInfos[0]` is name "0" and scene 1), so the name is looked up
     * the same way the real manifest would be.
     */
    sceneOf(text) {
        const name = /fn=([^&]*)/.exec(text)[1];
        if (name === 'unknown') return 999;
        const scene = this.nameToScene.get(name);
        if (scene === undefined) throw new Error(`no scene for content name ${name}`);
        return scene;
    }

    send(text) {
        const scene = this.sceneOf(text);
        this.sent.push(scene);
        this.waiting.push(scene);
        this.outstanding += 1;
        this.maxOutstanding = Math.max(this.maxOutstanding, this.outstanding);
    }

    next() {
        if (!this.waiting.length) return Promise.reject(new Error('nothing outstanding to answer'));
        let index = 0;
        if (this.order === 'lifo') index = this.waiting.length - 1;
        else if (this.order === 'reverse2' && this.waiting.length > 1) index = 1;
        const scene = this.waiting.splice(index, 1)[0];
        this.outstanding -= 1;
        return Promise.resolve({ opcode: 2, payload: replyFor(scene, this.payloads.get(scene)) });
    }
}

const session = { ticket: 'T', obfuid: 'O' };
const manifest = { dk: 'DK' };
const makeWork = (count) => Array.from({ length: count }, (_, i) => ({
    index: i,
    entry: { name: String(i), startSceneNo: i + 1 },
    sceneNo: i + 1,
    file: `page-${i + 1}.jpg`,
    full: `/tmp/page-${i + 1}.jpg`,
}));

/** Run one scripted drain and collect what `onPage` saw. */
async function drain({ count, depth, order = 'fifo', processLimit = 4, reject = () => false }) {
    const work = makeWork(count);
    const socket = new FakeSocket(order, new Map(work.map((w) => [w.entry.name, w.sceneNo])));
    const seen = [];
    const errors = await drainPages({
        socket, session, manifest, work, depth, processLimit,
        onPage: async (item, frame) => {
            if (reject(item)) throw new Error(`stub failure for scene ${item.sceneNo}`);
            seen.push({ scene: item.sceneNo, payload: frame.chunks[0].toString('utf8') });
        },
    });
    return { socket, seen, errors };
}

// In order, which is what the store was measured doing.
{
    const { seen, errors, socket } = await drain({ count: 20, depth: 4 });
    checkEqual('every page is processed', seen.length, 20);
    checkEqual('nothing fails', errors.length, 0);
    checkEqual('they arrive in scene order', seen.map((s) => s.scene).join(','), makeWork(20).map((w) => w.sceneNo).join(','));
    check('the socket is reused rather than reopened per page', socket.sent.length === 20);
}

// Out of order: the reply for the *second* outstanding request comes back first.
// Matching on arrival order would here put scene 7's bytes in scene 6's file.
{
    const { seen, errors } = await drain({ count: 20, depth: 4, order: 'reverse2' });
    checkEqual('an out-of-order run still processes every page', seen.length, 20);
    checkEqual('an out-of-order run fails nothing', errors.length, 0);
    const mismatched = seen.filter((s) => s.payload !== `scene-${s.scene}`);
    checkEqual('each page still gets its own bytes', mismatched.length, 0);
}

// Last-in-first-out is the worst case for order assumptions.
{
    const { seen, errors } = await drain({ count: 20, depth: 4, order: 'lifo' });
    checkEqual('a reversed delivery still processes every page', seen.length, 20);
    checkEqual('a reversed delivery still matches every page', seen.filter((s) => s.payload !== `scene-${s.scene}`).length, 0);
    checkEqual('a reversed delivery still fails nothing', errors.length, 0);
}

// The pipeline bound has to hold, or "depth" means nothing.
{
    const { socket } = await drain({ count: 40, depth: 8 });
    checkEqual('never more than `depth` requests are outstanding', socket.maxOutstanding, 8);
    const { socket: one } = await drain({ count: 5, depth: 1 });
    checkEqual('a depth of 1 is strictly one at a time', one.maxOutstanding, 1);
}

// A reply for a scene nobody asked for means the framing assumption has broken.
// Continuing would write it under some other page's name.
{
    const work = makeWork(3);
    const socket = new FakeSocket('fifo', new Map(work.map((w) => [w.entry.name, w.sceneNo])));
    socket.waiting.push(999);
    let threw = '';
    try {
        await drainPages({
            socket, session, manifest, work, depth: 3, processLimit: 3,
            onPage: async () => {},
        });
    } catch (error) {
        threw = error.message;
    }
    check('an unrequested scene aborts the volume', /cannot be matched to a request/.test(threw), threw);
}

// One page that will not rebuild is one bad page. It must not take the volume, or
// the connection, with it.
{
    const { seen, errors } = await drain({ count: 10, depth: 4, reject: (item) => item.sceneNo === 5 });
    checkEqual('the other pages still land', seen.length, 9);
    checkEqual('the bad page is reported once', errors.length, 1);
    checkEqual('and it is the right one', errors[0]?.item?.sceneNo, 5);
    check('seen pages never include the failed one', !seen.some((s) => s.scene === 5));
}

finish();
