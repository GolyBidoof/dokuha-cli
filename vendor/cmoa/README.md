# cmoa-headless

Download free/trial manga from CMOA (コミックシーモア) as an ordinary CLI program.

No browser, no Chromium, no cookies, no login, and **no dependencies** — it runs on
a stock Node 20+ using only the standard library. All image codecs (JPEG decode,
JPEG encode, PNG encode) are implemented in-tree, so there is nothing to install.

This is a from-scratch port of the `tampermonkey_script.js` userscript that used to
do the same job from inside a browser page.

## Quick start

```sh
node bin/cmoa-headless.mjs 'https://www.cmoa.jp/bib/speedreader/?cid=0000249510_jp_0001&u0=1&rurl=...'
```

A bare `cid` works too, and so does a `title/<id>` URL:

```sh
node bin/cmoa-headless.mjs 0000249510_jp_0001 -o ./out
```

Output is `0001.jpg`, `0002.jpg`, … plus a `metadata.json` describing the volume and
every page. Re-running skips pages that already exist, so an interrupted download
resumes; use `--force` to redo them.

## Driving CMOA, ebookjapan and BookWalker together

There is a combined driver one level up that takes all three stores in one command:

```sh
node ../books.mjs \
  'https://ebookjapan.yahoo.co.jp/books/126344/A000065415/' \
  'https://www.cmoa.jp/title/249510/' \
  'https://www.cmoa.jp/title/249510/vol/2/' \
  'https://bookwalker.jp/def45047f5-6b90-4d4f-84f7-bd8263daee70/?sample=2' \
  --out ./library --series 4 --mokuro
```

A CMOA **title page** is accepted in place of a speedreader URL. It names a
series, so a bare `/title/<id>/` means volume 1, `/title/<id>/vol/<n>/` means that
volume, and `--cm-volume all` pulls everything. CMOA publishes no volume list, so
the series is discovered by probing; a volume is only accepted once its first page
actually downloads, which is what keeps unreadable entries out of the queue.

It auto-detects each URL, downloads the volumes in parallel, and optionally pushes
every one of them through a local mokuro-bridge for OCR.

How each store is driven differs, for reasons each of its own tools made necessary:

| store | invoked as | why |
|---|---|---|
| CMOA | in-process | pure Node, no process-global state |
| ebookjapan | subprocess | its WASM phase installs a process-global fetch shim |
| BookWalker | in-process (CommonJS `require`) | it exports its session/job surface and has no globals |

OCR for the first two is pushed from the driver; BookWalker streams its pages to
the bridge itself and the driver only finalizes the session. See that script's
`--help` for the full option list, including the BookWalker `--bw-*` flags.

### Progress

Beware one thing before benchmarking a large batch: the bridge re-queues **every
image folder it finds** under `~/mokuro-input`, including folders left behind by
earlier runs. Those pages are OCR'd again on the next run, so a run can appear to
crawl while the bridge works through a backlog of stale books. Check with:

```sh
curl -s http://127.0.0.1:62642/health | python3 -c \
  'import sys,json; print(json.load(sys.stdin)["ocr_queue_depth"])'
```

A single OCR worker drains roughly 0.8 pages/s when the queue is deep, so a
1,900-page backlog is about 40 minutes of work that has nothing to do with the
volume you just asked for. Move unwanted folders out of `~/mokuro-input` and
restart the bridge.

Running the bridge under launchd (`./install-launchd.sh` in the bridge repo)
keeps it alive across terminal restarts; a plain `nohup` process dies with the
shell and takes its queue with it.


On a terminal the driver keeps a live block: one line per book, showing the store,
the title, the current phase and a meter for that phase, under a header with
overall volume and page counts. It redraws in place, so a run stays a few lines
tall no matter how long it takes, and **a finished volume keeps its line** rather
than disappearing — the block ends up as a summary of the whole run.

Every phase draws the same bar — same width, same characters — so a row never
jumps sideways as it advances. Only the colour changes:

| phase | colour | meaning |
|---|---|---|
| download | cyan | fetching pages from the store |
| upload | white | pushing pages to mokuro-bridge |
| OCR | yellow | the bridge is recognising text |
| finalize | magenta | assembling `.mokuro` / `.cbz` |
| done | green | finished |
| failed | red | failed, with the bar showing how far it got |

The OCR bar is the one worth having: OCR is where most of the wall time goes, so
the bridge is polled while it works instead of the display sitting still. Note
that on a fast local bridge OCR often finishes *during* upload, in which case the
yellow phase is real but very brief, and the row goes straight from white to
magenta.

On a pipe, or with `--quiet` / `--json` / `--no-progress`, it degrades to one
durable line per finished volume, with no cursor movement at all. Colour follows
`NO_COLOR` / `FORCE_COLOR`.

### Volume-level parallelism

All volumes start at once. Queuing is almost always the wrong trade: the stores
are independent, CMOA's cost is CPU (so a queued CMOA volume simply idles the
machine), and ebookjapan and BookWalker are I/O bound. `--series N` caps it, and
the default is now the whole batch (up to 16 to avoid opening hundreds of
subprocesses). On the seven-volume example above:

| | wall time |
|---|---|
| `--series 4` (7 volumes, 3 queued) | **80.1 s** |
| `--series 7` (all at once) | **21.1 s** |

Roughly 3.8×, from doing nothing but not queuing.

### Downloads and renders already overlap

It is worth being precise about this, because the obvious optimisation is a
trap. Fetching and rendering do not need a pipeline stage between them: the render
pool's workers each fetch a page and then render it, so while some workers are
decoding, others are waiting on the network. Overlap is already happening.

Measured separately on a 60-page sample:

| stage | throughput |
|---|---|
| fetch only, 8 connections | 10 ms/page (≈100 pages/s) |
| render only, 1 thread | 181 ms/page (≈5.5 pages/s) |

Rendering is about **18× the cost of fetching**, and the pool saturates at
8 workers (36 pages/s) — beyond that it is flat, and past ~16 it regresses from
contention. So the network is roughly 10% of the work and the CPU is the other
90%; adding concurrency to the fetch side, or interleaving the two stages more
aggressively, cannot recover more than that 10%. The lever that matters is worker
threads, which is why `--jobs` defaults to every core but one.

## Options

```
-o, --out DIR           output directory (default: ./<cid>)
    --title-dir         name the default directory after the title instead
-f, --format FMT        original | jpeg | png (default: original)
-q, --quality N         JPEG quality 1-100 (default: 92)
-c, --concurrency N     pages in flight (default: 12)
-j, --jobs N            render worker threads (default: cores - 1, 0 = inline)
    --max-sockets N     use a node:https pool with N sockets per host
    --limit N           stop after N pages
    --force             re-download pages that already exist
    --info              print volume metadata and exit
    --inspect           include reassembly geometry per page
    --json              machine-readable summary on stdout
    --quiet             no progress output
```

### `--format`

`original` keeps the CDN's own JPEG bytes when a page needed no reassembly, and
otherwise re-encodes to JPEG. In practice every page of a CMOA volume is scrambled,
so this behaves as “re-encode to JPEG at `--quality`”. Choose `png` for lossless
output at roughly 4–5× the size.

### `--jobs` and `--concurrency`

These tune different things and both matter:

* `--jobs` parallelises the CPU work (JPEG decode, tile copy, re-encode) across
  worker threads. **This is what makes it fast**, because rendering is CPU-bound.
* `--concurrency` is how many page fetches are in flight at once. The CDN is fast
  enough that this saturates well before 64.

`--jobs 0` renders on the main thread; useful for debugging, much slower.

## Performance

Measured on a 14-core machine, 244-page volume (~141 MiB), `--format original`:

| | wall time |
|---|---|
| naive: 6 fetches in flight, render on the main thread | **2 m 04 s** |
| tuned: 12 fetches in flight, 13 render workers | **8.6 s** |

Roughly **14× faster**. The measurement that drove the change:

```
--- CDN throughput (raw bytes, no decoding) ---
conc   wall    MiB    MB/s    req/s   p50ms   p95ms
   8  2.49s    22.3     9.0      39      60     162
  24  0.36s    22.3    61.2     263      59     185
  64  0.33s    22.3    67.9     292      83     302
 128  0.71s    22.3    31.3     135     173     305
 256  0.31s    22.3    72.3     311     297     305

--- render throughput vs worker threads ---
jobs   pages/s   ms/page
   0      5.14    194.5
   1      5.33    187.5
   2     10.31     97.0
   4     20.74     48.2
   8     34.00     29.4
  13     36.10     27.7    <- default on a 14-core machine
  16     33.43     29.9
  24     24.80     40.4
```

Scaling is near-linear to 8 workers, flat to the default, and then regresses:
past about 16 the workers contend more than they add. More threads than cores is
not free.

The network peaks around 70 MiB/s, so moving 141 MiB takes about two seconds. A
single core needs ~195 ms per page, i.e. ~48 s for the volume. So the bottleneck was
never the network: it was one thread doing all the decoding. Adding sockets beyond
~64 buys nothing; adding worker threads buys almost everything up to core count.

Run it yourself:

```sh
node bench.mjs --pages 96 --concurrency 8,24,64,128,256
node bench.mjs --max-sockets 256        # force the explicit https pool
```

### About `--max-sockets`

Node's global `fetch` runs through its own bundled undici pool, and undici is not
importable as a public module in current Node, so its per-origin connection cap
cannot be raised directly. `--max-sockets N` sidesteps this by switching every
request to an explicit `node:https` agent with `maxSockets = N`. In practice the
built-in pool already reaches the CDN's ~70 MiB/s ceiling, so this is a knob for
unusual networks rather than a speedup; it is off by default.

## How it works

The viewer is CMOA's “SpeedBinb”. Four requests are involved:

| step | endpoint |
|---|---|
| content info | `POST /bib/sws/bibGetCntntInfo.php?cid=<cid>&k=<k>&dmytime=<ms>&u0=1` |
| page list | `{ContentsServer}/sbcGetCntnt.php?cid=<cid>&p=<p>&vm=<vm>&dmytime=<d>&u0=1` |
| each page | `{ContentsServer}/sbcGetImg.php?cid=<cid>&src=<src>&p=<p>&q=1&vm=<vm>&dmytime=<d>&u0=1` |

`u0=1` is required on all of them — omit it and you get `result: -100`.

### The `k` token

`k` is generated **client-side** by the viewer (`Reader.J(cid)`); the server only
checks its shape. It is 32 characters from the URL-safe base64 alphabet: 16 random
characters, then one extra character per position derived from a rolling XOR of the
nonce, the cid repeated to 16 bytes, and the cid reversed and repeated to 16 bytes:

```js
k[i + 16] = B64[(xorNonce + xorHead + xorTail) & 63]
```

A freshly generated `k` is accepted (`result: 1`), which is why no browser session
is needed. `src/protocol.js` implements this as `generateK`.

### Decrypting the scramble tables

The content-info response carries `stbl`, `ttbl`, `ctbl` and `ptbl` as scrambled
strings. `Reader.jt` decrypts them:

* seed the hash from `cid + ':' + k` — **the key is the `cid`, not the ContentID**;
* a 32-bit LFSR (`state = (state >>> 1) ^ (1210056708 & -(state & 1))`) supplies a
  per-character offset;
* each character moves back into printable ASCII, and the result is JSON.

### Reassembling a page

Each page is delivered as one JPEG containing the page cut into tiles, packed with
padding. `Reader.mt` picks which of the 8 `ctbl`/`ptbl` entries to use from a
checksum of the filename characters at even and odd offsets; here that is the pair
whose entries look like `=8-8+4-…` (tiled, 8×8 grid, 4px padding).

The descrambler then produces a list of `(source → destination)` rectangles. The
details that matter, and that are easy to get wrong:

* the `width`/`height` of a destination rectangle are **display-grid** dimensions,
  so the edge tiles are one pixel narrower/taller than the interior ones;
* the layout is only applied when the image is large enough
  (`w >= 64 + 2·T·Dt && h >= 64 + 2·j·Dt && w·h >= (320 + 2·T·Dt)·(320 + 2·j·Dt)`);
  below that the page is already assembled and is used as-is;
* the visible region is the stored image minus the padding, which is occasionally a
  few pixels *smaller* than the declared display size — the packed tiles are clipped
  to the canvas deliberately.

Direction was verified by comparing the reassembled cover against CMOA's own
unscrambled thumbnail: normalised cross-correlation **+0.9928** for the forward
direction versus **−0.057** for the identity.

### What is not implemented

* **The “numeric” descrambler.** The viewer has a second layout class (`a`) for
  tiled patterns that are not `=T-j±Dt-…`. CMOA uses the tiled one for every page
  observed, so rather than ship an unverified transcription this raises
  `UnsupportedNumericLayout`.
* **Quality other than 1.** `sbcGetImg.php` accepts only `q=1`; `q=0,2,3,5` all
  return 403. The userscript's `desiredQuality: '3'` is not reachable through this
  endpoint, so the higher quality is simply not available.

## Layout

```
bin/cmoa-headless.mjs   entry point
src/protocol.js         k generation, table decryption, scramble selection
src/descrambler.js      tile geometry (tiled layout, verified against the viewer)
src/pagelist.js         volume metadata and page-list parsing
src/jpeg.js             baseline JPEG decoder
src/jpeg_encode.js      baseline JPEG encoder (4:2:0, Annex K tables)
src/png.js              PNG encoder with adaptive per-line filtering
src/codec.js            decode → reassemble → encode a page
src/render_pool.js      worker-thread pool (render-worker.js is the shim)
src/downloader.js       page list, worker pool, resume, writing
src/http.js             retry/backoff, timeouts, optional socket pool
bench.mjs               network + render benchmarks
test/                   see below
```

## Tests

```sh
npm test                 # offline tests (no network)
node test/run.mjs --live # also exercise the real API
```

Offline tests need no network and no external tools: the scramble tables, a JPEG
and its reference RGB decode are checked in under `test/fixtures/`. They cover
`k` generation, table decryption, scramble selection, descrambler geometry compared
rectangle-for-rectangle against a verbatim port of the viewer's own function, tile
completeness, JPEG decode accuracy, and JPEG encode round-trip fidelity.

Two of them exist because of bugs that were invisible to ordinary assertions:

- **render pool** renders the same page inline and through a worker and demands
  byte-identical output. The worker used to transfer `data.buffer` straight out of
  Node's shared Buffer pool, which shipped a slice of a 64 KiB slab instead of the
  image and detached memory other buffers were still using — appearing rarely, and
  far from its cause, as `DataCloneError`.
- **live progress** replays rendered frames into a small ANSI terminal emulator
  and asserts on what the screen ends up showing: one header, one row per volume,
  nothing wider than the display, and no leftovers from earlier frames. Wide CJK
  titles padded by character count (rather than display columns) used to wrap
  lines and make the redraw paint over itself.
