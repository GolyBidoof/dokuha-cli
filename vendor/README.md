# Vendored engines

`manga-dl` does not reimplement any store's decryption. It drives three engines that
already existed, copied here verbatim so a fresh clone runs with no sibling
checkouts.

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

Unmodified.

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
