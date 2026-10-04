# Changelog

## v0.0.9

A worker crash could hang the whole run, `--km-concurrency` never reached the
engine, and `--no-title-dir` let a sampler overwrite the volume it belongs to.

### Fixed

- **A crashed render worker hung the entire run.** Both worker pools handed the
  next page to a worker that had already died, and `postMessage` to a terminated
  worker is a silent no-op, so that page's promise never settled. Because the pool
  is closed in a `finally` that runs *after* the downloads are awaited, one crash
  meant the CLI produced no output and never exited; after `size` crashes every
  remaining page did the same. A dead worker is now dropped instead of reused, the
  pool refills itself, and an `exit` without a `message` settles the in-flight job
  rather than parking it forever.
- **`--km-concurrency` did nothing.** It was declared, shown in `--help`, read by
  the driver and consumed by the k-manga adapter, but `parseOptions` never copied
  it into the config, so the documented default of 16 was really a hardcoded 8.
  The five per-store page counts are now followed from declaration through the
  parse to the store context in one test, so the next dead flag fails the suite
  rather than shipping.
- **A sampler overwrote its own volume under `--no-title-dir`.** A sampler and the
  full volume share one content id, so naming the folder after the id sent both to
  the same directory, where they overwrote each other page for page. CMOA,
  BookWalker and Kindle were affected; k-manga already carried the sample suffix.
  One `volumeFolder` helper now decides this for every store.
- **A store-supplied title of `.` or `..` wrote outside `--out`.** The ebookjapan
  sanitiser stripped separators but not trailing dots, so the path resolved to the
  parent directory. It now uses the same sanitiser as every other store, which
  also removes a second, looser copy of the rule.
- **A re-run re-downloaded every descrambled ebookjapan page.** The "is this page
  already on disk" check looked for WebP magic regardless of the format actually
  written, so with descrambling on -- where the pages are JPEG -- it never
  matched, and the whole volume was fetched and re-encoded again without
  `--force`.
- **A page the descrambler could not rebuild was reported as a success.** When the
  WASM glue used a canvas call outside the known set, the composition returned no
  plan and the raw scrambled bytes were written to a `.jpg` path and counted as
  downloaded. It is now a failed page.
- **One flaky probe aborted a whole CMOA scan.** Probing deliberately rethrows
  anything that is not "this volume does not exist", so a single 429 or 500 while
  scanning killed the run even when every other URL was fine. A thrown probe now
  counts as a miss.
- **A volume whose page uploads mostly failed was reported as a success.** Upload
  failures were recorded but never affected `ok`, so a 200-page volume with 199
  bad pushes exited 0 with a `.mokuro` built from the one page that arrived.
- **A finalize stream that ended without a `done` frame counted as a success.**
  The vendored BookWalker client throws on that input and the ebookjapan client
  did not, so the same truncated upload was judged two ways.
- **`--parallel N` ran up to `2N` volumes.** Each scheduling lane built its own
  pool of `parallel` workers, which contradicts both the help text and the number
  the summary reports. Both lanes now draw from one gate.
- `<link rel="next">` on a BookWalker series page is now resolved against the page
  URL; a relative href used to reach the fetcher as-is and fail to parse.
- A series page fetch that answers non-200 now releases its socket instead of
  leaking one per page.

### Changed

- **The stores are a registry, not a set of branches.** Each store owns a
  descriptor: the URLs it answers to, its progress label, the lane it runs on, how
  a title URL expands, its series walk, and its download. `run.js` dispatches
  through that registry, so adding a store is one descriptor rather than a new
  branch in the driver, a switch in the adapter, and an entry in three tables.
- Folder naming, the volume marker and the shared scrapers moved out of the CMOA
  adapter, which every other adapter had been importing from.
- **The ebookjapan viewer's WASM module and glue chunks are no longer vendored.**
  They are ebookjapan's own proprietary build output and redistributing them under
  this project's MIT licence is not ours to do. They are now fetched from the store
  on first use and cached under `~/.bwdd-cli/ebookjapan-assets/` (or
  `$BWDD_EBOOKJAPAN_ASSETS`); `vendor/README.md` has the refresh procedure.

### Notes

- The tests that pinned the wiring by grepping the source have been replaced with
  behavioural ones. A check like "does `run.js` contain the text
  `retries: config.retries`" cannot tell a working build from a renamed variable,
  and it fails on any refactor; the same guarantee is now expressed by running the
  code.

## v0.0.2

Changed:
- **Downloading and the mokuro-bridge are two stages with separate worker pools.**
  A volume used to hold the lane slot it had downloaded in until its OCR had
  finished and its `.mokuro` had uploaded — minutes of a download slot spent
  waiting, with the network idle and later volumes queued behind it. The bridge
  stage now has its own workers (`--bridge-parallel`, default the same width as
  `--parallel`) fed by a bounded queue that holds `2 x --parallel` volumes, so a
  fast store cannot run the whole library onto disk while one OCR worker catches
  up. `--json` reports `mokuro.queuePeak`. Per-volume `phases` still describe only
  the store download, which is what every other store means by that key.

- **OCR and upload progress is read from the finalize stream instead of polling
  `/status`.** `finalize` emits a `wait_ocr` frame at least every 0.75 s while the
  OCR queue drains and an `upload_progress` frame per file while a remote
  destination uploads, so the extra request the client fired on a timer alongside
  the same operation is gone, and the numbers are finer-grained. `--ocr-wait` keeps
  its meaning as a bound on the OCR phase alone: it is an abort timer that only
  fires while the last frame was `wait_ocr`, so a slow upload is not mistaken for a
  slow model. Finalize is now called as soon as the last page is pushed, which is
  also what makes the bridge drop its `OCR_CHUNK_SIZE`/`OCR_IDLE_FLUSH_S` wait and
  start the tail of the queue immediately.

- **A local bridge reads the volume folder itself, so a volume costs two requests
  instead of one per page.** When the bridge is loopback and the library is under
  `$HOME` or the system temp roots, dokuha calls `POST /session/resume` with
  `source_dir` and lets the bridge copy the images and skip the pages whose OCR
  result is cached. `--no-folder-ingest` forces the per-page path. A remote bridge,
  a library outside the ingest roots, a bridge without the route (404/405), and a
  bridge whose resume handler throws (5xx) all fall back to uploading pages with a
  note rather than losing the volume. `mokuro.ingestedFromFolder` counts the
  volumes that took the fast path. The client half is covered by
  `tests/test_bridge.mjs`. **Live-verified** on a real 202-page volume against a
  restarted mokuro-bridge 0.6.0: `ingest: "folder"`, `pagesIngested: 202`,
  `pagesUploaded: 0`, `ocrDone: 202`, `pagesFailed: 0`, wall 130.4 s, producing a
  44 MB `.cbz`, a 463 KB `.mokuro` and a 139 KB `.webp`. Two requests for the whole
  volume. Note what the win is: OCR is ~128 s of that 130 s, and the per-page upload
  path was already measured at ~178 pages/s after the 60 ms start-rate floor was
  removed, so folder ingest saves ~200 HTTP requests and the client work of reading
  202 files, not wall time.

- **`phases` gained `prework`, so `handshake` means the session open again.** It had
  drifted into "everything before page work", which for Kindle made a 19 s
  render-window walk look like a handshake — and the reader session open was not
  timed at all. `handshake` is now the licence/login/token step and `prework` is
  getting ready to fetch pages: the manifest, the page list, the walk, ebookjapan's
  WASM module and shuffle table. Measured per store where a seam exists — Kindle
  (session vs walk), BookWalker (licence vs `configuration_pack.json`), ebookjapan
  (licence vs module + shuffle table), k-manga (session vs chapter index) — and
  **blank for CMOA**, whose vendored `openVolume` does session and page list in one
  call. A blank is deliberate; guessing would be worse.

Added:
- **`--bridge-parallel N`** and **`--no-folder-ingest`**, both described above.
- **`scripts/probes/live-bridge-ingest.mjs`**, which runs one real volume through
  the folder-ingest path against a live bridge and prints what the bridge reported.

Fixed:
- **`mokuro.ocrFailed` was always `null` on a successful volume.** The finalize
  `done` frame carries `pages_ocr_done` but not `pages_ocr_failed`; only the
  `wait_ocr` frames do. The last one is now carried through beside the final record,
  so a run that OCR'd some pages and failed others reports both numbers instead of
  hiding the failures behind a `null`.
- **`mokuro.outputFiles` was always `null`.** The finalize response carries its
  per-file upload summary as `uploads`; the client read `final.files`, which the
  bridge has never sent. It now reads `uploads`, so a `--json` consumer can see the
  bytes that were actually uploaded.
- **`session/resume` answered 500 on every request** (mokuro-bridge, found while
  wiring the folder-ingest path). `api.py` called `_safe_component` without
  importing it — it lives in `sessions.py`, and `ocr.py` already imports it from
  there — so the queue step raised `NameError`. The exception handler then raised
  `TypeError: deque.pop() takes no arguments (1 given)` from four cleanup sites,
  which replaced the real error with a bare 500 and left the session and its copied
  pages behind. Both fixed in `mokuro-bridge`; the same `deque.pop(index)` pattern
  was wrong in all four places, not just the resume one.

- **An Unlimited volume is labelled `KDUL` instead of `KDL`, and mixes with free
  Amazon volumes in one command.** They are the same store with different
  acquisition: one is kept, the other is a loan that is handed back and can be
  withdrawn. A volume found by a `--series` walk is tagged before it is fetched; a
  volume pasted on its own is corrected once the borrow path proves what it is. The
  dry run prints `kindle unlimited` for the ones it knows.
- **A Kindle Unlimited loan that was already open is handed back after the
  download, even though this run did not open it.** Such a volume is readable
  immediately, so it never entered the borrow path and nothing there would ever
  return it — the shelf quietly filled up with volumes already on disk. Only
  `KindleUnlimited` loans are returned (an owned book also has an acquisition id
  and is never touched), only after a *successful* download (a failure leaves the
  loan so it can be retried), and a sampler never triggers it. The volume line
  says `returned`, and a failed hand-back is reported rather than swallowed.
  Reading the library now asks for `activeBorrow` behind the concrete inline
  fragment, because a returned volume keeps its edge.
- **Kindle samplers download from the volume URL that offers them.** A 試し読み is
  the same reader route with `?sample=1`, and it publishes its own revision and
  reading token; a volume this account neither owns nor can borrow now downloads
  its trial pages with no extra flag. `--download-samplers` extends a `--series`
  walk past the free volumes to every sampler in the series, matching the other
  three stores. Two measured traps are handled: `isSample` is `false` on the
  sample route (so `bookAccessMethod: "SAMPLE"` is what selects
  `contentType=Sample`), and `cdnPrefetchInfo.resources` is one window rather than
  the sample's length.

- **Kindle Unlimited volumes are borrowed, downloaded and returned automatically,
  with no new flag.** An unborrowed KU title is served exactly like a volume the
  account cannot open (no reading token, `bookAccessMethod: "SAMPLE"`), so the
  adapter probes the store product page for the `KU-DP-BottomSheet-Context` widget
  when it hits that refusal, borrows with the widget's own CSRF token, downloads,
  and hands the loan back in a `finally` — a failed or partial download still
  returns the volume, because leaving it on the shelf is the one outcome that must
  not happen. Eligibility is learned from the responses, never from a flag: the
  first refusal settles it for the run, and later volumes are not asked again.
- **Borrows, downloads and returns all run in parallel, within a bounded loan
  window.** The window (6 outstanding loans) stays well inside Amazon's ~20-volume
  ceiling, and returns are batched: one `mycdBulkReturnBorrow` per group of volumes
  that finish together, with the loan ids from a single `getCustomerLibrary` read
  shared through the run. Measured offline: two volumes borrowed and downloaded
  together produce one return call carrying both loans.
- **`--series` now picks up Kindle Unlimited volumes, not just the free-in-full
  ones.** The first volume that is neither free nor open is probed once for the KU
  widget; every later non-free volume is offered as a candidate through the same
  borrow/download/return pipeline. A candidate whose borrow is refused is skipped
  with one line rather than failing the run.
- **k-manga (まんが王国) is the fifth store, and the first with no HTTP page
  requests at all.** `comic.k-manga.jp/title/<bookId>/` (which expands to the free
  volumes), a `/vol/<n>/` page and a `viewer-launcher/…` link are all accepted and
  detected automatically. Beaglee's NextViewer asks a JSONP endpoint for the table of
  contents and then opens a WebSocket to `wss://ws.viewer.k-manga.jp/`, down which
  both the page list *and the JPEG bytes* arrive in one framing — so a HAR of a whole
  read shows almost no HTTP traffic, and the content lives in the capture's
  `_webSocketMessages`. The adapter speaks that framing directly, and un-shuffles each
  page, which is a 96-pixel block permutation seeded from a per-image key. Measured:
  a 176-page free volume in ~85 s, 62 MB, 176/176 pages.
- **k-manga samplers are found, which needed the page's JavaScript to be satisfied.**
  A title page publishes a free volume as a real `<a href>`, but every sample as a
  button with *no href*: `title.js` writes those in on `DOMContentLoaded` from the
  page's `#titlejs` settings plus the button's `data-chapter-*` attributes. Reading
  only hrefs therefore reported two volumes for a title that offers ten, and called
  the other eight non-existent rather than merely not free. The parser now rebuilds
  the URL the way that script does, and reads attribute names case-insensitively --
  the live page writes `data-chapter-readType` and a browser-saved copy writes
  `data-chapter-readtype`, so a case-sensitive read succeeds against a saved page and
  fails against the site. With `--download-samplers`, free volumes come first and the
  samplers follow, each in its own `…（試し読み）` folder so a sampler can never be
  mistaken for the volume. A k-manga volume is identified by its name everywhere a
  reader sees it -- folder, progress row, summary, `--dry-run` -- with the stable
  `bookId`+volume id kept for the folder marker alone, so two volumes whose names
  clean up the same still cannot share a folder. Measured: 10 volumes, 440 pages in
  33.5 s (2 free volumes at 176 pages, 8 samplers at 11).
- **k-manga pages are pipelined, and `--km-concurrency` tunes it.** The viewer asks
  for one page at a time and waits, which measured 340-500 ms a page. The framing has
  no request id, so a pipelined reply is matched to its request by the scene number
  in its own body; a reply for a scene nobody asked for aborts the volume rather than
  writing the wrong page under the right name, and a dropped socket reconnects and
  resumes from the pages already on disk. Interleaved measurements (so server drift
  hit every arm equally) gave 497 / 369 / 315 / 217 / 103 ms a page at 1 / 2 / 4 /
  8 / 16 outstanding — and 501 and 590 at 24 and 48, i.e. slower than asking one at a
  time. The default is 8, capped at 32. The page rebuild is also overlapped with the
  next read. Measured end to end: a 176-page free volume went from 76.4 s to 25.1 s,
  writing byte-identical pages. Opening four sockets on the same ticket was measured
  as well: only ~1.4x for four times the connections, so one socket is used.
- **A dependency-free WebSocket client, `src/download/kmanga-ws.js`.** `package.json`
  targets Node 20, where `WebSocket` is not a global, so this is the handshake and the
  frame codec the store needs rather than a new dependency or a raised engine floor.
  It offers no extensions, so every frame is raw bytes.
- **`--descramble` / `--no-descramble` now cover k-manga as well as ebookjapan.**
  k-manga refuses to download without `sharp` rather than write a mosaic, because
  every one of its pages is scrambled.

- **Amazon Kindle is the fourth store.** A reader URL
  (`read.amazon.co.jp/manga/<ASIN>`), a store product page (`…/dp/<ASIN>` with any
  tracking tail) and a bare ASIN are all accepted and detected automatically, like
  the other three. The adapter reads the volume's state out of the reader page, walks
  the render service a window at a time, fetches each page from the signed CloudFront
  URL the manifest hands over, and decrypts AES-GCM pages with the key cut out of the
  reading token. No descrambling, no wasm, no tiles: a CDN resource *is* the finished
  page. Measured at ~20 s for a 207-page volume and ~19 s for a 244-page one.
- **Kindle needs a session, and `--kindle-cookie` takes one.** An Amazon volume is
  never public, not even a limited-time-free one, so this is the first store that
  always requires credentials. The flag accepts everything `--bw-cookie` does — a
  raw header, a `Copy as cURL` command, `@FILE`, a path, `-` for stdin — and the
  session is remembered in `~/.bwdd-cli/kindle-session.json` (`0600`). Without
  cookies the tool now says so once and stops, rather than reporting one confusing
  failure per volume.
- **`--series` walks a Kindle series.** The series' volume list is built in
  JavaScript on the store page, so it is not available headlessly; the reader's own
  "read next" call is used instead, with the series size as the stop so the walk
  cannot leave the series. Free-ness comes from `bookAccessMethod`:
  `LIMITED_TIME_FREE` counts, `SAMPLE` does not, because a sample ends in a 403.
  The walk goes forward only, so paste the first volume to cover a whole series.
- `--kdl-concurrency N` (default 12) for Kindle pages in flight, and
  `--kindle-max-volumes N` to cap a series walk.
- **A k-manga volume is spread over up to four viewer sockets, because the store
  paces a connection rather than the requests on it.** `--km-concurrency` is now a
  per-socket budget: depth stays at 16 on *each* socket, since splitting the budget
  across the pool measured worse (4 x 4: 396 ms per page against 4 x 16: 204 ms), and
  a volume short enough to fit one socket still opens one, because a handshake per
  socket is not worth it for eleven pages. Measured live, interleaved so server drift
  hit every arm equally, over 16 pages at depth 16: one socket 468 ms per page
  (spread 317-1680), two 369 ms (262-697), four **192 ms (191-246)** — 2.4x at the
  median and, more valuably, a 5.3x run-to-run spread narrowed to 1.3x, because this
  store's instability rather than its best case is what turns a 50 s volume into a
  three-minute one. The previous note that four sockets were "only ~1.4x faster" was
  taken when the single socket was not being throttled, the one regime where extra
  sockets cannot help.
- **The k-manga index fetch runs underneath the socket handshake instead of in front
  of it.** It is a second HTTP round trip against the ticket whose only product is the
  chapter list in the volume marker — the page list and the decrypt key both come from
  the socket's header reply — and it measured 1027-1235 ms per volume, about a third
  of this store's handshake, on a title whose index carried zero chapters. It now
  starts as soon as the launcher returns and is awaited only when the marker is
  written, so it costs the critical path nothing. It is deliberately no longer counted
  in the `handshake` phase: that figure means "how long before the first page", and a
  request running underneath it is not part of that wait.
- **Kindle's render walk prefetches eight windows instead of three.** The walk is pure
  latency — each window is one ~900 ms round trip and a wrong prediction costs a
  request, never a page — so it divides almost exactly by the depth. Measured over one
  220-page volume (nineteen windows): depth 3 ran 7.42 s, 6 ran 4.08 s, 8 ran 4.06 s,
  9 ran 3.61 s and 12 ran 3.33 s. Eight is the knee: past it the gain is under 20 %
  while one more speculative request is abandoned per step (measured unawaited windows
  at the end: 2 at depth 3, 7 at depth 8, 11 at depth 12). End to end through the
  shipped CLI, a 244-page volume is now 13.83 s with the walk at 4.11 s — so the walk
  is 30 % of the run and the CDN is the rest, where before the walk was the run.
- **The Kindle render ceiling a volume discovers is remembered for the rest of the
  run.** The service refuses a `numPage` above a content-specific ceiling — measured
  at exactly 6 for the audit title, which answers HTTP 400 to 7 — and the walk finds it
  by halving from 24, spending two refused round trips before the first real page is
  asked for. That is 1.07 s of a 4.06 s walk. The ceiling is a property of the content
  and does not change within a run, so a later volume now starts where an earlier one
  settled. A stale guess stays safe in both directions: too large is refused and halved
  as before, too small returns fewer views and the walk simply takes more windows.
- `scripts/probes/` and `docs/parallelism.md`: the live probes behind the numbers above
  (`probe-kindle.mjs`, `probe-kindle-batch.mjs`, `probe-kmanga.mjs`), and the write-up
  of why each measurement was taken the way it was — including why the first k-manga
  socket comparison was thrown away (sequential arms measured the store warming up,
  not the sockets) and what the remaining architectural changes are.

Fixed:

- **Every k-manga retry failed, because a reconnected socket never read the server's
  greeting.** The greeting belongs to the connection and the header reply to the
  ticket, and `readManifest` did both, so the retry path — which skipped it when it
  already had a manifest — left the greeting in the queue. The next read handed it to
  `drainPages`, which found no `scenes` and aborted with `k-manga answered scene
  undefined while N other page(s) were outstanding`. The README and this changelog
  both claimed k-manga "reconnects and resumes from the pages already on disk"; it did
  not, and `--km-concurrency` retries could never rescue a dropped socket. Greeting and
  header reply are now separate (`greetSocket`), the greeting is read on every
  connection, and the header reply is still reused because the key really is per
  ticket. Covered by the new `tests/test_kmanga_pool.mjs`.
- **A k-manga socket that died abandoned the other sockets' promises.** The pool
  originally settled its shards with `Promise.all`, so the first rejection returned
  while the surviving shards were still draining into a closed socket, and their own
  rejection landed with nobody watching — an unhandled rejection that can take the
  process down. The shards now settle together with `Promise.allSettled`, which also
  means a retry starts from a settled page set instead of racing one still being
  written.
- **A k-manga handshake that failed reported the wrong thing.** A retry budget that
  expired before the manifest was read left the page total at zero and answered
  `every one of the 0 pages of "..." failed to download`, hiding the only line that
  said what actually went wrong. The handshake failure is now named:
  `"<title>" could not be opened at all: <cause>`. This is what the pool test hit
  first, and it is why the retry bug above was found at all.
- **A note documented a series-listing optimisation that was not wired in.**
  It records `data-offer-asins` listing a whole series in one request and a 72-volume
  measurement of 70 s serial to 3.5 s, but nothing in this tree calls
  `kindleStoreSeriesList()`: `resolveKindleSeries` still walks the reader's
  `openNextBook` chain one round trip per volume. The doc now says so explicitly,
  because a reader would otherwise believe series scanning is already one request.
- **`scripts/bench-phases.mjs` could not pass a flag that takes a value.** It splits
  `argv` into `--flags` and non-`--` words and drops the value, so
  `node scripts/bench-phases.mjs kindle --kdl-concurrency 32` reached the CLI as a
  valueless `--kdl-concurrency`, failed option parsing and reported it as "no result"
  rather than as the usage error it was. Boolean flags such as `--no-descramble` were
  unaffected, which is why it went unnoticed; the phase table itself is unchanged and
  the concurrency pair in `docs/parallelism.md` was taken through `bin/dokuha.mjs`.
- **A shared accumulator updated with `await` inside a compound assignment loses
  every concurrent worker's contribution but the last.** `bytes += (await
  fsp.stat(f)).size` reads `bytes` *before* the await suspends, so with twelve
  workers a resumed Kindle volume reported 4 MB instead of 44 MB, differently on
  every run. The awaited value is now captured into a local first. The one other
  occurrence of the pattern, in the BookWalker output measurement, is sequential and
  was already correct.
- **A Kindle volume fetched without cookies is no longer reported as a series page.**
  Amazon answers 200 either way and strips the reading token, so the two look
  identical; the series endpoint is now asked which one it is, and a missing session
  is named as a missing session.

- **`--zip` writes a BookWalker volume as one archive.** Pages are now written as
  individual files by default, because a directory of pages can be inspected,
  resumed and handed to something other than the tool that made it, while a zip can
  only be opened whole. The pages path can also skip what a previous run already
  wrote, so re-running a partly-failed volume no longer re-downloads it.
- **ebookjapan pages are descrambled.** The CDN serves each page as a shuffled tile
  mosaic; the pages now come out readable. The shuffle has no published table, so
  the viewer's own WASM module is asked for the draw calls it would make and those
  are replayed with `sharp` (rotate/`setTransform`/`drawImage`, replayed as an
  affine transform, not a flat crop). This works for any title rather than only the
  ones that were reverse engineered by hand. On by default when `sharp` is
  installed; `--descramble` makes `sharp` mandatory, `--no-descramble` keeps the
  mosaic. Costs about 120 ms of CPU per page, so ebookjapan is now CPU-bound at
  roughly 25 pages/s regardless of `--parallel`.
- `--series` reads every positional URL as an entry point into a whole series and
  downloads only the volumes that are free to read in full. Series pages
  (`cmoa.jp/title/<id>/`, `ebookjapan.yahoo.co.jp/books/<title>/`,
  `bookwalker.jp/series/<id>/`) and individual volumes of a series both work, and
  any mix of the three stores can be given in one run. A free preview is not a free
  volume, so trial-only volumes are skipped.

Fixed:

- **ebookjapan was re-encoding a lossy source losslessly.** The store serves
  *lossy* VP8 WebP; the descrambler wrote *lossless* VP8L, which preserves the
  source's compression artefacts exactly and costs about five times the size and
  fifty times the CPU. It now encodes lossily, and to JPEG by default so that the
  pages match the other four stores. Measured on one 244-page volume: **28.5 s to
  8.5 s**, `rebuild` from 522 s to 102 s of worker time, and ~1135 KiB per page down
  to ~838 KiB. `--format webp` keeps the store's own codec (351 KiB, 130 ms); the
  scrambled pages written by `--no-descramble` are still WebP because they are the
  store's bytes.
- **The CDN will not serve JPEG.** `Accept: image/jpeg`, `image/png` and `*/*` all
  return WebP, and a `.jpg` suffix returns 403 — the `.jpg` in the manifest's `name`
  field is not real. The manifest's `imageTypes` advertises variants that are not
  served, so the format is ours to choose and there is no cheaper source to fetch.
- **k-manga spent one attempt of the retry budget and then failed the volume.**
  A drain that left work outstanding forced the loop to exit (`attempt = attempts`),
  so the check after it failed the whole volume without ever using the retries the
  budget exists for. It now goes round again.
- **k-manga's handshake was under-reported.** The index fetch ran outside the timed
  block, so `--json` never showed it. Session and index are now one `handshake`.
- **k-manga re-read the header reply on every retry.** The reply carries the page
  list and the session's decrypt key; the key is bound to the ticket, which is minted
  once per volume, so a retry now reuses the reply instead of spending another round
  trip. It is deliberately *not* cached across volumes, where a new session means a
  new ticket and therefore a new key.

Changed:

- **Kindle's window walk fetches ahead instead of one window at a time.** The walk is
  a cursor whose next offset depends on the view count of the window it just read, so
  it could not simply be parallelised. It turned out the view count comes back equal to
  the requested batch in every window, which makes the next offsets predictable, so the
  walk now speculates three windows ahead and consumes a reply only when its offset is
  the one the cursor actually wants. Speculative calls run against a copy of the walk's
  state, so a discarded request cannot leave a shrunk batch or a flipped content type
  behind. On a two-volume run: **31.6 s to 21.3 s**, with the walk's own share falling
  from 35.6 s to 15.1 s, and all 464 pages byte-identical to the sequential walk.
- **CMOA's pages are rebuilt by libvips instead of the JavaScript codec.** Decoding
  and encoding a 1350x1920 page took 128 ms and 68 ms in hand-written JavaScript;
  libvips does the same work in 8 ms and 15 ms. `rebuild` fell from 341 ms to **30 ms
  per page** and a 244-page volume from 9.08 s to **2.83 s**. Nothing about the
  descrambling changed — the tile scatter still runs in JavaScript, because the tiles
  sit at arbitrary offsets that no compressed-domain move can express — only the codec
  around it. Output is not byte-identical (mean absolute pixel difference 1.00/255,
  from libvips' own quantisation and chroma upsampling) and the files are slightly
  smaller. The vendored engine keeps its pure-JavaScript codec as a fallback and uses
  it automatically wherever `sharp` is not installed, so the engine still runs
  standalone.

Added:

- **CMOA says where its time goes.** `--json` now carries a real `rebuild` figure for
  CMOA (previously the engine owned the loop and only `fetch` was visible), split into
  `fetch`, `rebuild` and `write` per page, plus a `rebuilt` count saying how many pages
  actually had to be reassembled. The engine also skips a full JPEG decode when the
  coordinate tables show that a page needs no reassembly — same bytes, less work.
- **`--jpeg-quality N` for CMOA**, which the engine always supported and the CLI never
  exposed; pages were silently re-encoded at 92. Dropping to 45 cuts files about 2.5x
  (580 to 235 KiB) for a 2% time saving, so it is a size knob, not a speed one.

Changed:

- **`--parallel` no longer defaults to "all of them, up to 16".** Starting every
  volume at once was measured worse than running them one at a time (219 s against
  190 s on a mixed ten-volume batch), so the default is now bounded by the core
  count — three on a 14-core machine. An explicit `--parallel` is unchanged.
- **k-manga's pipeline default is 16, not 8.** The store is slower past ~16, so 16
  is the shoulder; the flag and its cap are unchanged.
- **`--json` has one shape for every store.** A result now always carries
  `store, id, title, folder, sample, totalPages, downloaded, skipped, failed,
  bytes, failures`, with a stable type each, assembled by `normalizeStoreResult`.
  Store-specific fields (`route`, `mode`, `seriesAsin`, `walkedPages`, …) are still
  there beside them, so nothing is lost — but a consumer no longer has to
  feature-test per store. `sample` is the field that made the case: CMOA, ebookjapan
  and k-manga all have samplers and only Kindle reported it.
- **Every result carries a phase breakdown.** `phases` records milliseconds for
  `handshake`, `fetch`, `rebuild` and `write`, which makes the audit's timing table
  reproducible with `npm run bench:phases` instead of a throwaway harness. The four
  phases do not all mean the same thing — a concurrent one is an aggregate across
  its workers, and a store that cannot measure a phase leaves it out rather than
  guessing. See `docs/phase-timing.md`.
- **One retry policy.** `src/retry.js` holds the backoff, the retryable statuses
  and `describeError`, which unwraps undici's `error.cause` so a connection reset
  stops being reported as a bare "fetch failed". Kindle's control-plane loop now
  uses it; the vendored engines keep their own loops, for the reason recorded in
  `vendor/README.md`.
- **The CPU budget is one allocation instead of three.** `src/cpu-budget.js`
  decides how many worker threads each CPU-heavy store may run, from the cores
  available and the stores actually in flight. Previously CMOA and BookWalker each
  sized themselves against the core count alone, so the two together could claim the
  whole machine twice and leave nothing for the other. Capping ebookjapan's
  descrambling the same way was tried and **removed**: measured over three runs each,
  it cost 30 % of wall time (37.0 s against 28.5 s), because libvips already threads
  internally and an outer queue only adds latency. The numbers are in
  `docs/phase-timing.md`.
- **`src/display.js` is split.** `src/ansi.js` holds the width, truncation and
  colour helpers; `src/live-progress.js` holds the block. Nothing else changed.
- **The project is `dokuha-cli`, and the command is `dokuha`.** 読破 (*dokuha*) is to
  read a work through to the end. `bin/manga-dl.mjs` became `bin/dokuha.mjs`, the
  package and repository are `dokuha-cli`, and `--version` prints `読破 dokuha <ver>`.
  The live-test opt-in moved with it: `MANGA_DL_TEST_NETWORK` is now
  `DOKUHA_TEST_NETWORK`. On-disk state deliberately did **not** move — the
  `~/.bwdd-cli/` cache and `free-session.json` / `kindle-session.json` keep their
  names, so an existing cache and a signed-in session survive the rename.
- **Volume folders are named after the volume title, not the content id.**
  `--title-dir` is now the default and `--no-title-dir` restores the old
  `<out>/<cid>` behaviour. A folder called `0000214001_jp_0001` tells a reader
  nothing. CMOA and BookWalker now also leave a `metadata.json` naming the volume,
  which every store's folder carries; ebookjapan already did. That marker is what
  keeps two volumes that clean up to the same title apart -- without it they would
  write the same page filenames into one directory and silently overwrite each
  other. An unmarked folder is treated as the current volume's own, so an
  interrupted download still resumes in place.
- **BookWalker no longer stages every volume through one shared `<out>/pending`.**
  The folder used to be created under a provisional name before the handshake
  resolved the title, and that name was the same directory for every volume in the
  batch; concurrent volumes could each rename it out from under the others. The
  folder is now chosen after the handshake, which is when the title is known, and
  no staging is needed at all.
- **BookWalker byte counts are measured from what was written.** `outputPath` is a
  directory now, and `stat` on a directory returns the directory's own size, so a
  finished 214-page volume reported "7 KiB". Pages are summed instead, which also
  counts pages reused from a previous run.
- **A BookWalker free volume is no longer downloaded twice when its two editions
  spell the volume number differently.** `--series` collapses the duplicate free
  editions of one volume by the number in the title, but only recognised `（3）` and
  `第3巻`. An edition labelled `3巻` therefore never collapsed against its `（3）`
  twin, so a four-volume free set that was really three volumes downloaded volume
  one twice. All three spellings now parse, with `全5巻` excluded because a
  complete-set listing is not a volume number.
- **BookWalker archives are named after the volume, not the content id.** The
  sampler derives the archive name from its own `session.cti` and falls back to
  `book_<uuid>.zip`, so any volume whose handshake does not echo a content title
  produced a uuid-named zip. The adapter already resolved the real title (and now
  also falls back to the volume title read from the store's list page), so it is
  passed through. This also gives mokuro a real volume title instead of a uuid.
- **The batch progress bar moves on pages, not finished volumes.** It was drawn
  from `completed / known`, where `completed` counts only pages in *finished*
  volumes, so on a long batch the bar sat still and then jumped. It now takes the
  larger of pages-arrived and pages-in-finished-volumes, which moves continuously
  and still reaches the end even when a finished volume had a failed page. The
  percentage beside the bar is derived from the same number, so the two cannot
  disagree.
- **Every volume is shown in the progress block, not the first ten.** The row cap
  was a fixed ten, so a twelve-volume batch hid its tail behind "… N more" even on
  a tall terminal. The default is now the terminal height, and `c` toggles a
  compact view. The cap cannot be removed entirely: the block is redrawn in place
  by walking the cursor back over it, and rows scrolled off the top cannot be
  addressed.
- **`--table FILE` was removed.** It selected a scramble table for the old
  descrambler. The table is no longer needed, and the flag was never read by the
  driver in the first place, so removing it cannot break a working script.
- **`--descramble`, `--pdf` and `--flat` never reached the adapter.** They were
  declared, documented and read on the adapter side, but `run.js` never put them in
  the context, so all of them were silent no-ops. All three are now wired. `--flat`
  is additionally refused for a batch of more than one volume, because every store
  numbers its pages from one inside each volume and a flat run would therefore have
  each volume overwrite the last.
- **`--series N` was renamed to `--parallel N`.** The old name now means the new
  series expansion above, so a script that passed `--series 4` to cap concurrency
  must be updated. The JSON summary's concurrency field is renamed from `series`
  to `parallel` for the same reason.
- A series page given *without* `--series` is now reported as such instead of being
  handed to the volume engine and failing with "no pages found".

## v0.0.1

First release, and an early one. A browserless CLI that drives three store engines
vendored in-tree.

This is a 0.0.x on purpose: it is verified against a small number of volumes, it has
no store-aware retry strategy, and the stores can change their viewers at any time.
The README lists the known limitations. Start with a single volume before pointing it
at a queue.

Added:

- `dokuha URL...` downloads CMOA, ebookjapan and BookWalker volumes in parallel,
  detecting the store from the URL. CMOA title pages expand to their volumes.
- `--mokuro` pushes volumes through mokuro-bridge for OCR, then finalizes them to a
  chosen destination.
- Live progress with one row per volume, colour-coded by phase, and a summary bar.
  Finished volumes keep their row.
- `--json` for a machine-readable summary, and `--dry-run` to list what would happen.
- BookWalker sessions via `--bw-cookie`, which accepts a Cookie header, a
  `Copy as cURL` command, `@FILE`, a path, or `-`. Repeatable and merged.

Notes:

- `sharp` is an optional dependency. Only BookWalker needs it, because its public
  pages are encrypted; its absence produces an actionable error rather than a
  per-page decode failure.
- Browserless by policy: no Puppeteer, no Chrome, no browser profile. The capture
  route in the vendored sampler is stubbed out.
