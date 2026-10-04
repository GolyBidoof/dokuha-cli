# How dokuha is put together

This is the explanation a maintainer needs. For what the tool does and why you
would want it, read the [README](../README.md).

The whole design follows from one observation: **the five stores have nothing in
common except that each has a private viewer API.** So the code is arranged so that
everything a store shares is written once, and a store contributes only what is
genuinely its own.

## The platform descriptor

Every store is one descriptor, exported from its adapter and registered in
`src/platforms/index.js`:

```js
export const platform = {
    id: 'cmoa',
    name: 'CMOA',           // for messages
    label: 'CMOA',          // for the progress table
    lane: 'cpu',            // which scheduling lane
    workerKey: 'cmoa',      // claims a share of the CPU budget
    patterns: [ /* URL forms, in priority order */ ],
    volumeId: (det) => det.cid ?? null,
    expand: (det) => det.kind === 'cmoa-title',
    resolve: resolveCmoaInput,   // a title URL -> concrete volumes
    series: resolveCmoaSeries,   // the --series walk
    download: downloadCmoa,      // one volume -> one result record
};
```

`PLATFORMS` is ordered, and the order *is* the detection order: the first platform
whose patterns match an input owns it. Everything that used to be a branch in the
driver is a lookup here:

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
3. Register it in `PLATFORMS` **at the position its patterns should be tried**.

Nothing else changes. The driver, the scheduler, the progress display, the folder
naming and the summary all pick it up.

This is the change that mattered most for maintainability. Before it, a sixth store
meant a new branch in the driver, a new case in the adapter switch, an entry in
three parallel tables, and a `--help` group that had to be extended by hand.

## Two stages, not one

A volume has two halves that have nothing to do with each other: getting the pages,
and turning them into OCR text and an upload. They used to be one job, which meant a
volume waiting several minutes on OCR held the worker slot it had downloaded in,
while the network sat idle and later volumes queued behind a finished transfer.

They are now separate stages with a bounded queue between them:

```
   series walk ──► tasks ──┬──► cpu lane ──┐
             (streams)     │               ├──► download stage ──► bridge queue ──► bridge stage
                           └──► net lane ──┘        (pages on disk)     (bounded)     (OCR + upload)
```

- `--parallel N` governs the download stage, through a **single gate both lanes
  draw from**. (It used to build a pool of `parallel` workers *per lane*, so two
  stores meant `2N` volumes in flight, contradicting both the help text and the
  number the summary reports.)
- `--bridge-parallel` governs the bridge stage, defaulting to the same width.
- The queue holds `2 x --parallel` volumes, so a fast store cannot run a whole
  library onto disk while one OCR worker catches up.

A bridge failure is a failed volume, not a failed run: the stage never throws, and a
volume whose page uploads mostly failed is reported as failed rather than quietly
succeeding on the few that arrived.

## The CPU budget

Page rebuilding is CPU-bound and there is more of it than there are cores. Rather
than let each volume claim a whole machine, `src/cpu-budget.js` divides one budget
across everything currently running, weighted per store, and recomputed as volumes
come and go:

```
allocateCpu({ cores, active: { cmoa: 4, bookwalker: 1 }, renderJobs: null })
```

The count has to be the *real* count. Passing a floor of one for a store with no
volumes in the run silently costs a CMOA-only run a third of its render threads.

## Shared primitives

Everything the five adapters genuinely share lives outside them:

| Module | What it owns |
| --- | --- |
| `download/volume-folder.js` | which directory a volume writes into, and the owner marker |
| `download/page-files.js` | `page-NNNN.ext` naming, legacy-name adoption, mtime stamping |
| `store-result.js` | the one result shape every store produces |
| `retry.js` | one retry policy with full jitter |
| `serial.js` | the serial queue, and the bounded pool |
| `phase-timer.js` | the five-phase breakdown in every `--json` result |
| `cpu-budget.js` | the shared render and normalise budget |

**The volume folder** deserves a note, because it is the one place where a wrong
answer destroys data. A sampler and its whole volume share a content id, so naming
folders by id alone would send both to one directory where they overwrite each other
page for page. The `（試し読み）` suffix is therefore applied on *both* naming paths,
and a `metadata.json` marker records which volume owns a folder so two volumes whose
titles clean up identically are disambiguated rather than merged. A folder with no
marker is treated as the current volume's own, which is what lets an interrupted
download resume in place.

**The result contract** is the other one. `RESULT_CORE` is the set of fields a
consumer may rely on, always present, whatever the store. Store-specific fields are
passed through beside it. Before the contract existed, `sample` was reported by one
store out of three that had it, so anything reading `--json` across stores had to
feature-test per store.

## Detection

`src/detect.js` is a thin façade over the registry. The patterns live with the
platform that owns them, and `PLATFORMS` order is the matching order, so adding a
store cannot silently change how another store's URLs parse.

Detection returns a `det`, and the two things the driver asks about it are
`platformFor(det.kind)` and whether the input is a series page.

## The vendored engines

`vendor/` holds the three store engines, and they are deliberately *not* unified.

| Tree | Shape | Why |
| --- | --- | --- |
| `vendor/bookwalker/` | CommonJS | ported as-is from a working downloader, MIT, byte-validated against a capture |
| `vendor/cmoa/src/` | ESM | protocol recovered from the minified viewer bundle; own JPEG codec and render pool |
| `vendor/ebookjapan/` | ESM | page list, the WebAssembly descrambler, the bridge client |

Each keeps its own retry loop, its own connection handling and its own timeouts.
The tempting move is a shared HTTP layer, and it is the wrong one: each store's
polite-request behaviour is tuned to what that store actually tolerates, and the
thing they have in common is the part that is easiest to get subtly wrong. `vendor/README.md`
records the deviations, and `src/retry.js` documents the same decision from the CLI
side.

The ebookjapan viewer WebAssembly is **not** vendored. It is the store's proprietary
build output, it is fetched at runtime into `~/.bwdd-cli/ebookjapan-assets/`, and
redistributing it is not this project's to do.

## Where the difficulty actually is

Not in the plumbing. Per store, the hard part is:

- **CMOA** -- pages are served as a tile mosaic, and the shuffle table is not
  published, so the viewer's own tables are replayed. Descoded and re-encoded on
  worker threads, because it is pure CPU.
- **BookWalker** -- a licence handshake whose session splits across two hosts, then a
  viewer job that fetches encrypted pages and normalises them in a second worker
  pool. The only store with two pools.
- **ebookjapan** -- the viewer's WebAssembly is asked for its draw calls and those
  are replayed with sharp, because the shuffle table is not exposed. This is why
  ebookjapan is CPU-bound where it used to be network-bound.
- **Kindle** -- the reader bundle has to be reverse-engineered, the series walk is
  one round trip per volume, and volumes are borrowed rather than fetched.
- **k-manga** -- the viewer is a WebSocket that paces a connection rather than the
  requests on it, so the client interleaves several sockets per volume.

## Provenance

The BookWalker engine descends from a browser userscript, and the protocol work,
the crypto and the viewer job are shared with it. What is new here is that there is
no browser. That split is also why `--bw-login` is documented as unavailable: a
browserless CLI cannot reuse a userscript's session, so `--bw-cookie` is the
supported path and the rest is honest about it.

Both vendored trees record their own upstream in `vendor/README.md`, including the
MIT licence of the project the BookWalker logic came from and the capture it was
byte-validated against.

## Testing

`npm test` runs 26 files, offline and hermetic: no network, no credentials, no OCR
model. `DOKUHA_TEST_NETWORK=1` opts in to the live checks.

Three things are worth knowing about how it is written:

- **Wiring is tested by running it, not by grepping.** An earlier suite asserted
  that `run.js` contained the literal text `retries: config.retries`. That passes
  for a broken program and fails on a good refactor, so the guarantees are now
  expressed behaviourally -- parse the flag, build the context, assert the adapter
  received it.
- **Fixtures are synthetic.** Every title, ASIN, publication code and volume UUID in
  the suite is invented, so the repository carries no reference to any real work.
- **The worker pools are tested for crashing.** A pool that hands work to a dead
  worker hangs the whole run silently, so a test terminates a worker mid-flight and
  asserts the pool evicts it, refills, and still returns correct bytes.

## Known limits, in detail

The README lists these briefly. The long form:

- **Kindle** has no anonymous route, only supports `amazon.co.jp`, walks a series
  forward from the volume you paste, and makes one request per volume while
  scanning. Its download *is* the walk: a 220-page volume is about nineteen render
  round trips, which is why prefetch depth matters more than page concurrency.
- **ebookjapan** is capped at 48 sockets in flight, because the vendored engine
  sizes its keep-alive pool by reading `--concurrency` out of `process.argv` at
  import time. `--concurrency N` reaches it; `--eb-concurrency N` on its own does
  not. It cannot write a PDF here: that engine's PDF step runs its CLI at module
  scope and exits the process, so the flag was removed rather than shipped broken.
- **k-manga** has no account support, and its throughput cap is set by the store and
  moves by more than 5x over minutes, so wall time is not predictable.
- **BookWalker** needs `sharp` and, for anything not free, a browser-supplied
  session. See [auth.md](auth.md).
- **Retries** are a flat per-page budget, not adaptive backoff, and a failed volume
  does not stop the batch. Re-running the same command skips what is already on disk.
- **Store changes will break it.** These are undocumented viewer APIs. When a store
  changes its viewer, this stops working until the engine is updated.
