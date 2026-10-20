# Architecture

This is the explanation a maintainer needs. For what the tool does and why you would want it, read the [README](../README.md). For measurement context behind the tuning, read [performance.md](performance.md).

The whole design follows from one observation: the five stores have nothing in common except that each has a private viewer API. So the code is arranged so that everything the stores share is written once, and a store contributes only what is genuinely its own.

## The shape of a run

A run has two halves. The first is mandatory: capture pages through the store's viewer, rebuild them offline, write one folder per volume. The second is optional: hand the finished folder to a separate local service, mokuro-bridge, over HTTP for OCR and delivery. That service is not part of this project and is not required; the CLI is simply one client of its documented protocol.

```
URLs ──► detection ──► series walk ──► download lanes ──► volume folders on disk
                                            │
                                            └─(only with --mokuro)─► bridge stage ──► OCR + delivery
```

Detection, discovery and downloading belong to this repository. OCR and delivery belong to mokuro-bridge. Nothing in the CLI reads or writes a destination itself.

## The platform registry

Every store is one descriptor, exported from its adapter and registered in `src/platforms/index.js`:

```js
export const platform = {
    id: 'cmoa',
    name: 'CMOA',           // for messages
    label: 'CMOA',          // for the progress table
    lane: 'cpu',            // which scheduling lane
    tuning: {               // optional cross-cutting knobs
        concurrency: 12,    // the --cm-concurrency default
        contextKey: 'cmoaConcurrency',
        cpuWeight: 1,       // share of the CPU budget
        cpuSlot: 'renderJobs',
        flag: { name: 'cm-concurrency', order: 1, help: 'CMOA pages in flight' },
    },
    hosts: ['cmoa.jp'],
    patterns: [ /* URL forms, in priority order */ ],
    volumeId: (det) => det.cid ?? null,
    expand: (det) => det.kind === 'cmoa-title',
    resolve: resolveCmoaInput,   // a title URL to concrete volumes
    series: resolveCmoaSeries,   // the --series walk
    download: downloadCmoa,      // one volume to one result record
};
```

`PLATFORMS` is ordered, and the order is the detection order for bare codes. A URL that carries a host is claimed by the store that owns that host before any pattern is tried, so a link to one store inside another store's query string cannot hand the URL to the wrong adapter. A bare ten-character `B0...` token is genuinely ambiguous between a Kindle ASIN and an ebookjapan reading code; the registry tries Kindle first, and `tests/test_detect.mjs` pins that choice.

Everything the driver used to switch on is a lookup here: which adapter downloads a task, which lane it runs on, how a progress row is labelled, and whether a URL expands into several volumes.

### Adding a store

1. Write the adapter, exporting `download(task, ctx)` and a `platform` descriptor.
2. Put the URL patterns in the descriptor, in the order they should be tried.
3. Register it in `PLATFORMS` at the position its patterns should be tried.

Nothing else changes. A store with nothing to tune declares no `tuning` block, and the consumers fall back to defaults: no per-store concurrency flag and no share of the CPU budget. The `tuning` block carries the store's page concurrency, its CLI flag and help text, its CPU weight and the context field its adapter reads, so `options.js`, `run.js` and `cpu-budget.js` never name a store.

## The two-stage scheduler

A volume has two halves that have nothing to do with each other: getting the pages, and optionally OCRing and delivering them. They used to be one job, which meant a volume waiting minutes on OCR held the worker slot it had downloaded in while the network sat idle.

The stages are now separate, with a bounded queue between them:

```
series walk ──► tasks ──┬──► cpu lane ──┐
             (streams)  │               ├──► download stage ──► bridge queue ──► bridge stage
                        └──► net lane ──┘        (pages on disk)     (bounded)     (OCR + delivery)
```

- `--parallel N` governs the download stage through a single gate both lanes draw from. The default is unlimited: every discovered volume starts at once, and the CPU-bound part is admission-controlled per volume by `cpu-budget.js`.
- CMOA runs on the CPU lane because its rebuilding is pure JavaScript. The other four run on the network lane.
- With a finite `--parallel N`, an ordinary batch bounds the queue at twice that width, so a fast store cannot fill the disk while one OCR worker catches up. `--series` runs leave the queue unbounded so downloading can continue while earlier volumes wait.
- `--bridge-parallel N` governs the bridge stage and defaults to the same width. Either option accepts `unlimited`.

Tasks are discovered lazily: a series walk publishes a volume as soon as it knows it, so the first volume can start downloading while the rest of the series is still being resolved. Repeated inputs are deduplicated by task key before dispatch, because two writers for one folder race on the same page files and completion marker.

Downloading is not the same as finishing. A volume is complete when its page files are valid on disk, and a later run treats them as checkpoints: adapters reuse complete pages and fetch only missing or corrupt ones. `--force` opts out of both the page checks and the destination checks.

## The page pipeline

Each adapter reports up to five phases per volume, in order:

| Phase | What it covers |
|---|---|
| `handshake` | licence, login, token or ticket |
| `prework` | manifest, page list, render-window walk, descrambler module, shuffle table |
| `fetch` | page bytes over the network |
| `rebuild` | descrambling, seam-carving, re-encoding |
| `write` | writing a page to disk |

`handshake` and `prework` are serial and therefore wall time. `fetch`, `rebuild` and `write` are summed across concurrent page workers and are aggregates, not a partition of the run. A blank phase means the adapter has no seam there. [performance.md](performance.md) explains how to read them and which store reports which.

How each store actually gets its pages:

- **CMOA** serves pages as a tile mosaic with an unpublished shuffle table, so the viewer's own tables are replayed. Decoding and re-encoding run on worker threads because the work is pure CPU.
- **BookWalker** needs a licence handshake whose session splits across two hosts, then a viewer job that fetches encrypted pages and normalises them in a second worker pool. It is the only store with two pools.
- **ebookjapan** asks the viewer's WebAssembly for its draw calls and replays them with sharp, because the shuffle table is not exposed. That is why it is CPU-bound where it used to be network-bound.
- **Kindle** speaks the reader bundle's own API. A volume's pages arrive assembled, so there is nothing to rebuild; the cost is the render-window walk and the CDN. The walk pipelines its windows at depth 8, and the book's page-count ceiling is remembered across volumes in the run instead of being rediscovered.
- **k-manga** is a WebSocket viewer that paces a connection rather than the requests on it. A long volume therefore opens up to four sockets, and each socket keeps its own request depth.

## The CPU budget

Page rebuilding is CPU-bound and there is more of it than there are cores. `src/cpu-budget.js` divides the machine into per-volume shares, weighted per store, and recomputes the allocation every time a volume starts:

```
allocateCpu({ cores, active: { cmoa: 4, bookwalker: 1 }, renderJobs: null })
```

The share is per volume on purpose: CMOA's render pool serves one volume, so four CMOA volumes must get a quarter each rather than four whole pools. A floor of one worker per volume keeps a very large batch useful, which also means the shares are admission control rather than a hard run-wide cap. Eighteen CMOA volumes on a thirteen-core machine get one render thread each, so the sum across volumes can exceed the core count. The point is that no single volume takes the machine; the total is not promised.

Only CMOA and BookWalker declare a CPU slot, because their pools are ordinary JavaScript workers that respond to admission control. ebookjapan and k-manga descramble through `sharp`, and libvips already threads internally; an outer queue measured 30 percent slower, so their callers are left alone. The weights and slots come from each descriptor, so the allocator names no store.

## The series walker

`--series` turns every positional URL into an entry point into a series. The walker publishes only the volumes that are free to read in full; `--download-samplers` adds each remaining volume's 試し読み preview as its own task. The distinction matters because a preview is not a free volume, and a sampler shares a content id with the book it belongs to.

Discovery is store-specific and bounded per store:

- **BookWalker** reads the series id in the URL or pages through the volume listing, deduplicating volumes.
- **CMOA** pages through the title listing. It publishes no volume list, so `--cm-volume all` probes volumes up to `--cm-scan-limit` and accepts one only when its first page downloads.
- **ebookjapan** reads the title page's series data, keeping the free volumes and, when asked, the trial volumes.
- **Kindle** reads the whole volume list in one `seriesAsinList` request from the nearest volume that has a store page, then classifies every volume's access concurrently, up to 200 volumes. A Kindle-Unlimited-only volume with no store page is reached through a related volume.
- **k-manga** reads the title page's volume list.

A series download writes one sibling volume folder per volume under `--out`, the same layout as a single-volume run. There is no separate series directory.

## Naming and folders

A volume becomes one directory under `--out`, named after its title after sanitising characters that any target filesystem would reject, capped at 80 characters. A sampler carries the `（試し読み）` suffix on both the title and id naming paths, so it can never land in the same directory as the whole volume.

Each successful volume writes a `metadata.json` marker recording the store, the content id, the title and the expected page count; Kindle adds the series ASIN, revision and sample flag. The marker is what lets a resumed run tell "my folder" from "another volume whose title cleaned up the same way", in which case the folder becomes `title (id)` rather than merging two volumes. A folder with no marker is treated as the current volume's own.

Pages are named `page-0001.jpg` by default: the word `page`, a hyphen, a one-based ordinal padded to four digits and the extension. A plain name sort is reading order, and modification times are stamped one second apart so a date sort also reads in order. BookWalker keeps the manifest's source stem instead, as `0001 cover.jpg`, still ordinal-first. [naming.md](naming.md) has the full rules, including the 255-byte filename budget.

## Progress and JSON output

The live block is written for a terminal: one row per volume, a footer that totals the run, and a stage band that moves through download, OCR and upload. It repaints rather than scrolling, so the same rows update in place. Pressing `p` pauses the redraw so the text can be selected and copied while the run continues; `c` compacts the block. `--no-progress` replaces the block with one plain line per volume, and `--quiet` turns off both the block and the closing summary.

The footer totals the downloaded size, and on a `--mokuro` run it adds the size of the destination artifacts as the bridge reports them: cover webp, cbz, mokuro and the per-series `series.json`.

`--json` prints one summary on stdout after a real run: `volumes`, `succeeded`, `failed`, `unsupported`, `pages`, `skippedPages`, `alreadyPresent`, `bytes`, `elapsedSeconds`, `downloadSeconds`, `outDir`, `parallel`, a `mokuro` section when the bridge ran, and a `results` array. Each result guarantees the same core fields whatever the store: `store`, `id`, `title`, `folder`, `sample`, `totalPages`, `downloaded`, `skipped`, `failed`, `bytes` and `failures`, plus a `phases` object. Store-specific fields are passed through beside them. Before the contract existed, `sample` was reported by one store out of three that had it, so anything reading `--json` across stores had to feature-test per store.

Exit codes are part of the interface: `0` when every discovered volume finished, `1` when at least one failed, `2` for a usage problem.

## The optional mokuro-bridge hand-off

mokuro-bridge is an independent local service in the mokuro ecosystem, not a component of dokuha. It runs OCR, assembles `.cbz`, `.mokuro` and cover `.webp` files, delivers them to a folder or a cloud account, and publishes a per-series `series.json` for reader.mokuro.app, interoperating with mokuro-bunko where that owns the index. This CLI can act as one client of its HTTP and NDJSON protocol; the protocol belongs to that project and is documented there.

With `--mokuro`, a finished volume folder enters the bridge stage:

1. The CLI discovers a running bridge, or uses `--bridge URL`. Discovery walks the candidate list and accepts the first `/health` that identifies the service.
2. It resolves a destination from `GET /upload-methods`. `--dest` accepts any id the service reports (an account alias, a bare provider id, or `local`), and the historical `provider:name` spelling still resolves. No `--dest` keeps the service's current destination, which is sticky by design. `--dest-folder` applies only to a local destination and is resolved on this machine.
3. For a local bridge whose ingest roots cover the library, one `POST /session/resume` hands over the folder and the service copies and caches the pages itself, so a whole volume costs two requests rather than one per page. A bridge on another host, a library outside the ingest roots, and an unsupported or failing resume route all fall back to uploading pages with `POST /session/{id}/page`, four at a time by default.
4. `POST /session/{id}/finalize` returns a stream of NDJSON frames. The CLI reports OCR and upload progress from that stream and no longer polls the status route for progress. A `wait_ocr` frame carries the OCR counters, an `upload_progress` frame carries per-file bytes and speed, and the terminal `done` frame carries the uploaded files and their final sizes.
5. A terminal `error` frame, or a stream that ends without a terminal frame, is a failed volume. A `partial_upload` terminal frame means the destination received the files but not the series index, which the reader cannot build, so it is a failed volume too. The message names the service's own reason, and `--force` re-runs the hand-off with the `overwrite` collision policy so a retry can replace the stored copies.
6. Re-runs resume: a live session for the same title is inspected and attached instead of duplicated, a volume that was already delivered is skipped, and `--force` opts out of the local completion marker.

A volume that failed in the bridge stage is a failed volume, never a failed run: the batch carries on. Without `--mokuro`, the CLI does not submit pages, but it will still reconnect to matching live sessions from an earlier run and resume their progress display.

## The vendored engines

`vendor/` holds three store engines, deliberately not unified:

| Tree | Shape | Why |
|---|---|---|
| `vendor/bookwalker/` | CommonJS | ported from a working downloader, MIT, byte-validated against a capture |
| `vendor/cmoa/src/` | ESM | protocol recovered from the minified viewer bundle; own JPEG codec and render pool |
| `vendor/ebookjapan/` | ESM | page list, the descrambler client, the bridge client |

Each keeps its own retry loop, connection handling and timeouts. A shared HTTP layer is the tempting move and the wrong one: each store's polite-request behaviour is tuned to what that store tolerates, and the part they have in common is the easiest to get subtly wrong. [vendor/README.md](../vendor/README.md) records every deviation.

Kindle and k-manga are not vendored engines. Their adapters and protocol code live in `src/download/` because they were written for this project.

The ebookjapan viewer WebAssembly is not vendored. It is the store's proprietary build output, fetched at runtime into `~/.bwdd-cli/ebookjapan-assets/`, and redistributing it is not this project's to do.

## Shared primitives

| Module | What it owns |
|---|---|
| `download/volume-folder.js` | which directory a volume writes into, and the owner marker |
| `download/page-files.js` | page naming, BookWalker's source-stem naming, legacy-name adoption, mtime stamping, image completeness checks |
| `download/existing-volume.js` | the whole-volume already-present gate, validating every page |
| `store-result.js` | the one result shape every store produces |
| `retry.js` | one retry policy with full jitter, and error description |
| `serial.js` | the serial queue and the bounded pool |
| `phase-timer.js` | the five-phase breakdown in every `--json` result |
| `cpu-budget.js` | the shared render and normalise budget |
| `live-progress.js` | the terminal block |
| `bridge.js` | the optional mokuro-bridge stage |

## Testing

`npm test` discovers 31 files: 30 run offline and one, the live network check, is skipped unless `DOKUHA_TEST_NETWORK=1` is set. There is no network, no credentials and no OCR model in the default suite.

Three things are worth knowing about how it is written:

- **Load-bearing guarantees are behavioural.** An earlier suite asserted only that a source file contained a literal assignment, which passes for a broken program and fails on a good refactor. Behaviour is tested by running it; `tests/test_wiring.mjs` still reads a little source text for assertions that have no runtime seam, which is a known wart.
- **Fixtures are synthetic.** Every title, ASIN, publication code and volume UUID in the suite is invented, so the repository carries no reference to a real work.
- **The worker pools are tested for crashing.** A pool that hands work to a dead worker hangs the run silently, so a test terminates a worker mid-flight and asserts that the pool evicts it, refills, and still returns correct bytes.

## Provenance

The BookWalker engine descends from a browser userscript, and the protocol work, the crypto and the viewer job are shared with it. What is new here is that there is no browser. That split is also why there is no sign-in flag: a browserless CLI cannot reuse a userscript's session, so `--bw-cookie` is the supported path and the rest is honest about it.

The vendored trees record their own upstream in [vendor/README.md](../vendor/README.md), including the MIT licence of the project the BookWalker logic came from and the capture it was byte-validated against.

## Known limits

- **Kindle has no anonymous route** and only supports `amazon.co.jp`. Every volume, sampler included, needs a signed-in session.
- **Store changes will break a store.** These are undocumented viewer APIs. When a store changes its viewer, that adapter stops working until it is updated.
- **A failed volume does not stop a batch.** Re-running the same command skips what is already on disk.
- **k-manga's throughput belongs to the store.** It moves by multiples over minutes and the client cannot raise it.
- **Retries are a bounded per-page budget, not an adaptive backoff across the run.** A store that is down stays down for the length of that budget.
