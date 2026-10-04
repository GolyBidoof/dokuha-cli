# Ten volumes, five storefronts, by phase

Two free volumes of the same title from each of the five stores, measured
2026-10-01, no OCR. Reproduce with:

```sh
sh bench/bench5-now.sh          # downloads into bench/now5-<store>
python3 bench/summarize5.py     # prints the tables below
```

`bench/` is gitignored, so the raw `--json` lands in `bench/logs/now5-<store>.json`
and is not committed. Each store runs in its own process, sequentially, with
`--force` so nothing is skipped and `--no-progress` so stderr stays readable.

## Read this before the numbers

`handshake` and `prework` are serial, so they are wall time. `fetch`, `rebuild` and
`write` are **summed across concurrent page workers**: BookWalker's second volume
reports 152 s of fetch and 282 s of rebuild inside a 7.5 s run. They are not a share
of anything and the two levels are not comparable to each other.

So there are two tables:

- **Wall level** — the requested division. `handshake + prework + page stage = wall`
  exactly, where page stage is the remainder.
- **Work level** — how the page stage's work is composed, in worker-seconds, with
  percentages of their own sum. This is where descrambling becomes visible.

See [phase-timing.md](phase-timing.md) for why an aggregate is a pressure gauge
rather than a price list.

## Wall level

| store | vol | pages | MiB | wall | handshake | prework | page stage |
|---|---|---|---|---|---|---|---|
| CMOA | 1 | 244 | 131.9 | 4.61 | 1.32 | — | 3.29 |
| CMOA | 2 | 220 | 137.7 | 4.55 | 1.31 | — | 3.24 |
| ebookjapan | 1 | 244 | 199.7 | 17.61 | 1.59 | 0.06 | 15.96 |
| ebookjapan | 2 | 220 | 193.1 | 17.62 | 5.80 | 0.95 | 10.87 |
| BookWalker | 1 | 220 | 138.9 | 8.83 | 2.58 | 1.21 | 5.04 |
| BookWalker | 2 | 244 | 143.3 | 7.54 | 2.58 | 0.16 | 4.80 |
| Kindle | 1 | 244 | 123.3 | 21.48 | 1.20 | 4.83 | 15.45 |
| Kindle | 2 | 220 | 119.7 | 21.28 | 1.22 | 4.60 | 15.46 |
| k-manga | 1 | 236 | 210.6 | 86.62 | 3.59 | 1.11 | 81.92 |
| k-manga | 2 | 215 | 207.1 | 92.06 | 3.03 | 1.02 | 88.01 |

Per store, both volumes:

| store | pages | MiB | wall | handshake | prework | page stage |
|---|---|---|---|---|---|---|
| CMOA | 464 | 269.6 | 9.16 | 2.64 | — | 6.53 |
| ebookjapan | 464 | 392.8 | 35.23 | 7.39 | 1.01 | 26.83 |
| BookWalker | 464 | 282.2 | 16.38 | 5.16 | 1.38 | 9.84 |
| Kindle | 464 | 242.9 | 42.76 | 2.42 | 9.44 | 30.91 |
| k-manga | 451 | 417.6 | 178.68 | 6.62 | 2.13 | 169.93 |

2307 pages and 1605 MiB in 282.2 s.

`prework` is missing for CMOA on purpose: its vendored `openVolume` opens the
session and reads the page list in one call, so the split is not observable from
this side. A blank is deliberate; a guess would be worse.

## Work level

Worker-seconds, summed across concurrent page workers.

| store | vol | fetch | rebuild | write | fetch % | rebuild % | write % |
|---|---|---|---|---|---|---|---|
| CMOA | 1 | 30.57 | 13.85 | 9.51 | 57 | 26 | 18 |
| CMOA | 2 | 31.97 | 12.60 | 9.23 | 59 | 23 | 17 |
| ebookjapan | 1 | 38.29 | 150.01 | 88.91 | 14 | 54 | 32 |
| ebookjapan | 2 | 36.44 | 116.85 | 75.52 | 16 | 51 | 33 |
| BookWalker | 1 | 274.46 | 258.75 | 0.03 | 51 | 49 | 0 |
| BookWalker | 2 | 152.07 | 281.89 | 0.04 | 35 | 65 | 0 |
| Kindle | 1 | 86.37 | 0.61 | 0.59 | 99 | 1 | 1 |
| Kindle | 2 | 70.96 | 0.57 | 0.59 | 98 | 1 | 1 |
| k-manga | 1 | 161.15 | 11.41 | 0.12 | 93 | 7 | 0 |
| k-manga | 2 | 237.93 | 11.25 | 0.12 | 95 | 5 | 0 |

## What the tables say

- **Kindle's `handshake` was a lie.** It reports 2.42 s of session open across both
  volumes and **9.44 s of `prework`** — the render-window walk. Before `prework`
  existed, all of that was one 10.3 s "handshake" and the session open was not timed
  at all. Kindle's page stage is then 99 % fetch: its pages arrive assembled, so
  there is nothing to rebuild (1.18 s) or re-encode.
- **ebookjapan is the descrambling store.** Rebuild is 51–54 % of its work and write
  another third, against 14–16 % fetch. Its wall time is still the second lowest,
  because it runs the most page workers at once. The 164 s of aggregate write for
  464 pages is not 164 s of disk: it is workers queueing behind a saturated machine,
  which is exactly what the aggregate absorbs. See the two-run comparison in
  [phase-timing.md](phase-timing.md).
- **BookWalker is fetch and rebuild in equal measure** (51/49 and 35/65), with no
  measurable write because the vendored engine writes the pages itself.
- **CMOA is the only store with no `prework` seam**, and the flattest work profile:
  roughly 57/26/18.
- **k-manga is 95 % fetch.** Its page stage is 169.93 s of a 178.68 s run, against
  6.62 s of handshake. Whatever else is true, this store's time is the CDN.

### k-manga's numbers are throttled, not comparable to the others

The same two k-manga volumes measured **45.6 s and 46.4 s** on 2026-09-30
(`bench/logs/all5-kmanga.json`), and **75.4 s and 104.8 s earlier on 2026-10-01
before any of the `prework` work touched `kmanga.js`**. This table was taken after,
at 86.6 s and 92.1 s. The store degrades as the same volumes are re-requested, so
treat the k-manga row as an upper bound from a tired CDN, and re-measure it in
isolation before comparing it to anything.

## Method notes

- **ebookjapan's WASM module is warmed first, deliberately.** The descrambler loads
  it from `~/.bwdd-cli/ebookjapan-assets` on first use; on a cold cache that is a
  multi-megabyte fetch which would land inside the first timed volume as several
  seconds of `prework` attributable to the cache rather than the store. That is why
  ebookjapan's `prework` is 0.06–0.95 s here.
- **One process per store, in sequence**, so the five do not contend with each other
  for the network or the CPU.
- `phases` describes the store download only. Bridge time is excluded by design, and
  these runs used no `--mokuro` at all.
