# Vendored engines

`manga-dl` does not reimplement any store's decryption. It drives three engines that
already existed, copied here so a fresh clone runs with no sibling checkouts. Two of
them carry deliberate deviations from upstream, recorded under "Deviations" below.

| Directory | Origin | Module system | Derived from |
|---|---|---|---|
| `cmoa/` | `cmoa_headless` in the CMOA work tree | ESM | that work tree, by the same author |
| `ebookjapan/` | `ebookjapan_headless` in the CMOA work tree | ESM | that work tree, by the same author |
| `bookwalker/` | `bookwalker-native-cli/cli` | CommonJS | the userscript repo's BookWalker logic, extracted to Node |

None of the three is a published repository. The two CMOA-work-tree engines were
written for Node, and the sampler was extracted from
[bookwalker-ebookjapan-cmoa-native-downloader](https://github.com/GolyBidoof/bookwalker-ebookjapan-cmoa-native-downloader)
when its CLI was split out at that project's v2.0.0. The userscript repo's own
`src/sites/cmoa/` and `src/sites/ebookjapan/` solve the same problems in a browser
and are the source of the algorithms, not of these files.

## Updating a vendored engine

These are copies, not submodules, because none of the three lives in a repository
that can be added as a submodule, and one of them (`bookwalker/`) is not under
version control at all.

To refresh one, copy the files over and re-apply the notes below, then run
`npm run engines:test` and `npm test`. Do not edit a vendored file to fix a bug in
`manga-dl`; fix the caller.

## Deviations from upstream

Deviations are kept to a minimum and recorded here, because a silent edit to a
vendored file is the kind of thing that gets lost.

### `bookwalker/public-trial.js`

The upstream file requires `./public-capture`, which reaches a lazily-loaded
Puppeteer path. This project is browserless by policy, so that route is replaced by
stubs that throw if anything ever calls them. Both call sites are only reached when
a caller explicitly asks for the capture route, so nothing in normal operation
touches them.

Two further deviations, both throughput fixes, both behaviour-preserving:

`crc32` was a bit-at-a-time loop over every page of a volume, run on the main thread
after the download had finished. A 244-page volume spent about 1.3s of dead tail in
it, and every volume of a `--series` batch stalled the event loop in turn. It is now
`zlib.crc32` when Node provides one (20.15+ and 22.2+) with the bit-at-a-time logic
kept as a table-driven fallback. The value is unchanged and is pinned against the
standard CRC-32 check value rather than against itself, because it is a wire format
that `unzip -t` has to accept. This is a safe change to send upstream.

`runPublicTrialJob` accepts an optional `options.normalizePage(data, job, manifest)`
hook, defaulting to the inline function, so an unchanged caller behaves exactly as
before. `manga-dl` passes a worker-pool-backed implementation so that un-permuting
and re-encoding encrypted pages stops competing with the event loop that drives the
fetches. Output is byte for byte identical; measured 2.7x on four workers. This one
is a genuine seam rather than a bug fix, so it is worth upstreaming as an option
rather than as a replacement.

### `bookwalker/package.json`

A new file, not an upstream one. It exists only to declare `"type": "commonjs"`,
because the parent package is ESM and Node would otherwise refuse to load this
CommonJS tree.

### `cmoa/`

`live_progress.js` was **removed**: it was imported by no engine module and is pure
presentation, so it moved to `src/display.js`. `vendor/cmoa/test/live_progress.test.mjs`
was repointed at the new location.

`bin/`, `.npmcache/` and the vendored `.gitignore` were dropped as packaging noise.

`src/downloader.js` changed by one line. `fetchPage` already accepted a `retries`
option and `openVolume` already forwarded the caller's budget to its two metadata
calls, but `downloadVolume` called `fetchPage` with `{ quality }` only. The retry
budget therefore applied to opening a volume and not to downloading its pages, which
is the opposite of useful: page fetches are the ones that fail. The call now passes
`retries` through as well. This one is a genuine engine bug, so it should be fixed
upstream and this note deleted when the engine is next refreshed.

### `ebookjapan/`

`bridge.mjs` had one deviation. The client put a 60 ms floor between consecutive
request starts, via a `pace()` helper called from `retrying()`. Because that floor
was global, its cost scaled with the page count rather than with request latency, and
it capped page uploads at 16.2 per second for the whole process: about 15s of dead
time before OCR could begin on a 244-page volume, and roughly four minutes across a
16-volume batch. It measured 178.4 pages per second with the floor gone, about 11x.

The gate was removed rather than made opt-out. Its only caller was `retrying()`, and
`retrying()`'s only caller was `pushPage()`, so it did nothing but serialise uploads;
the control-plane calls (`session/start`, `status`, `finalize`) call `request()`
directly and never took it. Pressure is still bounded by the caller's page
concurrency, by the bridge's own upload admission semaphore, and by the 429/5xx
exponential backoff, all unchanged. `COOLDOWN.minIntervalMs` is kept only so the
documented constant does not vanish; nothing reads it.

Everything else in this engine is unmodified.

## What is deliberately not vendored

- **Puppeteer** and anything that needs Chrome. Removed by policy: every engine here
  is browserless. `grep -ri puppeteer vendor/` should return nothing.
- **The sampler's browser session minting** (`browser.js`, `discovery.js`,
  `mint-session.js`, `cli.js`). Those exist to drive a real browser, which this tool
  does not do. A signed-in session is supplied as cookies instead; see the README.

## Cross-engine hazard

The ebookjapan engine's WASM phase installs browser globals (`window`, `document`,
`location`, `self`, `screen`, `devicePixelRatio`, `Window`) on `globalThis` and never
removes them. Its `fetch` shim is installed and restored around a single call and
does not leak, but the globals persist for the life of the process.

Observed: `typeof window` is `undefined` before an ebookjapan download and `object`
afterwards. The other two engines do not consult these globals, and a combined
three-store run succeeds, so this is recorded rather than worked around. If a future
engine starts branching on `typeof window`, ebookjapan will need to run in a child
process again.
