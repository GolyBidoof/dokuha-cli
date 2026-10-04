# Contributing

## Getting set up

```sh
git clone <this repo> dokuha
cd dokuha
npm install
npm test
```

`npm test` is offline and should take a couple of seconds. If it is slow or fails
without a network, that is a bug.

## The one rule that matters

**Do not edit anything under `vendor/` to fix a bug in `dokuha`.**

Those are copies of three existing engines, and edits to them are lost the next time
someone refreshes a copy. If a vendored engine needs different behaviour, change the
adapter in `src/download/` that drives it. If a vendored engine has a genuine bug, fix
it upstream and re-copy.

The deliberate deviations from upstream are listed in
[vendor/README.md](vendor/README.md). Keep that list accurate.

## Browserless, always

This tool must never require a browser, Chrome, or Puppeteer. That is a product
decision, not an accident of implementation. Concretely:

- No new dependency on Puppeteer, Playwright, `chrome-remote-interface`, or similar.
- No code path that launches a browser process.
- If a store needs a signed-in session, it is supplied as cookies by the user.

Both of these should return nothing:

```sh
# No browser driver anywhere in the dependency tree.
grep -rniE 'puppeteer|playwright|chrome-remote' package.json

# And nothing requires one at runtime.
grep -rnE "(require\(|from |import\()['\"]?(puppeteer|playwright|chrome-remote)" src/ vendor/
```

A plain `grep -ri puppeteer vendor/ src/` is **not** a valid check here and fails even
on a clean tree: the word appears in prose recording the removal, in `vendor/README.md`
and in the stub comment above `vendor/bookwalker/public-trial.js`. Note the distinction
the second command makes -- it matches an import, not a mention, so it is unaffected
by either. `vendor/README.md` still repeats the plain-grep claim; it is wrong in the
same way, so use the two commands above instead of it.

If you find yourself wanting a browser for something, raise it in an issue rather than
adding one.

## Style

There is no linter, so match the surrounding code:

- 4-space indentation, single quotes, semicolons, `const` by default.
- ESM in `src/` and `tests/`. Relative imports include the file extension.
- Comments explain **why**, not what. Do not restate the code.
- Use plain ASCII hyphens, never em-dashes, in comments and documents. Em-dashes in
  strings are a different matter: a few are deliberate user-facing punctuation or
  wire-format characters, so check what a string is before you "normalise" it.
- Every exported function gets a JSDoc block describing its contract.

Comments in this codebase tend to record the reason a thing is the way it is,
usually because the obvious alternative was tried and did not work. If you remove
one, make sure you are not deleting hard-won knowledge.

## Tests

Add a test for anything that could silently regress. Two rules:

1. **Default tests must be hermetic.** No network, no bridge, no real credentials.
   If a test needs a live store, put it in `tests/test_network.mjs`, which is skipped
   unless `DOKUHA_TEST_NETWORK=1` is set.
2. **Never write to a real session or output directory.** Use
   `fs.mkdtempSync(path.join(os.tmpdir(), 'dokuha-'))` and clean it up, and pass
   `bwNoState: true` in any test context.

The most valuable tests here are the ones that encode a bug that actually happened: a
doubled prefix that 404'd a route, a page sort that put page 10 before page 2, a
config default that a second parse mutated. Prefer that kind over tests that restate
an implementation.

## Commits

Sentence case, imperative, no trailing period. Two prefixes are used:

- `docs: ...` for documentation only
- `vX.Y.Z: ...` for a release

Large commits get a prose body explaining what changed and why, then bullets, and
finish with the test count.

## Releasing

Not yet wired up. Until it is, a release is: bump `version` in `package.json`, add a
CHANGELOG entry, tag, and push.
