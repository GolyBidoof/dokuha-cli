# Vendored engines

`manga-dl` does not reimplement any store's decryption. It drives three engines that
already existed, copied here verbatim so a fresh clone runs with no sibling
checkouts.

| Directory | Origin | Module system | Updated by |
|---|---|---|---|
| `cmoa/` | `cmoa_headless` from the CMOA work tree | ESM | upstream, then copied |
| `ebookjapan/` | `ebookjapan_headless` from the CMOA work tree | ESM | upstream, then copied |
| `bookwalker/` | `bookwalker-native-cli/cli` | CommonJS | upstream, then copied |

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
