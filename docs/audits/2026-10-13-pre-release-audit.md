# dokuha 1.0: pre-release audit (second pass)

_Historical snapshot, measured 2026-10-13. This is an archived working audit, not current documentation. The release blockers it records were fixed in the working tree of that day, and the status section at the end says so; the still-true engineering findings are summarised in [../architecture.md](../architecture.md)._

Read as a first-time user of the CLI, then as a maintainer of the tree. Measured 2026-10-13 against `8d607f4` plus the uncommitted working tree (16 files, +1117/−130, one untracked file `src/download/existing-volume.js`).

This is a *second* pass. [2026-09-30-five-store-audit.md](2026-09-30-five-store-audit.md) records the first (v0.0.9). Where a prior finding is still live it is marked **UNFIXED**; everything else is **NEW**.

**How to read the evidence.** `ran:` means the command was executed and its output observed. `read:` means the conclusion comes from reading the code and is not runtime-verified. Nothing here was fixed; the working tree is untouched.

## Verdict

The architecture is genuinely good, one platform registry, one result contract, one retry policy, a measured two-stage scheduler, and a 26-file hermetic suite that `npm test` actually runs. It is *not* release-ready yet, for three reasons that compound:

1. **The tree is red.** `npm test` fails 4 checks, all in the Kindle resume path.
2. **Detection can hand one store's URL to another store's adapter.** A Kindle pattern is tested first and is not anchored, so a store URL carrying another store's link in a query parameter is misrouted.
3. **The Kindle `--series` contract is broken at the registry seam.** The adapter receives the URL where it expects a config object, so `--kindle-cookie` is dropped on that path.

Plus the user-facing surface is larger than it needs to be: 52 options, two of them dead, one that always errors, several aliases, and a handful of wrong indicators on screen and in `--json`.

---

## 0. Release blockers

### 0.1 `npm test` is red: 4 Kindle resume checks, **NEW**

```
ran: npm test
FAIL  test_kindle_adapter.mjs
  FAIL  a resumed run reports the same byte total            (got 0, want 75000)
  FAIL  a truncated page is re-fetched, not trusted          (downloaded=0 skipped=3)
  FAIL  the repaired page is the real page again
  FAIL  the repaired run reports the full total again        (got 0, want 75000)
4 check(s) failed, 114 passed
```

`tests/run.mjs:84` exits 1 on failure, and `.github/workflows/test.yml:30` runs `npm test` on push, so this is a red build, not a silent one.

**Cause (read + ran).** The untracked `src/download/existing-volume.js` is called *ahead of* the adapter's page loop:

- `src/download/kindle.js:681`, `const existing = await existingVolume(...)`, then `if (existing) return existing;`, this is the entire +6-line diff to that file.
- `existing-volume.js:70-72` decides a folder is complete by counting files whose extension is in `IMAGE_EXTENSIONS` and comparing to `expectedPages`.
- `existing-volume.js:73-85` returns `skipped: expected` and `bytes: 0` (`:82`).

So a truncated `page-0002.jpg` (4 bytes, still a `.jpg`) makes the count match and the whole volume is declared complete. That bypasses the adapter's own integrity check, `kindle.js:817 isCompleteJpeg`, and the per-page byte accounting at `kindle.js:819-830` that the test asserts. This is also a data-integrity bug, not just a test bug: a corrupt page survives a resume on every store that uses this gate, and a fully-skipped rerun now reports **0 bytes**.

The gate is also applied twice per volume: once at `src/run.js:142`, and again inside all five adapters (`bookwalker.js:178`, `cmoa.js:119`, `ebookjapan.js:168`, `kindle.js:681`, `kmanga.js:540`). The two layers disagree on `checkRemote` (`run.js:147` uses `Boolean(ctx.bridge && task.title)`; the adapters use `!task.title`).

### 0.2 Detection misroutes URLs across stores: **NEW, verified**

`src/platforms/index.js:49-53` tests `PLATFORMS` in order `[kindle, cmoa, ebookjapan, bookwalker, kmanga]` (`:23`) and every non-bare pattern is an unanchored substring match. Consequences:

```
ran: node --input-type=module -e "import {detectSource} …"
https://ebookjapan.yahoo.co.jp/books/621001/A009000007/?ref=https://www.amazon.co.jp/dp/B0CKM9VJZ1
  -> kindle  B0CKM9VJZ1
https://bookwalker.jp/de<uuid>/?from=https://www.amazon.co.jp/dp/B0CKM9VJZ1
  -> kindle  B0CKM9VJZ1
https://www.cmoa.jp/bib/speedreader/?cid=0000249001_jp_0001&rurl=https://www.amazon.co.jp/dp/B0CKM9VJZ1
  -> kindle  B0CKM9VJZ1
https://comic.k-manga.jp/title/12345/vol/3/?ref=https://www.cmoa.jp/title/999/
  -> cmoa-title  999
```

Worse for a bare code: Kindle's `^B0[0-9A-Z]{8}$` (`kindle.js:1275`) is tested before ebookjapan's `^(B\d{6,})$` (`ebookjapan.js:449`), so a legitimate 10-character ebookjapan reading code beginning `B0` is claimed as a Kindle ASIN:

```
ran: detectSource('B090000001')  ->  { kind: 'kindle', asin: 'B090000001' }
```

**Minimal fix:** in `detectSource`, for an absolute URL parse `new URL(raw).hostname` and only test the platform that owns that host; at minimum anchor every non-bare pattern to its own host (`kindle.js:1273-1274`, `cmoa.js:238-243`, `ebookjapan.js:443-447`, `bookwalker.js:441/456`, `kmanga.js:742-746`).

### 0.3 Kindle `--series` receives the wrong second argument: **NEW, verified**

The registry calls `platform.series(det, input, ctx)` (`platforms/index.js:100`), but Kindle declares `resolveKindleSeries(det, config = {}, io = {})` (`kindle.js:1081`). So `config` is the raw URL string and `io.session` is never set (`run.js:55` passes `kindleSession`, not `session`). Indoors:

- `kindle.js:1083`, `const session = io.session || await loadKindleSession(config)` → `loadKindleSession(<URL string>)`, where `config.kindleCookies` (`kindle.js:87`) and `config.kindleNoState` (`kindle.js:80`) are `undefined`.
- Result: `--kindle-cookie` supplied on the command line is **ignored** on the `--series` path; only a previously saved state file is honoured. `--no-state` is ignored too.

The unit tests pass because they call the function in its *declared* order (`tests/test_kindle_adapter.mjs:680`, `:709`, `:733`), so the mismatch is invisible at the seam nobody tests. Likely fix: `series: (det, input, ctx) => resolveKindleSeries(det, ctx.config || {}, { ...ctx, session: ctx.kindleSession })`.

---

## 1. Are all downloaders and descramblers properly connected?

**Yes, every store's descramble/decrypt step is imported and called on the real path.** This was traced store by store and verified by import graph:

| store | detection | descramble / decrypt | reached on the real path? | output |
|---|---|---|---|---|
| Kindle | `kindle.js:1272-1276` | `kindle-protocol.js:289 kindleDecodePage` (AES-128-GCM `:279`) | yes, imported `kindle.js:20`, called `kindle.js:779` | `kindle.js:829` |
| CMOA | `cmoa.js:237-246` | `vendor/cmoa/src/descrambler.js compileDescrambler` | yes, `codec.js:14` ← `downloader.js:23` ← `cmoa.js:136` | `cmoa.js:171-184` |
| ebookjapan | `ebookjapan.js:442-459` | `src/download/ebj-descramble.js:167 composePage` | yes, imported `ebookjapan.js:7`, called `:256`/`:315` | `ebookjapan.js:260` |
| BookWalker | `bookwalker.js:455-460` | `vendor/bookwalker/bw-crypto.js descramblePage` | yes, worker `bw-normalize-worker.js:7` ← pool `:18` ← `bookwalker.js:212/217` | `bookwalker.js:276` |
| k-manga | `kmanga.js:741-748` | `kmanga-protocol.js:127/140` → `descrambleJpeg` | yes, imported `kmanga.js:12-25`, called `:729` | `kmanga.js:629` |

All five adapters import the same "already present" gate (`existing-volume.js`) and register a `platform` descriptor in `PLATFORMS`. No adapter is unreachable, and every `kind` except ebookjapan's intentional `unknown` maps to a platform whose `download` is a function.

Two descrambler modules are **not** on dokuha's path:

- `vendor/ebookjapan/descramble.mjs`, a standalone CLI with no exports; reached only from `vendor/ebookjapan/download.mjs:518` (its own CLI main). dokuha uses `ebj-descramble.js` instead, so this is vendored-but-unused by the product.
- `vendor/cmoa/src/descrambler.js` and `vendor/bookwalker/bw-crypto.js` are live (above). `src/download/ebj-descramble.js` and `kmanga-protocol.js` are live.

### 1.1 Per-store resume behaviour is inconsistent: **NEW, read**

The new whole-volume gate skips only when the file *count* matches. Where a page is validated at all, the validators differ:

| store | per-page reuse test |
|---|---|
| Kindle | `kindle.js:817` `isCompleteJpeg` (SOI/EOI check) |
| ebookjapan | `ebookjapan.js:237` `isCompleteImage` |
| k-manga | `kmanga.js:566`, **existence only** |
| CMOA | `vendor/cmoa/src/downloader.js:277`, `existsSync` |
| BookWalker | `vendor/bookwalker/public-trial.js:531`, `size > 0` |

So the same truncated page is re-fetched on Kindle/ebookjapan and silently kept on k-manga/CMOA/BookWalker. k-manga is the one in dokuha's own tree and is worth fixing directly.

### 1.2 BookWalker's gate is missing `expectedPages`: **NEW, read**

`bookwalker.js:178-181` omits the `expectedPages` argument that the other four adapters pass. In the remote/bridge branch (`existing-volume.js:22-24`) that yields `totalPages: 0`, so `run.js:782-789` prints **0 pages** for a skipped BookWalker volume. (`existingVolume`'s local branch recovers the count from the marker at `existing-volume.js:47`, so only the remote branch is affected.)

### 1.3 `--force` never reaches the BookWalker page loop: **NEW, read**

`grep -n force src/download/bookwalker.js` → **no matches**. The volume-level gate honours `ctx.force` (`existing-volume.js:40`), but the vendored sampler reuses any existing page whenever `options.force` is falsy (`public-trial.js:531`). So `--force` on BookWalker restarts the volume and then keeps every old page.

### 1.4 Resume results bypass the one result contract: **NEW, read + ran**

`RESULT_CORE` (`store-result.js:7-10`) promises `store, id, title, folder, sample, totalPages, downloaded, skipped, failed, bytes, failures` on **every** result. Two paths skip `normalizeStoreResult` (`run.js:160`):

- `run.js:150-157`, the skipped-volume result from `existingVolume`, whose return objects (`existing-volume.js:17-33, 56-68, 73-85`) **never include `sample`**.
- `run.js:167`, the Kindle-Unlimited-skip path sets `record.skipped = true`, a **boolean**, while `store-result.js:21` defines `skipped` as a count. A `--json` consumer doing arithmetic on `skipped` gets `true`.

So `docs/architecture.md:134-138`'s "always present, whatever the store" is not currently true.

### 1.5 The ebookjapan socket ceiling is secretly dokuha's `--concurrency`: **NEW, read**

`src/download/ebookjapan.js:5` imports `fetchWithRetry` from `vendor/ebookjapan/download.mjs`. That module parses **`process.argv`** at module scope (`download.mjs:45-96`) and builds its shared keep-alive agent with `maxSockets: CONCURRENCY` (`download.mjs:114-115`), where `CONCURRENCY = Number(opt('--concurrency', 48))`.

Consequences: the ebookjapan page-fetch ceiling is set by dokuha's `--concurrency` and **not** by `--eb-concurrency`; and `--force`, `--json`, `--quiet`, `--flat`, `--descramble`, `--mokuro`, `--overwrite`, `--series` all flip module-scope booleans/strings inside the vendored CLI. `docs/architecture.md:226-230` documents the symptom as a known limit, but the right fix for 1.0 is to stop importing a CLI module for one helper, extract `httpsGet`/`fetchWithRetry` (and an agent factory) into a small module with no `argv` parsing at import time.

---

## 2. Wrong or misleading UI indicators

### 2.1 `FORCE_COLOR=0` turns colour **on**; `NO_COLOR` beats `FORCE_COLOR`

`ran:` `src/ansi.js:16-20`

```
env -u NO_COLOR FORCE_COLOR=0 node … useColor({isTTY:false})  ->  true
env NO_COLOR=1 FORCE_COLOR=1  node … useColor({isTTY:false})  ->  false
```

`if (process.env.FORCE_COLOR) return true` treats the string `'0'` as truthy, so the documented way to *disable* colour forces it on for a piped run. And because `NO_COLOR` is checked first, `FORCE_COLOR=1` cannot override it, Node itself warns that `NO_COLOR` should be ignored when `FORCE_COLOR` is set. Fix: parse `FORCE_COLOR` as `'0'`/`'false'` → off, and give `FORCE_COLOR` precedence.

### 2.2 A skipped rerun reports 0 bytes and 0 pages: **NEW, ran**

`summary.bytes` (`run.js:763`) and `summary.pages` (`run.js:762`) sum only `downloaded`/`bytes` from the record. The skipped-volume record carries `bytes: 0, downloaded: 0` (`existing-volume.js:79-82`), so:

```
ran: npm test  →  "a resumed run reports the same byte total (got 0, want 75000)"
```

and the non-TTY line `run.js:789` reports `N/N volumes, 0 pages`. A no-op rerun of a complete library now looks like it downloaded nothing and, for the byte figure, that nothing exists. The old Kindle path summed on-disk sizes (`kindle.js:819-820`); the new gate throws that away.

### 2.3 Colour is lost in the footer's phase breakdown

`phaseBreakdown()` (`live-progress.js:498-505`) calls `this.meterColor(phase)` without the volume, but `meterColor` now branches on `volume?.uploadFile` (`live-progress.js:280`). Every `finalizing` count is therefore painted `cyan` in the footer regardless of the volume's real stage.

### 2.4 An ebookjapan homepage is displayed as a downloadable volume: **NEW, ran**

`ebookjapan.js:447`'s catch-all `/ebookjapan\.yahoo\.co\.jp/i` claims any URL on the host. `ran:`

```
node bin/dokuha.mjs --dry-run 'https://ebookjapan.yahoo.co.jp/'        ->  "ebookjapan  https://ebookjapan.yahoo.co.jp/"   exit 0
node bin/dokuha.mjs --dry-run 'https://ebookjapan.yahoo.co.jp/mypage/' ->  "ebookjapan  https://ebookjapan.yahoo.co.jp/mypage/" exit 0
```

with no volume id. A real run hands the adapter a `det` with neither `code` nor `publication`. The catch-all should be dropped; the specific patterns above it already cover the real `/books/…` and `/viewer/…` forms.

### 2.5 `plainLine` prints a red ✗ for any non-`done` phase

`live-progress.js:600` selects the mark purely on `phase === 'done'`. It is only reached from `finish()` (`:166`), where the phase has already been set to `done`/`error`, so it is currently correct, but the guard is one refactor away from printing a red cross for a succeeded volume. Prefer `error ? '✗' : '✓'`.

### 2.6 `overallColor` failure semantics are now correct: good

`live-progress.js:349` returns `'red'` when any volume failed and the batch is finished. The first audit's §4.4 bug is fixed; the footer also counts only `finished` (`totals()` `:341`). Worth keeping a regression test.

---

## 3. The flag surface: what to cut

There are **52 options** in `src/options.js` (51 visible in `--help`, plus the hidden `--title-dir`). That is the number the owner asked to reduce, and `README.md:46`'s "Almost nothing to configure" does not survive contact with `--help`.

### 3.1 Remove outright (no consumer, or a consumer that always refuses)

| flag | why | evidence |
|---|---|---|
| `--title-dir` | parsed, never changes behaviour (titles are already the default) | `options.js:49,160`; hidden `help.js:19` |
| `--kindle-max-volumes` | parsed into config, **read nowhere** | `options.js:200`; `grep -rn kindleMaxVolumes src vendor` → nothing |
| `--bw-login` | always exits 2 before doing anything | `bin/dokuha.mjs:37-43` |
| `--local-dir` | exact alias of `--dest local --dest-folder DIR` | `options.js:206`, `run.js:214` |

### 3.2 Merge

| today | proposed |
|---|---|
| `--force` and `--overwrite` | one flag; today `--overwrite` is read only by the bridge path (`run.js:222,241`) and `existing-volume.js:12`, while its help text promises "replace an existing file at the destination", which is not implemented |
| `--quiet` and `--no-progress` | one flag; `--no-progress` is read once (`run.js:320`) |
| `--descramble` / `--no-descramble` | keep one tri-state; today `--descramble` wins over `--no-descramble` **regardless of order** (`ran`: both orders → `true`, `options.js:185`) |
| `--concurrency` | fold into the per-store flags' docs; it exists only as a shared fallback (`options.js:148,172-176`) |

### 3.3 Re-file

`--format` is under **CMOA** but also drives ebookjapan (`ebookjapan.js:195`); `--descramble` is under **ebookjapan** but also applies to k-manga (`kmanga.js:548`); `--no-state` is under **BookWalker auth** but also configures Kindle (`kindle.js:80`). Groups should name a capability, not one store.

### 3.4 A proposed default surface (12 flags)

Keep prominent: `URL...`, `--out`, `--series`, `--download-samplers`, `--dry-run`, `--mokuro`, `--force`, `--json`, `--quiet`, `--parallel`, `--bw-cookie`, `--kindle-cookie`. Move everything else to an "Advanced" section of `--help`. The README's Options section is one line and a `--help` pointer (`README.md:119-126`); adding a 6-line quick-start flag list there would help a first-time user more than the current deferral.

### 3.5 Run UX defects (all executed locally, no network)

```
ran: node bin/dokuha.mjs --dry-run 'not a url'   -> exit 0   (non-dry run: exit 2)
ran: node bin/dokuha.mjs --out                   -> "Option '-o, --out <value>' argument missing"
ran: node bin/dokuha.mjs --seres                 -> "unknown option '--seres'"   (no "did you mean")
ran: node bin/dokuha.mjs --dry-run --jpeg-quality 500 'nope'   -> accepted, exit 0
ran: node bin/dokuha.mjs --dry-run --km-concurrency 999 'nope' -> accepted, exit 0
```

- `--dry-run` with nothing supported exits **0** while the same run without `--dry-run` exits 2 (`run.js:377-389`). Exit codes should not depend on a dry run.
- The missing-value message leaks Node's raw wording (`argument missing`), which `explainParseError` (`options.js:121-137`) does not match.
- `--jpeg-quality` is documented 1-100 and `--km-concurrency` 1-32; `toInt` only enforces a minimum.
- No near-miss suggestion for a typo.
- Minor: a bad URL still triggers a localhost bridge probe in resume-only mode (`ran:` `dokuha 'bad url'` prints `bridge http://127.0.0.1:62642 …`), so the first line of a failed run can be bridge noise unrelated to the error.

---

## 4. Code quality and readability

### 4.1 What is good

- Comment volume is down from the 35 % measured in [2026-09-30-five-store-audit.md](2026-09-30-five-store-audit.md) to **7 %** in `src/` (measured; `src/` = 6 659 code lines, 479 comment lines, 966 blank).
- The platform registry, `store-result.js`, `retry.js`, `cpu-budget.js`, `phase-timer.js` and `page-files.js` are small, single-purpose modules.
- `npm test` is hermetic and wired into push CI (`.github/workflows/test.yml:4-33`).

### 4.2 Dead code

- `src/detect.js`, a 15-line re-export shim with **no production importer** (`grep`: only `tests/test_detect.mjs:9`, `tests/test_series.mjs:17`; `run.js:6-12` imports `platforms/index.js` directly). Its own comment (`:5`) claims the rest of the code imports it by that name; nothing does.
- `platforms/index.js:32 STORE_LABELS` and `:66 canExpandSeries`, no `src` caller (`run.js` uses `platformFor(...).label` and `platform.expand` instead).
- `kmanga.js:35 kmangaVolumeUrl`, `kindle-protocol.js:390 kindlePageResolution`, single-occurrence symbols.
- `kindle-protocol.js:8,23` `kindleStoreSeriesList` / `kindleStoreSeriesUrl`, dead, and `docs/parallelism.md:124-126` already admits it.

### 4.3 Duplication

- The "already downloaded" gate is implemented twice per run (§0.1).
- `task.key` is constructed in five places (`run.js:32`, `run.js:326`, `ebookjapan.js:121`, `kindle.js:633`, `kmanga.js:462`).
- Progress emission has three shapes: direct `progress.update` (`bookwalker.js:321`), a `tell(progress, …)` helper (`ebookjapan.js:96`), and per-adapter local `tell` closures (`kindle.js:672`, `kmanga.js:461`).
- `ebookjapan.js:252-260` vs `:312-319` are the same fetch→compose→write block, and the two worker pools at `:227-272` / `:310-330` are two implementations of one job.
- Legacy-name adoption is implemented twice (`page-files.js:40` and `:62`).

### 4.4 Size and depth

`ran:` brace-matching scan of `src/`:

| function | length |
|---|---|
| `run.js:281 run()` | **513 lines** |
| `ebookjapan.js:117 downloadEbookjapan` | 273 |
| `kmanga.js:459 downloadKmanga` | 245 |
| `kindle.js:663 downloadOpenedKindle` | 229 |
| `kindle.js:1081 resolveKindleSeries` | 177 |
| `bridge.js:453 resumeExistingSession` | 153 |
| `bookwalker.js:164 downloadBookwalker` | 138 |
| `bridge.js:345 pushToBridge` | 107 |

Files over 700 lines: `kindle.js` 1285, `run.js` 793, `kmanga.js` 754, `bridge.js` 716. `run()` at 513 lines is the single biggest obstacle to reading the driver; it mixes build, lanes, the CPU budget, the bridge queue, the unlimited scheduler and the summary.

### 4.5 The uncommitted bridge feature (highest-risk new code)

`src/bridge.js` (+408) adds "resume an existing bridge session". It is careful, it confirms duplicates through `/sessions` before skipping, and writes a completion marker atomically (`bridge.js:696-700`). Three problems:

1. **An unbounded wait.** `resumeExistingSession` polls forever (`bridge.js:485` `for (;;) { … await sleep(1000) }`) with no deadline, and the 409 "page is currently being OCR'd" branch in `ingestFolder` does the same (`bridge.js:322-345`). A bridge that stalls mid-ingest hangs the volume with no timeout; `ctx.ocrWaitMs` is honoured by `finalizeWithProgress` but not by these loops.
2. **Costly resume.** `pageHashes()` (`bridge.js:668-675`) reads **every page file in full**, sequentially, to re-verify a completion marker. On a 500 MB volume every subsequent run reads all 500 MB before deciding to skip, the opposite of what "resume" should cost.
3. **Dead/unreachable code and duplicated literals.** `bridge.js:484` `if (latest.finalized) continue;` is unreachable (the same condition returns at `:479`). The `return { alreadyHandled: true, … }` after each inspect-catch is unreachable because `inspectExistingSession` always returns truthy or throws into the catch. The same bridge conflict message is matched by two different regexes (`bridge.js:52-53` and `:267-269`). And 15-field result literals are repeated five times.

### 4.6 Source-grepping tests: **UNFIXED**

`CHANGELOG.md` (v0.0.9 *Notes*) and `docs/architecture.md:207` both state that the wiring tests "were replaced with behavioural ones". They were not:

- `tests/test_wiring.mjs:22` reads `run.js` as text and asserts regexes, e.g. `:33 /retries:\s*config\.retries/`, `:45` an exact expression from `bookwalker.js`, `:55-62` the literal concurrency assignments.
- `tests/test_serial.mjs:96-125` greps `ebookjapan.js` source.
- `tests/test_modules.mjs:65-75` greps call/import text.

These pass for a broken program and fail on a correct refactor, and they are the reason the new bug in §0.3 was invisible: the suite asserts the *text* of the seam instead of running it. This is the single most valuable cleanup for 1.0, it unlocks every other refactor.

### 4.7 Adapter contract still has ad-hoc edges

`platform` is uniform, but the fields are not: `resolve` only in CMOA/k-manga, `session` only in Kindle, `workerKey` only in CMOA/BookWalker, and `expand` is a kind predicate in CMOA/k-manga but `() => false` elsewhere. `run.js` still reaches past the registry (`run.js:19-21` imports `bookwalkerPlatform`/`kindlePlatform`/ `prewarmBookwalker`; `:298/:344` call `kindlePlatform.session.*`; `:64` takes Kindle out of the parallel resolve; `:354` branches on `det.kind !== 'bookwalker'`). `docs/architecture.md:33-56` and `src/platforms/index.js:7` claim "not teaching the driver a new branch", still aspirational.

---

## 5. Tests and docs

- **Coverage gaps (read):** nothing imports `src/help.js`, `src/user-agent.js`, `src/download/existing-volume.js`, or `src/platforms/index.js` at its public surface; `src/download/bookwalker.js` is exercised only by the network-gated `test_network.mjs`. The two newest modules, `existing-volume.js` and the registry, are the least tested in the tree, which is exactly backwards.
- **Counts:** `npm test` discovers 26 files; `README.md:146` and `docs/architecture.md:202` say 26. Correct.
- **Stale claims to fix:**
- `docs/architecture.md:207` and `CHANGELOG.md` v0.0.9, source-grepping tests are gone (they are not).
- `docs/architecture.md:142` presents `src/detect.js` as part of the design; it has no production importer.
- `docs/architecture.md:90-95` says a matching bridge session is resumed and finalized; for a volume whose pages are already on disk the new `existingDestination` early-return (`run.js:161`, `run.js:201`) skips the resume-only branch entirely, so in `--no-mokuro` resume mode a completed local volume never picks its live bridge session back up. **This is a logic gap worth a decision, not just a doc edit (read, not runtime-verified).**
- `existing-volume.js:37-39` says interrupted folders stay resumable while `:72` only counts files.
- `README.md:94` ("`page-0001.jpg` on every store") is true by default, but ebookjapan can still emit `.webp` when `--format webp` is combined with descrambling (`ebookjapan.js:195-196`); the sentence should say "by default".

---

## 6. Recommended order for 1.0

**Blockers**
1. Fix the resume gate so it validates pages and preserves the byte/page totals (§0.1, §2.2). Add a test that a truncated page is refetched on all five stores.
2. Anchor detection per host and drop the ebookjapan catch-all (§0.2, §2.4).
3. Fix the Kindle series call contract (§0.3).
4. Route every result, including skip paths, through `normalizeStoreResult`, and drop `skipped = true` (`run.js:141-167`, §1.4).
5. Make the tree green before tagging.

**High value, low risk**
6. Remove the four dead flags and merge the three redundant pairs (§3.1-3.2); add an Advanced section to `--help`.
7. Fix the colour policy (`ansi.js:16-20`) and `phaseBreakdown` colour.
8. Bound the two new bridge polling loops and cache completion by mtime/size instead of a full re-hash (§4.5).
9. Delete `src/detect.js` and repoint its two tests; delete the unused exports.
10. Fix `--dry-run` exit codes and the missing-value/typo messages.

**The refactor that unlocks the rest**
11. Convert the source-grepping tests to behavioural ones (§4.6). Until this is done, every cleanup risks a red build for the wrong reason.

**Architecture for a 1.x**
12. Stop importing the vendored ebookjapan CLI for one helper (§1.5).
13. Split `run()`; move the Kindle-specific branches behind the registry (§4.7).
14. Make resume semantics uniform across the five stores (§1.1).

---

## Method and limits

- `npm test` and `node tests/test_kindle_adapter.mjs` were run; the 4 failures are reproducible.
- `detectSource` was exercised directly for every store's canonical URL forms plus the misrouting cases above.
- The CLI was run locally for `--help`, exit codes and error text; no store was contacted and no volume was downloaded.
- The live storefronts, macOS/Linux differences and the real bridge were **not** tested in this pass; the acceptance workflow remains the only check for those.
- Three read-only sub-agents independently audited store wiring, the flag surface and code quality. Their claims were folded in only after spot-checking the load-bearing ones (`detectSource`, the Kindle series signature, the dead flags, the red tests, the source-grepping tests).

---

## Status after implementation (2026-10-13)

Blockers 0.1-0.3, §1.2-1.4, §2.1-2.4, §3.1-3.2, §3.5 and §4.2 (detect.js) are implemented. Both suites are green: `npm test` 27/27 (1 skipped, network), and `npm run engines:test` 7/7. `tests/test_existing_volume.mjs` is new (16 checks) and covers the module that caused the blocker.

- **Resume integrity**, one shared `isCompleteImageFile` in `page-files.js`; the gate validates every page and sums on-disk bytes; Kindle, ebookjapan and k-manga use the same validator. The four Kindle checks pass and `test_detect` grew from 69 to 82 checks with the misrouting cases.
- **Detection**, `detectSource` claims an absolute URL by host before trying patterns. Cross-host misrouting is fixed and tested. The bare-code precedence (`B090000002` → Kindle) is **intentional**: `tests/test_detect.mjs:148-154` asserts it, and a 10-character `B0…` token is genuinely ambiguous between a Kindle ASIN and an ebookjapan reading code. §0.2's bare-code paragraph is therefore downgraded from "bug" to "documented ambiguity"; the cross-host cases were the real defect.
- **Kindle series**, the descriptor adapts the call shape, so `--kindle-cookie` reaches the walk.
- **Result contract**, both skip paths go through `normalizeStoreResult`; the KU path reports `skipped` as a page count and marks `kuUnavailable`.
- **Flags**, four removed, `--overwrite` merged into `--force`, the descramble pair made mutually exclusive, ranges enforced, near-miss suggestions added, and `--help` split into a common and an Advanced section. `--quiet` and `--no-progress` were **kept separate**: they are not redundant (`--quiet` is silent, `--no-progress` prints one plain line per volume), so merging them would have removed a behaviour rather than a duplicate.
- **UI**, `FORCE_COLOR` precedence and `=0` fixed; the footer's phase colours use the right volume; `--dry-run` exits 2 when nothing resolves.
- **Bridge**, both polling loops are bounded by `--ocr-wait`; the completion marker is a size/mtime signature, so resuming no longer re-reads every page.

**One judgement call to review.** `vendor/cmoa/test/live_progress.test.mjs` still asserted the *page-based* overall bar ("marking a volume done does not invent fetched pages"), but the in-flight work had already replaced it with the stage-weighted bar (`overallFraction`/`overallSegments`). The vendored test was realigned to the stage-weighted contract and the deviation recorded in `vendor/README.md`. If the page-based bar was the intended design, revert `overallFraction`/`overallSegments` and this test together, they must move as a pair.

**Not done, and still worth doing before 1.0:** the source-grepping assertions in `tests/test_wiring.mjs` / `test_serial.mjs` / `test_modules.mjs` (§4.6), the `run()` split (§4.4), stopping the vendored ebookjapan CLI import for one helper (§1.5), and deleting the unused exports in `platforms/index.js` (§4.2).
