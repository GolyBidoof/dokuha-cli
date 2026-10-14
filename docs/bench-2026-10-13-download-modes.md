# Five stores, two download modes: an end to end benchmark

Measured 2026-10-13. This is a wall clock and disk benchmark of whole free series, not a phase breakdown. It answers two questions: how long a store's free volumes take when they are fetched one at a time and when they are fetched concurrently, and what actually lands on disk. The per phase view of the same stores is in [bench-5-stores.md](bench-5-stores.md).

## Method

Each store was handed its series entry point and the tool's own series mode, so the tool discovered the free volumes itself and no volume was named by hand. Two arms per store:

- **serial**: `--parallel 1`, one volume at a time.
- **parallel**: no `--parallel` flag, which is the tool's default and starts every discovered volume at once.

Every run used `--series --no-state --no-progress --json`, wrote into a fresh scratch directory under `/tmp`, and used no `--mokuro`. `--no-state` keeps the cached free volume licence out of the comparison, so a later arm cannot benefit from a handshake an earlier arm warmed. Size is the sum of the bytes of every file the run wrote, measured after the command exited. Resolution is read from the header of every page image, not from a store's nominal size. Volume and page counts come from the folder layout and cross check with the run's own `--json` summary.

Each store ran its serial arm first and its parallel arm second. Because the first arm on CMOA and BookWalker was much slower than their later arms, the pair was then repeated with the order inverted, and CMOA was repeated twice more, so the store's own drift can be told apart from the flag. Each arm is a separate process writing into an empty directory, so nothing is shared between arms except the store itself.

## Machine and tool context

- Node v26.7.0
- dokuha 0.1.0, from this working tree
- macOS 27.2 (build 26B5101f)
- Apple M4 Pro, 14 cores, 24 GB RAM
- One store at a time, so the five did not contend with each other. A desktop browser was open throughout.

## Results

The requested two runs per store, serial first. Time per volume is the wall time divided by the volume count, so the numbers can be read both ways.

| store | mode | volumes | pages | size (MB) | wall (s) | s per volume | resolution |
|---|---|---|---|---|---|---|---|
| CMOA | serial | 3 | 600 | 184.3 | 110.5 | 36.8 | 760 x 1200 (600 pages) |
| CMOA | parallel | 3 | 600 | 184.3 | 17.0 | 5.7 | 760 x 1200 (600 pages) |
| BookWalker | serial | 3 | 600 | 159.8 | 19.7 | 6.6 | 760 x 1200 (600 pages) |
| BookWalker | parallel | 3 | 600 | 159.8 | 5.2 | 1.7 | 760 x 1200 (600 pages) |
| ebookjapan | serial | 3 | 600 | 208.2 | 41.5 | 13.8 | 760 x 1200 (600 pages) |
| ebookjapan | parallel | 3 | 600 | 208.2 | 18.4 | 6.1 | 760 x 1200 (600 pages) |
| Kindle | serial | 3 | 603 | 136.6 | 224.2 | 74.7 | 760 x 1200 (600 pages), 880 x 1200 (3 pages) |
| Kindle | parallel | 3 | 603 | 136.6 | 220.9 | 73.6 | 760 x 1200 (600 pages), 880 x 1200 (3 pages) |
| k-manga | serial | 2 | 376 | 153.0 | 31.2 | 15.6 | 760 x 1200 (376 pages) |
| k-manga | parallel | 2 | 376 | 153.0 | 25.7 | 12.8 | 760 x 1200 (376 pages) |

The volume counts are the tool's own discovery: three free volumes for four stores and two for k-manga. k-manga's eight remaining volumes are sampler-only and were skipped, which is what `--series` does without `--download-samplers`.

## Every arm, in execution order

The first table alone overstates the flag on two stores, because the first arm on CMOA and BookWalker was much slower than their later arms. These are all the arms that were run, in the order they ran.

| store | arm | mode | wall (s) | s per volume |
|---|---|---|---|---|
| CMOA | 1 | serial | 110.5 | 36.8 |
| CMOA | 2 | parallel | 17.0 | 5.7 |
| CMOA | 3 | parallel | 11.4 | 3.8 |
| CMOA | 4 | serial | 9.9 | 3.3 |
| CMOA | 5 | serial | 20.5 | 6.8 |
| CMOA | 6 | parallel | 6.8 | 2.3 |
| CMOA | 7 | parallel | 6.3 | 2.1 |
| CMOA | 8 | serial | 7.1 | 2.4 |
| BookWalker | 1 | serial | 19.7 | 6.6 |
| BookWalker | 2 | parallel | 5.2 | 1.7 |
| BookWalker | 3 | parallel | 6.8 | 2.3 |
| BookWalker | 4 | serial | 7.8 | 2.6 |
| ebookjapan | 1 | serial | 41.5 | 13.8 |
| ebookjapan | 2 | parallel | 18.4 | 6.1 |
| ebookjapan | 3 | parallel | 32.4 | 10.8 |
| ebookjapan | 4 | serial | 49.4 | 16.5 |
| Kindle | 1 | serial | 224.2 | 74.7 |
| Kindle | 2 | parallel | 220.9 | 73.6 |
| Kindle | 3 | parallel | 218.7 | 72.9 |
| Kindle | 4 | serial | 219.6 | 73.2 |
| k-manga | 1 | serial | 31.2 | 15.6 |
| k-manga | 2 | parallel | 25.7 | 12.8 |
| k-manga | 3 | parallel | 15.6 | 7.8 |
| k-manga | 4 | serial | 32.3 | 16.2 |

| store | serial arms (s) | parallel arms (s) | serial median | parallel median | reading |
|---|---|---|---|---|---|
| CMOA | 110.5, 9.9, 20.5, 7.1 | 17.0, 11.4, 6.8, 6.3 | 9.9 without the first arm | 9.1 | no reliable flag effect |
| BookWalker | 19.7, 7.8 | 5.2, 6.8 | 7.8 without the first arm | 6.0 | parallel faster in both orders |
| ebookjapan | 41.5, 49.4 | 18.4, 32.4 | 45.4 | 25.4 | parallel faster in both orders |
| Kindle | 224.2, 219.6 | 220.9, 218.7 | 221.9 | 219.8 | flat |
| k-manga | 31.2, 32.3 | 25.7, 15.6 | 31.8 | 20.6 | parallel faster in both orders |

## What the numbers say

Where the direction survives the order change, parallelism is doing real work. ebookjapan is the clearest case: parallel was faster in both orders, 18.4 s and 32.4 s against 41.5 s and 49.4 s, and it is the one store where the machine rather than the network is the limit. Its concurrent volumes are not individually faster: they take 15.4 s to 17.2 s each against 9.3 s to 18.8 s alone, so the win is overlap rather than extra throughput. k-manga also had parallel faster in both orders, 25.7 s and 15.6 s against 31.2 s and 32.3 s, though its per volume times are noisy in every arm, which is the store's own instability rather than the tool's scheduling. BookWalker points the same way on a smaller scale, 5.2 s and 6.8 s against 19.7 s and 7.8 s, where only the first serial arm is slow.

CMOA is the store that behaved unexpectedly, and it is the reason this page reports every arm rather than two. In the requested runs it reads as a 6.5x win, 110.5 s one at a time against 17.0 s together. Read in execution order, the 110.5 s is the first arm of the day and every later CMOA arm is between 6.3 s and 20.5 s, with medians of 9.9 s serial and 9.1 s parallel. The 6.5x is therefore the store being slow during one arm, not the flag. Nothing in the tool is shared between arms, so the cause is outside it.

Parallelism does not help Kindle, and the reason is structural rather than a bug. Its four arms span 218.7 s to 224.2 s, a 2.5 % spread. The three volumes' own work, as the run's own `--json` reports it, is about 31 s to 38 s of a 220 s run; the rest is series discovery. At the time of this run that was a forward walk, one reader request per volume, serial by construction and paid in full by both arms. It has since been replaced by one series-list request with the per-volume access checks run at once, so the structural argument here no longer describes the current tool, though these measurements stand as what was true that day. Raising `--parallel` cannot touch it, and it is why Kindle is the slowest store end to end despite writing the fewest bytes.

Resolution is uniform across all five stores: 760 x 1200 for every page except three Kindle cover pages at 880 x 1200. Bytes per page still differ by store, from 227 KB on Kindle to 407 KB on k-manga at the same pixel count, because each store's encoding differs.

## Method notes and caveats

- The first arm of the day, CMOA serial, is roughly ten times slower than every later CMOA arm. The tool does not cache pages between runs and each arm wrote into an empty directory, so the outlier is store side. Every other reading on this page is drawn from all the arms, not from the requested pair alone.
- `--no-state` disables the cached free volume licence, so every arm handshakes from scratch. Without it the later arm of BookWalker in particular could reuse a licence the earlier arm had already fetched.
- Every arm wrote into an empty directory and none used `--force`, so nothing was skipped and no page came from an earlier run. The byte count of an arm and its repeat matched apart from a one byte metadata difference on ebookjapan.
- Size is bytes on disk and includes each volume's small `metadata.json`, plus `manifest.json` on ebookjapan, so it is very slightly above the sum of the page images.
- Kindle has no anonymous route at all, even for a limited time free volume, so its runs used a saved Amazon reader session already present on the machine. The other four stores needed no session.
- Resolution was read from every page's image header, not from the store's nominal size, and a range is reported when the pages differ.
- Wall time is measured around the whole command, so it includes the tool's own series discovery. On Kindle that discovery is the dominant cost, which is why its arms are almost identical.
- The serial and parallel arms of a store are only two samples of a store whose latency moves by more than 2x between arms. The medians above are read with that in mind, and a store whose arms disagree is reported as inconclusive rather than as a win.
