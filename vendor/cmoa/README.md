# cmoa-headless (vendored)

Download free and trial manga from CMOA (コミックシーモア) without a browser. This is the vendored CMOA engine that `dokuha` drives through `src/download/cmoa.js`.

It runs on a stock Node 20+ using only the standard library. All image codecs (JPEG decode, JPEG encode, PNG encode) are implemented in-tree, so there is nothing to install. It is a from-scratch port of the `tampermonkey_script.js` userscript that used to do the same job from inside a browser page.

## How it is used here

`dokuha` imports `openVolume` and `downloadVolume` from this tree and calls them from the CMOA adapter. The adapter supplies the output folder, the page concurrency, the render worker count, the format, the quality and the retry budget. See [docs/stores.md](../../docs/stores.md) and [docs/architecture.md](../../docs/architecture.md).

This copy was trimmed for vendoring: the standalone `bin/` wrapper, `.npmcache/` and the vendored `.gitignore` were dropped as packaging noise, and `live_progress.js` moved to the CLI's own `src/live-progress.js`. The engine's own command entry, `main(argv)` in `src/cli.js`, is still present, but with no `bin/` wrapper it is not runnable by itself; `vendor/cmoa/package.json` still names a `bin/cmoa-headless.mjs` that is not in this tree, so treat `dokuha` as the supported entry point.

The deviations from the upstream engine are listed in [vendor/README.md](../README.md), including the one-line retry fix in `src/downloader.js` and the `sharp` fast path in `src/codec.js`.

## Driving CMOA and the other stores together

`dokuha` is the combined driver. It takes CMOA, ebookjapan, BookWalker, Kindle and k-manga URLs in one command and detects each one:

```sh
node bin/dokuha.mjs \
  'https://ebookjapan.yahoo.co.jp/books/126001/A009000001/' \
  'https://www.cmoa.jp/title/249001/' \
  'https://www.cmoa.jp/title/249001/vol/2/' \
  'https://bookwalker.jp/de00000001-0000-4000-8000-000000000001/?sample=2' \
  --out ./library --mokuro
```

A CMOA **title page** is accepted in place of a speedreader URL. A bare `/title/<id>/` resolves to volume 1 unless `--cm-volume` says otherwise, `/title/<id>/vol/<n>/` names that volume, and `--cm-volume all` probes upward from volume 1. CMOA publishes no volume list, so a series is discovered by probing; a volume is only accepted once its first page actually downloads, which is what keeps unreadable entries out of the queue. With `--series`, the title page is read directly and only the free-in-full volumes are taken, plus the 試し読み samplers when `--download-samplers` is given.

## What it writes

The canonical page name is `page-0001.jpg`: one-based, always four digits, so a plain name sort is reading order. The extension follows the page and the format (`page-0001.jpg` for jpeg and original, `page-0001.png` for png). A bare `0001.jpg` left by an earlier version is recognised and adopted rather than fetched again. A `metadata.json` marker describes the volume and every page, and modification times are restamped one second apart in reading order.

The extension is only known per page when the format is `original`, because a page that needed no reassembly keeps the CDN's own bytes.

## The engine's own command

The standalone command is still described by `src/cli.js`, and the options below match it. Invoke `main(argv)` if you need it in a scratch script. The flags are the engine's, not `dokuha`'s:

```
-o, --out DIR           output directory (default: ./<cid>)
    --title-dir         name the default output directory after the title
-c, --concurrency N     pages in flight (default: 12)
-j, --jobs N            worker threads for decoding/encoding (default: cores - 1, 0 = render inline)
-f, --format FMT        jpeg | png | original (default: jpeg)
-q, --quality N         JPEG quality 1-100 (default: 92); ignored for png
    --no-subsample      write 4:4:4 JPEG instead of 4:2:0
    --quality-request Q CDN quality parameter, normally 1 (default: 1)
    --force             re-download pages that already exist
    --limit N           only the first N pages
    --info              print volume information and exit
    --inspect           print per-page scramble details while downloading
    --quiet             suppress progress output
    --json              print a machine-readable summary
    --max-sockets N     use an explicit node:https pool of N sockets per host
    --retries N         attempts per request (default: 3)
    --timeout MS        per-request timeout in ms (default: 45000)
```

### `--format`

`original` keeps the CDN's own JPEG bytes when a page needed no reassembly, and otherwise re-encodes to JPEG. Choose `png` for lossless output at roughly 4 to 5 times the size.

### `--jobs` and `--concurrency`

These tune different things and both matter:

- `--jobs` parallelises the CPU work (JPEG decode, tile copy, re-encode) across worker threads. This is what makes it fast, because rendering is CPU-bound. `dokuha` sizes it from its shared CPU budget unless `--jobs` is passed.
- `--concurrency` is how many page fetches are in flight at once. The CDN is fast enough that this saturates well before 64.

`--jobs 0` renders on the main thread; useful for debugging, much slower.

## Performance

Measured on a 14-core machine, a 244-page volume (about 141 MiB), `--format original`:

| | wall time |
|---|---|
| naive: 6 fetches in flight, render on the main thread | **2 m 04 s** |
| tuned: 12 fetches in flight, 13 render workers | **8.6 s** |

Roughly 14 times faster. The measurements that drove the change:

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

Scaling is near-linear to 8 workers, flat to the default, and then regresses: past about 16 the workers contend more than they add. More threads than cores is not free.

The network peaks around 70 MiB/s, so moving 141 MiB takes about two seconds. A single core needs about 195 ms per page, roughly 48 s for the volume. The bottleneck was never the network: it was one thread doing all the decoding. Adding sockets beyond about 64 buys nothing; adding worker threads buys almost everything up to core count.

Run it yourself:

```sh
node vendor/cmoa/bench.mjs --pages 96 --concurrency 8,24,64,128,256
node vendor/cmoa/bench.mjs --max-sockets 256
```

### About `--max-sockets`

Node's global `fetch` runs through its own bundled undici pool, and undici is not importable as a public module in current Node, so its per-origin connection cap cannot be raised directly. `--max-sockets N` sidesteps this by switching every request to an explicit `node:https` agent with `maxSockets = N`. In practice the built-in pool already reaches the CDN's ceiling of about 70 MiB/s, so this is a knob for unusual networks rather than a speedup; it is off by default.

## How it works

The viewer is CMOA's "SpeedBinb". Four requests are involved:

| step | endpoint |
|---|---|
| content info | `POST /bib/sws/bibGetCntntInfo.php?cid=<cid>&k=<k>&dmytime=<ms>&u0=1` |
| page list | `{ContentsServer}/sbcGetCntnt.php?cid=<cid>&p=<p>&vm=<vm>&dmytime=<d>&u0=1` |
| each page | `{ContentsServer}/sbcGetImg.php?cid=<cid>&src=<src>&p=<p>&q=1&vm=<vm>&dmytime=<d>&u0=1` |

`u0=1` is required on all of them; omit it and you get `result: -100`.

### The `k` token

`k` is generated client-side by the viewer (`Reader.J(cid)`); the server only checks its shape. It is 32 characters from the URL-safe base64 alphabet: 16 random characters, then one extra character per position derived from a rolling XOR of the nonce, the cid repeated to 16 bytes, and the cid reversed and repeated to 16 bytes:

```js
k[i + 16] = B64[(xorNonce + xorHead + xorTail) & 63]
```

A freshly generated `k` is accepted (`result: 1`), which is why no browser session is needed. `src/protocol.js` implements this as `generateK`.

### Decrypting the scramble tables

The content-info response carries `stbl`, `ttbl`, `ctbl` and `ptbl` as scrambled strings. `Reader.jt` decrypts them:

- seed the hash from `cid + ':' + k`, and note that the key is the `cid`, not the ContentID;
- a 32-bit LFSR (`state = (state >>> 1) ^ (1210056708 & -(state & 1))`) supplies a per-character offset;
- each character moves back into printable ASCII, and the result is JSON.

### Reassembling a page

Each page is delivered as one JPEG containing the page cut into tiles, packed with padding. `Reader.mt` picks which of the 8 `ctbl`/`ptbl` entries to use from a checksum of the filename characters at even and odd offsets; here that is the pair whose entries look like `=8-8+4-...` (tiled, 8x8 grid, 4px padding).

The descrambler then produces a list of `(source -> destination)` rectangles. The details that matter, and that are easy to get wrong:

- the `width`/`height` of a destination rectangle are display-grid dimensions, so the edge tiles are one pixel narrower or taller than the interior ones;
- the layout is only applied when the image is large enough (`w >= 64 + 2*T*Dt && h >= 64 + 2*j*Dt && w*h >= (320 + 2*T*Dt)*(320 + 2*j*Dt)`); below that the page is already assembled and is used as-is;
- the visible region is the stored image minus the padding, which is occasionally a few pixels smaller than the declared display size; the packed tiles are clipped to the canvas deliberately.

Direction was verified by comparing the reassembled cover against CMOA's own unscrambled thumbnail: normalised cross-correlation **+0.9928** for the forward direction against **-0.057** for the identity.

### What is not implemented

- **The "numeric" descrambler.** The viewer has a second layout class (`a`) for tiled patterns that are not `=T-j+-Dt-...`. CMOA uses the tiled one for every page observed, so rather than ship an unverified transcription this raises `UnsupportedNumericLayout`.
- **Quality other than 1.** `sbcGetImg.php` accepts only `q=1`; `q=0,2,3,5` all return 403. The userscript's `desiredQuality: '3'` is not reachable through this endpoint, so the higher quality is simply not available.

## Layout

```
src/cli.js              the engine's own command (main(argv); no bin wrapper here)
src/protocol.js         k generation, table decryption, scramble selection
src/descrambler.js      tile geometry (tiled layout, verified against the viewer)
src/pagelist.js         volume metadata and page-list parsing
src/jpeg.js             baseline JPEG decoder
src/jpeg_encode.js      baseline JPEG encoder (4:2:0, Annex K tables)
src/png.js              PNG encoder with adaptive per-line filtering
src/codec.js            decode, reassemble, encode a page
src/render_pool.js      worker-thread pool (render-worker.js is the shim)
src/downloader.js       page list, worker pool, resume, writing
src/http.js             retry/backoff, timeouts, optional socket pool
bench.mjs               network and render benchmarks
test/                   see below
```

## Tests

```sh
npm run engines:test                   # 7 offline files, no network
node vendor/cmoa/test/run.mjs --live   # adds the two live tests
```

The offline tests need no network and no external tools: the scramble tables, a JPEG and its reference RGB decode are checked in under `test/fixtures/`. They cover `k` generation, table decryption, scramble selection, descrambler geometry compared rectangle for rectangle against a verbatim port of the viewer's own function, tile completeness, JPEG decode accuracy, and JPEG encode round-trip fidelity. `pagelist` and `codec` are live tests, and the runner skips them offline.

Two of the offline tests exist because of bugs that were invisible to ordinary assertions:

- **render pool** renders the same page inline and through a worker and demands byte-identical output. The worker used to transfer `data.buffer` straight out of Node's shared Buffer pool, which shipped a slice of a 64 KiB slab instead of the image and detached memory other buffers were still using, appearing rarely and far from its cause as `DataCloneError`.
- **live progress** replays rendered frames into a small ANSI terminal emulator and asserts on what the screen ends up showing: one header, one row per volume, nothing wider than the display, and no leftovers from earlier frames. Wide CJK titles padded by character count rather than display columns used to wrap lines and make the redraw paint over itself. `dokuha` keeps the shared progress module in `src/live-progress.js`, and this test was repointed there.
