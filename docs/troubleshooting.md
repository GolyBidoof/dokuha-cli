# Troubleshooting

The failures people hit first, and what the tool is actually telling them. Every message quoted here is one the CLI or an adapter produces.

## Exit codes

| Code | Meaning |
|---|---|
| `0` | Every discovered volume finished. |
| `1` | The run completed but at least one volume failed. The reasons are printed above the summary. |
| `2` | A usage problem: no URLs, nothing recognisable, a bad option, or a missing cookie file. |

Re-running the same command is the normal first response to a `1`: finished pages are checkpoints, so only the gaps are fetched. Add `--force` only when you want to discard what is there.

## "no supported volume URLs given" or "no URLs given"

Nothing in the positionals resolved to a store. The reasons are listed under the message. The usual causes:

- A bare ebookjapan publication code (`A` followed by digits) is refused on purpose, because a publication does not name its own title. Use `https://ebookjapan.yahoo.co.jp/books/<title>/<code>/` instead.
- A series or title page given without `--series`. The message says to add it. A CMOA title page without `--series` resolves to volume 1 by default, which is `--cm-volume`'s doing, and a DMM `/product/<series>/` or `/volumes/` page is refused until you add `--series`; a pasted DMM `free_streaming/` or `tachiyomi/` viewer URL is a single volume and needs no flag, and `/latest/` resolves the newest listed volume on its own.
- A URL from a store this tool does not speak to, or a URL whose host is one of the six but whose path is not one it can read.

## A flag is rejected

A misspelled flag suggests the nearest real one, so `--dest-foder` answers with `did you mean --dest-folder?`. A missing value names the flag. An `@FILE` cookie argument is checked while parsing, so a mistyped path fails once at startup instead of once per volume.

`--cm-volume` must be a volume number, a comma list, or `all`. A `/vol/<n>/` in the URL overrides it. `--jpeg-quality` is 1 to 100 and `--km-concurrency` is 1 to 32; anything outside those ranges is rejected at parse time.

`--download-samplers` without `--series` prints a note and is ignored. `--zip` is BookWalker-only; other stores write their pages unchanged and the run says so. `--descramble` and `--no-descramble` cannot be combined.

## A fatal error left a log

An unexpected crash writes one file under `.dokuha-logs/` in the directory the command ran from, named `failure-<timestamp>-<pid>.log`, mode `0600`. It records the version, the Node and platform versions, the command line with cookie arguments redacted, and the stack, so a bug report has facts rather than a paraphrase. The path is printed on stderr when the log is written.

## BookWalker: "did not grant a licence"

The message lists the likely reasons. In order worth trying:

1. **The session expired.** Sign in again at bookwalker.jp and copy fresh cookies. A BookWalker session is split across two hosts, and both halves may be needed: `viewer.bookwalker.jp` carries `SESSION`, `u1` and `bid`, and `member.bookwalker.jp` carries the `JSESSIONID` used as `kpid`. `--bw-cookie` is repeatable for exactly this reason.
2. **The cached licence is stale.** Add `--no-state` for one run. A stale cache is indistinguishable from an expired session, so this is the cheapest test.
3. **`u1` is missing.** It is `HttpOnly`, so it never appears in `document.cookie` or a console snippet. Pass it directly with `--bw-u1 <uuid>`.
4. **You passed cookies but there is no signed-in marker.** A run is treated as signed in only when the cookies include one of `bwmember`, `bwlogin`, `lbwsid` or `cm_kp_login_account`. Without one of those, the run is anonymous and a paid volume is refused.

Free volumes need no session at all. If even a free one fails, drop `--bw-cookie` and `--bw-state` and try again to separate the session from the store.

## Kindle: "needs signed-in read.amazon.co.jp cookies" or a token error

Every Kindle volume needs a session, including a limited-time-free one. Pass `--kindle-cookie`, or let the CLI use `~/.bwdd-cli/kindle-session.json`.

- **"the Kindle reader answered HTTP 401/403/404"** usually means the session expired. Copy fresh cookies.
- **"the Kindle reader published no reading token"** means the account cannot open that volume: it may be region-locked, withdrawn, a sample that has ended, or not a manga volume at all. It is not always an expired session.
- **"is a Kindle series page, not a volume"** means the ASIN you pasted is the series, not one of its volumes. Paste a volume URL (on `.../dp/<ASIN>`, the ASIN that is not the series) and add `--series` to download the whole series from it.
- **A Kindle Unlimited title that will not borrow** is usually an expired session rather than an expired subscription.
- Only `read.amazon.co.jp` and only the Japan store are spoken to.

## DMMブックス: 403, 429 and shuffled pages

- **A 403 on a page or on `configuration_pack.json`** means the CloudFront signature rolled over. The adapter refreshes `/viewerapi/auth/` once, one refresh shared by the manifest and every page worker, and retries the request; a 403 that survives that refresh is a real refusal, so reopen the viewer and paste a fresh URL. The CLI sends the free route's CloudFront values in the `Cookie` header.
- **429s and 5xx** retry with bounded backoff. Lower `--dmm-concurrency` (default 16) to reduce pressure, and use `--parallel N` to start fewer volumes at once; `--retries` sets the per-page attempt budget, and a 403 refresh does not spend one of those attempts.
- **A chessboard page is a deliberate `--no-descramble` output.** If the shuffle was not meant to stay, rerun without the flag. When `sharp` is missing the run fails with its install line instead of writing a shuffled page.
- **A sampler is not a free volume.** `free_streaming_url` is present only while the free window is open, and the rest expose `tachiyomi_url`. A pasted `tachiyomi/` viewer URL downloads that one preview directly, with no `--series` and no `--download-samplers`; in a `--series` walk, add `--download-samplers` to take the previews, and each sampler folder gets one `（試し読み）` suffix.

## k-manga: launcher or entry-point failures

- **"k-manga launcher answered HTTP ..."** with a note about the `isIPad` cookie gate means the launcher did not hand back a viewer URL. This is a store-side gate; retrying is reasonable.
- **"offers no free reading entry point right now"** means the title page listed no volume this tool can read without paying. A volume that is only a 試し読み sample is not a free volume; add `--download-samplers` to take the samples as well.
- **Slow runs are normal.** k-manga's throughput is set by the store, not by the client, and it moves by more than five times over minutes. `--km-concurrency` tunes requests per socket, not the store's own pace.

## CMOA: "has no readable volumes"

CMOA publishes no volume list, so `--cm-volume all` probes volumes up to `--cm-scan-limit` (default 60) and accepts one only when its first page actually downloads. If a title reports no readable volumes, the free window may have closed or the probe limit may be too low.

## ebookjapan: pages look like a shuffled mosaic

That is the scrambled form the CDN serves, and it means the page was written without being rebuilt. Two causes:

- The optional `sharp` dependency is not installed. The run warns with the install line. Install it with `npm install sharp`.
- The run was made with `--no-descramble`, which is the flag that deliberately keeps the CDN bytes.

`--descramble` requires `sharp` and fails clearly if it is missing. A volume downloaded while descrambling was off has a `manifest.json` that records the choice, so the resume gate knows the pages are not the rebuilt ones.

## Serial vs parallel downloads look inconsistent

That is usually the store, not the scheduler. Every discovered volume starts at once by default, but stores drift by multiples between runs. CMOA in particular was measured about ten times slower in one arm than in every later arm on the same day, with nothing shared between runs. Compare arms taken close together, and repeat before believing a difference.

## The optional mokuro-bridge hand-off

mokuro-bridge is a separate service. These messages are the CLI's side of that conversation; the service's own documentation covers its configuration.

- **"no mokuro-bridge found"**: start the service, or point at it with `--bridge URL`. The default search is `:62642`.
- **"destination ... is not configured on the bridge"**: the target you named with `--dest` is not set up in the service. The message lists the configured ids.
- **"the bridge has no local output configured"**: `--dest local` was requested but the service has no local destination. Configure one there.
- **"OCR did not finish within --ocr-wait"**: raise `--ocr-wait` (seconds, default 3600) or check whether the service's OCR worker is running. On first contact the service restores its persisted sessions and re-queues pages whose OCR cache is missing, so a stale backlog from an earlier run can make a new volume look slow. Its `GET /queue` route reports the worker state.
- **A bridge failure is a failed volume, not a failed run.** If some page uploads fail, the volume is reported failed rather than quietly succeeding on the few that arrived. The same goes for a terminal `partial_upload`: the destination received the volume files but not `series.json`, so the series index is incomplete and the volume is counted as failed. The message names the service's own reason; the service keeps its working files, and `--force` re-runs the hand-off so the destination copies are replaced.
- **"destination check unavailable for <title>: ...; continuing"**: the optional pre-download check could not answer, usually because the account is misconfigured. The run carries on without the check rather than failing.

### `--dest` takes a bridge id or an account alias

mokuro-bridge remembers the last upload method it was told to use, so naming one with `--dest` also changes the service's default for later runs, including runs started by other programs. Leave `--dest` off to keep using whatever it is already set to. The value is any id the service reports from `GET /upload-methods`: an account alias such as `mega-work` or `drive-other-email`, an rclone-backed account, or `local`. A bare provider id such as `mega` is looked up as an alias first and is the first account of that provider only when nothing else has claimed the name. The historical `mega:work` spelling still resolves, including through a rename, because the service reports each account's provider and storage name. A name the service does not report is rejected before the run starts, and the message lists what is configured.

Accounts, aliases and per-account remote roots are managed in the bridge's dashboard, or with `mokuro-bridge --setup-upload`; `dokuha` neither creates nor stores them. `--dest-folder` applies when the destination is `local` only, and a relative path is resolved on this machine, not on the bridge. A remote destination's folder is a property of the account in the bridge, not a CLI flag.

## Getting more detail

- `--json` prints one machine-readable summary with a `results` array after a real run. Each result carries `store`, `id`, `title`, `folder`, `sample`, `totalPages`, `downloaded`, `skipped`, `failed`, `bytes`, `failures` and a `phases` object. A dry run prints its list as a table even when `--json` is also given.
- `phases` breaks a volume into `handshake`, `prework`, `fetch`, `rebuild` and `write`, so a slow volume can be attributed rather than guessed at. [performance.md](performance.md#the-phase-model) explains why two of those are wall time and three are aggregates.
- `--no-progress` replaces the live block with one plain line per volume, which is easier to read in a log or a pipe.
- Pressing `p` in the live block freezes every redraw so its text can be selected and copied while the download keeps running; press `p` again to resume, and any notes that arrived while it was frozen print then. `--no-progress` is the fully static alternative when there is no keyboard available.
- `--dry-run` lists what would be downloaded and exits without fetching, which is the quickest way to check that URLs and flags resolve as expected.
