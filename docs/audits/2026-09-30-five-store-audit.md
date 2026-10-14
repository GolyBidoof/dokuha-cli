# dokuha: five-store audit and benchmark

_Historical snapshot, measured 2026-09-30. This is an archived working audit, not current documentation. Some findings it records have since been fixed; see [../architecture.md](../architecture.md) and [../stores.md](../stores.md) for how the code behaves now. Its measurement tables and the `bench/` evidence they cite are unchanged._

Measured 2026-09-30 on the machine that runs this repo (14 cores, macOS, Node v26.7.0). Target title: **スーパーの裏でヤニ吸うふたり**, the two free volumes of each store, ten volumes in total. No OCR was run; mokuro-bridge was only checked for connectivity.

Raw evidence lives in `bench/`:

| file | what it is |
|---|---|
| `logs/<store>.json` | `--json` summary of one store's two volumes, run alone |
| `logs/mixed.json` | the same ten volumes in one mixed batch |
| `analysis.json` | per-page width, height, bytes and format for all 2 224 pages |
| `perpage.json` | per-page pixel difference against the Kindle copy |
| `hashes.json` | 64-bit difference hash per page |
| `phases.json` | handshake latencies |
| `logs/tty.raw` | a captured progress-display session |

Reproduce with `bash bench/run-stores.sh`, `node bench/analyze.mjs`, `node bench/allpages.mjs`, `REPS=3 node bench/phases.mjs`.

---

## 1. Interface, progress bars and bridge consistency

**The progress block itself is consistent.** All five stores produce the same row shape, marker, store tag, title, phase, 12-column meter, detail, and the same footer, because every adapter funnels its events through `LiveProgress.update()` with the same field names (`total`, `done`, `failed`, `bytes`, `phase`). Captured session, one volume of each store:

```
  ✓ BW   スーパーの裏でヤニ吸うふたり 1巻【無料お試し…  done     ████████████ 244/244 pages  143.3 MiB
  ✓ EBJ  スーパーの裏でヤニ吸うふたり　（1）【無料お試… done     ████████████ 244/244 pages  256.9 MiB
  ✓ CMOA スーパーの裏でヤニ吸うふたり 1巻               done     ████████████ 244/244 pages  138.2 MiB
  ✓ KM   スーパーの裏でヤニ吸うふたり (1)               done     ████████████ 236/236 pages  210.6 MiB
  ✗ KDL  スーパーの裏でヤニ吸うふたり 1巻 (デジタル版…  failed                fetch failed
  ██████████████████████████████████████████████████████ 100%
  5/5 done · 968/968 pages · 1 failed · 3m09s
```

Everything below the display level is **not** consistent.

### 1a. A failed batch is reported as a green, complete success

`LiveProgress.overallColor` returns `green` whenever `finished + failed === total`, before it ever asks whether anything failed:

```js
if (t.failed === t.total && t.total > 0) return 'red';
if (t.finished + t.failed === t.total && t.total > 0) return 'green';   // 4 done + 1 failed → green
```

and the footer counts failures as done (`${t.finished + t.failed}/${t.total} done`). Verified directly: 4 volumes done and 1 failed renders a full green bar reading `5/5 done · 1 failed`. A partially failed run is indistinguishable from a clean one at a glance. The one row that did fail also loses its meter, because the failure happened before any phase transition so `errorPhase` is `null`, the opposite of the comment on `fraction()` that promises a failed row "keeps its context".

### 1b. The `--json` result record is not uniform

`run.js` documents a "uniform store record". Four stores agree on the core fields; three add private ones and none shares the same set:

| store | extra fields | missing vs. the others |
|---|---|---|
| CMOA | `subtitle` | n/a |
| BookWalker | `route`, `mode` | `subtitle` |
| Kindle | `seriesAsin`, `accessMethod`, `sample`, `isSample`, `walkedPages` | `subtitle` |
| k-manga | n/a | `subtitle` |
| ebookjapan | n/a | `subtitle` |

`route`/`mode` are BookWalker-only by nature, but `sample` exists conceptually for every store (CMOA, ebookjapan and k-manga all have samplers) and is only reported by Kindle. Anything consuming `--json` across stores has to feature-test per store.

### 1c. `metadata.json` means two different things

The same filename holds a folder-owner marker in four stores and a full page manifest in ebookjapan:

| store | `metadata.json` keys |
|---|---|
| CMOA / BookWalker | `{store, id, title}` |
| k-manga | `{store, id, bookId, volume, title, sample, descrambled, chapters}` |
| Kindle | `{store, id, title, seriesAsin, revision, pages, expectedPages}` |
| ebookjapan | `{source, title, publication, code, fileId, direction, version, imageTypes, chapters, totalPages, concurrency, descrambled, elapsedSeconds, bytes, pages}`, **no `store`, no `id`** |

This breaks the README's collision protection: `resolveVolumeFolder()` reads the marker and compares `existing.id` to decide whether a folder is already this volume's. An ebookjapan folder has no `id`, so:

- ebookjapan itself never calls `resolveVolumeFolder()`, it always writes to `safeName(book.name)`, so two ebookjapan volumes that clean up to the same name silently overwrite each other, which is exactly what the README says cannot happen;
- any other store writing into an ebookjapan folder sees no marker and picks a disambiguated sibling, splitting one volume across two folders.

Also note `--no-title-dir` names an ebookjapan folder after the *publication* code (`book.code || book.publication`) while every other store uses its own id.

### 1d. Page filenames are consistent, the README is not

All five stores now write `page-0001.<ext>`. The README's output-layout section still documents CMOA as `0001.jpg`, BookWalker as `page-0001.jpg` and ebookjapan as `page_000.webp`; two of the three are stale, and ebookjapan is `.webp` at four digits like everyone else.

### 1e. Bridge wiring is consistent on screen, not in the record

`--mokuro` connects once per run (`connectBridge` before the lanes start) and prints the same two lines for every store. Underneath, there is one path for four stores and a different one for BookWalker:

- CMOA, ebookjapan, k-manga, Kindle → the driver's `pushToBridge()`: push pages, poll OCR, finalize. The mokuro record carries `{bridge, destination, sessionId, pagesUploaded, pagesAlreadyOcr, pagesFailed, ocrDone, ocrFailed, outputDir, outputFiles, failures}`.
- BookWalker → the vendored sampler streams pages to the bridge itself, sets `deferredFinalize`, and the driver only finalizes. Its record carries `{bridge, sessionId, pagesUploaded, pagesAlreadyOcr, pagesFailed, outputDir}`, **no `destination`, `ocrDone`, `ocrFailed`, `outputFiles` or `failures`**.

So a `--mokuro --json` consumer gets a different shape for one store out of five, and BookWalker's OCR totals are unavailable even though the sampler knows them.

### 1f. mokuro-bridge connectivity

The bridge at `http://127.0.0.1:62642` was up (v0.6.0, `mokuro_installed: true`, `mokuro_custom_fork: true`). `connectBridge` + `resolveDestination` is a single shared code path and behaved identically for every store, including the actionable failure message when no bridge answers. This part is consistent.

---

## 2. Native resolution and native page size

Measured across all 2 224 downloaded pages (`bench/analysis.json`).

| store | pages | native resolution | distinct sizes | format | total | per page |
|---|---|---|---|---|---|---|
| BookWalker | 464 | **1350×1920** | 1 | JPEG | 282.2 MiB | 601-647 KiB |
| Kindle | 464 | **1350×1920** | 1 | JPEG | 242.9 MiB | 518-557 KiB |
| ebookjapan | 464 | **1350×1920** | 1 | lossless WebP | 514.5 MiB | 1078-1199 KiB |
| k-manga | 451 | **1350×1920** | 1 | JPEG | 417.6 MiB | 914-986 KiB |
| CMOA | 464 | **1350×1920 *and* 1131×1609** | **2** | JPEG | 281.9 MiB | 580-669 KiB |

**Everything is 1350×1920 except CMOA, which mixes two sizes.** CMOA serves a downscaled 1131×1609 rendition (exactly 0.838×) for most pages, and the full size for the rest:

- volume 1: 109 pages at 1350×1920, **135 pages at 1131×1609**
- volume 2: 133 pages at 1350×1920, **87 pages at 1131×1609**

CMOA's `--format original` is supposed to give the original; on this title it is serving a lower-resolution variant for 54 % of volume 1 and 40 % of volume 2. This is the single largest quality difference between the stores: upscaled to 1350×1920 those pages differ from the native copies by MAE ≈ 12/255, against ≈ 5.5/255 for CMOA's full-size pages.

**Container sizes differ strongly for identical pixels.** ebookjapan is 2.1× the size of Kindle for the same page because it rebuilds each page from tiles and re-encodes it as *lossless* WebP (1078-1199 KiB/page). k-manga is ~1.8× Kindle at 914-986 KiB/page because it re-encodes the un-shuffled JPEG at high quality. BookWalker keeps the CDN's original JPEG untouched (601-647 KiB/page).

---

## 3. Speed: handshake, download, unscramble

### 3a. End to end, each store run alone (its two volumes in parallel)

| rank | store | pages | total | wall | pages/s | MiB/s |
|---|---|---|---|---|---|---|
| 🥇 | **BookWalker** | 464 | 282.2 MiB | **10.7 s** | **43.2** | **26.3** |
| 🥈 | Kindle | 464 | 242.9 MiB | 22.9 s | 20.2 | 10.6 |
| 🥉 | CMOA | 464 | 281.9 MiB | 38.0 s | 12.2 | 7.4 |
| 4 | k-manga | 451 | 417.6 MiB | 56.3 s | 8.0 | 7.4 |
| 5 | **ebookjapan** | 464 | 514.5 MiB | **61.7 s** | **7.5** | 8.3 |

**Fastest: BookWalker. Slowest: ebookjapan on its good run, but k-manga is the slowest store on a typical run**, because its throughput is not stable. Three separate runs of exactly the same two k-manga volumes on the same machine:

| run | conditions | wall |
|---|---|---|
| 1 | `--series`, descramble on | **56.3 s** |
| 2 | `--series --no-descramble` | **190.9 s** |
| 3 | `--series`, descramble on | > 5 min at 314 MB of ~418 MB when stopped |

The work is identical in runs 1 and 3, so this is the store throttling, not the client: k-manga's 56.3 s is a best case, not a representative one. Treat 56 s as the floor and ~3 min as the expected wall time; the README already documents that "the store throttles, so throughput has a ceiling that is not ours to raise", and this is what that looks like in practice. Every other store reproduced within a few percent.

The shape of the cost is visible in the CPU time each run consumed:

| store | user CPU | CPU per page |
|---|---|---|
| BookWalker | 25.7 s | 55 ms |
| Kindle | 9.9 s | 21 ms |
| CMOA | 113.4 s | 244 ms |
| ebookjapan | 241.4 s | 520 ms |
| k-manga | 25.1 s | 56 ms |

CMOA and ebookjapan are CPU-bound (render/descramble), BookWalker and Kindle are network-bound, and k-manga is bound by the store's own socket pacing.

### 3b. Handshake

Median of three, one request chain each (`bench/phases.json`):

| store | what it covers | median | first call |
|---|---|---|---|
| CMOA | `openVolume`, viewer metadata + page table | **0.40 s** | 1.45 s |
| ebookjapan | `collectPages`, open_book → get_drm → WASM decrypt → manifest | **0.77 s** | 1.41 s |
| Kindle | `openKindleVolume`, reader page + bookInfo + token | **0.92 s** | 1.10 s |
| BookWalker | `openFreeSession`, anonymous licence, 3 dependent round trips | **1.34 s** | 2.76 s |
| k-manga | launcher → session → index → WebSocket → header reply | **3.22 s** | 3.22 s |

k-manga's handshake is 8× CMOA's and is the only one that is not HTTP-only: 1.59 s of its 3.22 s is the WebSocket connect plus the header request/reply, the rest is the launcher and the index fetch. It is also the only store whose handshake is a meaningful fraction of a small volume's total.

All five are one-shot costs per volume except BookWalker, which the driver already pre-warms and shares across volumes of a run.

### 3c. Download vs. unscramble

The three numbers below are derived from the store's own stage, not from a profiler inside the loop, so "fetch" is total minus the measured stages.

**ebookjapan**, rebuilds every page from the viewer WASM's tile draw calls and re-encodes lossless WebP. Running the same two volumes with `--no-descramble` (mosaic kept, same network, same page list) isolates it completely:

| variant | wall | user CPU | pages | bytes |
|---|---|---|---|---|
| default (rebuild) | **61.7 s** | 241.4 s | 464 | 514.5 MiB |
| `--no-descramble` | **5.3 s** | 1.5 s | 464 | 276.3 MiB |

**The descramble is 56.4 s of the 61.7 s, 91 % of the wall time and 99 % of the CPU.** The network half is 5.3 s at 52 MiB/s; everything else is tile compositing and `sharp` lossless-WebP encoding at ~520 ms of CPU per page. That is also why ebookjapan gains almost nothing from `--parallel`: the cores are already saturated by one volume.

**CMOA**, descrambles and re-encodes every page through its own render pool. The vendored engine reports `elapsedMs` per page but does not split fetch from render, so the split was measured directly, over 24 pages of volume 1 through the engine's own `volume.fetchPage()` and `renderPage()`:

| stage | per page | note |
|---|---|---|
| fetch | **47 ms** | 291 KiB average, one CDN GET |
| render (descramble + re-encode) | **237 ms** | single-threaded, inline |
| ratio | **5.1×** | render is 5.1× the fetch |

237 ms of CPU per page matches the full run almost exactly (113 s user CPU ÷ 464 pages = 244 ms/page), so the descramble *is* the CPU cost and the network is a fifth of it. **CMOA's unscramble is its download.** (The engine's own README quotes ~18× for aggregate throughput with a full pool, which is the same fact seen from the pool's side, not a contradiction.)

**k-manga**, every page is a block-scrambled JPEG re-encoded after un-shuffling. On the fastest run (56.3 s for 451 pages) it used only 25.1 s of CPU: the rebuild is ~21 ms/page and the rest is the store's socket pacing (the README's own table: 217 ms/page at pipeline depth 8), so **for k-manga the download is the transport and the unscramble is negligible**, the opposite of CMOA. The `--no-descramble` control run took 190.9 s, i.e. *longer* with less work done, which is the cleanest possible demonstration that this store's cost is server-side and not CPU-side.

**BookWalker**, pages are encrypted and un-permuted in a worker pool, but the pool is a rounding error next to 26 MiB/s of transfer: 55 ms of CPU per page including decrypt, decode, re-encode and write.

**Kindle**, no unscramble. Pages are AES-GCM-decrypted with a key cut from the reading token; 21 ms of CPU per page covers decrypt + write over 11 MiB/s.

Ranking the unscramble cost per page: **ebookjapan (~520 ms) ≫ CMOA (~244 ms) ≫ k-manga (~21 ms) ≈ BookWalker decrypt/decode (≈55 ms total per page, most of it transfer) > Kindle (≈21 ms, decrypt only)**.

### 3d. Running the stores together is slower than running them one at a time

The default is to start every volume at once (`--parallel` = all, capped at 16) in two "lanes": a CPU lane for CMOA and a network lane for everything else. Ten volumes, same machine, same content:

| store | alone (2 volumes) | mixed batch (2 volumes) | slowdown |
|---|---|---|---|
| BookWalker | 10.7 s | 72.5 s | **6.8×** |
| Kindle | 22.9 s | 77.3 s | 3.4× |
| CMOA | 38.0 s | 68.0 s | 1.8× |
| k-manga | 56.3 s | **217.2 s** | 3.9× |
| ebookjapan | 61.7 s | 68.0 s | 1.1× |
| **total wall** | **189.6 s** | **219.4 s** | **1.16× slower** |

The two-lane model separates CMOA from the rest, but four of the five stores have per-page CPU work, CMOA render, ebookjapan descramble, BookWalker normalize, k-manga descramble, and only CMOA's and BookWalker's pools are sized against the machine (`sizing()` in `run.js`). ebookjapan's 32 concurrent descrambles and k-manga's unbounded rebuilds are not accounted for at all, so the batch oversubscribes the cores. The result is that the default is both slower *and* less reliable.

### 3e. CMOA wastes half the machine when one volume finishes first

`sizing()` computes `renderJobs = cores / concurrentCmoa` once, when each volume starts, and `ctx.jobs` is a getter read once by `downloadCmoa`. Measured on two CMOA volumes: 13 render jobs split as 6 + 6. Volume 1 finished at 14.3 s and volume 2 ran on to 38.0 s still holding 6 threads, i.e. roughly 7 cores idle for the last 24 s (~170 core-seconds wasted per two-volume run). The pool is never re-sized as the volume count changes.

---

## 4. Bugs found

### 4.1 Kindle: a series walk silently drops a volume the account can already read: **reproduced, high impact**

> Superseded later: the walk this section describes was replaced by a single series-list request with the per-volume access checks run at once, so the hop-by-hop behaviour here is history rather than a description of the current resolver.

`resolveKindleSeries` classifies each hop with `kindleIsFree()`, which is true only for `LIMITED_TIME_FREE`/`FREE_TRIAL`/`FREE_READ`. A volume this account can read in full through an existing Kindle Unlimited loan reports `bookAccessMethod: FULL_BOOK`, which is *not* free, so the walk then looks for a borrow widget on the product page. An already-borrowed volume has no widget, the button has already become "read now", so the offer is `null` and the volume is dropped from the task list entirely.

Measured on the target series (`bench/`, probe in the session log):

```
 1  B0B683NKKV  access=FULL_BOOK           isFree=false  KUctx=false  KUstr=5   widget=null   ← dropped
 2  B0BNKZMFN6  access=LIMITED_TIME_FREE   isFree=true   KUctx=true   KUstr=7   widget=KINDLE_UNLIMITED
 3  B0C6KFBZH8  access=SAMPLE              isFree=false  KUctx=false  KUstr=0   widget=null
 … through volume 9
  kindle B0B8SKZBBT: 1 free in full of 9 volumes walked
```

Volume 1 has a valid reading token and downloads fine when asked for directly (verified: 244 pages, 129 MB), the series resolver just refuses to queue it. So `dokuha --series <kindle series URL>` produces a library missing a volume, with a summary line that says so only if you count the volumes yourself. The same applies to any volume the account owns outright. The distinction the code needs is "this account can read it" versus "the store is giving it away", and `FULL_BOOK` is the first.

### 4.2 Kindle: one transient network error fails a whole volume: **reproduced**

`kindleFetch()`, used by every control-plane call (`open-book`, `get-series-data`, `render`, uploads), is a bare `fetch` with no retry and no error wrapping:

```js
async function kindleFetch(url, session, extraHeaders = {}, { method = 'GET', body } = {}) {
    const response = await fetch(url, { ... signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) ... });
    return response;
}
```

A blip therefore surfaces as the undici `TypeError` `fetch failed`, message only, with the real `cause` (ECONNRESET, UND_ERR_SOCKET, …) discarded, and it takes the volume down. Observed twice: a mixed-batch run failed a whole Kindle volume with the literal text `fetch failed`; re-running the same ASIN alone succeeded immediately (84 fetched, 160 resumed). Meanwhile the *page* fetches in the same adapter do retry six times with jittered backoff, so the adapter is inconsistent with itself.

The same fixed 45 s `FETCH_TIMEOUT_MS` is used for CDN pages, and under a mixed batch 8-11 pages per volume died with `The operation was aborted due to timeout`, while the same volumes alone had zero failures. Retrying with the same fixed budget does not recover a load-induced timeout.

### 4.3 ebookjapan: the documented bare publication code does not work, and the code the tool prints is rejected

The README's accepted-URL table says a bare publication code like `A002664637` is valid. It is detected (`/^(A\d{6,})$/`) and passed straight to `open_book` as if it were a viewer code:

```
$ dokuha A007056462 --out bench/out
  open_book 404: open free A007056462 failed (got 404 Not Found
  {"error":{"code":2000,"type":"ResourceNotFound","message":"publication of A007056462 is not exists."}})
```

An `A…` code is a *publication*, not a reading code; it needs `GET /br_api/books/…` to resolve before `open_book` will accept it, which is exactly what `resolveEbookjapanSeries()` does, and what the file-URL path does. Only the bare-code path skips that step.

The mirror image is worse: `--series` prints bare reading codes (`B00167056462`) as its targets, and those are **not recognised as input at all**, `detectSource()` has no pattern for a leading `B`, so pasting back a code the tool itself printed is reported as "not a CMOA, ebookjapan, BookWalker, Kindle or k-manga URL". The `/viewer/free/B…/` URL does work.

Reproduced for all four forms:

| input | result |
|---|---|
| `https://ebookjapan.yahoo.co.jp/books/716241/A007056462/` | ✅ 244 pages |
| `https://ebookjapan.yahoo.co.jp/viewer/free/B00167056462/` | ✅ 244 pages |
| `A007056462` | ❌ `open_book 404` (documented as valid) |
| `B00167056462` | ❌ rejected by detection (emitted by `--series`) |

### 4.4 A failed batch renders as a green, 100 %, "N/N done" success: **reproduced**

See §1a. `overallColor` prefers `green` over the presence of failures, and the footer counts failures in the "done" numerator.

### 4.5 Smaller items

All five are **fixed**; see §7 for the change and its verification.

- **`--zip` is silently ignored outside BookWalker.** It is only read in `bookwalker.js`; passing it with a CMOA or ebookjapan URL does nothing and says nothing. `--download-samplers` without `--series` does warn, so the pattern exists. → `run()` now detects the positional URLs offline and says `note: --zip only applies to BookWalker; other stores write their pages unchanged`.
- **The failure row loses its meter.** `fraction()` falls back to `volume.errorPhase || 'downloading'`, but `errorPhase` is only set on a phase transition; a volume that fails during setup has `errorPhase: null` and renders a bare row, contradicting the comment above the function. → the `error` case now carries the reached phase's fraction, falls back to the page count, and finally to an empty track, it never returns `null`.
- **`--pdf` is a documented dead end.** It is in `--help`, in the README table and in `options.js`, and every use throws. The help text does say "not available in process", but a flag that always throws is better removed than documented. → removed from `options.js`, `run.js` and the ebookjapan adapter; `--pdf` is now `unknown option` (exit 2) and the README says the capability is absent rather than flag-shaped.
- **ebookjapan has no folder-collision protection** (§1c) while the README claims all stores have it. → ebookjapan now goes through `resolveVolumeFolder`; its page manifest moved to `manifest.json` and `metadata.json` carries the standard `{store, id, title}` marker.
- **`resolveVolumeFolder` treats a missing `id` as a new volume.** Combined with 1c, the marker contract is only honoured by three of five stores. → an ownerless marker is now read as "this volume's", not "someone else's", which is what keeps the migration from renaming every existing ebookjapan folder. A marker that names a *different* owner still disambiguates as before.

---

## 5. What to change before pushing to GitHub

The repository is **already published** at `https://github.com/GolyBidoof/dokuha-cli` (`origin/main` exists, `main` tracks it), with **56 modified or untracked files**, 2 800 insertions and 406 deletions, sitting uncommitted. So the question is really what to fix before committing and tagging, not before first publication.

### Blocking

1. **Fix the Kindle series bug (§4.1).** It silently produces an incomplete library, which is the worst failure mode this tool has: no error, no missing file, just a volume that is not there.
2. **Fix the failure/colour semantics (§4.4).** Reporting a failed batch as a green 100 % is a correctness bug in the primary UI.
3. **Fix or remove the ebookjapan bare-code path (§4.3)** and the README row that advertises it.
4. **Commit the work in reviewable pieces.** 2 800 uncommitted lines across 27 files including vendored engines is not reviewable as one commit. Split: vendored engine deviations (with `vendor/README.md` updated), the new adapters, the driver, tests.
5. **Do not ship the vendor bundles unchanged without saying so.** `vendor/ebookjapan/` contains the store's own minified bundles (`DC71MjMq.js`, `DIKTQ-Ds2.js`, `Dn6eYzwe.js`) and `br_core_bg…wasm`. These are third-party, likely proprietary artefacts, redistributed in a public MIT-licensed repository. `vendor/README.md` describes them as "copies", not as licensed. Either confirm the redistribution is acceptable or fetch them at install time. This is a legal question, not a code one, and it is the highest-risk item on this list.

### Should fix

6. **Add CI.** `.github/workflows/acceptance.yml` exists but is `workflow_dispatch` only and needs a sibling checkout. There is no workflow that runs `npm test`, so the 19-file, 812-check hermetic suite never runs on a push. A 10-line `on: [push, pull_request]` job running `npm test` is the single highest-value addition.
7. **Fix the README against reality.** Page filenames (§1d), the `metadata.json` collision claim (§1c), the bare publication code (§4.3), and `--pdf`. Several measured claims (throughput, concurrency) are accurate and worth keeping; the layout and accepted-URL sections are not.
8. **Correct `package.json`.** `private: true` in a repository meant to be cloned and run is defensible, but it also blocks `npm publish` for no stated reason; `repository` points at the right URL while the README's own title still says `dokuha-cli`; there is no `files` field, no `keywords`, and the `bin` name (`dokuha`) does not match the repo name, so `npx dokuha` and `git clone … && node bin/dokuha.mjs` are two different names for one thing.
9. **Decide what `library/` and `bench/` are.** `library/` is correctly ignored. `bench/` as used in this audit is scratch evidence and must be ignored or deleted before committing, it currently holds ~3 GB of copyrighted pages.
10. **Pin the engine boundaries.** `vendor/README.md` says "do not edit a vendored file to fix a bug in dokuha", yet `src/download/*.js` reaches deep into vendored internals (`openVolume`, `collectPages`, `RenderPool`, `runPublicTrialJob`). The rule is right; the seam is not enforced by anything. A one-line header comment per vendored directory naming its public surface, and an import lint, would make it real.

### Nice to have

11. `CONTRIBUTING.md` says how to run tests but not how to add a store, which is the only extension point that matters.
12. The CHANGELOG stops at `v0.0.2` while the diff on disk is far past it.
13. No `engines` test in CI either, `npm run engines:test` is a second suite nobody runs.

---

## 6. Code quality and architecture

### 6.1 The measured problem: it is a comment corpus with a program inside

| file | lines | comment lines | % comment |
|---|---|---|---|
| `src/user-agent.js` | 12 | 11 | **92 %** |
| `src/serial.js` | 70 | 37 | 53 % |
| `src/download/page-files.js` | 166 | 81 | 49 % |
| `src/workers/bw-normalize-worker.js` | 69 | 34 | 49 % |
| `src/download/kmanga-protocol.js` | 292 | 125 | 43 % |
| `src/download/kindle-protocol.js` | 947 | 402 | 42 % |
| `src/download/kindle.js` | 1710 | 627 | 37 % |
| `src/display.js` | 869 | 277 | 32 % |
| **all of `src/`** | **9 177** | **3 179** | **35 %** |

Add 644 blank lines and **42 % of `src/` is not code**. The comments are not documentation in the API sense, they are essays: 20-line narratives above four-line functions, measurements, and post-mortems of bugs that were fixed years of commits ago. They are also frequently *stale*, and a stale comment is worse than none:

- `display.js#fraction()` promises a failed row "keeps its context", it does not (§4.5).
- `cmoa.js` documents a three-store tool; there are five.
- `README.md` documents page names and codes that no longer behave that way (§1d, §4.3).
- `series.js` says "three resolvers"; there are four plus Kindle.
- `run.js` says "uniform record"; it is not (§1b).

The information in them is genuinely valuable, the measurements are the best part of this repository, but it belongs in `docs/` and `vendor/README.md`, versioned and reviewable, not welded to the line it describes.

### 6.2 Architectural changes worth making

**A. One adapter contract instead of five shapes.** Each `src/download/<store>.js` exports a resolver and a downloader with its own context keys, its own idea of which options it honours, and its own result record. Formalise it:

```
resolve(input, config, deps) -> { tasks[], rejected[], notes[] }
download(task, ctx)          -> StoreResult
```

with one `StoreResult` normaliser applied in `runTask` so `--json` is identical for all five, `sample` is a first-class field everywhere, and `metadata.json` is written by one function that always carries `{store, id, title}` (with the ebookjapan manifest moved to `manifest.json`).

**B. Per-store phase timing, surfaced uniformly.** There is currently *no* phase instrumentation anywhere, the numbers in §3 took a benchmark harness that pokes vendored internals. A `ctx.timer` with four fixed phases (`handshake`, `fetch`, `rebuild`, `write`) recorded by each adapter and emitted in `--json` would make this audit a one-line command, would expose the CMOA job-sizing waste (§3e), and is the prerequisite for any scheduling work.

**C. A real scheduler.** The two lanes are a first approximation that loses (§3d). What the data says:

- four of five stores have per-page CPU work, so the unit of admission should be *threads*, not lanes;
- CMOA's pool must be re-sized when the volume count changes, not fixed at volume start (§3e);
- ebookjapan's 32 descrambles per volume and k-manga's rebuilds need to be inside the same budget as `renderJobs`/`normalizeWorkers`;
- the default of "start everything" is measurably worse than sequential, so `--parallel` should default to something the machine can actually run, not to the volume count.

A single global CPU budget with per-store weights would subsume `sizing()` entirely.

**D. One retry policy.** Kindle retries pages six times and control-plane calls zero times (§4.2); ebookjapan retries four times in its engine and again in a refresh pass; BookWalker has an internal loop; CMOA forwards `--retries` into the engine; k-manga counts reconnect attempts separately. Unify on a small `retry(fn, {attempts, backoff, timeout, isRetryable})` helper, always preserve `error.cause`, and make the timeout adaptive so a load-induced timeout is retried with a longer budget rather than the same one.

**E. `display.js` is 869 lines for a progress bar.** It is well factored internally (bars, truncation, cursor arithmetic, keyboard) but it is also the largest file after the Kindle adapter and it mixes width/ANSI measurement, layout, colour policy and terminal state. Split `ansi.js` (display width, truncate, clamp, colour policy) from `live-progress.js` (the block), and fix the failure semantics (§4.4) while there.

### 6.3 Comment removal

A trial strip was run on a scratch copy of the tree (a tokenizer that respects strings, template literals and regex literals, so a `//` inside a URL or a `/*` inside a regex is not mistaken for a comment). Result: **2 957 lines removed from 22 files, all 22 still parse under `node --check`, and 18 of 19 test files pass.**

The nineteenth fails, and it fails for a reason worth knowing before anyone attempts this:

```
FAIL  test_serial.mjs  FAIL  the queue is explained where it is created  (the reason for the queue is not documented)
```

`tests/test_serial.mjs:120` greps the *source text* of `ebookjapan.js` for an English sentence that only exists in a comment:

```js
check('the queue is explained where it is created',
    /process-global `fetch` shim/.test(source), 'the reason for the queue is not documented');
```

So **the test suite currently forbids removing comments.** That check has to change first, along with anything similar, or "remove the comments" is not a refactor, it is a failing build. Once it does, the plan that keeps the value is:

1. move the measured rationale into `docs/` (one page per store) and `vendor/README.md` (the deviations, where they belong);
2. strip narrative comments from `src/`, keeping only short JSDoc `@param`/`@returns` where a signature is genuinely not self-describing;
3. rewrite the text-based assertions in `tests/` to assert behaviour instead of comments (`test_serial.mjs` is one; the wiring tests grep source too and should be reviewed for the same smell);
4. fix the stale claims listed in §6.1 rather than porting them;
5. keep the other 812 checks green as the safety net for the whole pass.

That takes `src/` from 9 177 lines to roughly 6 200 and makes the remaining code readable in one screen per function.

---

## 7. What was changed, and how it was verified

Everything below is **uncommitted**, left in the working tree for review. No commit was made.

### 7.1 The four reproduced bugs

| § | change | where | verification |
|---|---|---|---|
| 4.1 | a volume the account can already read is queued instead of dropped | `kindleIsReadable()` and an `entitled` branch in the series walk | `tests/test_kindle_adapter.mjs` §6c: a `FULL_BOOK` hop is queued as held, is **not** probed on the store page, borrows nothing, and downloads its pages |
| 4.2 | control-plane requests retry; the transport cause survives | `kindleFetch()` retries GETs (3 attempts, backoff), reports the endpoint and `error.cause`; POSTs are deliberately not retried; page fetches get a growing budget (45 s + 30 s per attempt) | `tests/test_kindle_adapter.mjs`: a flaked reader page is retried and still opens, a permanent failure names `/manga/`, and a flaked borrow is sent **exactly once** |
| 4.3 | a bare reading code is accepted, a bare publication code is refused with the URL that works | `src/detect.js`; message reworded in `src/series.js` | `tests/test_detect.mjs`, `tests/test_series.mjs` |
| 4.4 | a batch that lost a volume is red, not green, and its footer counts only successes | `overallColor()`, `footer()` in `src/display.js` | `tests/test_display.mjs` |

The two tests that encoded the old, broken behaviour (a bare `A…` code being "accepted", and the old series rejection wording) were rewritten to the corrected contract, not weakened.

### 7.2 The smaller items

All five of §4.5, listed there with their individual changes. `--zip` now warns, `--pdf` is gone (`unknown option`, exit 2), the failure row always draws a meter, and ebookjapan goes through `resolveVolumeFolder` with a real owner marker.

### 7.3 The ebookjapan viewer artefacts are no longer redistributed

`vendor/ebookjapan/` shipped four of the store's own minified build files under this project's MIT licence. They are deleted, and `.gitignore` does not name them either, the history scrub that removes them from past commits is a separate step.

`vendor/ebookjapan/bundles.mjs` fetches them from `/_nuxt/` on first use into `~/.bwdd-cli/ebookjapan-assets/` (or `$BWDD_EBOOKJAPAN_ASSETS`) and caches them. Only the glue chunk's name is known up front; the chunks it imports and the `.wasm` it loads are read out of its own text, so there is one constant to refresh on a redeploy rather than four. `BWDD_EBOOKJAPAN_GLUE` overrides it without a code edit, and `docs/ebookjapan-assets.md` documents the procedure and why scraping the site for the name does not work (it was tried: no Vite/Nuxt manifest exists, and the glue is not reachable from the entry chunk's 950-module graph).

**Verified live.** Both free volumes from a cold cache: 244 + 220 pages, 269,349,166 bytes for volume 1, **byte-identical** to the run against the vendored files, and a second run reused the cache with no asset request at all (`skipped=244`, 1.9 s, empty stderr).

### 7.4 Comments stripped, rationale kept

`src/` and `bin/` went from **9 315 to 6 290 lines** (−3 025, −32 %). Every file still parses and the whole suite is green.

The rationale was not discarded: `bench/extract_comments.py` pairs each comment with the line of code it explained and writes `docs/rationale.md`, **1 309 notes across 21 files**, in file order, so reading it alongside the source is still the same walk. The one test that asserted a comment's presence (`tests/test_serial.mjs`) now asserts the same fact against that file, so deleting the reason still fails the build.

### 7.5 Test suite

| | before | after |
|---|---|---|
| `npm test` | 19 files, 812 checks | **20 files, 841 checks** |
| `npm run engines:test` | 7 files, passing | 7 files, passing |

New: `tests/test_volume_folder.mjs` (the marker contract, disambiguation, and the ownerless-marker migration). `test_kindle_adapter.mjs` grew 100 → 114 checks.

`vendor/cmoa/test/live_progress.test.mjs` was updated: it imports the shared `src/display.js` and still asserted the *old* overall-bar contract (only completed volumes count). The working tree deliberately changed that bar to track fetched pages, and the vendored copy had not followed, the deviation is recorded in `vendor/README.md`.

### 7.6 Verified, not assumed

- `node --check` on every `.js`/`.mjs` under `src/`, `bin/` and `vendor/`.
- `npm test` 20/20, `npm run engines:test` 7/7.
- ebookjapan live from a cold asset cache, twice, as above.
- `--help`, `--dry-run` across a mixed CMOA/BookWalker batch, `--zip` with both a non-BookWalker and a BookWalker URL, and `--pdf` (now rejected).

### 7.7 Renamed to `dokuha-cli`

読破 (*dokuha*) is to read a work through to the end. The package, the repository slug, the command and the README wordmark all changed:

| | before | after |
|---|---|---|
| package | `manga-dl` | `dokuha-cli` |
| command | `manga-dl` | `dokuha` |
| entry point | `bin/manga-dl.mjs` | `bin/dokuha.mjs` (renamed with `git mv`) |
| version line | `manga-dl 0.0.2` | `読破 dokuha 0.0.2` |
| live-test opt-in | `MANGA_DL_TEST_NETWORK` | `DOKUHA_TEST_NETWORK` |

The README now opens with a 読破 wordmark. On-disk state deliberately did **not** move: `~/.bwdd-cli/`, `free-session.json` and `kindle-session.json` keep their names, so an existing asset cache and a signed-in session survive the rename. `BWDD_EBOOKJAPAN_ASSETS` is unchanged for the same reason.

**Not done here, because it is outside this working tree:** the directory is still `~/GitHub/manga-dl` and the GitHub repository is still `GolyBidoof/bookwalker-ebookjapan-cmoa-native-headless-cli`. Both are one command each, in §7.8.

### 7.8 The architectural changes

All five of §6.2 are implemented. Three of them changed behaviour that the test suite could not see, so each was also exercised live.

**A. One adapter contract.** `src/store-result.js` exports `RESULT_CORE`, the eleven fields every result now always carries with a stable type, and `normalizeStoreResult()`, applied through a single `callAdapter()` dispatch in `runTask` so no store can be added without it. Store-specific fields are passed through untouched beside the core rather than dropped, so `route` and `seriesAsin` still reach existing consumers. This is what §1b identified: `sample` was reported by Kindle alone even though three stores have samplers. Verified live on CMOA (`ok=true`, 244 pages, `sample: false` present, `subtitle` preserved).

**B. Per-store phase timing.** `src/phase-timer.js` is an *accumulator*, not a cursor, because every store times work inside concurrent page workers and a shared "current phase" would charge one page's time to whichever page called it last. The four phases are emitted in `--json` and the audit's table is now reproducible:

```sh
npm run bench:phases
```

Measured live, one volume each: BookWalker `handshake 2.4 s / rebuild 39.1 s`, ebookjapan `handshake 2.2 s / fetch 20.8 s / rebuild 521.8 s / write 307.2 s`, CMOA `handshake 1.9 s / fetch 12.0 s`, the ratios §3 measured by hand.

The semantics are documented in `docs/phase-timing.md` and matter: a concurrent phase is an *aggregate across its workers*, not wall time, and a later draft that subtracted those aggregates from stage wall time to synthesise a `fetch` was removed because it mixes units, a blank phase is more useful than a meaningless number. Which store can measure which is a table in that document, and it follows from who owns the page loop.

**C. A real CPU budget.** `src/cpu-budget.js` replaces the inline `sizing()` arithmetic. The unit of admission is a thread rather than a lane, the allocation is recomputed every time a volume starts so freed capacity is visible, and it is one allocation rather than three independent ones that could each claim the whole machine. The two `test_wiring.mjs` checks that asserted the *shape of the source expression* (`/cores \/ concurrentCmoa/`) were rewritten to assert the allocation's behaviour; they were the same source-grepping smell §6.3 flagged.

**Part of C was tried and reverted on the evidence.** §6.2 C proposed putting ebookjapan's descrambling inside the same budget, on the theory that 32 concurrent `sharp` operations on a 14-core machine is oversubscription. It was implemented, then measured, three runs capped at 14 workers against three at the current 32:

| | wall | `rebuild` | `write` |
|---|---|---|---|
| 32 workers | **28.5 s** (27.8 / 28.7 / 29.1) | 531 s | 293 s |
| capped at 14 | 37.0 s (36.7 / 36.9 / 37.3) | 104 s | 0.2 s |

Capping is **30 % slower**, consistently. libvips already threads internally, so an outer queue adds latency to work that was already saturating the machine. The pool was removed, `cpu-budget.js` sizes only the two in-process JavaScript pools, and the finding is recorded in `docs/phase-timing.md` for the next person who has the same idea.

That experiment also produced the most useful measurement caveat in the audit: the two rows do the same work, yet the capped one reports five times less `rebuild` and a thousand times less `write`. **A concurrent phase is a pressure gauge, not a price list**, which is why `docs/phase-timing.md` says so in the section above the table rather than in a footnote.

**D. One retry policy.** `src/retry.js` holds `retry()`, the jittered backoff, the retryable-status set, and `describeError()`, which unwraps undici's `error.cause` so an `ECONNRESET` stops being logged as a bare `fetch failed`. Kindle's control-plane loop, the one adapter that owned a loop, now uses it, keeping the "GETs retry, POSTs do not" rule from §4.2. The vendored engines keep their own loops, recorded in `vendor/README.md`.

**E. `display.js` split.** 630 lines became `src/ansi.js` (101: width, truncation, colour policy) and `src/live-progress.js` (532: the block). The three importers were repointed and `src/display.js` deleted.

### 7.9 The descramble audit

A second pass over all five stores, prompted by the question of why ebookjapan writes WebP when every other store writes JPEG. §3 measured the *speed* of each store; this measured what each one actually does with the bytes, and found a single mistake responsible for most of ebookjapan's cost.

**The finding.** ebookjapan's CDN serves **lossy VP8 WebP** (396 KB for a 1350x1920 page). The descrambler decoded it to raw pixels, unscrambled the tiles, and re-encoded **lossless VP8L**, which preserves the source's compression artefacts exactly, at 1,950 KB, 4.9 times the source, for zero quality gain. The encoder, not the descrambling, was the whole cost:

| encode | size | time |
|---|---|---|
| lossless WebP effort 2 (was) | 1905 KiB | 906 ms |
| lossless WebP effort 0 | 2081 KiB | 267 ms |
| WebP lossy q90 | 351 KiB | 130 ms |
| JPEG q95 4:4:4 (now) | 715 KiB | 16 ms |

**End to end on one 244-page volume: 28.5 s to 8.5 s.** `rebuild` fell from 522 s to 102 s of worker time, and pages from ~1135 KiB to ~838 KiB. ebookjapan went from the slowest store in §3 to BookWalker's bracket. The extension also changed from `.webp` to `.jpg`, so the four other stores and this one now agree.

**There is no cheaper source.** The CDN ignores `Accept`, `image/webp`, `image/jpeg`, `image/png` and `*/*` all return the same WebP, and a `.jpg` suffix returns 403. The `.jpg` in the manifest's `name` field is fiction, and `imageTypes: 4` advertises variants that are not served. The format is therefore ours to choose, which is why the choice mattered so much.

**Why WebP at all.** The format follows the source: four stores serve JPEG, so their pages are JPEG by pass-through. Nobody chose WebP over JPEG, whoever wrote the encoder chose *lossless* over *lossy* without noticing the input was lossy.

**The other four stores do not have this problem**, because their sources are JPEG and their outputs are JPEG.

**Two CMOA ideas were tested and declined.**

- *Raise the page concurrency above the render-worker count.* The reasoning was that a page worker spends part of each cycle fetching, so 12 workers feeding 13 renderers must leave some idle. Measured over two runs each: **9.38 s at 17 workers against 9.43 s at 12**, a wash. The render pool is the throughput limit and its fill level is not the constraint, so the fixed default stays and no derivation was added.
- *Serialise CMOA volumes so a surviving volume keeps all 13 render workers* (§3e). Not implemented, and the measurement above is why: if fill level does not affect throughput at 12-versus-17, then halving the per-volume allocation is unlikely to cost any either, while serialising would give up the overlap of one volume's fetching with another's rendering. It needs a multi-volume CMOA benchmark to settle, and the titles to hand expand to one volume.

**k-manga.** The handshake under-reported itself (the index fetch sat outside the timed block), the header reply was re-read on every retry, and a drain that left work outstanding spent an attempt and then failed the whole volume instead of using the retries. All three are fixed. The pipeline default moved from 8 to 16, which is the shoulder the store's own help text names. The 56 s to 190 s spread across runs is store-side throttling and is not addressable from here.

### 7.10 CMOA, measured rather than inferred

CMOA was the last store with an opaque profile, because the vendored engine owns the page loop: `--json` showed a `fetch` figure and a wall time and nothing between them. Three additions fixed that, and each is recorded in `vendor/README.md` as a deviation to re-apply after a vendor refresh:

- the engine now reports `fetchMs`, `renderMs` and `writeMs` per page beside the `elapsedMs` it already had;
- `jpeg.js` gained `readJpegSize()`, which reads the frame header without decoding;
- `codec.js` decides the `format === 'original'` passthrough from the coordinate and piece tables *before* decoding, instead of after. The rendered bytes are identical; only the route to them changed. Its own comment already said "Nothing was permuted, so the served bytes already are the page", the decode above that branch was simply in the wrong order.

**What CMOA actually does** (one 244-page volume):

| | worker time | per page |
|---|---|---|
| handshake | 1.06 s | n/a |
| fetch | 20.3 s | 83 ms |
| rebuild | 83.2 s | 341 ms |
| write | 0.13 s | 1 ms |
| **wall** | **9.08 s** | |

Every page is scrambled (`rebuilt` 244/244), so the passthrough path does not fire for a volume like this one, it is correct and worth having for the assembled case, but it is not a speedup here. The render pool runs at **79% occupancy** (83.2 s of work across 13 workers in an 8.01 s page stage), and the floor is 83.2/13 + 1.06 = **7.5 s** against 9.08 s measured. **CMOA has about 1.2x left, not the 2-3x it feels like.**

**Four ideas tested and rejected:**

| idea | result |
|---|---|
| Per-volume render-pool startup | **4 ms** to spawn all 13 workers, nothing to recover |
| More pages in flight (12 to 17) | 9.43 s vs 9.38 s, a wash |
| libvips oversubscription (`sharp.concurrency(1)`) | **N/A**: CMOA ships its own hand-written JPEG codec and never loads `sharp` |
| Lower re-encode quality | q92 to q45 cuts files **2.5x** (580 to 235 KiB/page) but time by **2%** (341 to 334 ms/page) |

That last row is the informative one: the JPEG *encode* is not the cost, so the 341 ms is dominated by the decode and the tile copy. Quality is a **size** lever, not a speed lever, which is why `--jpeg-quality` is now exposed as an option rather than applied as a default, and the engine's 92 is left alone.

**The one idea left standing** is splitting the page worker's `fetch -> render -> write` into a fetch stage feeding a render queue, so the 13 renderers never idle while a worker is on the network. The ceiling is that same 1.2x, and it is now moot, because the renderer itself turned out to be the thing to fix.

**§7.11 The fix: hand the codec to libvips**

The 341 ms/page was 128 ms of `decodeJpeg` and 68 ms of encode, both hand-written JavaScript, plus ~90 ms of pool queueing and IPC that is not CPU at all. The decode is 72% of the real work and cannot be avoided algorithmically, so the lever was the codec.

Measured on the same page: libvips decodes it in **8 ms** against the engine's 63 ms, and encodes in **15 ms** against 68 ms. `codec.js` now dispatches: `renderPage` is async, and if `sharp` resolves it decodes and encodes through libvips, otherwise it falls through to the original pure-JavaScript codec, untouched. The engine still runs standalone with no dependencies, `sharp` is already an `optionalDependencies` entry, and a checkout without it silently keeps the old behaviour.

| | pure JS | libvips |
|---|---|---|
| `rebuild` | 341 ms/page | **30 ms/page** |
| volume wall time | 9.08 s | **2.83 s** |
| bytes | 580 KiB/page | 554 KiB/page |

**CMOA went from the third-slowest store to 3.2x faster, and it is now bounded by its 1.07 s handshake and its fetches rather than by rendering**, `rebuild` is 7.2 s of worker time across 13 threads, 0.55 s of wall.

Output is not byte-identical, which is the price and was accepted deliberately: libvips uses its own quantisation and chroma upsampling. Measured against the JavaScript path on the same page, the mean absolute pixel difference is **1.00/255** with a maximum of 14, encoder rounding, not anything visible, at identical dimensions, and all 244 files are valid JPEG. The tile scatter still runs in JavaScript and must: the tiles sit at arbitrary offsets such as (4,4), not multiples of the 8- or 16-pixel boundaries JPEG's variable-length MCUs would need for a cheaper move in the compressed domain. With full-resolution RGB in hand it became a row-wise rectangle copy instead of a per-pixel colour conversion.

`render-worker.js` awaits `renderPage` and its handler is async; the two vendored tests that called `renderPage` now await it, and the pool-versus-inline byte-identity check still passes because both paths use the same implementation.

### 7.11 Kindle's walk, pipelined

§3 left Kindle unexplained: its `rebuild` and `write` are both ~0.3 s because its pages are JPEG pass-through, yet it was the second-slowest store. The time was all in the walk. `walkKindleWindows` is a cursor, and its stride is the *view count* of the window it just read, so the next offset is not known until the previous reply lands, which is why the obvious "compute the offsets and fan out" is wrong, and why `fetchWindowOrShrink` can halve the batch mid-walk on a 400 or flip the content type between `Sample` and `FullBook`.

Instrumenting the walk settled it. A 244-page volume takes **21 windows**, and across all 21 the view count came back *equal to the requested batch*, making the stride perfectly regular and the offsets predictable after all.

Two other things the probe showed. The batch settles at **6 views**, not the 24 that `KINDLE_RENDER_BATCH_MAX` allows: the walk starts at 24, takes a 400, halves to 12, takes another, and lands on 6. And 6 is the CDN's limit for this book, `views` never disagreed with it once. **Raising the maximum does not help**, and an A/B of 6/12/24 found no difference outside run-to-run variance (totals 127 s / 126 s / 118 s, with the fetch figure moving the opposite way to the handshake), so it stays at 24.

What helped was pipelining. The walk now keeps up to three speculative window fetches in flight at `skip + k * batch`, and consumes one only when its offset is the offset the cursor actually wants, so a wrong prediction costs a request and never a page. Speculative fetches run against a copy of the walk's state: `fetchWindowOrShrink` shrinks the batch and may flip the content type, and a request that is thrown away must not leave those changes for the real walk to inherit. A speculative promise that is never awaited carries its own no-op catch so it cannot surface as an unhandled rejection.

| | sequential | pipelined |
|---|---|---|
| wall, two volumes | 31.6 s | **21.3 s** |
| walk (`handshake`) | 35.6 s | 15.1 s |
| pages | 464 | 464, byte-identical |

### 7.12 Still open

Not done in this pass, in rough priority order:

1. **The `--parallel` default is bounded now, but the number is not measured.** §3d showed "all of them" was worse than one at a time (219.4 s against 189.6 s), so the default is now `cores / 4`, three here. Nothing measured *three*: the audit only brackets the two ends, and the right value in between needs repeated multi-volume runs per store.
2. **The README prose**, which the rename makes unavoidable. The usage examples were mechanically renamed, and the stale external banner is now replaced by `dokuha-logo.png`, but the output-layout section and the store notes still need a read against the code.
3. **The stale documentation in §1c/§1d/§4.3/§4.5**, `README.md` page-filename examples and the `--pdf` row are fixed, but the folder-collision claim and the vendored-engine notes should be re-read against the code.
4. **A CI job that runs `npm test`.** There is still only a `workflow_dispatch` acceptance workflow, so nothing gates a push today.
5. **The git-history scrub** for the four deleted artefacts.
6. **The two renames that need a shell outside this tree:**

```sh
mv ~/GitHub/manga-dl ~/GitHub/dokuha-cli      # then reopen the working directory
gh repo rename dokuha-cli                     # then update the origin remote
```
