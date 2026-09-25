/**
 * Live multi-volume progress display.
 *
 * The old output printed one line per volume at the *end* of that volume, so a
 * run that spends most of its wall time in the mokuro bridge showed nothing at
 * all until the downloads finished. This renders a persistent block instead:
 * one line per running volume, redrawn in place, with the current phase and a
 * meter for that phase.
 *
 * Design constraints that shaped it:
 *
 *  - Volumes are worked in parallel, so a single cursor line is not enough;
 *    the block is rewritten with an absolute cursor move each frame.
 *  - Three tools report very differently: CMOA has an `onProgress` callback,
 *    BookWalker has `onProgress` events, and ebookjapan is a subprocess whose
 *    live block has to be parsed off stderr. All three funnel into `update()`.
 *  - The bridge's OCR phase is polled, not streamed, so `pollOcr()` drives that
 *    phase's meter and the frame rate is raised while it is the active work.
 *  - `--quiet`, `--json` and a non-TTY stream fall back to plain, timestamped
 *    lines: a redrawn block is meaningless in a log file or a pipe.
 */

const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

const C = {
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  bold: '\x1b[1m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
  // Bright white, so the upload bar stands apart from the default foreground.
  white: '\x1b[97m',
};

/** Phase order matters: a volume only ever moves forward through these. */
const PHASES = ['queued', 'downloading', 'uploading', 'ocr', 'finalizing', 'done', 'error'];

/** Short forms for the header's phase breakdown. */
const PHASE_SHORT = {
  downloading: 'get',
  uploading: 'push',
  ocr: 'ocr',
  finalizing: 'pack',
};

const PHASE_LABEL = {
  queued: 'waiting',
  downloading: 'download',
  uploading: 'upload',
  ocr: 'OCR',
  finalizing: 'finalize',
  done: 'done',
  error: 'failed',
};

function useColor(stream) {
  if (process.env.NO_COLOR) return false;
  if (process.env.FORCE_COLOR) return true;
  return Boolean(stream && stream.isTTY);
}

function humanBytes(n) {
  if (!n) return '0 B';
  if (n < 1024) return `${n} B`;
  if (n < 1048576) return `${(n / 1024).toFixed(0)} KiB`;
  if (n < 1073741824) return `${(n / 1048576).toFixed(1)} MiB`;
  return `${(n / 1073741824).toFixed(2)} GiB`;
}

export function humanTime(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return '--:--';
  const s = Math.floor(seconds);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s`;
  return `${Math.floor(s / 3600)}h${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}m`;
}

/** Visible width, ignoring ANSI sequences and counting East Asian wide chars as 2. */
export function displayWidth(text) {
  const plain = String(text).replace(/\x1b\[[0-9;]*m/g, '');
  let width = 0;
  for (const ch of plain) {
    const cp = ch.codePointAt(0);
    if (
      (cp >= 0x1100 && cp <= 0x115f) ||
      (cp >= 0x2e80 && cp <= 0xa4cf) ||
      (cp >= 0xac00 && cp <= 0xd7a3) ||
      (cp >= 0xf900 && cp <= 0xfaff) ||
      (cp >= 0xfe30 && cp <= 0xfe6f) ||
      (cp >= 0xff00 && cp <= 0xff60) ||
      (cp >= 0xffe0 && cp <= 0xffe6) ||
      (cp >= 0x20000 && cp <= 0x3fffd)
    ) {
      width += 2;
    } else {
      width += 1;
    }
  }
  return width;
}

/**
 * Pad to `width` display columns.
 *
 * `String.prototype.padEnd` counts UTF-16 units, so a Japanese title "padded" to
 * 40 comes out 80 columns wide and wraps the line — which desynchronises the
 * cursor arithmetic and paints the display over itself. Padding has to be
 * measured the same way truncation is.
 */
export function padTo(text, width) {
  const s = String(text ?? '');
  const missing = width - displayWidth(s);
  return missing > 0 ? s + ' '.repeat(missing) : s;
}

/**
 * Hard-clamp a line to `width` display columns.
 *
 * The last line of defence for the cursor maths: a wrapped line makes the block
 * taller than `drawnLines` claims, so the next redraw starts in the wrong place.
 */
function clampLine(line, width) {
  if (displayWidth(line) <= width) return line;
  // Keep any trailing ANSI reset so the clamp cannot leak colour.
  const suffix = line.endsWith(C.reset) ? C.reset : '';
  const body = suffix ? line.slice(0, -C.reset.length) : line;
  return truncate(body, width) + suffix;
}

/**
 * Truncate to `max` display columns, adding an ellipsis when cut.
 *
 * Colour is carried through: any escape sequence encountered before the cut is
 * kept, and a reset is appended if the slice ended while a colour was open.
 * Slicing naively cut a line mid-bar and dropped the bar's closing reset, which
 * then leaked the bar's colour into every line printed after it.
 */
export function truncate(text, max) {
  const s = String(text ?? '');
  if (displayWidth(s) <= max) return s;
  const reset = '\x1b[0m';
  let out = '';
  let width = 0;
  // Track the last colour opened and, if one is open at the cut, emit that same
  // colour immediately before the reset. Redundant but unambiguous: it makes the
  // last colour in the string the correct one, so nothing downstream has to parse
  // the sequence to work out what to close.
  let open = null;
  for (let i = 0; i < s.length; ) {
    if (s[i] === '\x1b') {
      const m = /^\x1b\[[0-9;]*m/.exec(s.slice(i));
      if (m) {
        out += m[0];
        open = m[0] === reset ? null : m[0];
        i += m[0].length;
        continue;
      }
    }
    const ch = s[i];
    const w = displayWidth(ch);
    if (width + w > max - 1) break;
    out += ch;
    width += w;
    i += ch.length;
  }
  return `${out}…${open ? open + reset : ''}`;
}

export class LiveProgress {
  /**
   * @param {object}  [options]
   * @param {boolean} [options.quiet]  suppress everything
   * @param {boolean} [options.plain]  force the non-redrawing fallback
   * @param {number}  [options.width]  override the detected terminal width
   * @param {number}  [options.maxLines] cap how many volume lines are shown
   */
  constructor({ stream = process.stderr, quiet = false, plain = false, width = null, maxLines = 10 } = {}) {
    this.stream = stream;
    this.quiet = quiet;
    this.color = useColor(stream);
    // A redrawn block only makes sense on a terminal. Piped output keeps the
    // plain path so logs stay readable and greppable.
    this.tty = !plain && !quiet && Boolean(stream && stream.isTTY);
    this.maxLines = maxLines;
    this.width = width || (stream && stream.columns) || 100;
    this.volumes = [];
    this.byKey = new Map();
    this.started = Date.now();
    this.drawnLines = 0;
    this.lastDraw = 0;
    this.spin = 0;
    this.phase = '';
    this.timer = null;
    // How many rows have been written since the block was anchored.
    this.bufferRow = 0;
    // Row offset of the block's first line relative to the cursor, and whether a
    // block is currently on screen. The position is tracked in software rather
    // than left to the terminal: DEC save/restore looks simpler, but the saved
    // cursor is process-global state on the pty and the ebookjapan subprocess
    // draws its own live block through the same terminal, wiping it out. The
    // result was `ESC 8` with no matching `ESC 7`, so every frame appended
    // instead of overwriting.
    this.anchorOffset = 0;
    this.anchored = false;
    /** Count of progress calls that referenced an unregistered volume. */
    this.misuseCount = 0;
    this.misuseDetail = '';
  }

  /** Record a progress-layer misuse without letting it affect the run. */
  misuse(detail) {
    this.misuseCount++;
    if (!this.misuseDetail) this.misuseDetail = detail;
  }

  paint(text, color) {
    return this.color && color ? `${C[color]}${text}${C.reset}` : String(text);
  }

  // ---------------------------------------------------------------- volumes
  /** Register a volume up front so it is visible while still queued. */
  add(key, { tag, label } = {}) {
    if (!key) {
      this.misuse(`add with key ${JSON.stringify(key)}`);
      return null;
    }
    if (this.byKey.has(key)) return this.byKey.get(key);
    const volume = {
      key,
      tag: tag || '?',
      label: label || key,
      index: this.volumes.length + 1,
      total: 0,
      done: 0,
      failed: 0,
      bytes: 0,
      upload: 0,
      uploadTotal: 0,
      uploadCached: 0,
      ocr: 0,
      ocrTotal: 0,
      ocrPending: 0,
      phase: 'queued',
      note: '',
      error: '',
      // Pages belonging to a *finished* volume. Kept separately from `done`
      // because `done` counts pages that have arrived at any stage: BookWalker
      // reports a page as done once it is pushed to the bridge, so using it for
      // overall progress made a batch with one book of seven finished read 89%.
      completed: 0,
      // The phase the volume was in when it failed, so its bar can still show how
      // far it got instead of collapsing to an empty row.
      errorPhase: null,
      startedAt: Date.now(),
      endedAt: 0,
    };
    this.volumes.push(volume);
    this.byKey.set(key, volume);
    return volume;
  }

  /**
   * Merge state into a volume.
   *
   * Phase transitions are forward-only, so a late progress event from an earlier
   * phase (a stray download callback arriving during OCR) cannot move a volume
   * backwards on screen.
   */
  update(key, patch = {}) {
    const volume = this.byKey.get(key);
    if (!volume) {
      // Deliberately not fatal. A display widget must never be able to fail a
      // download, which is exactly what throwing here did once. Unknown keys are
      // counted and reported at the end instead.
      // `LIVE_PROGRESS_TRACE=1` prints the call site, which is the quickest way
      // to find the offending wiring when this counter is ever non-zero.
      if (process.env.LIVE_PROGRESS_TRACE) {
        const where = new Error().stack.split('\n').slice(2, 5).map((l) => l.trim()).join(' <- ');
        process.stderr.write(`\n[progress-trace] update(${JSON.stringify(key)}, ${JSON.stringify(patch)}) ${where}\n`);
      }
      this.misuse(`update for key ${JSON.stringify(key)}`);
      return null;
    }
    const { phase, ...rest } = patch;
    Object.assign(volume, rest);
    if (phase && PHASES.indexOf(phase) > PHASES.indexOf(volume.phase)) {
      // Remember how far it had got, in case it fails in the new phase.
      volume.errorPhase = volume.phase;
      volume.phase = phase;
    }
    if (phase === 'done' || phase === 'error') {
      if (volume.phase !== 'error') volume.phase = phase;
      volume.endedAt = Date.now();
    }
    this.tick();
    return volume;
  }

  /** Mark a volume finished. `error` decides whether it counts as failed. */
  finish(key, { error = '', bytes = 0 } = {}) {
    const volume = this.byKey.get(key);
    if (!volume) {
      this.misuse(`finish for key ${JSON.stringify(key)}`);
      return;
    }
    if (bytes) volume.bytes = bytes;
    if (error) {
      volume.error = error;
      volume.errorPhase = volume.phase === 'error' ? volume.errorPhase : volume.phase;
      volume.phase = 'error';
    } else if (volume.phase !== 'error') {
      volume.completed = volume.total || volume.done || 0;
      volume.phase = 'done';
    }
    volume.endedAt = Date.now();
    if (this.tty) this.draw(true);
    else this.plainLine(volume);
  }

  /**
   * A free-form line that must not fight the redrawn block.
   *
   * On a terminal the block is erased first, the line is written, and the block
   * is repainted immediately. Writing the line and waiting for the next tick used
   * to leave the frame scrolled mid-block, which is what produced stray fragments
   * like a lone "2" on its own line.
   */
  note(text) {
    if (this.quiet) return;
    if (!this.tty) {
      this.stream.write(text.endsWith('\n') ? text : `${text}\n`);
      return;
    }
    // On a terminal the block is redrawn in place; see below.
    // Put the cursor on the block's first row and erase the block, so the note
    // takes its place as ordinary, permanent output.
    this.clear();
    this.anchored = false;
    const line = text.endsWith('\n') ? text : `${text}\n`;
    this.stream.write(line);
    // The note now occupies the rows the block used to, so the block's new
    // anchor is the row after the note. Advancing the offset updates both the
    // anchor and `bufferRow` together, because `bufferRow` is set to the anchor
    // whenever the cursor is on it.
    this.anchorOffset += (line.match(/\n/g) || []).length;
    this.bufferRow = this.anchorOffset;
    this.drawnLines = 0;
    this.draw(true);
  }

  // ------------------------------------------------------------------ shape
  /** Fractional progress for the volume's current phase, or null if unknown. */
  fraction(volume) {
    const ratio = (done, total) => (total > 0 ? Math.min(1, done / total) : null);
    switch (volume.phase) {
      case 'downloading':
        return ratio(volume.done, volume.total);
      case 'uploading':
        return ratio(volume.upload + volume.uploadCached, volume.uploadTotal);
      case 'ocr': {
        const total = volume.ocrTotal || volume.uploadTotal;
        if (volume.ocrPending && total) return ratio(total - volume.ocrPending, total);
        return ratio(volume.ocr, total);
      }
      case 'finalizing':
        // Work is done; finalization has no measurable progress of its own.
        return 1;
      case 'done':
        return 1;
      case 'error':
        // Show how far it got rather than blanking the bar, so a failure keeps
        // its context instead of collapsing to an empty row.
        return this.fraction({ ...volume, phase: volume.errorPhase || 'downloading' });
      default:
        return null;
    }
  }

  /** The phase detail text, e.g. "120/244 pages". */
  detail(volume) {
    const parts = [];
    switch (volume.phase) {
      case 'downloading':
        if (volume.total) parts.push(`${volume.done}/${volume.total} pages`);
        if (volume.bytes) parts.push(humanBytes(volume.bytes));
        break;
      case 'uploading': {
        const sent = volume.upload + volume.uploadCached;
        if (volume.uploadTotal) parts.push(`${sent}/${volume.uploadTotal} pages`);
        if (volume.uploadCached) parts.push(`${volume.uploadCached} cached`);
        break;
      }
      case 'ocr': {
        const total = volume.ocrTotal || volume.uploadTotal;
        if (total) {
          const done = volume.ocrPending ? total - volume.ocrPending : volume.ocr;
          parts.push(`${done}/${total} pages`);
        }
        if (volume.ocrPending) parts.push(`${volume.ocrPending} pending`);
        break;
      }
      case 'finalizing':
        parts.push('assembling .mokuro');
        break;
      case 'done':
        if (volume.total) parts.push(`${volume.done}/${volume.total} pages`);
        if (volume.bytes) parts.push(humanBytes(volume.bytes));
        break;
      case 'error':
        parts.push(truncate(volume.error || 'failed', 60));
        break;
      default:
        parts.push('waiting');
    }
    if (volume.failed) parts.push(`${volume.failed} failed`);
    return parts.filter(Boolean).join('  ');
  }

  /**
   * The bar's fill colour, which is what distinguishes the phases.
   *
   * Every phase draws the identical bar — same width, same characters — so a row
   * does not visually jump when it moves from download to upload to OCR. Only the
   * colour changes: network work is cyan, upload is white/bold, OCR is yellow,
   * and finished work is green so a completed volume still reads as complete.
   */
  meterColor(phase) {
    switch (phase) {
      case 'downloading':
        return 'cyan';
      case 'uploading':
        return 'white';
      case 'ocr':
        return 'yellow';
      case 'finalizing':
        return 'magenta';
      case 'done':
        return 'green';
      case 'error':
        return 'red';
      default:
        return null;
    }
  }

  /**
   * The phase bar. `width` is fixed so the column never shifts between phases,
   * and the colour is closed here so a finished row cannot tint whatever is
   * printed after it.
   */
  meter(volume, width = 12) {
    return this.bar(this.fraction(volume), this.meterColor(volume.phase), width);
  }

  /**
   * A bar of fixed `width`. Returns blanks for an unknown fraction so callers
   * that lay out columns keep their alignment.
   */
  bar(fraction, color, width) {
    if (fraction === null) return ' '.repeat(width);
    const filled = Math.max(0, Math.min(width, Math.round(fraction * width)));
    const body = `${'█'.repeat(filled)}${'░'.repeat(width - filled)}`;
    if (!this.color || !color) return body;
    return `${C[color]}${body}${C.reset}`;
  }

  marker(volume) {
    if (volume.phase === 'done') return this.paint('✓', 'green');
    if (volume.phase === 'error') return this.paint('✗', 'red');
    return this.paint(SPINNER[this.spin % SPINNER.length], 'cyan');
  }

  /**
   * One line per volume: marker, store, title, phase, meter, detail.
   *
   * One line per book rather than one line per phase, so a three-store run stays
   * three lines tall and does not scroll the terminal while it works. The title
   * is fixed-width (a wide CJK title in a variable-width column is what pushed
   * lines past the terminal edge and wrapped them), and the whole line is
   * clamped as a backstop.
   */
  renderVolume(volume) {
    const marker = this.marker(volume);
    const tag = this.paint(volume.tag, volume.phase === 'error' ? 'red' : 'cyan');
    const phase = this.paint(PHASE_LABEL[volume.phase].padEnd(8), 'dim');
    const meter = this.paint(this.meter(volume), volume.phase === 'error' ? 'red' : 'green');
    const detail = this.paint(this.detail(volume), volume.phase === 'done' ? 'green' : '');

    const labelWidth = Math.max(12, Math.min(46, this.width - 46));
    const label = this.paint(padTo(truncate(volume.label, labelWidth), labelWidth), 'bold');

    // Fit the detail text into what is left rather than letting `clampLine` cut
    // the line at the bar, which would slice the bar in half and drop its
    // closing colour reset onto whatever printed next.
    const used = 2 + 1 + 1 + 4 + 1 + labelWidth + 1 + 8 + 1 + 12 + 1;
    const detailText = truncate(detail, Math.max(6, this.width - used));

    return `  ${marker} ${tag} ${label} ${phase} ${meter} ${detailText}`.trimEnd();
  }

  /** How many volumes are in each phase, so the header can say what is running. */
  phaseCounts() {
    const counts = new Map();
    for (const v of this.volumes) counts.set(v.phase, (counts.get(v.phase) || 0) + 1);
    return counts;
  }

  /**
   * Aggregate page progress across the batch.
   *
   * `downloaded` counts every page that arrived; `known` is the sum of the page
   * counts of volumes that have reported one, which grows as volumes are opened.
   * They are kept apart because the old single summary line conflated them and
   * read `0/7 volumes · 234/234 pages` — looking complete when only one volume's
   * length was known.
   */
  totals() {
    const sum = (fn) => this.volumes.reduce((a, v) => a + fn(v), 0);
    const downloaded = sum((v) => v.done || 0);
    const known = sum((v) => v.total || 0);
    // Two different questions, deliberately answered by two different numbers:
    //
    //   downloaded  pages that have arrived, across all stages — the "is it
    //               moving" figure, and what the per-row detail shows.
    //   completed   pages in volumes that are actually *finished* — the honest
    //               basis for a completion bar, since a page merely pushed to the
    //               bridge is not a page done.
    //
    // Downloaded is clamped to the known total, which grows as volumes report
    // their length, so the counter never reads as more complete than it is.
    return {
      downloaded: known ? Math.min(downloaded, known) : downloaded,
      known,
      completed: sum((v) => v.completed || 0),
      ocr: sum((v) => v.ocr || 0),
      finished: this.volumes.filter((v) => v.phase === 'done').length,
      failed: this.volumes.filter((v) => v.phase === 'error').length,
      total: this.volumes.length,
      counts: this.phaseCounts(),
    };
  }

  /**
   * The bar colour for the run as a whole: the colour of the phase doing the
   * work, so the footer bar matches the rows it summarises.
   */
  overallColor(t) {
    if (t.failed === t.total && t.total > 0) return 'red';
    if (t.finished + t.failed === t.total && t.total > 0) return 'green';
    if (t.counts.get('ocr')) return 'yellow';
    if (t.counts.get('finalizing')) return 'magenta';
    if (t.counts.get('uploading')) return 'white';
    if (t.counts.get('downloading')) return 'cyan';
    return null;
  }

  /** Where the run has got to, as a fraction of the pages it knows about. */
  overallFraction(t) {
    if (t.known) return Math.min(1, t.completed / t.known);
    return null;
  }

  /** What the running volumes are doing, e.g. "3 push · 1 get". */
  phaseBreakdown(t) {
    const active = PHASES
      .filter((phase) => phase !== 'queued' && phase !== 'done' && phase !== 'error' && t.counts.has(phase))
      .map((phase) => this.paint(`${t.counts.get(phase)} ${PHASE_SHORT[phase]}`, this.meterColor(phase)));
    const queued = t.counts.get('queued') || 0;
    if (queued) active.push(this.paint(`${queued} queued`, 'dim'));
    return active;
  }

  /**
   * The two-line footer under the volume rows.
   *
   * Line one is a bar for the whole batch, which is what actually answers "how
   * much longer". Line two carries the counters and the phase breakdown, so the
   * parts that used to be crammed into one ambiguous line are now separable at a
   * glance: how many books are done, how many pages of how many known, how much
   * has been OCR'd, what is running, and the elapsed time.
   */
  footer() {
    const t = this.totals();
    const elapsed = (Date.now() - this.started) / 1000;

    // The bar is the whole width minus a fixed gutter for the percentage.
    const barWidth = Math.max(10, this.width - 8);
    const bar = this.bar(this.overallFraction(t), this.overallColor(t), barWidth);
    const pct = t.known ? `${Math.floor((t.completed / t.known) * 100)}%`.padStart(4) : '   -';
    const barLine = clampLine(`  ${bar} ${this.paint(pct, 'dim')}`, this.width);

    const counts = [];
    counts.push(`${t.finished + t.failed}/${t.total} done`);
    if (t.known) counts.push(`${t.downloaded}/${t.known} pages`);
    if (t.ocr) counts.push(this.paint(`${t.ocr} OCR'd`, 'yellow'));
    if (t.failed) counts.push(this.paint(`${t.failed} failed`, 'red'));
    counts.push(humanTime(elapsed));

    const phases = this.phaseBreakdown(t);
    const sep = this.paint(' · ', 'dim');
    const line2 = phases.length
      ? `  ${counts.join(sep)}${sep}${phases.join(sep)}`
      : `  ${counts.join(sep)}`;
    return [barLine, clampLine(this.paint(line2, 'dim'), this.width)];
  }

  // ----------------------------------------------------------------- output
  /**
   * Put the cursor back on the block's first row and erase what it drew.
   *
   * The block is anchored by remembering how many rows were written since its
   * first line, and stepping back up that many. This is explicit rather than
   * relying on DEC save/restore: the saved cursor lives on the tty, and the
   * ebookjapan subprocess writes its own live block to the same terminal, which
   * cleared it — leaving a bare restore with nothing to restore to, so the block
   * scrolled down the screen one frame at a time.
   *
   * Counting rows is safe here because every emitted line is clamped to the
   * terminal width (see `clampLine`), so none of them wrap.
   */
  clear() {
    if (!this.anchored) return;
    this.moveToAnchor();
    this.stream.write('\x1b[0J');
  }

  /**
   * Move the cursor up to the block's first row and adopt that row as current.
   *
   * `bufferRow` is deliberately set to the anchor: after moving, the cursor *is*
   * on the anchor row, so leaving the old (larger) value behind would make the
   * next clear step up past the block and erase unrelated output.
   */
  moveToAnchor() {
    const up = this.bufferRow > this.anchorOffset ? this.bufferRow - this.anchorOffset : 0;
    if (up > 0) this.stream.write(`\x1b[${up}A`);
    this.bufferRow = this.anchorOffset;
  }

  draw(force = false) {
    if (!this.tty || this.quiet) return;
    const now = Date.now();
    // ~12fps is enough to look live without flooding a slow terminal.
    if (!force && now - this.lastDraw < 80) return;
    this.lastDraw = now;
    this.spin++;

    const lines = [];
    const done = this.volumes.filter((v) => v.phase === 'done').length;
    const failed = this.volumes.filter((v) => v.phase === 'error').length;
    // Two footer lines are reserved, plus one for the overflow notice.
    const budget = Math.max(3, this.maxLines - 3);

    // Keep every volume on screen until the budget forces a choice, so a finished
    // book leaves its summary behind instead of vanishing from the block.
    //
    //   - everything fits: show all of them, in submission order.
    //   - it does not: show the running ones first, since those are the ones
    //     still changing, and keep the most recently finished as context.
    let visible;
    if (this.volumes.length <= budget) {
      visible = this.volumes;
    } else {
      const running = this.volumes.filter((v) => v.phase !== 'done' && v.phase !== 'error');
      const finished = this.volumes.filter((v) => v.phase === 'done' || v.phase === 'error');
      visible = running.slice(0, budget);
      for (const v of finished.slice(-(budget - visible.length))) visible.push(v);
      if (!visible.length) visible = this.volumes.slice(-1);
    }

    const hidden = this.volumes.length - visible.length;
    if (hidden > 0) lines.push(this.paint(`  … ${hidden} more`, 'dim'));
    for (const volume of visible) lines.push(this.renderVolume(volume));
    lines.push(...this.footer());

    const body = `${lines.join('\n')}\n`;
    if (this.anchored) {
      // Step back to the block's first row, erase downward, repaint in place.
      this.moveToAnchor();
      this.stream.write(`\x1b[0J${body}`);
    } else {
      // First frame for this anchor: the cursor sits just below the note that
      // preceded it, so paint downward and make this row the new anchor.
      this.stream.write(body);
      this.anchorOffset = this.bufferRow;
      this.anchored = true;
    }
    this.bufferRow += lines.length;
    this.drawnLines = lines.length;
  }

  /** The fallback for non-TTY output: one durable line per event. */
  plainLine(volume) {
    if (this.quiet) return;
    const mark = volume.phase === 'done' ? this.paint('✓', 'green') : this.paint('✗', 'red');
    const elapsed = humanTime(((volume.endedAt || Date.now()) - volume.startedAt) / 1000);
    const detail = this.detail(volume);
    this.stream.write(`  ${mark} ${volume.tag} ${truncate(volume.label, 44)}  ${detail}  ${elapsed}\n`);
  }

  /** Throttled redraw; also used as the polling hook. */
  tick() {
    if (!this.tty) return;
    this.draw();
  }

  /**
   * Keep redrawing while something is being polled.
   *
   * `waitForOcr` only learns about progress between polls, so without a timer the
   * spinner would freeze for the whole poll interval and look hung.
   */
  startTicker(intervalMs = 120) {
    if (!this.tty || this.timer) return;
    this.timer = setInterval(() => this.draw(), intervalMs);
    this.timer.unref?.();
  }

  stopTicker() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** Tear down: stop the timer and leave the final state on screen. */
  done() {
    this.stopTicker();
    if (!this.tty) return;
    // Paint once, then commit the block permanently: drop the anchor and step
    // past it so the summary and any trailing notes start on the next line
    // instead of on top of it. Re-anchoring here would print the block a second
    // time when the cursor was already sitting below it.
    if (this.anchored) {
      this.draw(true);
      this.anchored = false;
      this.drawnLines = 0;
      // Commit the block: step past it so the summary starts on the next row.
      this.stream.write('\n');
      this.bufferRow += 1;
    }
  }
}
