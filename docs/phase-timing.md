# Phase timing

Every `--json` result carries a `phases` object:

```json
{ "ok": true, "seconds": 29.65, "phases": { "handshake": 2220, "prework": 894, "fetch": 20820, "rebuild": 521750, "write": 307160 } }
```

Five phase names, in the order they happen. `seconds` is the whole task and is
unrelated to them; `phases` describes only the store download, because that is the
part every store has in common. Bridge time (push, OCR, finalize) is deliberately
excluded — folding it in would make the same key mean something different for a
`--mokuro` run than for a plain one.

## What the numbers are

| phase | what it covers |
|---|---|
| `handshake` | opening the session: licence, login, token, ticket |
| `prework` | getting ready to fetch pages: the manifest, the page list, the render-window walk, loading the descrambler's WASM module, building the per-page shuffle table |
| `fetch` | transferring page bytes from the store's CDN |
| `rebuild` | CPU work that turns the transferred bytes into the page that gets written: descrambling, seam-carving, JPEG re-encoding |
| `write` | writing a page to disk |

`prework` exists because `handshake` used to mean "everything before page work", and
for some stores almost all of that was preparation rather than a round trip. Kindle
was the clearest case: its 16–19 s of `handshake` was nearly all the render-window
walk, with the actual reader session open happening outside the timer entirely. The
two are now measured separately wherever the adapter has a seam.

**A concurrent phase is an aggregate, not wall time.** Each page worker times its
own step and the durations are *summed*, so `rebuild: 521750` on a 244-page volume
means 522 page-seconds of rebuilding across all workers, not 522 seconds elapsed.
`handshake` and `prework` are serial, so for those two the number is wall time, and
`wall - handshake - prework` is the page stage — those three do partition the run.

That is the right unit for comparing stores — "how much rebuilding does this store
need per volume" — but it is the wrong unit for "how long did the rebuild take". To
turn an aggregate into wall time you need the concurrency it ran at, and that is
per store and per phase.

Two consequences worth knowing:

- An aggregate also absorbs contention, and by more than you would guess. The same
  ebookjapan volume, same pages, same machine, measured two ways:

  | | wall | `rebuild` | `write` |
  |---|---|---|---|
  | 32 page workers at once | **28.5 s** | 531 s | 293 s |
  | the same, rebuilds capped at 14 | 37.0 s | 104 s | 0.2 s |

  The capped run is 30 % *slower* while reporting five times less rebuilding and a
  thousand times less writing. Every one of those seconds is real — it is time a
  worker spent inside that step — but a step measured while the machine is
  oversubscribed is mostly measuring the queue it was standing in. Treat a phase as
  a pressure gauge, not a price list, and compare runs taken the same way.
- Aggregates can exceed `seconds` by a wide margin. The 32-worker ebookjapan row
  above totals 824 s of phase time inside a 28 s task.

That second row is also why nothing caps ebookjapan's or k-manga's descrambling.
`src/cpu-budget.js` sizes CMOA's render pool and BookWalker's seam-carving pool,
which are ordinary JavaScript workers; `sharp` is not, because libvips threads
internally and an outer queue measured 30 % slower. Both figures in the table are
three runs each, with spreads under 1.5 s.

## Which store reports which

The phase is blank when the store cannot measure it. Nothing is inferred or
guessed: a blank means "this adapter has no seam there".

| store | handshake | prework | fetch | rebuild | write |
|---|---|---|---|---|---|
| CMOA | yes | — | yes | — | marker only |
| ebookjapan | yes | yes | yes | yes | yes |
| BookWalker | yes | yes | — | yes | — |
| Kindle | yes | yes | yes | yes | yes |
| k-manga | yes | yes | — | yes | yes |

`prework` is measured per store like this:

- **Kindle** — `openKindleVolume` is the handshake and `walkKindleWindows` is
  `prework`; the walk used to be reported as handshake.
- **BookWalker** — `negotiateSession` is the handshake, the
  `configuration_pack.json` fetch (page manifest and body) is `prework`.
- **ebookjapan** — `collectPages` (licence and page list) is the handshake;
  `loadGlue` plus the per-page shuffle table is `prework`. On a cold asset cache that
  module load is a multi-megabyte download, so it is worth seeing.
- **k-manga** — `openKmangaSession` is the handshake. The chapter index is started
  early and overlapped, so it is timed from its start to its own resolution rather
  than wrapped, which would have measured the `await` instead of the request.
- **CMOA** — **blank, and it is not an omission.** `openVolume` in the vendored
  engine does the session *and* the page list in one call, so the two cannot be
  separated from here. Reporting a guess would be worse than reporting nothing.

The pattern is who owns the page loop:

- **ebookjapan and Kindle** do their own page loop, so each step is timed where it
  happens.
- **k-manga** hands pages to a callback, so `rebuild` and `write` are timed there;
  the socket read itself is inside the transport and is not observable.
- **CMOA and BookWalker** delegate the whole loop to a vendored engine, so the
  adapter only sees the seams the engine exposes — CMOA's `volume.fetchPage` and
  BookWalker's `normalizePage`. Everything else about their page stage is
  unattributed rather than rolled into a neighbouring phase.
- **CMOA and BookWalker** also report no `write`: the engine writes the pages.

An earlier draft subtracted the measured parts from the wall time of the engine
call and called the remainder `fetch`. That was removed: the parts are aggregates
and the stage is wall time, so the subtraction mixes units and can go negative. A
blank is more useful than a number that means nothing.

## Reproducing the audit

```sh
npm run bench:phases                     # one free volume per store
npm run bench:phases -- cmoa ebookjapan  # a subset
npm run bench:phases -- --no-descramble  # keep the scrambled mosaic
```

The script runs `bin/dokuha.mjs --json` once per store and prints the table. Kindle
needs a session, so it is skipped with a message if none is configured.

The audit's §3 numbers came from this and from a per-phase harness; where they
disagree it is because the harness separated steps the adapter cannot see — CMOA's
render pool was measured directly at 237 ms/page against 47 ms/page of fetch, and
that split is still not visible in `phases`.

## Forcing the rebuild to zero

`--no-descramble` leaves `rebuild` out entirely for ebookjapan and k-manga. The
difference between the two runs is the cleanest measure of what descrambling costs,
because it needs no assumption about concurrency:

```sh
node bin/dokuha.mjs 'https://ebookjapan.yahoo.co.jp/books/000002/A000000002/' --json --out /tmp/a
node bin/dokuha.mjs 'https://ebookjapan.yahoo.co.jp/books/000002/A000000002/' --json --out /tmp/b --no-descramble
```
