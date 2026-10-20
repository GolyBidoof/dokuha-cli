# Vendored engines

`dokuha` does not reimplement any store's decryption. It drives three engines that already existed, copied here so a fresh clone runs with no sibling checkouts. Each carries deliberate deviations from upstream, recorded under "Deviations" below. [docs/architecture.md](../docs/architecture.md) explains where these engines sit in the platform registry and the page pipeline.

| Directory | Origin | Module system | Derived from |
|---|---|---|---|
| `cmoa/` | `cmoa_headless` in the CMOA work tree | ESM | that work tree, by the same author |
| `ebookjapan/` | `ebookjapan_headless` in the CMOA work tree | ESM | that work tree, by the same author |
| `bookwalker/` | `bookwalker-native-cli/cli` | CommonJS | the userscript repo's BookWalker logic, extracted to Node |

None of the three is a published repository. The two CMOA-work-tree engines were written for Node, and the sampler was extracted from [bookwalker-ebookjapan-cmoa-native-downloader](https://github.com/GolyBidoof/bookwalker-ebookjapan-cmoa-native-downloader) when its CLI was split out at that project's v2.0.0. The userscript repo's own `src/sites/cmoa/` and `src/sites/ebookjapan/` solve the same problems in a browser and are the source of the algorithms, not of these files.

Kindle and k-manga have no vendored engine. Their protocol code and adapters live in `src/download/` because they were written for this project.

## Updating a vendored engine

These are copies, not submodules, because none of the three lives in a repository that can be added as a submodule, and one of them (`bookwalker/`) is not under version control at all.

To refresh one, copy the files over and re-apply the notes below, then run `npm run engines:test` and `npm test`. Do not edit a vendored file to fix a bug in `dokuha`; fix the caller.

## Deviations from upstream

Deviations are kept to a minimum and recorded here, because a silent edit to a vendored file is the kind of thing that gets lost.

### `bookwalker/public-trial.js`

The upstream file requires `./public-capture`, which reaches a lazily-loaded Puppeteer path. This project is browserless by policy, so that route is replaced by stubs that throw if anything ever calls them. Both call sites are only reached when a caller explicitly asks for the capture route, so nothing in normal operation touches them.

Two further deviations, both throughput fixes, both behaviour-preserving:

`crc32` was a bit-at-a-time loop over every page of a volume, run on the main thread after the download had finished. A 244-page volume spent about 1.3s of dead tail in it, and every volume of a `--series` batch stalled the event loop in turn. It is now `zlib.crc32` when Node provides one (20.15+ and 22.2+) with the bit-at-a-time logic kept as a table-driven fallback. The value is unchanged and is pinned against the standard CRC-32 check value rather than against itself, because it is a wire format that `unzip -t` has to accept. This is a safe change to send upstream.

`runPublicTrialJob` accepts an optional `options.normalizePage(data, job, manifest)` hook, defaulting to the inline function, so an unchanged caller behaves exactly as before. `dokuha` passes a worker-pool-backed implementation so that un-permuting and re-encoding encrypted pages stops competing with the event loop that drives the fetches. Output is byte for byte identical; measured 2.7x on four workers. This is a genuine seam rather than a bug fix, so it is worth upstreaming as an option rather than as a replacement.

A feature port from the userscript repo's PR #1 ("Enhance BookWalker downloader with improved naming conventions"): `runPublicTrialJob` accepts an optional `options.pageName(index, source, extension)`. When given, it is used for the file written to disk, the filename uploaded if the optional mokuro-bridge hand-off is used, and the ZIP entry, so all three agree and a resume looks for the page that was actually written. The engine defaults are the historical `page-NNNN.jpg` for files and ZIP entries and `page_NNNN.jpg` for the bridge, so an unchanged caller behaves exactly as before.

The policy itself is not in the engine: `dokuha` passes `bookWalkerPageName` from `src/download/page-files.js`, which keeps the naming rule on the `dokuha` side of the boundary and produces `0001 cover.jpg` from the EPUB source stem. [docs/naming.md](../docs/naming.md) has the rule, including the 255-byte cap. The only upstream changes are the seam plus carrying each job's manifest `file` through to the page objects it was missing from. This one is a genuine feature rather than a bug fix, so it is worth upstreaming as an option.

### `bookwalker/package.json`

A new file, not an upstream one. It exists only to declare `"type": "commonjs"`, because the parent package is ESM and Node would otherwise refuse to load this CommonJS tree.

### `cmoa/`

`live_progress.js` was **removed**: it was imported by no engine module and is pure presentation, so it moved to `src/live-progress.js`. `vendor/cmoa/test/live_progress.test.mjs` was repointed at the new location.

Two of that test's checks were then updated, because the shared module changed under it. The overall bar used to count only completed volumes, so on a long batch it sat still and then jumped; it then tracked pages that had actually been fetched. It now weights the whole pipeline instead: a downloading volume contributes its fetched share, uploading and OCR contribute theirs, and a finished volume contributes a whole unit, so the bar moves through upload and OCR too. The test asserts that contract: 40% for the fixture's two partly-finished volumes, 60% once one finishes, and no overshoot from further pages on a finished volume. The CLI's own `tests/test_display.mjs` covers the same behaviour from the other side.

`bin/`, `.npmcache/` and the vendored `.gitignore` were dropped as packaging noise.

Three changes were made while auditing CMOA's speed, all of them additions rather than alterations of behaviour, and all of them worth re-applying after a refresh:

- `downloader.js` now reports `fetchMs`, `renderMs` and `writeMs` alongside the existing `elapsedMs` in its `onProgress` payload. `elapsedMs` was the only figure available, and it cannot separate waiting for the CDN from rebuilding the page, which is exactly the split needed to tell where a CMOA run spends its time. Nothing consumes the field unless a caller asks.
- `jpeg.js` gained `readJpegSize()`, which walks the marker list to the frame header and returns the dimensions for a few microseconds. It exists so `codec.js` can ask how big a page is without decoding it.
- `codec.js` uses that in `renderPage`: whether any tile moves is a property of the coordinate and piece tables and the page's dimensions, not of its pixels, so the `format === 'original'` passthrough is now decided before `decodePage` rather than after it. Previously every page paid a full JPEG decode to discover that it needed no work, which is the common case for a volume the CDN serves already assembled. The rendered bytes are identical either way; only the route to them changed.

`codec.js`'s own comment on that branch already said "Nothing was permuted, so the served bytes already are the page"; the decode above it was simply in the wrong order.

`codec.js` gained a second, much faster renderer. `renderPage` is now async and dispatches: if `sharp` resolves it decodes and encodes through libvips, and if it does not it falls through to the original pure-JavaScript codec, which is untouched. The engine therefore still runs standalone with no dependencies. `sharp` is an optional dependency of `dokuha`, and a checkout without it silently keeps the old behaviour. `render-worker.js` awaits `renderPage` and its handler is async to match; the two vendored tests that called `renderPage` now await it too.

The measurements behind that choice, on one 244-page volume: the pure-JavaScript renderer spent 128 ms/page decoding and 68 ms/page encoding, and libvips does the same work in 8 ms and 15 ms. End to end, `rebuild` fell from 341 ms to 30 ms per page and the volume from 9.08 s to 2.83 s. Output is not byte-identical, because libvips uses its own quantisation and chroma upsampling, but at 4:2:0 the mean absolute pixel difference against the JavaScript path is 1.00/255, which is encoder rounding rather than anything visible, and the files are slightly smaller (554 KiB/page against 580).

The tile scatter still runs in JavaScript, and has to: the tiles sit at arbitrary offsets such as (4,4) and are not multiples of the 8- or 16-pixel boundaries that JPEG's variable-length MCUs would need for any cheaper move in the compressed domain. With full-resolution RGB in hand it is a row-wise rectangle copy rather than the per-pixel colour conversion the YCbCr path needed.

`src/downloader.js` changed by one line. `fetchPage` already accepted a `retries` option and `openVolume` already forwarded the caller's budget to its two metadata calls, but `downloadVolume` called `fetchPage` with `{ quality }` only. The retry budget therefore applied to opening a volume and not to downloading its pages, which is the opposite of useful: page fetches are the ones that fail. The call now passes `retries` through as well. This one is a genuine engine bug, so it should be fixed upstream and this note deleted when the engine is next refreshed.

### `ebookjapan/`

`page-list.mjs` had the one change that mattered for correctness. It asked the viewer WASM for the manifest with `open_param({ limit: 2000, size: 1200 })`. That `size` is not merely the viewer window: the WASM emits every page's tile coordinates in the coordinate space of that box, and the CLI reads those coordinates back out of the CDN image, which is served at the page's intrinsic size (1304x2048 for the book measured here, against a 1596x2432 image). With a 1200-tall box the recorded source offsets covered only the top-left corner of each image, so every rebuilt page came out as a shuffled mosaic: the composed image was full of unrelated fragments, exactly like the protected CDN asset.

Asking for a box at or above the intrinsic size (`limit: 10000, size: 10000`) returns the intrinsic page, and then the offsets line up with the image one to one: the same page composes to a clean 1304x2048 JPEG in about 117 ms. This matches the independent reverse-engineering of the same WASM in `bookwalker-drm/ebookjapan_stuff/wasm_understanding`, whose `SHUFFLE_FINDINGS.md` records that the tiling is of the displayed box and that taking the intrinsic window is the correct output.

Anything already downloaded before this change holds scrambled pages whose files are still structurally valid JPEGs, so the resume gate treats them as complete; re-fetch those volumes with `--force`.

`bridge.mjs` carries deliberate client-side deviations from upstream. The first was a 60 ms floor between consecutive request starts, via a `pace()` helper called from `retrying()`. Because that floor was global, its cost scaled with the page count rather than with request latency, and it capped page uploads at 16.2 per second for the whole process: about 15s of dead time before OCR could begin on a 244-page volume, and roughly four minutes across a 16-volume batch. It measured 178.4 pages per second with the floor gone, about 11x.

The gate was removed rather than made opt-out. Its only caller was `retrying()`, and `retrying()`'s only caller was `pushPage()`, so it did nothing but serialise uploads; the control-plane calls (`session/start`, `status`, `finalize`) call `request()` directly and never took it. Pressure is still bounded by the caller's page concurrency, by the bridge's own upload admission semaphore, and by the 429/5xx exponential backoff, all unchanged. `COOLDOWN.minIntervalMs` is kept only so the documented constant does not vanish; nothing reads it.

`resolveDestination` resolves a destination id against what the bridge reports before validating it. The bridge renamed account ids from `provider:name` spellings to aliases such as `provider-name` and accepts both as input, while the client only accepted the raw spelling it was given. It now matches the exact id, then for a colon id the derived alias (with underscores turned into hyphens, as the bridge derives it), then the reported `provider`/`account` pair, then the literal colon id for a bridge that reports only ids. The middle two matter after an account is renamed, when the alias no longer derives from the storage name at all. `provider:default` resolves to the bare provider. An unknown name is still rejected locally, and a colon name never falls back to the provider's first account, so a typo cannot silently retarget an upload. The client also resolves a relative `localDir` against this process rather than sending it to the bridge, which would have resolved it against the bridge's own working directory. This is a client compatibility fix and changes nothing against a bridge that reports the old ids.

`BridgeClient.status()` also keeps the bridge's response body in its error now. A 400 from that route means a persisted record for a finalized session is still on disk, while a 404 is a session that finished and was cleaned up; the caller has to tell those apart to resume or skip instead of failing the volume.

Everything else in this engine is unmodified.

#### `resumeSession` is an addition, not upstream

`BridgeClient.resumeSession(title, sourceDir)` wraps `POST /session/resume` with a `source_dir` field. Upstream `ebookjapan_headless` has no folder-ingest call: it pushes pages one HTTP request at a time, which is one request per page. The bridge has always had the route (its own `mokuro_bridge/ocr_folder.py` client uses exactly this call), so this is the client catching up to the server, not a change to the vendored engine's behaviour. It is additive: nothing existing calls it unless `src/bridge.js` chooses the folder path, and that path falls back to `pushPage` when the bridge refuses.

The route only accepts paths under `$HOME` or the system temp roots (403 otherwise) and reads the directory without moving it, so the caller's library is left alone.

#### The viewer's own build artefacts are not vendored

Un-shuffling a page and listing a volume need the store's WebAssembly module (`br_core_bg.<hash>.wasm`) and its wasm-bindgen glue chunk. Earlier revisions of this repository copied four of those files under `vendor/ebookjapan/`. They have been removed: they are ebookjapan's own proprietary build output, and redistributing them under this project's MIT licence is not ours to do.

`vendor/ebookjapan/bundles.mjs` now fetches them from `/_nuxt/` on first use and caches them under `~/.bwdd-cli/ebookjapan-assets/` (or `$BWDD_EBOOKJAPAN_ASSETS`). Only one name is known up front, the glue chunk, and the files it imports and the `.wasm` it loads are read out of its own text, so there is nothing else to keep in sync. The refresh procedure, and why the site cannot be scraped for the name instead, are in the section below.

This is a deviation from upstream `ebookjapan_headless`, which expects the files to sit beside `wasm.mjs`.

## What is deliberately not vendored

- **Puppeteer** and anything that needs Chrome. Removed by policy: every engine here is browserless. The word still appears in this file and in a stub comment in `vendor/bookwalker/public-trial.js`, so the plain `grep -ri puppeteer vendor/` check is not usable; see [CONTRIBUTING.md](../CONTRIBUTING.md) for the two commands that check for a real dependency and a real import.
- **The sampler's browser session minting** (`browser.js`, `discovery.js`, `mint-session.js`, `cli.js`). Those exist to drive a real browser, which this tool does not do. A signed-in session is supplied as cookies instead; see [docs/auth.md](../docs/auth.md).

## Cross-engine hazard

The ebookjapan engine's WASM phase installs browser globals (`window`, `document`, `location`, `self`, `screen`, `devicePixelRatio`, `Window`) on `globalThis` and never removes them. Its `fetch` shim is installed and restored around a single call and does not leak, but the globals persist for the life of the process.

Observed: `typeof window` is `undefined` before an ebookjapan download and `object` afterwards. The other engines do not consult these globals, and a mixed run succeeds, so this is recorded rather than worked around. If a future engine starts branching on `typeof window`, ebookjapan will need to run in a child process again.

## ebookjapan viewer assets

ebookjapan's page viewer is driven by a WebAssembly module. Un-shuffling a page and listing a volume both need it: `decrypt_session`, `open_param` and `shuffle` all live in `br_core_bg.<hash>.wasm`, behind a wasm-bindgen glue chunk the store serves from `/_nuxt/`.

Those files are **not** in this repository. They are the store's own proprietary build artefacts, and redistributing them under this project's MIT licence is not ours to do. They are fetched from the store at first use and cached on the machine that needs them.

| | |
|---|---|
| default cache | `~/.bwdd-cli/ebookjapan-assets/` |
| override | `BWDD_EBOOKJAPAN_ASSETS=/some/dir` |
| refresh the chunk name | `BWDD_EBOOKJAPAN_GLUE=NewChunk.js` |

The first run that needs them prints one line and downloads about 170 KB. Later runs read the cache and make no request for them at all, so an existing cache keeps working even if the store redeploys the files it was built from.

### Refreshing after a redeploy

`vendor/ebookjapan/bundles.mjs` names exactly one file up front, as `GLUE_CHUNK`. Everything else, the two chunks that file imports and the `.wasm` it loads, is read out of that chunk's own text, so there is nothing else to keep in sync. A Vite build hash changes only when the file changes, so this usually stays valid for a long time.

When it does change, the failure is explicit rather than a page-by-page failure: the 404 names the chunk and says to see here. To find the new name:

1. open any ebookjapan volume viewer in a browser and open DevTools, then Network;
2. filter for `wasm` and reload the viewer;
3. the request whose response is `br_core_bg...wasm` was issued by the glue chunk, so the requesting script is the `.js` chunk immediately before it in the log, named `/_nuxt/<name>.js`;
4. pass that name:

```sh
# one-off
BWDD_EBOOKJAPAN_GLUE=NewName.js dokuha '<ebookjapan URL>'

# permanent: change GLUE_CHUNK in vendor/ebookjapan/bundles.mjs, then
rm -rf ~/.bwdd-cli/ebookjapan-assets
```

Deleting the cache is what forces a refetch; without it the existing copy is used.

Scraping the name was tried and abandoned: the store publishes no Vite or Nuxt manifest, the viewer page's payload names no chunks, and a breadth-first walk of the whole 950-module graph reachable from the entry chunk never mentions `br_core_bg`. Discovery would have cost about 11 s and 5 MiB per cold start to find something a single constant already names.
