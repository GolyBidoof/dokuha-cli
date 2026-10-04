# Live probes

These are measurement harnesses, not tests: they talk to the real stores, they are
never run by `npm test`, and they do not download pages unless asked. They exist
because both of the last two rounds of concurrency work were justified by a number
somebody measured, and the measurements are worth being able to reproduce.

Every script reuses the shipped adapter code rather than reimplementing the protocol,
so a probe and a real run cannot drift apart in the parts that matter (the probes only
re-parameterise the parts under test, and say so where they copy a loop).

## Kindle

A Kindle probe needs a saved session (`~/.bwdd-cli/kindle-session.json`, or
`--kindle-cookie`) and a volume this account can open. It fetches render windows —
the walk — and never touches the page CDN, so it is cheap and safe.

```sh
# One walk, with a line per window: offset, batch, views, latency, cumulative time.
node scripts/probes/probe-kindle.mjs B0SAMPLE02 --depth 8

# Skip the shrink ladder by asserting the ceiling the first run discovered.
node scripts/probes/probe-kindle.mjs B0SAMPLE02 --depth 8 --batch 6

# What the render service actually accepts, and whether bundleImages changes anything.
node scripts/probes/probe-kindle-batch.mjs B0SAMPLE02
```

`probe-kindle.mjs` reimplements `walkKindleWindows` with a tunable prefetch depth,
because the depth is a module constant in the shipped code and the whole question is
what that constant should be. Everything it calls to build a URL, parse a tar and read
a manifest comes from `src/download/kindle-protocol.js`.

## k-manga

No credentials. The probe resolves the free volumes of the audit title, opens a real
viewer session, and drains pages over N sockets — counting bytes and timing, but
**not** descrambling and **not** writing, so what is timed is the store's own pacing.

```sh
node scripts/probes/probe-kmanga.mjs --sockets 4 --depth 16 --pages 16
node scripts/probes/probe-kmanga.mjs --sockets 1 --depth 16 --pages 16
```

It calls the shipped `drainPages`, so the scheduling under test is the real one.
`--pages N` truncates the sheet, which is what makes an interleaved comparison
possible in reasonable time; `--no-header` skips the header request on the extra
sockets, to answer whether they need one.

### Interleave, or the numbers are meaningless

k-manga's throughput varies by more than 5x over tens of minutes. A sequential sweep
of 1/2/3/4 sockets produced a clean monotonic line (1378, 1123, 599, 208 ms a page)
that was entirely the store warming up. Rotate the arms so drift hits each of them
equally:

```sh
for rep in 1 2 3; do
  for s in 1 2 4; do
    echo "##### rep=$rep sockets=$s"
    node scripts/probes/probe-kmanga.mjs --sockets $s --depth 16 --pages 16
  done
done
```

Two arms in a row are not enough to say anything; the medians are in
`docs/parallelism.md`, and a new claim needs at least the same shape of evidence.

## Headless end-to-end check

`live-kmanga-one.mjs` runs the shipped `downloadKmanga` on one real sampler volume,
with descrambling on and pages written to a temp folder, and prints the result. It is
the quickest way to confirm that a change to the pooling still produces valid JPEGs:

```sh
node scripts/probes/live-kmanga-one.mjs
```

## mokuro-bridge

The bridge path is a black box from dokuha's side, so these probes point at a
running bridge and report what it says.

`live-bridge-ingest.mjs` takes an already-downloaded volume folder (so it costs no
store traffic), hands it to the bridge through the shipped `pushToBridge`, and
finalizes to a temporary local directory. It prints every progress patch and the
final record. With folder ingest working, a 202-page volume is two requests; the
control arm is the per-page path:

```sh
node scripts/probes/live-bridge-ingest.mjs 'library/サンプル作品【期間限定無料】 1'
node scripts/probes/live-bridge-ingest.mjs 'library/サンプル作品【期間限定無料】 1' --no-folder-ingest
```

Two things to check before blaming dokuha for a failure: the bridge must be
**restarted** after any change to its own code, and it re-queues every image folder
under its work directory, so a leftover volume from an earlier attempt shows up as
`ocr_queue_depth` and will be OCR'd again. `GET /queue` says whether the OCR worker
is actually running (`worker.state`), which is the difference between a slow backlog
and a stuck one.
