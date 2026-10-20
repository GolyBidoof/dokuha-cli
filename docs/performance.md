# Performance

This page records what has been measured, how it was measured, and what the numbers do and do not mean. Every figure is a snapshot from a specific machine and date, not a promise about your run. Stores throttle, CDNs drift and a laptop on battery is not the benchmarks below.

The reproducible tools live in the repository: `npm run bench:phases`, `tools/bench-phases.mjs` and the read-only probes in `tools/probes/`. Raw runs are written under `bench/`, which is gitignored.

## The phase model

Every `--json` result carries a `phases` object, in milliseconds:

```json
{ "handshake": 2220, "prework": 894, "fetch": 20820, "rebuild": 521750, "write": 307160 }
```

| Phase | What it covers |
|---|---|
| `handshake` | opening the session: licence, login, token or ticket |
| `prework` | getting ready to fetch: manifest, page list, render-window walk, loading the descrambler's WebAssembly, building the shuffle table |
| `fetch` | page bytes from the store's CDN |
| `rebuild` | CPU work that turns those bytes into a page: descrambling, seam-carving, JPEG encoding |
| `write` | writing a page to disk |

`phases` describes the store download only. Bridge time is excluded on purpose, so the same key means the same thing on a plain run and a `--mokuro` run.

Two rules matter when reading these numbers.

**A concurrent phase is an aggregate, not wall time.** `fetch`, `rebuild` and `write` are summed across page workers, so `rebuild: 521750` on a 244-page volume means 522 page-seconds of rebuilding across all workers, not 522 seconds elapsed. `seconds` is the wall time of the whole task. `handshake` and `prework` are serial, so those two are wall time.

**An aggregate is a pressure gauge, not a price list.** The same ebookjapan volume, measured twice on the same machine:

| Setup | Wall | `rebuild` | `write` |
|---|---|---|---|
| 32 page workers at once | 28.5 s | 531 s | 293 s |
| The same, rebuilds capped at 14 | 37.0 s | 104 s | 0.2 s |

The capped run is 30 percent slower while reporting five times less rebuilding and a thousand times less writing. Those seconds really were spent inside the step, but on an oversubscribed machine a step mostly measures the queue it stood in. That experiment is also why `sharp` work for ebookjapan and k-manga is not capped: libvips already threads internally, and an outer queue added latency. Only CMOA's render pool and BookWalker's seam-carving pool take a share of the CPU budget described in [architecture.md](architecture.md#the-cpu-budget).

## Which store can measure which

A blank phase means the adapter has no seam there, not that the phase was free.

| Store | handshake | prework | fetch | rebuild | write |
|---|---|---|---|---|---|
| CMOA | yes | n/a | yes | n/a | marker only |
| ebookjapan | yes | yes | yes | yes | yes |
| BookWalker | yes | yes | n/a | yes | n/a |
| Kindle | yes | yes | yes | yes | yes |
| k-manga | yes | yes | n/a | yes | yes |
| DMMブックス | yes | yes | yes | yes | yes |

`prework` is deliberately separate from `handshake`: it used to be folded in, which made Kindle's render-window walk look like a slow login. Which store exposes which seam follows from who owns the page loop. ebookjapan, DMMブックス and Kindle run their own page loops and time each step where it happens. k-manga hands pages to a callback, so the socket read itself is not visible. CMOA and BookWalker delegate the whole loop to a vendored engine, so the adapter only sees the hooks the engine exposes. CMOA's `prework` is blank because its `openVolume` does the session and the page list in one call, and a guess would be worse than a blank.

## Five measured stores, by phase

Two free volumes of the same title from each store, one process per store, measured 2026-10-01 with no OCR. 2,307 pages and 1,605 MiB. DMMブックス is not in this table: the measurements predate the sixth store, and no DMM phase breakdown has been taken yet.

| Store | Pages | MiB | Wall | handshake | prework | page stage |
|---|---|---|---|---|---|---|
| CMOA | 464 | 269.6 | 9.16 s | 2.64 s | n/a | 6.53 s |
| ebookjapan | 464 | 392.8 | 35.23 s | 7.39 s | 1.01 s | 26.83 s |
| BookWalker | 464 | 282.2 | 16.38 s | 5.16 s | 1.38 s | 9.84 s |
| Kindle | 464 | 242.9 | 42.76 s | 2.42 s | 9.44 s | 30.91 s |
| k-manga | 451 | 417.6 | 178.68 s | 6.62 s | 2.13 s | 169.93 s |

At the work level, the page stage divides like this across concurrent workers:

| Store | `fetch` share | `rebuild` share | `write` share |
|---|---|---|---|
| CMOA | 57 to 59 percent | 23 to 26 percent | 17 to 18 percent |
| ebookjapan | 14 to 16 percent | 51 to 54 percent | 32 to 33 percent |
| BookWalker | 35 to 51 percent | 49 to 65 percent | under 1 percent |
| Kindle | 98 to 99 percent | about 1 percent | about 1 percent |
| k-manga | 93 to 95 percent | 5 to 7 percent | under 1 percent |

What the tables say:

- **ebookjapan is the descrambling store.** Rebuild and write are most of its work and fetch is a sixth of it, yet its wall time is still one of the lowest because it runs many page workers at once.
- **Kindle arrives assembled.** It is almost pure fetch; there is nothing to rebuild. Its `prework` is the render-window walk, which is why it is the largest `prework` of the five measured stores.
- **BookWalker is fetch and rebuild in equal measure**, with no measurable write because the vendored engine writes the pages itself.
- **k-manga is the CDN.** Its page stage is 95 percent of the run, and the store's own throttling is the reason, not the client.
- **CMOA has the flattest profile**, roughly 57/26/18, and no `prework` seam to show.

k-manga's row should be read as an upper bound. The same volumes measured 45.6 s and 46.4 s on 2026-09-30, then 75.4 s and 104.8 s, then 86.6 s and 92.1 s here, as the store was asked for the same pages again. Treat k-manga wall times as noisy and re-measure in isolation before comparing them.

## Serial versus parallel downloads

Whole free series, each store handed its series entry point so the tool discovered the volumes itself. Two arms per store: `--parallel 1` and the default unlimited. Measured 2026-10-13 on an Apple M4 Pro (14 cores, 24 GB), Node 26, dokuha 0.1.0, one store at a time, no OCR; DMMブックス is not in this table for the same reason.

| Store | Volumes | Pages | Size | Serial | Parallel |
|---|---|---|---|---|---|
| CMOA | 3 | 600 | 184.3 MB | 110.5 s | 17.0 s |
| BookWalker | 3 | 600 | 159.8 MB | 19.7 s | 5.2 s |
| ebookjapan | 3 | 600 | 208.2 MB | 41.5 s | 18.4 s |
| Kindle | 3 | 603 | 136.6 MB | 224.2 s | 220.9 s |
| k-manga | 2 | 376 | 153.0 MB | 31.2 s | 25.7 s |

The CMOA pair overstates the flag badly: the first arm of the day was about ten times slower than every later CMOA arm, and with the arms repeated in both orders its medians were 9.9 s serial against 9.1 s parallel. The honest summary is that parallelism helps where the machine or the connection is the limit, and that the size of the win moves with the store.

ebookjapan is the clearest real win in both orders (18.4 s and 32.4 s parallel against 41.5 s and 49.4 s serial). k-manga likewise (25.7 s and 15.6 s against 31.2 s and 32.3 s), though its per-volume times are noisy in every arm. BookWalker points the same way on a smaller scale. Kindle was flat, and the reason was structural rather than a bug: at the time its series discovery walked forward one reader request per volume, so the discovery cost dominated both arms. Discovery has since become one store request with the per-volume access checks run concurrently, and these measurements stand as what was true that day.

Every page in that benchmark was 760 x 1200 except three Kindle cover pages at 880 x 1200. Bytes per page still differ by store, from about 227 KB on Kindle to about 407 KB on k-manga at the same pixel count, because each store encodes differently.

## Concurrency findings

**Kindle prefetch depth is 8.** One 220-page volume is nineteen render windows, one request each. Sweeping the prefetch depth:

| Depth | 3 | 6 | 8 | 9 | 12 |
|---|---|---|---|---|---|
| Walk | 7.42 s | 4.08 s | 4.06 s | 3.61 s | 3.33 s |

Past eight the remaining gain is under 20 percent while one extra speculative request is abandoned per step, so 8 is the default.

**Kindle remembers the render-window ceiling.** The render service refuses a page count above a book-specific limit, and the walk used to discover that limit by halving on every volume. On the measured title the ceiling was 6, and remembering it after the first volume saved about 1.07 s, 26 percent of that volume's walk.

**Kindle's page concurrency is at its plateau.** `--kdl-concurrency 32` did not beat the default 12 in a paired run (15.49 s against 13.64 s), so the default stands. Two runs are not a sweep; the honest reading is that more requests in flight bought nothing.

**k-manga needs sockets, not requests on one socket.** Interleaved measurements, because sequential arms only measure the store warming up:

| Sockets | Median ms per page | Spread |
|---|---|---|
| 1 | 468 | 5.3x |
| 2 | 369 | 2.7x |
| 4 | 192 | 1.3x |

Four sockets improve the median 2.4x and, more valuably, tighten the spread. The depth budget stays on each socket: 4 sockets x 16 requests measured 204 ms per page against 396 ms for 4 x 4. Eight sockets did not beat four (medians 10.01 s against 9.56 s over three interleaved pairs), so four stays the cap.

**k-manga overlaps its chapter index with the socket handshake.** The index request measured 1027 to 1235 ms per volume and its result is only needed for the volume marker, so it runs underneath the handshake instead of in front of it.

**DMMブックス starts at 16 page fetches in flight.** `--dmm-concurrency` defaults to 16 and caps at 32. Every page is a request against a short-lived signed CDN URL and the store answers bursts with 429s, so 16 is the working default rather than the ceiling; lower it if a run starts collecting 429s.

## HTTP/2 page transport

Node's global `fetch` is HTTP/1.1 only, while the DMM CDNs serve HTTP/2. `src/download/h2-fetch.js` multiplexes DMM page and manifest requests over one HTTP/2 session per CDN origin, falls back to the global `fetch` when an origin negotiates HTTP/1.1 or an h2 request fails, and keeps `Accept-Encoding: identity` because it does not decompress. The gain is latency, not bandwidth: on a link with about 300 ms round-trip time, eight concurrent HTTP/1.1 page requests reached about 68% of a 10.6 MB/s link and HTTP/2 reached about 99%, taking a 232-page volume from about 27.5 s to about 19 s. Below about 100 ms RTT the difference disappears, so this is a high-latency win rather than a general speedup.

## The optional bridge hand-off

Handing a volume to mokuro-bridge is not a performance feature for OCR time: OCR dominates, and the client cannot shorten it. What the hand-off costs is measured in requests and in dead time.

- **One request per volume instead of one per page.** For a local bridge whose ingest roots cover the library, the CLI sends `POST /session/resume` with the folder path and the bridge copies and hashes the pages itself. The first live measurement on a 202-page volume took two requests for the whole volume. The wall time was 130.4 s, of which OCR was about 128 s; the upload the folder path replaces was about a second, so the win is 200 HTTP requests and 202 files the client no longer reads and posts, not wall time.
- **Progress comes off the finalize stream.** `POST /session/{id}/finalize` is a streaming NDJSON response that reports `wait_ocr` frames at least every 0.75 s and `upload_progress` frames per file, so the client no longer polls `GET /session/{id}/status` alongside it.
- **The bridge's OCR batch is not the client's page concurrency.** A 104-sample capture during a real five-volume run saw the bridge's `processing_depth` at 32 in 97 of 102 valid samples, and all 44 multi-session samples were 32 pages; the only smaller batch was the 9-page drain tail. The number 8 that appears in `/health` is `ocr_chunk_size`, the queue depth that wakes the OCR worker, not the batch it takes. That batching belongs to mokuro-bridge; this CLI only waits and streams.

## Reproducing

```sh
npm run bench:phases                     # one free volume per store, with the phase breakdown
node tools/bench-phases.mjs cmoa ebookjapan  # a subset
node tools/bench-phases.mjs --no-descramble  # keep the scrambled bytes, to price the rebuild

node tools/probes/probe-kindle.mjs B0SAMPLE02 --depth 8
node tools/probes/probe-kindle-batch.mjs B0SAMPLE02
node tools/probes/probe-kmanga.mjs --sockets 4 --depth 16 --pages 16
```

The probes are read-only: they walk listings and count, and write no pages. Kindle needs a session, so `bench:phases` skips it with a message when none is configured. [tools/probes/README.md](../tools/probes/README.md) documents each probe and the interleaving discipline the k-manga numbers depend on.

## Caveats

- **These are snapshots.** Store latency moves by multiples between arms on the same day, as the k-manga rows show. Any future claim should say when it was measured.
- **Interleave arms when comparing sockets or concurrency.** A sequential sweep mostly measures the store warming up.
- **The default `--parallel` is unlimited and has no finite-width sweep behind it with a real bridge attached.** The two-stage split changed what the number means: it now caps the download stage only, while `--bridge-parallel` caps OCR and upload.
- **The socket budget is per volume.** A mixed run can hold many sockets at once; a run-wide socket budget has been discussed but not measured.
