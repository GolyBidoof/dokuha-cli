# manga-dl

A browserless, headless command line tool that downloads volumes from **CMOA**,
**ebookjapan** and **BookWalker**, and can push them through
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

Volumes start **all at once** by default. Queuing is nearly always the wrong trade:
the stores are independent, CMOA's cost is CPU (so a queued volume just idles the
machine) and the other two are I/O bound. Measured on a seven-volume batch, going
from four at a time to all seven took **80.1s to 21.1s**.

`--series N` caps it, and `--concurrency N` sets the per-store page concurrency in
one go. Defaults: CMOA 12, ebookjapan 32, BookWalker 128 pages in flight.

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
vendor/                 the three engines, copied verbatim; see vendor/README.md
tests/                  test suite
```

## Tests

```sh
npm test                 # offline, fast
npm run engines:test     # the CMOA engine's own suites
MANGA_DL_TEST_NETWORK=1 npm test    # adds the tests that hit real stores
```

The default suite is hermetic and makes no network calls.

## Credits and licence

MIT. The store engines under `vendor/` are vendored copies of code by the same
author; see [vendor/README.md](vendor/README.md) for exactly what was changed.

This tool is for downloading material you have the right to download. It does not
defeat any access control you have not already been granted: it uses the same
signed URLs your browser receives, and free volumes need no credentials at all.
