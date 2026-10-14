# How dokuha is put together

This is the explanation a maintainer needs. For what the tool does and why you would want it, read the [README](../README.md).

The whole design follows from one observation: **the five stores have nothing in common except that each has a private viewer API.** So the code is arranged so that everything a store shares is written once, and a store contributes only what is genuinely its own.

## The platform descriptor

Every store is one descriptor, exported from its adapter and registered in `src/platforms/index.js`:

```js
export const platform = {
    id: 'cmoa',
    name: 'CMOA',           // for messages
    label: 'CMOA',          // for the progress table
    lane: 'cpu',            // which scheduling lane
    tuning: {               // the cross-cutting knobs, read by the driver
        concurrency: 12,    // --cm-concurrency default
        contextKey: 'cmoaConcurrency',
        cpuWeight: 1,       // share of the CPU budget
        cpuSlot: 'renderJobs',
        flag: { name: 'cm-concurrency', order: 1, help: 'CMOA pages in flight' },
    },
    patterns: [ /* URL forms, in priority order */ ],
    volumeId: (det) => det.cid ?? null,
    expand: (det) => det.kind === 'cmoa-title',
    resolve: resolveCmoaInput,   // a title URL -> concrete volumes
    series: resolveCmoaSeries,   // the --series walk
    download: downloadCmoa,      // one volume -> one result record
};
```

`PLATFORMS` is ordered, and the order is the detection order: the first platform whose patterns match an input owns it. Everything that used to be a branch in the driver is a lookup here:

| The driver used to... | now |
| --- | --- |
| `switch (task.kind)` to pick an adapter | `platformFor(task.kind).download(...)` |
| `if (det.kind === 'cmoa-title')` to expand | `platform.expand(det)` |
| a nested ternary choosing a task target | `platform.volumeId(det)` |
| an if-chain labelling progress rows | `platform.label` |
| `kind === 'cmoa' ? cpuLane : netLane` | `platform.lane` |
| `if (task.kind === 'kindle') loadSession()` | `platform.session.load()` |

### Adding a store

1. Write the adapter, exporting `download(task, ctx)` and a `platform` descriptor.
2. Put its URL patterns in the descriptor, in the order they should be tried.
3. Register it in `PLATFORMS` at the position its patterns should be tried.

Nothing else changes. The driver, the scheduler, the progress display, the folder naming and the summary all pick it up. A store with nothing to tune declares no `tuning` block at all, and the consumers fall back to sensible defaults: no per-store concurrency flag, and no share of the CPU budget. The `tuning` block is where a store's page concurrency, its CLI flag and help text, its CPU weight and the context field its adapter reads all live, so `options.js`, `run.js` and `cpu-budget.js` never name a store.

This is the change that mattered most for maintainability. Before it, a sixth store meant a new branch in the driver, a new case in the adapter switch, an entry in three parallel tables, and a `--help` group that had to be extended by hand.

## Two stages, not one

A volume has two halves that have nothing to do with each other: getting the pages, and turning them into OCR text and an upload. They used to be one job, which meant a volume waiting several minutes on OCR held the worker slot it had downloaded in, while the network sat idle and later volumes queued behind a finished transfer.

They are now separate stages with a bounded queue between them:

```
   series walk ──► tasks ──┬──► cpu lane ──┐
             (streams)     │               ├──► download stage ──► bridge queue ──► bridge stage
                           └──► net lane ──┘        (pages on disk)     (bounded)     (OCR + upload)
```

- `--parallel N` governs the download stage, through a **single gate both lanes draw from**. It used to build a pool of `parallel` workers per lane, so two stores meant `2N` volumes in flight, contradicting both the help text and the number the summary reports. The default is unlimited: every discovered volume starts at once, and the CPU-bound part is bounded by `cpu-budget.js` instead.
- `--bridge-parallel` governs the bridge stage, defaulting to the same width.
- With a finite `--parallel N`, an ordinary volume batch bounds the queue at `2 x N`, so a fast store cannot run a whole library onto disk while one OCR worker catches up. `--series` runs leave this queue unbounded so the next requested series can keep downloading while earlier volumes wait for OCR. With the default unlimited `--parallel`, the queue is unbounded too, but the download and bridge width limits still cap active work.
- Either concurrency option accepts `unlimited`. This removes queue backpressure; use it only when the machine, store and bridge can handle the load.

A bridge failure is a failed volume, not a failed run: the stage never throws, and a volume whose page uploads mostly failed is reported as failed rather than quietly succeeding on the few that arrived.

Page files are checkpoints: adapters reuse complete pages on a later run and fetch only missing or invalid files (`--force` opts out). When the bridge already owns a matching session, the CLI reads its session and shared OCR queue state, resumes the progress display, waits for an in-flight finalize or upload, or starts finalization if the session is ready. Without `--mokuro`, the CLI only reconnects to matching live bridge sessions; it does not submit new pages. For a volume whose pages are already on disk, the `existingDestination` early return skips the resume branch, so a completed local volume does not pick its live bridge session back up in resume-only mode. That is a known gap rather than desired behaviour.

## The CPU budget

Page rebuilding is CPU-bound and there is more of it than there are cores. Rather than let each volume claim a whole machine, `src/cpu-budget.js` divides one budget across everything currently running, weighted per store, and recomputed as volumes come and go:

```
allocateCpu({ cores, active: { cmoa: 4, bookwalker: 1 }, renderJobs: null })
```

The count has to be the real count. Passing a floor of one for a store with no volumes in the run silently costs a CMOA-only run a third of its render threads. Only CMOA and BookWalker reach the allocator, because only they declare a `cpuSlot`; ebookjapan and k-manga descramble through `sharp`, and libvips already threads internally, so capping their callers measured 30 percent slower. The weight each store asks for and the slot it fills both come from its `tuning` block, so the allocator names no store.

## Shared primitives

Everything the five adapters genuinely share lives outside them:

| Module | What it owns |
| --- | --- |
| `download/volume-folder.js` | which directory a volume writes into, and the owner marker |
| `download/page-files.js` | `page-NNNN.ext` naming, BookWalker's source-stem naming, legacy-name adoption, mtime stamping |
| `download/existing-volume.js` | the whole-volume already-present gate, validating every page |
| `store-result.js` | the one result shape every store produces |
| `retry.js` | one retry policy with full jitter |
| `serial.js` | the serial queue, and the bounded pool |
| `phase-timer.js` | the five-phase breakdown in every `--json` result |
| `cpu-budget.js` | the shared render and normalise budget |

**The volume folder** deserves a note, because it is the one place where a wrong answer destroys data. A sampler and its whole volume share a content id, so naming folders by id alone would send both to one directory where they overwrite each other page for page. The `（試し読み）` suffix is therefore applied on both naming paths, and a `metadata.json` marker records which volume owns a folder so two volumes whose titles clean up identically are disambiguated rather than merged. A folder with no marker is treated as the current volume's own, which is what lets an interrupted download resume in place. [naming.md](naming.md) has the full rules.

**The result contract** is the other one. `RESULT_CORE` is the set of fields a consumer may rely on, always present, whatever the store. Store-specific fields are passed through beside it. Before the contract existed, `sample` was reported by one store out of three that had it, so anything reading `--json` across stores had to feature-test per store.

## Detection

`src/platforms/index.js` owns detection. The patterns live with the platform that owns them, and a URL is claimed by the store that owns its host before any pattern is tried, so a link to one store inside another store's query string cannot hand the URL to the wrong adapter. `PLATFORMS` order is the matching order for bare codes, which carry no host, and that makes a bare `B0...` token an intentional ambiguity between a Kindle ASIN and an ebookjapan reading code.

Detection returns a `det`, and the things the driver asks about it are `platformFor(det.kind)`, whether the input is a series page, and whether the input can be expanded into volumes.

## The vendored engines

`vendor/` holds three store engines, and they are deliberately not unified.

| Tree | Shape | Why |
| --- | --- | --- |
| `vendor/bookwalker/` | CommonJS | ported as-is from a working downloader, MIT, byte-validated against a capture |
| `vendor/cmoa/src/` | ESM | protocol recovered from the minified viewer bundle; own JPEG codec and render pool |
| `vendor/ebookjapan/` | ESM | page list, the descrambler client, the bridge client |

Each keeps its own retry loop, its own connection handling and its own timeouts. The tempting move is a shared HTTP layer, and it is the wrong one: each store's polite-request behaviour is tuned to what that store actually tolerates, and the thing they have in common is the part that is easiest to get subtly wrong. [vendor/README.md](../vendor/README.md) records every deviation.

Kindle and k-manga are not vendored engines. Their adapters and protocol code live in `src/download/`, because they were written for this project rather than copied from a working downloader.

The ebookjapan viewer WebAssembly is **not** vendored. It is the store's proprietary build output, it is fetched at runtime into `~/.bwdd-cli/ebookjapan-assets/`, and redistributing it is not this project's to do.

## Where the difficulty actually is

Not in the plumbing. Per store, the hard part is:

- **CMOA**: pages are served as a tile mosaic and the shuffle table is not published, so the viewer's own tables are replayed. Decoded and re-encoded on worker threads, because it is pure CPU.
- **BookWalker**: a licence handshake whose session splits across two hosts, then a viewer job that fetches encrypted pages and normalises them in a second worker pool. The only store with two pools.
- **ebookjapan**: the viewer's WebAssembly is asked for its draw calls and those are replayed with sharp, because the shuffle table is not exposed. This is why ebookjapan is CPU-bound where it used to be network-bound.
- **Kindle**: the reader bundle has to be reverse-engineered, the whole series arrives in one store request with its per-volume access checks run at once, and volumes are borrowed rather than fetched.
- **k-manga**: the viewer is a WebSocket that paces a connection rather than the requests on it, so the client interleaves several sockets per volume.

## Provenance

The BookWalker engine descends from a browser userscript, and the protocol work, the crypto and the viewer job are shared with it. What is new here is that there is no browser. That split is also why there is no sign-in flag: a browserless CLI cannot reuse a userscript's session, so `--bw-cookie` is the supported path and the rest is honest about it.

The vendored trees record their own upstream in [vendor/README.md](../vendor/README.md), including the MIT licence of the project the BookWalker logic came from and the capture it was byte-validated against.

## Testing

`npm test` discovers 30 files: 29 run offline and one, the live network check, is skipped unless `DOKUHA_TEST_NETWORK=1` is set. There is no network, no credentials and no OCR model in the default suite.

Three things are worth knowing about how it is written:

- **Wiring is tested by running it where it matters, and by reading the source where it does not.** An earlier suite asserted only that `run.js` contained the literal text `retries: config.retries`, which passes for a broken program and fails on a good refactor; the load-bearing guarantees are now behavioural. `tests/test_wiring.mjs` still reads source text for a handful of assertions that have no runtime seam, which is a known wart.
- **Fixtures are synthetic.** Every title, ASIN, publication code and volume UUID in the suite is invented, so the repository carries no reference to any real work.
- **The worker pools are tested for crashing.** A pool that hands work to a dead worker hangs the whole run silently, so a test terminates a worker mid-flight and asserts the pool evicts it, refills, and still returns correct bytes.

## Known limits, in detail

The README and [stores.md](stores.md) list these. The long form:

- **Kindle** has no anonymous route, only supports `amazon.co.jp`, walks a series forward from the volume you paste, and makes one request per volume while scanning. Its download is the walk: a 220-page volume is about nineteen render round trips, which is why prefetch depth matters more than page concurrency.
- **ebookjapan** is capped at 48 sockets in flight by default, because the vendored engine sizes its keep-alive pool by reading `--concurrency` out of `process.argv` at import time. `--concurrency N` reaches it; `--eb-concurrency N` on its own changes the worker count but not the socket ceiling. The engine's PDF step runs its own CLI at module scope and exits the process, so there is no PDF output here.
- **k-manga** has no account support, and its throughput cap is set by the store and moves by more than five times over minutes, so wall time is not predictable.
- **BookWalker** needs `sharp` and, for anything not free, a browser-supplied session. See [auth.md](auth.md).
- **Retries** are a flat per-page budget, not adaptive backoff, and a failed volume does not stop the batch. Re-running the same command skips what is already on disk.
- **Store changes will break it.** These are undocumented viewer APIs. When a store changes its viewer, this stops working until the adapter is updated.

## Open engineering notes

These are still-true findings from the audits in [audits/](audits/2026-10-13-pre-release-audit.md), kept here because they are code work rather than user documentation:

- Some assertions in `tests/test_wiring.mjs`, `tests/test_serial.mjs` and `tests/test_modules.mjs` read source text instead of exercising behaviour.
- `run()` is long enough that the Kindle-specific branches would be clearer behind the registry.
- The vendored ebookjapan CLI module is imported for one helper (`fetchWithRetry`), which carries its module-scope argument parsing and HTTP agent into the process.
- A few exports in `src/platforms/index.js` are used only by tests.
