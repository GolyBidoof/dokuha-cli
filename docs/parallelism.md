# Parallelism, round trips, and what to change next

This is the working note behind the Kindle and k-manga concurrency changes, and the
place the measurements live so the next person does not have to re-derive them.

Two things in this repository have been optimised before by measurement rather than
by intuition (`AUDIT.md` §7), and both times the intuition was wrong: CMOA's cost
turned out to be its render rather than its network, and ebookjapan's turned out to
be the descramble rather than the download. The same was true here. Kindle's walk
was pure latency and divides by the prefetch depth; k-manga's was **not** an
in-flight limit and does not divide by the pipeline depth at all — it divides by the
number of *connections*, which is why the old "four sockets are only 1.4×" note in
the README was wrong for the regime that matters.

Everything below was measured against the live stores with the probes in
`scripts/probes/`, on the two volumes the audit used throughout
(a two-volume work, volumes 1 and 2).

## Method, and why the first k-manga numbers were thrown away

k-manga's throughput varies by more than 5× over tens of minutes. The first socket
comparison ran the arms one after another and produced a perfectly clean line:

| sockets (sequential arms) | 1 | 2 | 3 | 4 |
|---|---|---|---|---|
| ms per page | 1378 | 1123 | 599 | 208 |

That is not a measurement of sockets; it is a measurement of the store warming up.
The arms were re-run **interleaved** (1, 2, 4, 1, 2, 4, 1, 2, 4) so that drift hits
every arm equally, which is the same discipline `AUDIT.md` §3a used for k-manga's
original numbers. Only interleaved figures are quoted below. If a future change is
justified by a k-manga number, it should be justified by an interleaved one.

The probes are re-runnable and read-only (they walk and count; they do not write
pages):

```sh
node scripts/probes/probe-kindle.mjs B0SAMPLE02 --depth 8        # one walk, per window
node scripts/probes/probe-kindle-batch.mjs B0SAMPLE02            # the render page ceiling
node scripts/probes/probe-kmanga.mjs --sockets 4 --depth 16 --pages 16
```

## Kindle: the walk was the whole cost, and it is latency

`walkKindleWindows` is a cursor over the render service, one request per window of
views. `AUDIT.md` §7.11 pipelined it to a depth of three and cut the walk from 35.6 s
to 15.1 s over two volumes. The depth was never measured beyond three, so it was
swept. One 220-page volume is nineteen windows:

| prefetch depth | 3 | 6 | 8 | 9 | 12 |
|---|---|---|---|---|---|
| walk | 7.42 s | 4.08 s | 4.06 s | 3.61 s | 3.33 s |
| speculative windows left in flight at the end | 2 | 5 | 7 | 8 | 11 |

The walk divides by the depth almost exactly — each window is one ~900 ms round trip
and the only cost of a wrong prediction is a request, never a page — with a knee at
eight. Past eight the remaining gain is under 20 % while one more speculative request
is abandoned per step, so **`KINDLE_PREFETCH_DEPTH` is now 8**.

### The shrink ladder was a third of the small walk

The render service refuses a `numPage` above a book-specific ceiling and answers
`HTTP 400 {"message":"Unexpected number of pages"}`. The ceiling is exactly **6** for
this title (probed: 2, 4, 6 succeed; 7, 8, 10, 12, 16, 24, 32, 48 all 400, and the
rejection arrives in ~440 ms while a success takes ~600–1000 ms). The walk discovers
it by halving from 24, which costs two refused round trips before the first real page
is asked for:

| depth 8, first volume | auto | batch known to be 6 |
|---|---|---|
| walk | 4.06 s | **2.99 s** |

That is 1.07 s — 26 % of the walk — spent discovering a number that does not change
within a run. The ceiling is a property of the content, so it is now remembered on
the shared run context (`ctx.kindleBatch`) and every later volume starts where the
first one settled. A stale guess stays safe in both directions: too large is refused
and halved as before, too small returns fewer views and the walk simply takes more
windows. Neither can lose a page.

`bundleImages` was tested as an alternative and changes nothing: the tar is
byte-for-byte the same size with `bundleImages=true`, so the render service never
inlines the page images and the per-page CDN fetches cannot be folded into the walk.

### End to end, the bottleneck moved off the walk

Through the shipped CLI (`scripts/bench-phases.mjs kindle`), one 244-page volume:

| | wall | handshake (walk) | fetch | rebuild | write |
|---|---|---|---|---|---|
| 244 pages | **13.83 s** | 4.11 s | 62.75 s (aggregate, 12 workers) | 0.53 s | 0.51 s |

The walk is now 30 % of the run and the CDN is the rest, which is the intended
outcome and also the next question: is `--kdl-concurrency` (default 12, max 32) still
right? Measured through `bin/dokuha.mjs` on the 220-page free volume, one run each,
because `scripts/bench-phases.mjs` cannot pass a valued flag (see below):

| `--kdl-concurrency` | wall | handshake | fetch (aggregate) |
|---|---|---|---|
| 12 | 13.64 s | 4.35 s | 65.07 s |
| 32 | 15.49 s | 4.99 s | 60.82 s |

More requests in flight bought nothing — the aggregate fetch time fell while the wall
time did not, which is what a store already serving as fast as it will looks like —
so the default stands. Two runs is not a sweep, and the 0.6 s handshake difference
between them is large enough that the wall figures should not be read as a 13 %
regression either; the honest reading is "no gain to be had here".

Before this change the same volume's walk alone was 19.3 s in a two-volume run, so the
page fetch could not have been the binding constraint.

Note `scripts/bench-phases.mjs` **cannot pass a flag that takes a value**: it splits
`argv` into `--flags` and non-`--` words and drops the value
(`scripts/bench-phases.mjs:35`), so `node scripts/bench-phases.mjs kindle
--kdl-concurrency 32` reaches the CLI as a valueless `--kdl-concurrency` and fails
option parsing, reporting it as "no result". Boolean flags like `--no-descramble`
work, which is why it was never noticed.

### Still on the table: the series walk is N round trips for one page of data

An earlier note recorded this optimisation as done, with its own measurement:
"Measured on a 72-volume series: **70 s serial → 3.5 s** at width 24, same
two free volumes found." It is **not wired in**. `resolveKindleSeries` still walks the
reader's linked list hop by hop, and `kindleStoreSeriesList` /
`kindleStoreSeriesUrl` in `kindle-protocol.js` are dead code — nothing in the tree
calls them (`grep -rn kindleStoreSeriesList src` → the definition only). The wiring was
never landed, so the documented 20x is not what the shipped code does today. The note
that claimed otherwise has been removed rather than left to mislead, and the helper
below is what the missing wiring needs.

The helper does work:

```
GET https://www.amazon.co.jp/dp/B0SAMPLE03   1.30 s   8 volume ASINs in data-offer-asins
```

`resolveKindleSeries` instead walks the reader's own "read next" call once per volume,
about a second each, which is why the README says a long series "costs about a second
per volume to scan". The store page would make that **one request for the whole
series**, and it also reaches volumes *before* the pasted one, which the forward-only
walk cannot. It is not a drop-in replacement: `data-offer-asins` did not include the
Kindle-Unlimited-only volume 1 of this series, and it carries no `bookAccessMethod`,
so per-volume classification would still need one reader-page call each — but those
calls are independent and could run concurrently, where the linked walk cannot.
Worth doing when series scanning matters more than download time; it was not done
here because the audit's numbers are per-volume downloads, where it changes nothing.

## k-manga: the store paces connections, not requests

### The index fetch is a third of the handshake and buys nothing here

`fetchKmangaIndex` is a JSONP round trip against the ticket. It measured **1027–1235 ms
per volume** on a title whose index returned **0 chapters**, and its only product is
the `chapters` array in the volume marker — the page list and the decrypt key both
come from the socket's header reply. It now starts immediately after the launcher and
is awaited only when the marker is written, so it overlaps the socket handshake and
the whole download behind it. It was deliberately removed from the `handshake` phase
figure: that number exists to say how long a volume waits before its first page, and
a request running underneath it is no longer part of that wait.

### Four sockets instead of one, interleaved

Sixteen pages per arm, depth 16, three rotations:

| sockets | ms per page (each run) | median | spread |
|---|---|---|---|
| 1 | 317, 468, 1680 | 468 | 5.3× |
| 2 | 697, 369, 262 | 369 | 2.7× |
| 4 | 191, 246, 192 | **192** | **1.3×** |

The median is **2.4× better**, and the more valuable half is the spread: this store's
instability, not its best case, is what makes a run take three minutes instead of one.
The old README line — "four sockets on the same ticket was measured as well and is
only ~1.4× faster, so one socket is used" — was measured when the single socket was
not being throttled, which is precisely the regime where extra sockets cannot help
and therefore the wrong regime to generalise from. `--km-concurrency` is a
*per-socket* budget now and a long volume opens up to four sockets; a short one still
opens one, because the handshake is not worth multiplying.

Splitting the depth budget across the pool was tried and rejected — the store paces
the connection, so depth must stay on each socket:

| sockets × depth | per-socket requests | ms per page (median) |
|---|---|---|
| 1 × 16 | 16 | 758 |
| 4 × 4 | 4 | 396 |
| 4 × 8 | 8 | 331 |
| 4 × 16 | 16 | **204** |

### A retry could never have worked

Writing the pool test exposed a bug that predates it. `readManifest` consumed the
socket's bare greeting *and* sent the header request, and the retry path skipped the
whole function when it already had a manifest. The greeting belongs to the
**connection**, not to the ticket, so a reconnected socket left its greeting in the
queue; the next `next()` handed it to `drainPages`, which found no `scenes` and threw
`k-manga answered scene undefined while N other page(s) were outstanding`. Every
reconnect therefore failed. The README and CHANGELOG both claim k-manga "reconnects
and resumes from the pages already on disk" — it did not. Greeting and header request
are now separate (`greetSocket`), the greeting is read on every connection, and the
header reply is still reused because the key really is per ticket.
`tests/test_kmanga_pool.mjs` covers the dead-socket retry with fake sockets.

Two smaller things fell out of the same test:

- The shards settle with `Promise.allSettled`. Under `Promise.all`, a socket that
  died abandoned the other shards' promises, which kept draining into a closed socket
  and rejected with nobody watching — an unhandled rejection that can take the
  process down.
- A retry budget that expires before the manifest is read left `total` at zero and
  reported `every one of the 0 pages failed to download`, hiding the only line that
  said what went wrong. The handshake failure is now named.

## Architecture: the phases are serial, and the bridge is the reason to change that

The download path is now much better parallelised than the path after it. `runTask`
does, in order, and inside one lane slot:

```
download every page  →  upload every page to the bridge  →  poll OCR  →  finalize (which may upload the whole volume again, to MEGA)
```

That is a problem for three separate reasons, and the bridge already supports the
fixes.

> **Status: 1, 2 and 3 are implemented.** §4 and §5 are still proposals. What was
> built, and where it differs from the sketch below:
>
> - The stages have separate worker pools (`--bridge-parallel`, default
>   `--parallel`) and a queue bounded at `2 x --parallel`. `--json` gained
>   `mokuro.queuePeak`.
> - Folder ingest is additionally gated on the bridge being **loopback**: the route
>   takes a *server-side* path, so a bridge on another host cannot read it, and the
>   ingest-root check alone would not catch that.
> - The client also falls back on a **5xx** from `/session/resume`, not just 403/404.
>   That is not defensive padding: mokuro-bridge 0.6.0 answers 500 on every folder
>   because `api.py` calls `_safe_component` without importing it, and its own
>   exception handler then crashes with `deque.pop() takes no arguments` and hides
>   the real error. Both are fixed in the bridge, but a bridge bug must not cost a
>   volume.
> - `finalize` is called immediately after the last page rather than after the OCR
>   poll finishes, which also makes the bridge stop waiting on its 8-page/1.5 s
>   batch window.
> - Live verification of §2 and §3 against the real bridge is **done**, after a
>   bridge restart to pick up the two fixes. One real 202-page volume, local
>   destination: `ingest: "folder"`, `pagesIngested: 202`, `pagesUploaded: 0`,
>   `ocrDone: 202`, `pagesFailed: 0`, wall **130.4 s**, output a 44 MB `.cbz`,
>   463 KB `.mokuro`, 139 KB `.webp`. The stream reported OCR marching
>   32 → 64 → … → 192 → 202, which is the `wait_ocr` cadence the old client was
>   polling for. §1 is covered offline by `tests/test_pipeline.mjs`.
>
>   The honest size of the §2 win: **two requests instead of 202**, and 202 files
>   the client no longer reads into memory and posts. It is not a wall-time win —
>   OCR is ~128 s of those 130 s, and the per-page path already ran at ~178 pages/s
>   once the 60 ms start-rate floor was removed, so the upload it replaces was
>   about a second.

### 1. The OCR/finalize tail holds a download lane

`laneWorker` awaits `runTask` before taking the next volume, and `runTask` includes
`pushToBridge`. With the default `--parallel` (cores / 4, so three here), a volume
waiting on OCR — or uploading a `.mokuro` to MEGA, which can take minutes — occupies a
lane while the network is idle. The download stage and the bridge stage want
independent concurrency and a queue between them. This is the single biggest
structural change available and it needs no bridge change at all.

### 2. One HTTP request per page, when one request per volume would do

`pushToBridge` POSTs each page separately (`src/bridge.js:131`), 464 requests for the
audit's two volumes. The bridge has **no batch or multi-file push endpoint**
(`mokuro-bridge/mokuro_bridge/api.py:1395` takes exactly one `UploadFile`). It does
have `POST /session/resume` with a `source_dir` form field
(`mokuro-bridge/mokuro_bridge/api.py:1090`, `:1273`), which syncs a whole local folder
into the session, skips files whose sha256 already matches (`:1187`), and queues only
pages with no valid OCR cache (`:1242`). dokuha already has the pages as local files
in exactly that folder layout, and the folder-ingest path is already used elsewhere
in the bridge's own clients (`mokuro_bridge/ocr_folder.py:206`).

So for a local bridge with the library on the same machine this is
**1 request per volume instead of one per page, with no page bytes over HTTP at all**.
Two caveats: `source_dir` is restricted to home and the temp roots
(`config.py:217`, `api.py:450` → 403 otherwise), so an external-volume library must
fall back to the per-page path; and the call has to be `/session/resume`, not
`/session/start`, because only the former reads a directory.

### 3. The client polls for a completion the bridge already streams

`waitForOcr` polls `GET /session/{id}/status` every 1 s, backing off to 4 s
(`src/bridge.js:47`). The bridge's `POST /session/{id}/finalize` already waits for OCR
internally and is the **only streaming route in the API**: it emits a fresh `wait_ocr`
frame at least every 0.75 s (`mokuro-bridge/mokuro_bridge/api.py:1878`) before
`assemble`/`pack`/`upload`/`done`. The client could push, call finalize once, and read
progress off that stream — deleting a state machine, the poll interval, and up to 4 s
of dead time at the end of every volume's OCR. The one ordering constraint is real:
finalize sets `finalizing` and `/page` then answers 400 (`api.py:1833`), so all pages
must be in before it is called.

Note also that the poll is not just latency. The bridge batches OCR across sessions
and flushes on `len(queue) >= 8` or after 1.5 s of quiet
(`mokuro-bridge/mokuro_bridge/ocr.py:714`, `:1126`); a new page restarts the 1.5 s
timer, so a trickle arriving faster than 1.5 s/page defers the flush until eight
accumulate. Pushing *slower* than that makes the bridge do more, smaller model calls.

### 4. Bridge ports: a pool of processes, not a pool of sockets

The client discovers one bridge and `DEFAULT_CANDIDATES` stops at the first healthy
one (`vendor/ebookjapan/bridge.mjs:52`). Several ports look like free parallelism, and
they are not:

- Each bridge process has **exactly one OCR worker thread** and a per-process queue;
  there is no flag for more (`mokuro-bridge/mokuro_bridge/ocr.py:1209`).
- Two instances would need **separate `WORK_DIR` and `OUTPUT_DIR`**. The session JSON
  is rewritten whole with no cross-process lock (`sessions.py:96`), so sharing a work
  dir loses `pages_received`/`pages_ocr_done` on a last-writer-wins race, and two
  model copies would compete for the same MPS device.
- The `fetchProxyPorts` that fill 62643–62690 are a browser fetch accelerator and
  never serve sessions or OCR (`fetchproxy.py:225`), so a second instance on an
  adjacent port collides with them.
- On one MPS device, a second worker does not add throughput; it adds a second copy
  of a model that is already the bottleneck. The bridge's own fork exposes a
  4-process pipeline that it never drives (`mokuro_generator.py:268` is bypassed), so
  the real headroom is inside one process.

The useful direction is the opposite one: **many sessions feeding one bridge**, which
it is explicitly built for (`_take_fair_items` round-robins pages from several
sessions into one model call, `ocr.py:595`). That means the two-stage pipeline above,
not a port pool. Ports become worth pooling only if the bridge is ever given a
per-instance GPU or more than one OCR worker.

### 5. Keep the OCR cache if you re-run to more than one destination

`delete_after_upload` defaults to true for remote destinations and the client sets it
that way (`src/bridge.js:83`), and cleanup deletes the volume *and* the whole
`_ocr/<volume>` cache (`ocr.py:1262`). So after a successful MEGA upload there is
nothing left to hit: re-running the same volume to Drive re-OCRs all of it. The cache
is keyed by (volume directory, page filename) and validated against the image's
sha256 (`ocr.py:299`), so it is small, correct, and worth a `--keep-ocr-cache` flag.

## Summary of what changed

| change | file | measured effect |
|---|---|---|
| Kindle prefetch depth 3 → 8 | `src/download/kindle.js` | 7.42 s → 4.06 s per 220-page walk |
| Kindle render ceiling remembered across volumes | `src/download/kindle.js`, `src/run.js` | −1.07 s per volume after the first |
| k-manga index fetch overlapped with the socket handshake | `src/download/kmanga.js` | −1.0 s of critical path per volume |
| k-manga viewer-socket pool (up to 4) | `src/download/kmanga.js` | 2.4× median, 5.3× → 1.3× spread |
| k-manga greeting read on every connection | `src/download/kmanga.js` | retries can succeed at all |
| k-manga shards settle together | `src/download/kmanga.js` | no unhandled rejection on a dead socket |
| k-manga handshake failures named | `src/download/kmanga.js` | "0 pages" → the real cause |
| Download and bridge stages split into separate pools | `src/run.js` | a volume no longer holds a download lane through OCR and upload |
| OCR/upload progress read from the finalize stream | `src/bridge.js` | one request instead of a `/status` poll per 1–4 s |
| Folder ingest via `POST /session/resume` | `src/bridge.js`, `vendor/ebookjapan/bridge.mjs` | 2 requests per volume instead of 202, live on a real 202-page volume |
| `session/resume` 500 on every folder | `mokuro-bridge/mokuro_bridge/api.py` | missing `_safe_component` import; `deque.pop(index)` in four cleanup sites |

Two tests were added or extended: `tests/test_kmanga_pool.mjs` (fake sockets, covering
the sharding, the per-socket header reply, the dead-socket retry, and that a short
volume opens one socket), the batch-memory checks in
`tests/test_kindle_adapter.mjs`, `tests/test_pipeline.mjs` (the two-stage scheduler,
driven through the real `run()` with a fake store and bridge), and the
folder-ingest plus NDJSON-stream checks in `tests/test_bridge.mjs`.

## Two levers that were tested and are not there

Both of these look obviously worth trying, and both were measured before anyone
wrote code. Recorded so they are not re-litigated. Every arm below is one volume,
one process unless stated, `--force`, no OCR.

### Kindle's page-fetch concurrency is already at its ceiling

| `--kdl-concurrency` | page stage (warm rep) | fetch aggregate |
|---|---|---|
| 3 | 25.47 s | 50 s |
| 12 | **7.57 s** | 50 s |
| 24 | 7.28 s | 57 s |

12 and 24 are the same run twice over, and the fetch aggregate is flat, so the
shipped default of 12 is already at the plateau. An earlier sweep arm at
`--kdl-concurrency 3` read 47.97 s and its repeat read 25.47 s — the arms are
rotated precisely because a single pass at low concurrency measures the CDN
warming up, not the concurrency.

The plateau is not free of detail, though: the fetch *aggregate* falls as
concurrency rises (84 s → 63 s → 50 s for the same 220 pages), so per-request
latency drops from ~382 ms to ~227 ms. The CDN rewards being asked harder; it just
stops rewarding after about twelve.

### k-manga does not want more sockets

Each k-manga socket reads one frame at a time (`await socket.next()`), so sockets
are the only parallelism lever and `KM_MAX_SOCKETS = 4` looks like a cap worth
raising. It is not. Interleaved, three pairs, 24 pages each, depth 16:

| pair | 4 sockets | 8 sockets |
|---|---|---|
| 1 | 9.56 s | 15.62 s |
| 2 | 4.52 s | 4.42 s |
| 3 | 10.90 s | 10.01 s |
| median | 9.56 s | 10.01 s |

One pair each way and one tie. The same arm ranges from 4.52 s to 15.62 s within
minutes, so the store's own variance (3.5x) swamps any socket effect. The four-socket
cap costs nothing.

### Kindle's per-process ceiling is partly ours — unproven

The same three arrangements, measuring the same per-volume work:

| arrangement | per-volume | aggregate |
|---|---|---|
| 1 process, 1 volume (solo) | 15.8 MiB/s | 15.8 MiB/s |
| 1 process, 2 volumes | 7.9 MiB/s each | 15.7 MiB/s |
| **2 processes, 1 volume each** | **11.4 MiB/s each** | **~20 MiB/s** |

One process appears to cap near 16 MiB/s however the fetches are distributed between
volumes, and splitting into two processes recovers about a third of the per-volume
loss. That would make a fetch-stage process pool worth roughly +28% on a Kindle
batch — but this is **one run per arm**, and the arm above it shows how badly a
single Kindle measurement can mislead. Repeat it before believing it, let alone
building on it. The mechanism to look for is the event loop or undici's per-process
pool, not the CDN, because the CDN was still responding faster under more load.

## Open questions

- **The socket budget is per volume, and nothing measures the product.** A 236-page
  volume opens four sockets, and the default `--parallel` runs about three volumes at
  once, so a series run can hold twelve sockets and 192 outstanding page requests.
  Every measurement above was taken with one volume. The right shape is probably a
  run-wide socket budget, the way `allocateCpu` gives the re-encoding stores a share
  of the machine, but that needs the same interleaved treatment.
- **`--km-concurrency` was optimised on a single socket.** The 16-that-beats-24 sweep
  predates the pool, and the throttle that sets the per-socket optimum may not be the
  same one now that four connections share the budget. Re-sweeping 8/16/24 per socket
  with the pool is cheap and worth doing.
- **The `--parallel` default (cores / 4) still has no measurement behind the number
  three**, only the two ends (`AUDIT.md` §3d, §7.12). The pipeline split changed what
  the number means — it is now the *download* width, with `--bridge-parallel`
  separately controlling how many volumes sit in OCR and upload — so the sweep should
  be redone as two numbers rather than one. Nothing here has measured a download width
  above three with a real bridge attached.
- **Kindle's page-fetch concurrency was tried and is not a lever** — 32 did not beat
  12 in a single paired run, and the default stands. See the end-to-end table above.
  The CDN is the remaining wall time, and it is not obviously ours to raise.

