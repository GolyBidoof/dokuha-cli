
import path from 'node:path';
import fsp from 'node:fs/promises';
import { createRequire } from 'node:module';

import { USER_AGENT } from '../user-agent.js';
import { timed } from '../phase-timer.js';
import { SAMPLE_SUFFIX, volumeFolder, writeVolumeMarker } from './volume-folder.js';
import { stampPageTimes } from './page-files.js';
import { connectWebSocket } from './kmanga-ws.js';
import {
    KM_API_URL,
    KM_PROFILES,
    KM_WS_URL,
    buildDataRequest,
    buildHeaderRequest,
    isScrambled,
    parseFrame,
    parseIndexJsonp,
    parseViewerUrl,
    readJpegSize,
    scrambleGeometry,
    scrambleOrder,
} from './kmanga-protocol.js';

const require = createRequire(import.meta.url);

export const KM_ORIGIN = 'https://comic.k-manga.jp';

export function kmangaTitleUrl(bookId) {
    return `${KM_ORIGIN}/title/${bookId}/pv`;
}

export function kmangaVolumeUrl(bookId, volume) {
    return `${KM_ORIGIN}/title/${bookId}/vol/${volume}`;
}

const GATE_COOKIE = 'isIPad=off';

const PAGE_NAME = (index) => `page-${String(index).padStart(4, '0')}.jpg`;

const READ_TIMEOUT_MS = 30_000;

export function sharpAvailable() {
    try {
        require('sharp');
        return true;
    } catch {
        return false;
    }
}

export function assertSharpAvailable() {
    try {
        require('sharp');
    } catch {
        throw new Error(
            'k-manga pages are block-scrambled and need the optional "sharp" dependency to be un-shuffled.\n'
            + '  Install it with:  npm install sharp\n'
            + '  Without it the store cannot produce readable pages, so it is not downloaded at all.',
        );
    }
}

async function kmangaFetch(url, { ctx, headers = {}, redirect = 'manual' } = {}) {

    const doFetch = ctx?.fetchImpl || fetch;
    const response = await doFetch(url, {
        redirect,
        headers: {
            'User-Agent': ctx?.userAgent || USER_AGENT,
            Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            'Accept-Language': 'ja,en;q=0.8',
            Cookie: GATE_COOKIE,
            ...headers,
        },
    });
    return response;
}

function responseCookies(response) {
    const raw = typeof response.headers.getSetCookie === 'function'
        ? response.headers.getSetCookie()
        : [response.headers.get('set-cookie')].filter(Boolean);
    const jar = new Map();
    for (const line of raw) {
        const pair = String(line).split(';')[0];
        const eq = pair.indexOf('=');
        if (eq > 0) jar.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
    }
    return jar;
}

function cookieHeader(jar) {
    const parts = [...jar].map(([name, value]) => `${name}=${value}`);
    if (!parts.some((p) => p.startsWith('isIPad='))) parts.unshift(GATE_COOKIE);
    return parts.join('; ');
}

export async function openKmangaSession(launcherUrl, ctx = {}) {
    const response = await kmangaFetch(launcherUrl, {
        ctx,
        headers: { Referer: KM_ORIGIN },
        redirect: 'manual',
    });
    const cookies = responseCookies(response);

    if (response.status !== 302 && response.status !== 303 && response.status !== 307) {
        const body = await response.text().catch(() => '');
        throw new Error(`k-manga launcher answered HTTP ${response.status} instead of a redirect`
            + `${body.includes('isIPad') ? ' (the isIPad cookie gate was not satisfied)' : ''}: ${launcherUrl}`);
    }
    const location = response.headers.get('location');
    if (!location) throw new Error(`k-manga launcher gave no Location header: ${launcherUrl}`);

    const viewerUrl = new URL(location, launcherUrl).toString();
    const session = parseViewerUrl(viewerUrl);
    if (!session.ticket || !session.obfuid) {
        throw new Error(`k-manga viewer URL is missing its ticket or obfuid: ${viewerUrl}`);
    }
    return { viewerUrl, cookies, session };
}

export async function fetchKmangaIndex(session, cookies, ctx = {}) {
    const url = `${KM_API_URL}?t=${encodeURIComponent(session.ticket)}&fn=index.csv`
        + `&o=${encodeURIComponent(session.obfuid)}&type=index&callback=cb&u=${Date.now()}`;
    try {
        const response = await kmangaFetch(url, {
            ctx,
            headers: {
                Accept: '*/*',
                Referer: `${KM_ORIGIN}/`,
                Cookie: cookieHeader(cookies),
            },
            redirect: 'follow',
        });
        if (!response.ok) return null;
        return parseIndexJsonp(await response.text());
    } catch {
        return null;
    }
}

function textOf(html) {
    return String(html).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
}

function readAttributes(tag) {
    const attrs = {};
    const attribute = /([A-Za-z_:][-A-Za-z0-9_:.]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
    for (const match of String(tag).matchAll(attribute)) {
        attrs[match[1].toLowerCase()] = match[2] !== undefined ? match[2] : match[3];
    }
    return attrs;
}

function readLauncherTemplate(html) {
    const script = /<script\b[^>]*\bid=["']titlejs["'][^>]*>/i.exec(html);
    const attrs = script ? readAttributes(script[0]) : {};
    const viewerId = attrs['data-viewer-id-pc'];
    const book = attrs['data-book'];
    const formatType = attrs['data-format-type'];
    const quality = attrs['data-quality-default'];
    if (viewerId && book && formatType && quality) return { viewerId, book, formatType, quality };

    const rendered = /\/viewer-launcher\/(\d+)\/(\d+)\/(\d+)\/([^/"'\s]+)/.exec(html);
    if (rendered) {
        return { viewerId: rendered[1], quality: rendered[2], book: rendered[3], formatType: rendered[4] };
    }
    return null;
}

function buildLauncherUrl(template, { volume, attrs }) {
    if (!template) return null;
    const fcipath = attrs['data-chapter-fcipath'] ?? '1';
    const readType = attrs['data-chapter-readtype'] ?? '0';
    const fcid = attrs['data-chapter-fcid'] ?? '0';
    const fcupdated = attrs['data-chapter-fcupdated'] ?? '0';
    return `${KM_ORIGIN}/viewer-launcher/${template.viewerId}/${template.quality}/${template.book}/${template.formatType}`
        + `/${volume}/${fcipath}/${readType}/${fcid}/${fcupdated}`;
}

export function parseLauncherUrl(href) {
    const url = new URL(href, KM_ORIGIN);
    const parts = url.pathname.split('/').filter(Boolean);
    if (parts[0] !== 'viewer-launcher' || parts.length < 9) return null;
    return {
        url: url.toString(),
        bookId: parts[3],
        mode: parts[4],
        volume: Number(parts[5]),
        readType: Number(parts[7]),
        fcid: parts[8],
    };
}

export function parseTitlePage(html) {
    const text = String(html);
    const template = readLauncherTemplate(text);
    const anchor = /<a\b([^>]*)>([\s\S]*?)<\/a>/gi;

    const best = new Map();
    for (const match of text.matchAll(anchor)) {
        const attrs = readAttributes(match[1]);
        const href = attrs.href || '';
        const classes = attrs.class || '';
        const rendered = href.includes('/viewer-launcher/') ? parseLauncherUrl(href) : null;

        if (!rendered && !/x-invoke-viewer--btn__selector|book-chapter--btn/.test(classes)) continue;

        const volume = Number(attrs['data-chapter-exid'] ?? rendered?.volume);
        if (!Number.isInteger(volume) || volume < 1) continue;

        const launcher = rendered ? rendered.url : buildLauncherUrl(template, { volume, attrs });
        if (!launcher) continue;

        const label = textOf(match[2]);
        const readType = Number(attrs['data-chapter-readtype'] ?? rendered?.readType);

        const entry = {
            volume,
            launcher,
            readType,
            sample: readType === 0 || (readType !== 1 && readType !== 4 && /試し読み/.test(label)),
        };
        const previous = best.get(volume);
        if (!previous || rank(entry) < rank(previous)) best.set(volume, entry);
    }

    const name = /"@type"\s*:\s*"ProductGroup"[\s\S]{0,300}?"name"\s*:\s*"([^"]+)"/.exec(text)?.[1]
        || /<meta property="og:title" content="([^"]+)"/.exec(text)?.[1]
        || null;

    return {
        name: name ? decodeEntities(name) : null,
        volumes: [...best.values()].sort((a, b) => a.volume - b.volume),
    };
}

function rank(entry) {
    if (entry.sample) return 2;
    return entry.readType === 4 ? 0 : 1;
}

function decodeEntities(value) {
    return String(value)
        .replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&apos;/g, "'")
        .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}

export async function resolveKmangaInput(det, config, input, ctx = {}) {
    const wanted = det.kind === 'kmanga-volume' ? Number(det.volume) : null;
    const bookId = det.bookId;

    const response = await kmangaFetch(kmangaTitleUrl(bookId), { ctx });
    if (!response.ok) {
        return { tasks: [], rejected: [{ input, error: `k-manga title page for ${bookId} answered HTTP ${response.status}` }], notes: [] };
    }
    const page = parseTitlePage(await response.text());
    if (!page.volumes.length) {
        return {
            tasks: [],
            rejected: [{ input, error: `k-manga title ${bookId} offers no free reading entry point right now` }],
            notes: [],
        };
    }

    const free = page.volumes.filter((v) => !v.sample);
    const samples = page.volumes.filter((v) => v.sample);

    const usable = config.series
        ? (config.samplers ? [...free, ...samples] : free)
        : page.volumes;

    const chosen = wanted != null && !config.series
        ? usable.filter((v) => v.volume === wanted)
        : usable;

    if (!chosen.length) {
        const known = page.volumes.find((v) => v.volume === wanted);
        const why = known
            ? `volume ${wanted} of "${page.name || bookId}" is only a 試し読み sample, not a free volume`
                + ' (add --download-samplers to take samplers as well)'
            : `volume ${wanted} of "${page.name || bookId}" has no reading entry point on the title page`;
        return { tasks: [], rejected: [{ input, error: why }], notes: [] };
    }

    const notes = [];
    if (config.series && samples.length) {
        notes.push(config.samplers
            ? `  k-manga ${page.name || bookId}: ${free.length} free volume(s), plus ${samples.length} 試し読み sampler(s)`
            : `  k-manga ${page.name || bookId}: ${samples.length} sample-only volume(s) skipped; --download-samplers takes them`);
    }

    const tasks = chosen.map((entry) => {
        const title = page.name ? `${page.name} (${entry.volume})` : `k-manga ${bookId} vol ${entry.volume}`;
        return {
            input,
            kind: 'kmanga',

            target: entry.sample ? `${title}${SAMPLE_SUFFIX}` : title,
            id: `${bookId}vol${entry.volume}${entry.sample ? 'sample' : ''}`,
            bookId,
            volume: entry.volume,
            launcher: entry.launcher,
            title,
            sample: entry.sample,
        };
    });
    return { tasks, rejected: [], notes, streamed: false };
}

export async function descrambleJpeg(jpeg, image) {
    const sharp = require('sharp');
    const source = await sharp(jpeg, { failOn: 'none' }).toColourspace('srgb').removeAlpha().raw()
        .toBuffer({ resolveWithObject: true });
    const { data, info } = source;
    const geometry = scrambleGeometry({
        declaredWidth: image.declaredWidth,
        declaredHeight: image.declaredHeight,
        sourceWidth: info.width,
        sourceHeight: info.height,
    });
    const { block, gridX, gridY } = geometry;
    const order = scrambleOrder({ gridX, gridY, key: image.key });

    const outWidth = gridX * block;
    const outHeight = gridY * block;
    const out = Buffer.alloc(outWidth * outHeight * 3);
    for (let t = 0; t < order.length; t++) {
        const from = order[t];
        const sourceX = (from % gridX) * geometry.cell + 1;
        const sourceY = Math.floor(from / gridX) * geometry.cell + 1;
        const targetX = (t % gridX) * block;
        const targetY = Math.floor(t / gridX) * block;
        for (let row = 0; row < block; row++) {
            const from_ = ((sourceY + row) * info.width + sourceX) * 3;
            const to = ((targetY + row) * outWidth + targetX) * 3;
            data.copy(out, to, from_, from_ + block * 3);
        }
    }

    return sharp(out, { raw: { width: outWidth, height: outHeight, channels: 3 } })
        .extract({
            left: 0,
            top: 0,
            width: Math.min(image.declaredWidth, outWidth),
            height: Math.min(image.declaredHeight, outHeight),
        })
        .jpeg({ quality: 95, chromaSubsampling: '4:4:4' })
        .toBuffer();
}

/**
 * Read the bare greeting every new socket sends.
 *
 * This is deliberately separate from the header request. The greeting belongs to the
 * *connection*, not to the volume, so a reconnect must read it again even when the
 * manifest it already holds is still valid. Folding the two together is what made the
 * retry path fail every time: a reconnected socket skipped the greeting, the next
 * `next()` handed the greeting to `drainPages`, and a frame with no `scenes` was
 * matched against an outstanding request -- "k-manga answered scene undefined while 16
 * other page(s) were outstanding". The manifest can be reused; the greeting cannot.
 */
async function greetSocket(socket) {
    const hello = await socket.next(READ_TIMEOUT_MS);
    const greeting = parseFrame(hello.payload);
    if (!greeting.hello) throw new Error('k-manga socket did not greet with a bare BCP000 frame');
}

async function readManifest(socket, session) {
    socket.send(buildHeaderRequest({ ticket: session.ticket, obfuid: session.obfuid, profile: KM_PROFILES[0] }));
    const reply = await socket.next(READ_TIMEOUT_MS);
    const frame = parseFrame(reply.payload);
    if (frame.chunks !== null) throw new Error('k-manga header reply unexpectedly carried image data');

    const body = frame.body || {};
    if (!Array.isArray(body.contentInfos) || !body.contentInfos.length) {
        throw new Error(`k-manga header reply listed no pages: ${JSON.stringify(body).slice(0, 200)}`);
    }
    return body;
}

const DEFAULT_PIPELINE = 8;

const MAX_PIPELINE = 32;

const PROCESS_LIMIT = 4;

const MAX_ATTEMPTS = 6;

/**
 * How many viewer sockets one volume may spread its pages over.
 *
 * The store paces a single connection rather than the requests on it, so a deeper
 * pipeline stops helping while another socket keeps scaling. Four is where the
 * measured curve flattened (`scripts/probes/probe-kmanga.mjs`, interleaved medians:
 * 468 ms/page on one socket, 369 ms on two, 192 ms on four) and it is also the
 * point where the run-to-run spread collapsed from 5.3x to 1.3x.
 */
const KM_MAX_SOCKETS = 4;

/**
 * Pages a socket has to be responsible for before another one is worth opening.
 *
 * Every extra socket costs a WebSocket handshake and a header round trip, which is
 * pure overhead on an eleven-page sampler. At this spacing a volume has to be
 * around a hundred pages before the pool is full.
 */
const KM_PAGES_PER_SOCKET = 32;

export async function drainPages({ socket, session, manifest, work, depth, processLimit, onPage, timer = null }) {
    const outstanding = new Map();
    const processing = new Set();
    const errors = [];
    let cursor = 0;

    const fill = () => {
        while (outstanding.size < depth && cursor < work.length) {
            const item = work[cursor++];
            outstanding.set(item.sceneNo, item);
            socket.send(buildDataRequest({
                ticket: session.ticket,
                obfuid: session.obfuid,
                name: item.entry.name,
                decryptKey: manifest.dk,
            }));
        }
    };

    fill();
    while (outstanding.size) {
        // The wait for the next frame is this store's download: pages arrive over
        // the viewer socket rather than by HTTP request, so there is no fetch call to
        // wrap and the socket read is the only place the transfer is visible.
        const reply = await timed(timer, 'fetch', () => socket.next(READ_TIMEOUT_MS));
        const frame = parseFrame(reply.payload);
        const scenes = frame.body?.scenes;
        const sceneNo = Array.isArray(scenes) && scenes.length ? scenes[0].sceneNo : undefined;
        const item = outstanding.get(sceneNo);
        if (!item) {
            throw new Error(`k-manga answered scene ${sceneNo} while ${outstanding.size} other page(s) `
                + 'were outstanding, so the reply cannot be matched to a request');
        }
        outstanding.delete(sceneNo);
        fill();

        const task = onPage(item, frame).catch((error) => { errors.push({ item, error }); });
        processing.add(task);

        task.finally(() => processing.delete(task));
        if (processing.size >= processLimit) await Promise.race(processing);
    }
    await Promise.all(processing);
    return errors;
}

export async function downloadKmanga(task, ctx = {}) {
    const out = ctx.out;
    if (!out) throw new Error('k-manga: ctx.out is required');
    const key = task.key || `kmanga:${task.target}`;
    const tell = (event, payload) => {
        if (event === 'update') ctx.progress?.update(key, payload);
        else if (event === 'note') ctx.progress?.note?.(payload);
    };

    let descramble = true;
    if (ctx.descramble === false) {
        descramble = false;
    } else if (sharpAvailable()) {
        descramble = true;
    } else if (ctx.descramble === true) {
        assertSharpAvailable();
    } else {
        throw new Error(
            'k-manga pages are block-scrambled and need the optional "sharp" dependency to be un-shuffled.\n'
            + '  Install it with:  npm install sharp\n'
            + '  Or pass --no-descramble to keep the scrambled pages deliberately.',
        );
    }

    tell('update', { label: task.title || key, phase: 'downloading', total: 0, done: 0, failed: 0, bytes: 0 });

    // The launcher mints the ticket the socket needs, so the session is unavoidably
    // first. The index is not: it is a second HTTP round trip whose only product is the
    // chapter list that goes into the volume marker -- the page list and the decrypt key
    // both come from the socket's header reply. It is therefore started here and awaited
    // only when the marker is written, which lets it overlap the socket handshake and the
    // whole download behind it. Measured live at 1.14 s per volume, about a third of this
    // store's handshake, on a title whose index carried zero chapters.
    //
    // Reported as `prework`, not `handshake`: it is preparation the volume needs
    // before it can be described, and the point of the handshake figure is the wall
    // time a volume waits before its first page, which a request running underneath
    // it is not part of.
    const opened = await timed(ctx.timer, 'handshake', () => openKmangaSession(task.launcher, ctx));
    const { cookies, session } = opened;
    // The index is the volume's chapter list: preparation the reader needs, not a
    // handshake and not page bytes. It runs underneath the socket setup, so it is
    // timed from here to its own resolution rather than wrapped in `in()`, which
    // would end up measuring the await instead of the request.
    const stopIndex = ctx.timer?.start();
    const indexPromise = fetchKmangaIndex(session, cookies, ctx)
        .catch(() => null)
        .finally(() => { if (stopIndex) ctx.timer.record('prework', stopIndex()); });
    const bookId = task.bookId || session.bookId || 'unknown';

    const title = task.title || `k-manga ${bookId} vol ${task.volume ?? '?'}`;

    const id = task.id || task.target;
    const shown = task.target || title;

    const folder = await volumeFolder(ctx, { title, id, sample: task.sample === true });
    await fsp.mkdir(folder, { recursive: true });

    const depth = Math.max(1, Math.min(MAX_PIPELINE, Number(ctx.kmConcurrency) || DEFAULT_PIPELINE));
    const processLimit = Math.max(1, Math.min(PROCESS_LIMIT, depth));
    const attempts = Math.max(1, Math.min(MAX_ATTEMPTS, 1 + (Number(ctx.retries) || 0)));

    let downloaded = 0;
    let skipped = 0;
    let bytes = 0;
    let manifest = null;
    let work = null;
    let total = 0;
    const done = new Set();
    const permanent = new Map();
    let lastError = null;

    for (let attempt = 1; attempt <= attempts; attempt++) {
        const sockets = [];
        try {
            // The first socket also carries the header reply: it holds both the page list
            // and the session's decrypt key. The key is bound to the ticket, which is
            // minted once for this volume, so a retry can reuse the reply rather than
            // spending another round trip on an answer that cannot have changed. It is
            // *not* cached across volumes, where a new session means a new ticket and a
            // new key.
            const connect = ctx.connectSocket || connectWebSocket;
            const opened = await timed(ctx.timer, 'handshake', async () => {
                const socket = await connect(KM_WS_URL, { origin: KM_ORIGIN, userAgent: ctx.userAgent });
                // The greeting is per connection and is read on every attempt; the header
                // reply is per ticket and is reused across attempts. See `greetSocket`.
                await greetSocket(socket);
                return { socket, manifest: manifest ?? await readManifest(socket, session) };
            });
            manifest = opened.manifest;
            sockets.push(opened.socket);

            if (!work) {
                const pages = manifest.contentInfos
                    .slice()
                    .sort((a, b) => Number(a.startSceneNo) - Number(b.startSceneNo));
                total = pages.length;
                work = [];
                for (const [position, entry] of pages.entries()) {
                    const file = PAGE_NAME(position + 1);
                    const full = path.join(folder, file);
                    if (!ctx.force && await exists(full)) {
                        skipped += 1;
                        done.add(position);
                        continue;
                    }
                    work.push({ index: position, entry, sceneNo: Number(entry.startSceneNo), file, full });
                }
                tell('update', { label: title, total, done: skipped });
            }

            const todo = work.filter((item) => !done.has(item.index) && !permanent.has(item.index));
            if (!todo.length) break;

            // One connection is rate-limited by the store no matter how deep its pipeline
            // is, so the remaining pages are spread over a few sockets instead of queued on
            // one. Measured live, interleaved so server drift hit every arm equally, over
            // 16 pages of one free volume (`scripts/probes/probe-kmanga.mjs`):
            //
            //   sockets      1       2       4
            //   median     468ms   369ms   192ms   per page
            //   spread   317-1680 262-697 191-246
            //
            // The median is 2.4x better and the spread collapses from 5.3x to 1.3x, which is
            // the more valuable half: this store's instability, not its best case, is what
            // makes a run unpredictable. Depth stays as configured on *each* socket, because
            // splitting the budget across the pool measured worse (4 sockets at depth 4:
            // 396 ms per page median, against 204 ms at depth 16), and the extra sockets are
            // only opened when the sheet is long enough to need them.
            //
            // Note this budget is per volume: two volumes running together open two pools,
            // so the total in flight is volumes x sockets x depth. Nothing measures that
            // product yet; see docs/parallelism.md.
            const count = Math.max(1, Math.min(KM_MAX_SOCKETS, Math.ceil(todo.length / KM_PAGES_PER_SOCKET)));
            if (count > 1) {
                const rest = await timed(ctx.timer, 'handshake', () => Promise.all(
                    Array.from({ length: count - 1 }, async () => {
                        const socket = await connect(KM_WS_URL, { origin: KM_ORIGIN, userAgent: ctx.userAgent });
                        // Each socket authenticates the same way and gets its own copy of the
                        // reply; the key is per ticket, so it must match the first socket's.
                        await greetSocket(socket);
                        await readManifest(socket, session);
                        return socket;
                    }),
                ));
                sockets.push(...rest);
            }

            const shards = sockets.map(() => []);
            todo.forEach((item, i) => shards[i % sockets.length].push(item));

            // The rebuild budget is a property of the machine, not of the socket, so it is
            // divided by the pool: four sockets must not each run four `sharp` rebuilds.
            const perSocketProcess = Math.max(1, Math.round(processLimit / sockets.length));

            // `allSettled`, not `all`: a socket that dies must not abandon the other
            // shards' promises. They would keep draining into a closed socket and reject
            // with nobody watching, which is an unhandled rejection that can take the
            // process down; waiting for every shard also means the retry starts from a
            // settled page set instead of racing one still being written.
            const settled = await Promise.allSettled(sockets.map((socket, index) => drainPages({
                socket, session, manifest, work: shards[index], depth, processLimit: perSocketProcess, timer: ctx.timer,
                onPage: async (item, frame) => {
                    const buffer = await timed(ctx.timer, 'rebuild', () => pageBytes(frame, item.entry, descramble));
                    await timed(ctx.timer, 'write', () => fsp.writeFile(item.full, buffer));
                    downloaded += 1;
                    bytes += buffer.length;
                    done.add(item.index);
                    tell('update', { phase: 'downloading', done: skipped + downloaded, total, bytes });
                },
            })));

            let shardError = null;
            for (const outcome of settled) {
                if (outcome.status === 'fulfilled') {
                    for (const { item, error } of outcome.value) permanent.set(item.index, error.message);
                } else {
                    shardError = shardError || outcome.reason;
                }
            }
            if (shardError) throw shardError;

            if (!work.some((item) => !done.has(item.index) && !permanent.has(item.index))) break;
            // Anything still outstanding goes round again. This used to force the loop
            // to exit here, which spent one attempt of the budget and then failed the
            // whole volume from the check below, without ever using the retries that
            // the budget exists for.
        } catch (error) {
            lastError = error;
        } finally {
            for (const socket of sockets) socket.close();
        }
    }

    const failures = [...permanent].map(([position, error]) => ({ file: PAGE_NAME(position + 1), error }));
    const unfinished = (work || []).filter((item) => !done.has(item.index) && !permanent.has(item.index));
    if (unfinished.length) {
        throw new Error(`k-manga: ${unfinished.length} of ${total} pages of "${title}" were never fetched`
            + `${lastError ? `: ${lastError.message}` : ''}`);
    }

    if (!downloaded && !skipped) {
        // A retry budget that expired before the manifest was read leaves `total` at
        // zero, and "every one of the 0 pages failed to download" then hides the only
        // line that says what actually went wrong.
        if (!total && lastError) {
            throw new Error(`k-manga: "${title}" could not be opened at all: ${lastError.message}`);
        }
        throw new Error(`k-manga: every one of the ${total} pages of "${title}" failed to download`
            + (failures.length ? `: ${failures[0].error}` : ''));
    }

    await writeVolumeMarker(folder, {
        store: 'kmanga',
        id,
        bookId,
        volume: task.volume ?? null,
        title: shown,
        sample: task.sample === true,
        descrambled: descramble,
        chapters: (await indexPromise)?.chapters || null,
    });

    if (downloaded) await stampPageTimes(folder, Array.from({ length: total }, (_, i) => PAGE_NAME(i + 1)));

    return {
        store: 'kmanga',
        id,
        title: shown,
        folder,
        totalPages: total,
        downloaded,
        skipped,
        failed: failures.length,
        bytes,
        failures,
    };
}

async function exists(file) {
    return fsp.access(file).then(() => true, () => false);
}

async function pageBytes(frame, entry, descramble) {
    const scenes = frame.body?.scenes;
    if (!Array.isArray(scenes) || !scenes.length) {
        throw new Error(`k-manga page ${entry.name} carried no scene`);
    }
    const scene = scenes[0];
    const images = scene.images || [];
    if ((scene.sceneImagePartition ?? 1) > 1 || images.length > 1) {
        throw new Error(`k-manga page ${entry.name} is a composite scene `
            + `(partition ${scene.sceneImagePartition}, ${images.length} image(s)), which is not supported`);
    }
    const image = images[0];
    if (!image || !frame.chunks?.length) throw new Error(`k-manga page ${entry.name} carried no image data`);
    if (image.format !== 'jpeg') {
        throw new Error(`k-manga page ${entry.name} is ${image.format}, which is not implemented`);
    }

    const jpeg = frame.chunks[0];
    if (!readJpegSize(jpeg)) throw new Error(`k-manga page ${entry.name} is not a readable JPEG`);
    if (!isScrambled(image) || !descramble) return jpeg;
    return descrambleJpeg(jpeg, {
        key: Number(image.key),
        declaredWidth: Number(image.width),
        declaredHeight: Number(image.height),
    });
}

export const platform = {
    name: 'k-manga',
    id: 'kmanga',
    label: 'KM',
    lane: 'net',
    patterns: [
        { re: /comic\.k-manga\.jp\/title\/(\d+)\/vol\/(\d+)/i, kind: 'kmanga-volume',
            build: (m, raw) => ({ kind: 'kmanga-volume', bookId: m[1], volume: Number(m[2]), url: raw }) },
        { re: /comic\.k-manga\.jp\/viewer-launcher\/(?:\d+\/){2}(\d+)\/[a-z]+\/(\d+)/i, kind: 'kmanga-volume',
            build: (m, raw) => ({ kind: 'kmanga-volume', bookId: m[1], volume: Number(m[2]), url: raw }) },
        { re: /comic\.k-manga\.jp\/title\/(\d+)/i, kind: 'kmanga-title',
            build: (m, raw) => ({ kind: 'kmanga-title', bookId: m[1], url: raw }) },
    ],
    volumeId: () => null,
    expand: (det) => det.kind === 'kmanga-volume',
    series: (det, input, ctx = {}) => resolveKmangaInput(det, { ...ctx.config, series: true }, input, ctx),
    resolve: (det, config, input, ctx) => resolveKmangaInput(det, config, input, ctx),
    download: downloadKmanga,
};
