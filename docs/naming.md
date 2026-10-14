# Naming

How `dokuha` turns a volume into paths and file names on disk, and what it sends to mokuro-bridge. The rules live in `src/download/volume-folder.js` and `src/download/page-files.js`, and every store goes through them, so a mixed-store library has one shape.

## Volume folders

A volume is written into one directory under `--out` (default `./library`). There is no series parent directory: a `--series` run writes one sibling volume folder per volume, exactly like a run that named each volume by hand.

The folder name is the volume's title, run through `safeFolderName`:

- the characters `/ \ : * ? " < > |` become `_`;
- runs of whitespace collapse to one space, and the result is trimmed;
- the name is capped at 80 characters, and trailing dots and spaces are removed because Windows drops them silently;
- an empty result falls back to `volume`.

Two flags change the folder:

- `--no-title-dir` names the folder after the content id instead of the title, still sanitized.
- `--flat` writes the pages straight into `--out`. It refuses a run with more than one volume, because page numbers restart at 1 in each volume and they would overwrite each other.

A sampler gets the suffix `（試し読み）` on both naming paths, title or id. This matters because a sampler and its whole volume share a content id, so without the suffix they would land in the same directory and overwrite each other page for page.

Each successful volume writes `metadata.json` into its folder. It records the store, the content id, the title and the expected page count. Kindle adds the series ASIN, the revision, the page count and a `sample` flag. When a folder already has a marker naming a different content id, the new volume is written to `title (id)` instead, so two volumes whose titles clean up identically are kept apart rather than merged. A folder with no marker is treated as the current volume's own, which is what lets an interrupted download resume in place.

ebookjapan additionally writes `manifest.json`, which lists the pages and the descrambling state. It is written only after the whole volume succeeds and is what a resumed run reads to decide whether existing pages are reusable. mokuro-bridge completion is recorded separately, in `.dokuha-bridge-completion.json`, which names the destination it was written for and records a size and mtime signature of the page set.

## Page names

The default page name is `page-0001.jpg` on every store: the word `page`, a hyphen, a one-based ordinal padded to four digits, and the extension. A plain name sort is reading order.

| Store | Extension | Notes |
|---|---|---|
| CMOA | `.jpg`, or `.png` with `--format` | `page-0001.jpg`; the vendored codec decides the final extension per page |
| ebookjapan | `.jpg`, or `.webp` | `.jpg` when descrambled to JPEG; `.webp` with `--format webp`, and `.webp` when descrambling is off |
| Kindle | `.jpg` | Pages arrive assembled from the store |
| k-manga | `.jpg` | Block-scrambled pages are rebuilt to JPEG |
| BookWalker | `.jpg` | A different name shape, below |

Older names are adopted on resume rather than re-downloaded: `page_0001.jpg`, a bare `0001.jpg`, and the pre-convention variations are renamed to the canonical name when found.

Page modification times are rewritten one second apart in reading order, ending at roughly the time of the run. A reader that sorts by date then shows the pages in order even without an archive file.

## BookWalker page names

BookWalker's published manifest names each page after the EPUB source it was built from, so `dokuha` keeps that stem instead of an opaque ordinal. A page built from `OEBPS/text/cover.xhtml` is written as `0001 cover.jpg`, and the same name is used for the file on disk, the entry in a `--zip` archive, and the filename uploaded to mokuro-bridge, so a resume looks for the page it actually wrote.

The rule is `bookWalkerPageName(index, source, extension)`:

- only the basename of the source matters; a query string or fragment is dropped, and a trailing `.xhtml` or `.html` is removed;
- the stem is sanitized the same way as a page name: forbidden characters are removed, trailing dots and spaces are stripped, and a reserved Windows device name such as `con` or `lpt1` is prefixed with `_`;
- the stem is capped at 190 code points;
- the four-digit ordinal stays first, so a plain name sort is still reading order;
- the whole entry is then built to fit the 255-byte limit of a filename on every target filesystem. The ordinal and the extension are measured first in UTF-8, and the stem is truncated character by character until what is left fits the budget. A page with no usable stem is just `0001.jpg`.

The policy lives on the `dokuha` side, in `src/download/page-files.js`, and reaches the vendored engine as an optional `options.pageName(index, source, extension)` hook. With no hook the engine keeps its historical `page-NNNN.jpg` name.

## What mokuro-bridge receives

Bridge uploads always use `page_NNNN.ext`: the word `page`, an underscore, a one-based ordinal padded to four digits, and the lowercase extension. It is deliberately close to, but not the same as, the on-disk name, because the bridge sorts pages itself. The bridge path sorts by the ordinal encoded in each file's name rather than by the whole string, so a folder holding both `0001 cover.jpg` and a leftover `page-0002.jpg` still interleaves in reading order.
