# 読破 (dokuha-cli)

**dokuha-cli is the engine and the batch downloader of the dokuha project.** It is a Node CLI that downloads manga volumes from five stores (BookWalker, CMOA, ebookjapan, Kindle and k-manga) at full resolution, unscrambles them offline, and owns *series* downloads: give it a series URL and it finds the free volumes and previews itself.

```sh
# paste a title page URL from any store; dokuha lists what is free before it downloads
dokuha --dry-run --series 'https://www.cmoa.jp/title/<id>/'
```

Paste the URL a store gave you, with `<id>` as the store's own number. The store is worked out from the URL, the volume is fetched through the store's own viewer API, and the pages land on disk as ordinary numbered images. CMOA is the easiest first try: it works anonymously, its free volumes are small, and its codec is pure JavaScript, so it needs no extra dependency.

## The three projects

- **dokuha-cli** (this repository) is the engine and the batch downloader: a Node CLI that downloads manga volumes from five stores at full resolution, unscrambles them offline, and owns series downloads.
- **dokuha-userscript** is the in-browser companion. What you can install today is the earlier userscript release, [bookwalker-ebookjapan-cmoa-native-downloader](https://github.com/GolyBidoof/bookwalker-ebookjapan-cmoa-native-downloader), which covers BookWalker, CMOA and ebookjapan: it downloads the single volume you already have open, with no install beyond a userscript manager. The rewrite that adds Kindle and k-manga is in development and not published yet.
- **mokuro-bridge** is where all three converge. It is a small local service that runs mokuro OCR on finished pages and uploads the result to MEGA, Google Drive, OneDrive or a local folder, producing the `.cbz` / `.mokuro` / `.webp` trio that reader.mokuro.app reads. Both downloaders hand finished volumes to it, so OCR and upload are identical no matter which one produced the pages.

This repository is the CLI only. The userscripts and the bridge are separate projects, and the bridge runs on your own machine.

## What this CLI is responsible for

**Five stores, one command.** BookWalker, CMOA, ebookjapan, Amazon Kindle (JP) and k-manga, in the same run. Mix URLs from all five; each is detected on its own.

**Paste a series, get the series.** Hand it a title page with `--series` and it reads the volume listing, takes the volumes that are free to read in full, and skips the ones that are only a preview. `--download-samplers` carries on and takes each remaining volume's 試し読み sampler as well, filed under its own `（試し読み）` folder so a ten-page sample can never be mistaken for the book.

```sh
dokuha --series 'https://www.cmoa.jp/title/000000/'
dokuha --series --download-samplers 'https://ebookjapan.yahoo.co.jp/books/000000/'
```

**OCR and upload included.** `--mokuro` hands finished volumes to [mokuro-bridge](https://github.com/GolyBidoof/mokuro-bridge) for OCR and delivery. Downloading and OCR run as independent stages, so a volume waiting on a slow upload no longer stalls the network behind it.

**Almost nothing to configure.** Free volumes and previews on four of the five stores need no account, no cookies and no login. There is one optional dependency, `sharp`, used for image work; it installs by itself.

```sh
npm install -g dokuha-cli
dokuha --help
```

Requires Node 20 or newer. [docs/auth.md](docs/auth.md) covers the two cases that do need a signed-in session.

`dokuha` checks npm for a newer release at most once a day and prints one line to stderr when one exists, naming the new version and the exact upgrade command. The check never delays a download, stays quiet for `--json` and `--quiet` and whenever stderr is not a terminal, so scripts never have to parse it, and any network failure is silent. `DOKUHA_UPDATE_NOTICE=1` opts a non-terminal back in, and `DOKUHA_NO_UPDATE_CHECK=1` turns the check off entirely. Run `dokuha --check-update` to ask right now and get an exit code: 0 when current, 1 when a newer release exists, 2 when the check failed. Run `dokuha --update` to print and then run `npm install -g dokuha-cli@latest` for a global npm install; it refuses when the running copy is a git checkout or a local install, where that command would upgrade the wrong thing.

## Where it converges with the other two

The CLI writes a volume folder of finished pages. It can stop there, or it can hand the folder to mokuro-bridge with `--mokuro`, which is the same hand-off the userscript makes. The bridge does the OCR, builds the `.cbz` / `.mokuro` / `.webp` trio and uploads it.

mokuro-bridge remembers the last upload method it was given, because that is how the bridge itself works. Naming one with `--dest` therefore changes where later runs land too, including runs started by other programs; leave `--dest` off to keep using the bridge's current destination. `--dest-folder` applies when the destination is `local`, and a relative path is resolved on this machine, not on the bridge.

## Why a CLI and not a browser

Every store here has a private viewer API. `dokuha` speaks to that API directly, so there is no Chrome, no Puppeteer, no DOM and no CSS selectors to keep patched. It starts in milliseconds, runs on a machine that has never had a browser installed, and is not broken by a frontend redesign.

The one price is sessions: a browserless tool cannot sign you in, so a title already in your account is opened with cookies you copy from a browser. Free volumes do not need that. See [docs/auth.md](docs/auth.md).

## Key advantages

- **Series-aware.** `--series` walks a title page or a series page and finds the free-in-full volumes; `--download-samplers` adds the previews without ever letting them collide with the whole volume.
- **Full resolution.** Pages are written at the size the store serves, not a viewer thumbnail. ebookjapan pages are rebuilt from the viewer's own shuffle geometry rather than screenshotted.
- **Two-stage pipeline.** Download and OCR are separate stages with a queue between them, so a slow upload never blocks the next volume.
- **Shared CPU budget.** Page rebuilding is CPU-bound, so `src/cpu-budget.js` divides one machine-wide budget across the stores that are actually running.
- **Resumable.** Finished pages are checkpoints. Re-run the same command and only missing or invalid pages are fetched; `--force` starts over.
- **Machine-readable.** `--json` prints one summary with per-volume results and a five-phase timing breakdown, so a slow volume can be attributed to the handshake, the fetch, the rebuild or the write.

## Use cases

- Download the free and preview volumes of a series you are following, from any of the five stores, in one command.
- Back up volumes you already own, with your own session, into a uniform `page-0001.jpg` layout.
- Queue a series for OCR and MEGA or Drive upload through mokuro-bridge, and read the result in reader.mokuro.app.
- Feed another tool: the per-page layout and the `metadata.json` marker are stable enough to script against.

## Options

`dokuha --help` shows the dozen flags a normal run needs, then an **Advanced** section for store-specific and tuning options: per-store page concurrency, CMOA volume selection, BookWalker session internals and bridge destinations. The defaults come from measurement, so most runs need only a URL and `--out`.

```sh
dokuha --help
```

Flags are grouped by purpose. `--out` is where volumes are written, `--series` and `--download-samplers` select a series, `--mokuro` opts into the bridge, `--force` re-fetches, `--json` is for scripts, and `--dry-run` lists the work without downloading.

## In-depth docs

- [docs/stores.md](docs/stores.md): per-store support matrix, sessions, free versus paid, samplers and known limits.
- [docs/auth.md](docs/auth.md): BookWalker and Kindle sessions, cookie forms and the state files.
- [docs/naming.md](docs/naming.md): how volume folders, series folders and page names are derived.
- [docs/troubleshooting.md](docs/troubleshooting.md): the common failures and what to do about them.
- [docs/architecture.md](docs/architecture.md): the platform registry, the two-stage scheduler and the vendored engines.
- [docs/parallelism.md](docs/parallelism.md), [docs/phase-timing.md](docs/phase-timing.md), [docs/bench-5-stores.md](docs/bench-5-stores.md) and [docs/bench-2026-10-13-download-modes.md](docs/bench-2026-10-13-download-modes.md): the measurements behind the defaults, including a full five-store serial against parallel run.
- [vendor/README.md](vendor/README.md): the three vendored engines and every deliberate deviation from upstream.
- [docs/audits/2026-10-13-pre-release-audit.md](docs/audits/2026-10-13-pre-release-audit.md) and [docs/audits/2026-09-30-five-store-audit.md](docs/audits/2026-09-30-five-store-audit.md): dated audit snapshots, kept for the record rather than as current documentation.

## Tests

```sh
npm test
```

31 test files are discovered; 30 run offline and one is a live network check that is skipped unless `DOKUHA_TEST_NETWORK=1` is set. The offline suite is hermetic: no network, no credentials, no OCR model. Every title and identifier in the fixtures is invented.

## Credits and licence

Written by [GolyBidoof](https://github.com/GolyBidoof) and **DeepSeek V4.1 Flash**, which wrote the driver, the option parser, the store adapters, the progress display and the test suite.

MIT. [LICENSE](LICENSE)
