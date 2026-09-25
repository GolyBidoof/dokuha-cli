# Changelog

## v0.1.0

First release. A browserless CLI that drives three store engines vendored in-tree.

Added:

- `manga-dl URL...` downloads CMOA, ebookjapan and BookWalker volumes in parallel,
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
