# manga-dl

<img width="1572" height="324" alt="image" src="https://github.com/user-attachments/assets/abca4f8e-0e52-45e8-878a-60be4176f87d" />

**v0.0.2: early, potentially buggy, and not ready for large-scale use.**

This is a first cut. It works on the volumes it has been tried against, but it has
not been used broadly, the three stores can change their viewers without warning at
any time, and error handling on unusual input is thin. Expect rough edges.

Please **do not point it at a large queue yet**. Start with one volume, check the
output, and work up. If something breaks, a URL that reproduces it is the most
useful thing you can report.

A browserless, headless command line tool that downloads volumes from **BookWalker**,
**CMOA** and **ebookjapan**, and can push them through
[mokuro-bridge](https://github.com/) for OCR.

No browser, no extension, no Puppeteer. It reads each store's own viewer API,
fetches the page files directly, and rebuilds every page offline at full
resolution.

```sh
node bin/manga-dl.mjs \
  'https://ebookjapan.yahoo.co.jp/books/126344/A000065415/' \
  'https://www.cmoa.jp/title/249510/' \
  'https://bookwalker.jp/def45047f5-6b90-4d4f-84f7-bd8263daee70/?sample=2' \
  --out ./library
```

Volumes run in parallel. Paste whatever URL the site shows you; the store is
detected automatically.

## Status and known limitations

The honest list, so you can judge whether it will work for you:

- **Verified against a small number of volumes.** Three stores, roughly a dozen
  titles. Anything unusual (a region-restricted title, an odd page layout, a
  multi-chapter manifest) is untested.
- **Retries are a flat budget, not adaptive backoff.** `--retries N` sets how many
  attempts each page gets, but there is no store-aware backoff, no circuit breaking,
  and no resume across runs beyond skipping pages that are already on disk. A long
  flaky run produces failures rather than a slow success.
- **A failed volume does not stop the batch**, and there is no automatic re-run of
  the failures. Check the summary, then re-run the same command: finished pages are
  skipped.
- **ebookjapan `--descramble` and `--pdf` do not work here.** They throw. The engine's
  descramble step runs its whole CLI at module scope and exits the process, which
  cannot be driven from a library. Use the engine directly for those.
- **ebookjapan is capped at 48 sockets in flight.** The vendored engine sizes its
  keep-alive pool by reading `--concurrency` out of `process.argv` when it is first
  imported, and manga-dl does not translate its own flags into that one. So
  `--concurrency N` does reach the engine and raises the pool, but `--eb-concurrency N`
  on its own does not: past 48, requests queue on an agent that is still sized at 48.
  Measured, 120 concurrent fetches peak at 48 sockets with no flag and at 8 with
  `--concurrency 8`.
- **BookWalker needs `sharp`**, an optional dependency, and needs a browser-supplied
  session for anything not free. See below.
- **Store changes will break it.** These are undocumented viewer APIs; when a store
  changes its viewer, this stops working until the engine is updated.

## Install

Requires Node 20 or newer.

```sh
git clone <this repo> manga-dl
cd manga-dl
npm install          # optional; only needed for BookWalker
```

`npm install` pulls in `sharp`, which BookWalker needs because its public pages
are encrypted. CMOA and ebookjapan have no dependencies at all, so if you never
download from BookWalker you can skip the install entirely.

## Usage

```
node bin/manga-dl.mjs URL... [options]
```

Run `--help` for the full list. The options that matter most:

| Option | What it does |
|---|---|
| `--out DIR` | Where volumes are written. Default `./library` |
| `--title-dir` | Name each folder after the volume title instead of the content id |
| `--mokuro` | Push every volume through mokuro-bridge for OCR |
| `--series N` | Volumes at once. Default: **all of them**, up to 16 |
| `--json` | Machine-readable summary on stdout |
| `--dry-run` | List what would be downloaded, then stop |

### Accepted URLs

| Store | Accepted forms |
|---|---|
| CMOA | `cmoa.jp/title/<id>/` (expands to volumes), `cmoa.jp/title/<id>/vol/<n>/`, a bare cid like `0000249510_jp_0001`, a speedreader URL |
| ebookjapan | `ebookjapan.yahoo.co.jp/books/<title>/<pub>/`, a bare publication code like `A002664637` |
| BookWalker | `bookwalker.jp/de<uuid>/`, a bare uuid, with or without a `?sample=2` suffix |

A CMOA title page has no published volume list, so it is discovered by probing.
`--cm-volume all` probes up to `--cm-scan-limit` volumes (default 60).
A `/vol/<n>/` in the URL always wins over `--cm-volume`.

### Concurrency

By default every volume in the batch starts at once, capped at 16. Queuing is nearly
always the wrong trade: the stores are independent, CMOA's cost is CPU (so a queued
volume just idles the machine) and the other two are I/O bound. Measured on a
seven-volume batch, going from four at a time to all seven took **80.1s to 21.1s**.

`--series N` caps it, and `--concurrency N` sets the per-store page concurrency in
one go. Defaults: CMOA 12, ebookjapan 32, BookWalker 128 pages in flight. Page
uploads to mokuro-bridge are not rate limited; they are bounded by
`--push-concurrency` and by the bridge's own admission control.

## BookWalker credentials

**Free volumes need no account, no cookies and no browser.** If a volume is free to
read, it just downloads. The same is true of CMOA and ebookjapan.

A signed-in session is only needed for titles already in your library. This build
is browserless, so it cannot sign in for you or drive a Chrome profile; you pass it
a session from the browser you are already signed into.

Easiest route: open the book in your browser, open DevTools, go to the Network tab,
click any request to `bookwalker.jp`, and use **Copy as cURL**.

```sh
node bin/manga-dl.mjs 'https://bookwalker.jp/de<uuid>/' --bw-cookie "$(pbpaste)"
```

`--bw-cookie` accepts a raw `Cookie:` header, a whole `Copy as cURL` command, `@FILE`
to read from a file, a bare path, or `-` for stdin. Give it more than once and the
values are merged, which is usually what you want: the viewer page and the member
page each carry different cookies.

```sh
# Both pastes at once, merged by name.
node bin/manga-dl.mjs URL --bw-cookie "$(pbpaste)" --bw-cookie "@/tmp/other.txt"
```

| Option | Purpose |
|---|---|
| `--bw-cookie TEXT` | Session cookies. Repeatable and merged |
| `--bw-state FILE` | Where the session is saved, so you do not re-paste every run |
| `--no-state` | Do not read or write a saved session |
| `--bw-sample` | Force the trial route instead of the free one |

A session is reused from `~/.bwdd-cli/free-session.json` unless you pass
`--no-state`. Sessions expire, and an expired one is the most common cause of a
licence refusal; the error message says so when it happens.

## OCR with mokuro-bridge

Start mokuro-bridge, then add `--mokuro`:

```sh
node bin/manga-dl.mjs URL... --out ./library --mokuro --dest local --dest-folder ./ocr
```

Pages are pushed to the bridge, which OCRs them and hands the result to the
destination you pick (`local`, `mega`, `drive`, ...). Progress reports each phase
separately, and a finished volume keeps its row.

One thing worth knowing before benchmarking: **the bridge re-queues every image
folder it finds** under its input directory, including leftovers from earlier runs.
A big stale backlog makes a run look far slower than it is. Check it with:

```sh
curl -s http://127.0.0.1:62642/health | python3 -c 'import sys,json; print(json.load(sys.stdin)["ocr_queue_depth"])'
```

## Project layout

```
bin/manga-dl.mjs        entry point; parse, dispatch, exit code
src/options.js          every option declared once
src/help.js             help text, generated from the declarations
src/detect.js           which store a URL belongs to
src/display.js          the live progress display
src/bridge.js           mokuro-bridge: push pages, poll OCR, finalize
src/download/*.js       one adapter per store
vendor/                 the three engines; see vendor/README.md for the deviations
tests/                  test suite
```

## Tests

```sh
npm test                 # offline, fast
npm run engines:test     # the CMOA engine's own suites
MANGA_DL_TEST_NETWORK=1 npm test    # adds the tests that hit real stores
```

The default suite is hermetic and makes no network calls.

## Relationship to the userscript downloader

The sibling project
[**bookwalker-ebookjapan-cmoa-native-downloader**](https://github.com/GolyBidoof/bookwalker-ebookjapan-cmoa-native-downloader)
covers the same three stores and speaks to the same endpoints. The difference is
where the code runs:

| | Userscript downloader | This tool |
|---|---|---|
| Runs in | your browser, as a userscript | Node, headless |
| Drives | the store's own page, in a tab | the store's API, over HTTP |
| Decryption | the same algorithms | the same algorithms |
| You see | a browser window doing the work | a terminal |

**They share the same reverse-engineering work, not one codebase.** The cid-to-URL
derivation, the licence handshake parameters, the manifest layout, the scramble
tables and the decryption routines were each worked out once. Both projects use the
results, because there is only one correct answer to what a store's viewer does.

How much code is literally shared varies by store, and it is worth being precise:

- **BookWalker: the same code.** The decryption in this repo's
  `vendor/bookwalker/bw-crypto.js` is identical to the userscript's
  `src/sites/bookwalker/03-crypto.js`, down to the decompiler-assigned names (`A8j`,
  `a0g`, `A3b`, `B0p`). For that store this repo genuinely reuses the userscript's
  implementation rather than reproducing it.
- **CMOA and ebookjapan: the same algorithms, separate implementations.** The
  userscript reads pages out of the page it is running in; these engines call the
  store APIs directly and descramble in Node, which is a different enough job that
  the code was written afresh. The tables, tokens and descrambling are the same,
  because they have to be.

The practical consequence is the same either way: when a store changes something, the
answer is discovered once and both projects need the same correction.

**Credit for the protocol work belongs to that project.** It is why this repo's
engines are vendored rather than assumed: a fresh clone should reproduce that work
rather than require the original checkout.

## Credits and licence

MIT.

The protocol work this tool depends on, meaning the licence handshakes, the manifest
layouts, the scramble tables and the decryption routines, was reverse engineered in
[bookwalker-ebookjapan-cmoa-native-downloader](https://github.com/GolyBidoof/bookwalker-ebookjapan-cmoa-native-downloader).
Credit for it belongs to that project.

The engines under `vendor/` are copies of that work and of its sibling Node code. Two
of them are no longer byte for byte identical to their originals: each carries
deliberate, documented throughput fixes with the reasoning and the measurements
written into the source. See [vendor/README.md](vendor/README.md) for exactly what
changed in each.

Built with assistance from **DeepSeek V4.1**, which wrote and reviewed the driver,
the option parser, the progress display and the test suite.

This tool is for downloading material you have the right to download. It does not
defeat any access control you have not already been granted: it uses the same
signed URLs your browser receives, and free volumes need no credentials at all.
