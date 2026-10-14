# Stores

`dokuha` supports five storefronts. Each is a platform descriptor in `src/platforms/index.js` with its own URL patterns, its own adapter in `src/download/`, and its own idea of what is free. This page is the support matrix, the session requirements and the known limits. It is verified against the code, not against the store's own documentation.

## At a glance

| Store | Host | Session needed | Free in full | Samplers | `--series` walk | Lane | Needs `sharp` |
|---|---|---|---|---|---|---|---|
| BookWalker | `bookwalker.jp` | Only for paid or library titles | Yes, anonymous | Yes | Yes, series and volume listing | net | For every volume (seam-carving) |
| CMOA | `cmoa.jp` | No, free and preview only | Yes, anonymous | Yes | Yes, title listing by probing | cpu | No, a pure-JavaScript codec is vendored |
| ebookjapan | `ebookjapan.yahoo.co.jp` | No, free and preview only | Yes, anonymous | Yes | Yes, title listing | net | Yes, to descramble; without it pages are written scrambled |
| Kindle | `amazon.co.jp` | Always, including samplers | No anonymous route | With `--download-samplers` | Yes, walked forward one volume at a time | net | No, pages arrive assembled |
| k-manga | `comic.k-manga.jp` | No account support | Yes, anonymous | Yes | Yes, title listing | net | Yes, to descramble; without it pages are written scrambled |

"Free in full" means a volume the store currently offers to read without paying. It is not the same as a preview, which is what `--download-samplers` handles.

## What the URLs look like

A URL is claimed by the store that owns its host before any pattern is tried, so a link to one store inside another store's query string cannot hand the URL to the wrong adapter.

| Store | Accepted |
|---|---|
| BookWalker | `bookwalker.jp/series/<id>`, a volume URL carrying a `de<uuid>`, or a bare UUID. `?sample=` selects the trial route. |
| CMOA | `cmoa.jp/title/<id>/vol/<n>`, `cmoa.jp/title/<id>`, a `speedreader` URL with `?cid=`, or a bare cid of the form `0000249001_jp_0001`. |
| ebookjapan | `ebookjapan.yahoo.co.jp/books/<title>/<publication>`, `.../books/<title>`, a viewer or title URL, or a bare reading code such as `B000000002`. |
| Kindle | `read.amazon.co.jp/manga/<asin>`, a product page such as `amazon.co.jp/dp/<asin>`, or a bare ASIN. |
| k-manga | `comic.k-manga.jp/title/<id>/vol/<n>`, a `viewer-launcher` link, or `comic.k-manga.jp/title/<id>`. |

A bare ebookjapan publication code (an `A` followed by digits) is refused with a message naming the `/books/<title>/<code>/` URL that does work, because a publication does not name its own title. A bare ten-character `B0...` token is genuinely ambiguous between a Kindle ASIN and an ebookjapan reading code; the registry tries Kindle first, and `tests/test_detect.mjs` pins that choice.

## Sessions

Only two stores ever need a signed-in session.

- **BookWalker**: a free volume downloads with no cookies at all. `--bw-cookie` is needed for a title already in your account. The session is split across `viewer.bookwalker.jp` and `member.bookwalker.jp`, so the flag is repeatable and both halves may be required. `--bw-sample`, `--bw-u1`, `--bw-cr`, `--bw-no-cr` and `--bw-entry` are Advanced overrides for the licence handshake.
- **Kindle**: every volume needs a signed-in `read.amazon.co.jp` session, because an Amazon volume is never public, not even a limited-time-free one. Pass `--kindle-cookie`, or rely on the saved session at `~/.bwdd-cli/kindle-session.json`. Only the Japan store is supported.

CMOA, ebookjapan and k-manga have no account path at all: they are anonymous, free-and-preview stores here.

Cookie forms and the state files are covered in [auth.md](auth.md).

## Series downloads

`--series` turns every positional URL into an entry point into a series and keeps only the volumes that are free to read in full. `--download-samplers` then carries on past the free volumes and takes each remaining volume's 試し読み sampler, as far as the series goes. Samplers are written to their own `（試し読み）` folder, so a preview can never overwrite the whole volume.

| Store | How the series is found | Sampler support |
|---|---|---|
| BookWalker | Series id in the URL, or the volume listing. Deduplicates volumes. | Yes |
| CMOA | The title page, paging through the listing. CMOA publishes no volume list, so `--cm-volume all` probes volumes up to `--cm-scan-limit`. | Yes |
| ebookjapan | The title page. | Yes |
| Kindle | Walks forward from the volume you paste, one request per volume, up to 200 volumes. A volume that is free in full, already in your library, or borrowable through Kindle Unlimited is taken. | Yes, with `--download-samplers` |
| k-manga | The title page. | Yes |

There is no separate series folder. A series download writes one sibling volume folder per volume under `--out`, the same layout as a single-volume run. See [naming.md](naming.md).

## Kindle Unlimited

A Kindle Unlimited volume is borrowed rather than owned. The CLI borrows it, downloads it and returns it. The progress row is tagged `KDUL` instead of `KDL`, and the volume counts against your open loan slots while it is held. Loans are capped at six open at a time, and the CLI respects that ceiling and returns each volume as soon as its pages are on disk. A volume that cannot be borrowed is reported as a skip with a reason, not as a failure. There is nothing extra to configure: Unlimited rides on the same session as every other Kindle volume.

## Known limits

- **Kindle has no anonymous route.** It speaks only to `amazon.co.jp`, walks a series forward from the volume you paste, and makes one request per volume while scanning, which makes it the slowest discovery.
- **CMOA has no paid path.** Only volumes the store serves for free are reachable, because there is no cookie or session mechanism for the store here.
- **ebookjapan is CPU-bound.** Its pages are tile-scrambled and rebuilt from the viewer's own WebAssembly, which is why it needs `sharp`. Its keep-alive socket pool is sized once at import from `--concurrency` (default 48), so `--eb-concurrency` alone changes the worker count but not the socket ceiling.
- **BookWalker needs `sharp` for every volume**, because the vendored engine normalises pages through it. It is the only store with two worker pools (the download and the normalise pool).
- **k-manga's throughput cap belongs to the store.** It moves by more than five times over minutes and the client cannot raise it, so wall time is not predictable. `--km-concurrency` sets requests outstanding per viewer socket, 1 to 32; a long volume opens up to four sockets.
- **Retries are a flat per-page budget, not adaptive backoff.** A failed volume does not stop the batch, and re-running the same command skips what is already on disk.
- **Store changes will break a store.** These are undocumented viewer APIs. When a store changes its viewer, that adapter stops working until it is updated.
