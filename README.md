**読破** (*dokuha*): to read a work through to its final page. Not a glance, not a
chapter, not a volume set aside half-finished. Cover to cover, in order, nothing
skipped.

---

## Every other tool for this drives a browser

They launch Chrome, load the store's viewer, wait for JavaScript to fetch the pages,
and scrape the result out of the DOM. That is a lot of moving parts: a ~400 MB
browser dependency, a renderer to keep patched, selectors that break when a store
changes its CSS, and a profile you have to sign in to by hand.

**`dokuha` skips the browser entirely.** It speaks each store's own viewer API
directly. No Chrome, no Puppeteer, no DOM, no selectors. It starts in milliseconds,
runs on a laptop that has never had a browser installed, and keeps working when a
store redesigns its frontend, because the API it uses is the one the viewer itself
is built on.

```sh
dokuha 'https://bookwalker.jp/de00000000-0000-4000-8000-000000000001/'
```

Paste the URL the site gave you. The store is worked out from the URL, the volume is
downloaded at full resolution, and the pages land on disk as ordinary numbered JPEGs.

## What you get

**Five stores, one command.** CMOA, ebookjapan, BookWalker, Amazon Kindle (JP) and
k-manga, in the same run. Mix URLs from all five; each is detected on its own.

**Paste a series, get the series.** Hand it a title page instead of a volume and it
reads the volume grid, takes the volumes that are free to read *in full*, and skips
the ones that are only a preview. One flag takes the previews too, filed separately
so a ten-page sample can never be mistaken for the book.

```sh
dokuha --series --download-samplers 'https://www.cmoa.jp/title/000000/'
```

**OCR and upload included.** `--mokuro` hands finished volumes to
[mokuro-bridge](https://github.com/GolyBidoof/mokuro-bridge) for OCR and delivery to
local disk, MEGA, Drive or OneDrive. Downloading and OCR run as independent stages,
so a volume waiting on a slow upload no longer stalls the network behind it.

**Almost nothing to configure.** Free volumes and previews on four of the five stores
need no account, no cookies and no login. There is exactly one optional dependency,
and it installs by itself.

```sh
npm install -g dokuha-cli
```

Requires Node 20+. See [docs/auth.md](docs/auth.md) for the two cases that do need a
signed-in session.

## Built to be fast, and measured

Not a claim, a set of numbers that are reproducible from the shipped CLI:

- A ten-volume batch across all five stores, by phase and at wall level:
  [docs/bench-5-stores.md](docs/bench-5-stores.md)
- Running seven volumes at once instead of four at a time: **80.1s to 21.1s**
- Uploading a 244-page volume through the bridge went from 15 s of dead time to
  nothing, about 11x, once a global request-rate floor was removed
- Page rebuilding moved onto worker threads, because it is pure CPU and was
  serialising the event loop that resolves the fetches

Some of it was not straightforward. k-manga's viewer has no page requests to
intercept at all: a HAR of a whole read is almost entirely stylesheets and
analytics, and the actual book arrives down a WebSocket in its own framing. Capturing
that, and interleaving several sockets when the store turned out to pace connections
rather than requests, is most of the work in that adapter.

Every `--json` result carries a `phases` breakdown, so when a volume is slow you can
see whether it was the handshake, the CDN, the rebuild or the write, rather than
guessing.

The reasoning and the measurements are in
[docs/parallelism.md](docs/parallelism.md) and [docs/phase-timing.md](docs/phase-timing.md).

## Your library, arranged properly

```
library/
  サンプル作品 (1)/
    page-0001.jpg
    page-0002.jpg
    metadata.json
  サンプル作品 (2)/
  サンプル作品 (3)（試し読み）/
```

Pages are `page-0001.jpg` on every store, so one `sort` gives one reading order
across a mixed library. Modification times are one second apart, so readers that sort
by date get the right sequence without an archive file. Two volumes whose titles
happen to be identical are kept apart rather than merged.

## Being straight about where it is

This is an early release and it is worth saying what that means.

- **Start with one volume.** Not a large queue. The stores can change their viewers
  without warning, and when they do this stops working until the engines are
  updated.
- **Kindle needs your cookies.** An Amazon volume is never public, not even a
  limited-time-free one, so there is no anonymous route. That is Amazon's model, not
  a gap in the tool.
- **k-manga is throttled by the store.** Throughput has a ceiling the client cannot
  raise, and that ceiling moves over minutes, so wall time is not predictable.
- **ebookjapan is CPU-bound**, because its pages have to be rebuilt from a shuffle
  the store never publishes. More parallel volumes stop helping once the cores are
  busy.
- **It is not affiliated with any store**, and it does not defeat anything: it takes
  what a store offers publicly, or what your own session already entitles you to.

Per-store details are in [docs/architecture.md](docs/architecture.md).

## Options

There are a few dozen. `dokuha --help` is the honest list, grouped the way you would
look for them:

```sh
dokuha --help
```

## Under the hood

Each store is a single descriptor: the URLs it answers to, its progress label, how a
title expands, its series walk, and how one volume is fetched. Adding a sixth store
means writing one adapter, not touching the driver, the scheduler, the display or
the summary.

The five store engines are vendored separately, in the shape each was written in,
each keeping its own retry and connection policy, because that is the part that is
easiest to get subtly wrong. The full explanation is
[docs/architecture.md](docs/architecture.md).

## Tests

```sh
npm test
```

26 files, offline and hermetic: no network, no credentials, no model. Every title and
identifier in the fixtures is invented.

## Credits

Written by [GolyBidoof](https://github.com/GolyBidoof) and **DeepSeek V4.1 Flash**.
DeepSeek V4.1 Flash wrote the driver, the option parser, the store adapters, the
progress display and the test suite.

## Licence

MIT. [LICENSE](LICENSE)
