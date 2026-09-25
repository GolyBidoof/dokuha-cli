/**
 * Compact in-place terminal progress.
 *
 * Designed for many volumes running at once: each in-flight volume gets a
 * single line, finished ones collapse into one summary line, and a totals
 * footer aggregates every volume. The whole block is rewritten in place by
 * moving the cursor up over the previous block, so the console is never
 * flooded — one redraw per ~80 ms, not one line per event.
 *
 *   ebj download + mokuro · 12 volumes            01:23  3 done
 *   ▶ 賭ケグルイ （1）【無料お試し版】   [####------]  44%  118/249 · OCR 96/118 · 40 MiB
 *   ▶ 賭ケグルイ （2）【無料お試し版】   [########--]  78%  231/280 · 71 MiB
 *   ✓ 賭ケグルイ （3）【無料お試し版】   249p · OCR 249 · MEGA
 *   ────────────────────────────────────────────────────────────
 *   3 volumes · 998/1057 pages · 250 MiB · OCR 470 · 1 failed · 82 MiB/s
 *
 * On a non-TTY (pipe, file, CI) the same block is emitted at intervals instead
 * of being rewritten, so logs stay short and readable.
 */

const C = {
  reset: '\x1b[0m', dim: '\x1b[2m', bold: '\x1b[1m',
  red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m', cyan: '\x1b[36m',
};

function useColor(stream) {
  if (process.env.NO_COLOR != null) return false;
  if (process.env.EBJ_COLOR === 'always') return true;
  if (process.env.EBJ_COLOR === 'never') return false;
  return Boolean(stream && stream.isTTY);
}

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const num = v => (Number.isFinite(Number(v)) && Number(v) >= 0 ? Number(v) : 0);

export function bar(done, total, width = 14) {
  const t = num(total), d = clamp(num(done), 0, t || width);
  const fill = t > 0 ? Math.round((width * d) / t) : 0;
  return `${'#'.repeat(fill)}${'-'.repeat(width - fill)}`;
}

export function humanBytes(n) {
  const b = num(n);
  if (b < 1024) return `${b} B`;
  if (b < 1048576) return `${(b / 1024).toFixed(1)} KiB`;
  if (b < 1073741824) return `${(b / 1048576).toFixed(1)} MiB`;
  return `${(b / 1073741824).toFixed(2)} GiB`;
}

export function humanTime(sec) {
  const s = Math.max(0, num(sec));
  if (s < 60) return `${s.toFixed(1)}s`;
  if (s < 3600) {
    const m = Math.floor(s / 60), r = Math.round(s % 60);
    return `${m}m${String(r).padStart(2, '0')}s`;
  }
  const h = Math.floor(s / 3600), m = Math.round((s % 3600) / 60);
  return `${h}h${String(m).padStart(2, '0')}m`;
}

function clean(s, n = 44) {
  const t = String(s ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n - 1) + '…' : t;
}

/** Visual for a stage that is running without a known total. */
const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

/** Short label for what a volume is doing right now. */
function stageLabel(v) {
  switch (v.state) {
    case 'downloading': return 'download';
    case 'downloaded': return 'descramble';
    case 'descrambling': return 'descramble';
    case 'thumbnails': return 'thumbs';
    case 'uploading': return 'upload';
    case 'OCR': return 'OCR';
    case 'assembling': return 'assemble';
    case 'packaging': return 'pack';
    case 'uploading output': return 'store';
    case 'cleaning': return 'cleanup';
    case 'complete': return 'done';
    case 'error': return 'error';
    default: return clean(v.state || 'working', 10);
  }
}

export class Progress {
  /**
   * @param {object}  [opts]
   * @param {boolean} [opts.compact]  One line per volume instead of two.
   * @param {number}  [opts.maxLines] Cap the live block height.
   */
  constructor({ stream = process.stderr, quiet = false, compact = false, maxLines = 24 } = {}) {
    this.stream = stream;
    this.quiet = quiet;
    this.color = useColor(stream);
    // EBJ_FORCE_TTY renders the live block into captured output, which is the
    // only way to inspect the real layout when stderr is redirected.
    this.tty = (process.env.EBJ_FORCE_TTY === '1' || Boolean(stream && stream.isTTY)) && !quiet;
    this.compact = compact;
    this.maxLines = maxLines;
    this.prevLines = 0;
    this.volumes = new Map();
    this.order = [];
    this.header = '';
    this.started = Date.now();
    this.lastDraw = 0;
    this.sparseAt = 0;
    this.spin = 0;
    // Single-volume runs get the roomier two-line layout; parallel runs stay
    // terse so N volumes still fit on screen.
    this.mode = 'single';
  }

  paint(text, color) { return this.color && color ? `${C[color]}${text}${C.reset}` : text; }

  volume(name) {
    const key = String(name);
    let v = this.volumes.get(key);
    if (!v) {
      v = {
        name: key, total: 0, downloaded: 0, failed: 0, bytes: 0, stale: 0,
        uploadDone: 0, uploadFailed: 0, uploadSkipped: 0,
        ocrDone: 0, ocrTotal: 0, ocrPending: 0,
        storage: '', storagePct: 0, error: '',
        state: 'downloading', endedAt: 0,
      };
      this.volumes.set(key, v);
      this.order.push(key);
    }
    return v;
  }

  setHeader(text) { this.header = text; }

  update(name, patch) {
    const v = this.volume(name);
    Object.assign(v, patch);
    if (v.state === 'complete' || v.state === 'error') {
      if (!v.endedAt) v.endedAt = Date.now();
    } else {
      v.endedAt = 0;
    }
    this.draw();
  }

  /** Force a redraw even inside the throttle window. */
  flush(name, patch) {
    if (name && patch) Object.assign(this.volume(name), patch);
    this.draw(true);
  }

  /** Completed volumes as one summary line, most recent first. */
  finishedLine() {
    const done = this.order
      .map(k => this.volumes.get(k))
      .filter(v => v.state === 'complete' || v.state === 'error');
    if (!done.length) return null;
    const bad = done.filter(v => v.state === 'error');
    const latest = done[done.length - 1];
    const label = `${done.length} finished`;
    const tail = clean(latest.name, 30);
    return this.paint('✓', 'green') + ' ' + label +
      this.paint(` · ${tail}`, 'dim') +
      (bad.length ? this.paint(` · ${bad.length} failed`, 'red') : '');
  }

  /** Aggregate footer across every volume. */
  totalsLine() {
    const all = this.order.map(k => this.volumes.get(k));
    if (all.length < 2) return null;
    const pages = all.reduce((a, v) => a + num(v.total), 0);
    const got = all.reduce((a, v) => a + num(v.downloaded), 0);
    const bytes = all.reduce((a, v) => a + num(v.bytes), 0);
    const ocr = all.reduce((a, v) => a + num(v.ocrDone), 0);
    const failed = all.reduce((a, v) => a + num(v.failed) + num(v.uploadFailed), 0);
    const el = (Date.now() - this.started) / 1000;
    // Avoid a nonsense rate on the first redraws, where elapsed is ~0.
    const rate = bytes && el > 1 ? ` · ${humanBytes(bytes / el)}/s` : '';
    const pending = all.filter(v => v.state !== 'complete' && v.state !== 'error').length;
    const parts = [
      `${all.length} volumes`,
      pending ? `${pending} running` : 'all settled',
      `${got}/${pages || '?'} pages`,
      humanBytes(bytes),
    ];
    if (ocr) parts.push(`OCR ${ocr}`);
    if (failed) parts.push(this.paintLocal(`${failed} failed`));
    return this.paint(parts.join(' · ') + rate + ` · ${humanTime(el)}`, 'dim');
  }

  paintLocal(text) { return this.color ? `${C.red}${text}${C.reset}` : text; }

  /** The activity column: `[####----] 44% · 118/249`. */
  meter(v) {
    const total = num(v.ocrTotal) || num(v.total);
    if (v.state === 'OCR') {
      const done = num(v.ocrDone), t = total || 0;
      const pct = t ? Math.round((100 * done) / t) : 0;
      return `[${bar(done, t)}] ${String(pct).padStart(3)}%  OCR ${done}/${t || '?'}` +
        (v.ocrPending ? this.paint(` · ${v.ocrPending} pending`, 'yellow') : '');
    }
    if (v.state === 'uploading' || v.state === 'uploading output') {
      const t = num(v.total) || total;
      const done = num(v.uploadDone);
      const pct = t ? Math.round((100 * done) / t) : 0;
      return `[${bar(done, t)}] ${String(pct).padStart(3)}%  ${done}/${t || '?'}` +
        (v.uploadSkipped ? this.paint(` · ${v.uploadSkipped} cached`, 'dim') : '');
    }
    if (v.state === 'downloaded' || v.state === 'descrambling') {
      // The leading mark is already spinning; measuring percent is not useful
      // here because the descrambler reports only on completion.
      // The leading spinner already shows it is working, so this column carries
      // the page count instead of a second spinner.
      return this.paint(`${v.total || '?'} pages reassembling`, 'dim');
    }
    if (v.state === 'complete') {
      const bits = [`${v.total || '?'}p`];
      if (v.ocrDone) bits.push(`OCR ${v.ocrDone}`);
      if (v.storage) bits.push(clean(v.storage, 22));
      return this.paint(bits.join(' · '), 'green');
    }
    if (v.state === 'error') return this.paint(`✗ ${clean(v.error || v.storage || 'failed', 50)}`, 'red');
    // downloading / finalizing / packaging / etc.
    const t = num(v.total);
    const d = num(v.downloaded);
    const pct = t ? Math.round((100 * d) / t) : 0;
    const suffix = v.state === 'downloading' ? '' : ` · ${stageLabel(v)}`;
    return `[${bar(d, t)}] ${String(pct).padStart(3)}%  ${d}/${t || '?'}${suffix}` +
      (v.failed ? this.paint(` · ${v.failed} failed`, 'red') : '') +
      (v.bytes ? this.paint(` · ${humanBytes(v.bytes)}`, 'dim') : '');
  }

  /** The second line for the roomy single-volume layout. */
  noteLine(v) {
    // The meter already states where it went; the note adds where it lives.
    if (v.state === 'complete') return clean(v.path || '', 64);
    if (v.state === 'error') return clean(v.error || 'failed', 64);
    if (v.state === 'downloading') {
      const el = (Date.now() - this.started) / 1000;
      const rate = v.bytes && el > 1 ? ` · ${humanBytes(v.bytes / el)}/s` : '';
      return `saving to disk${rate}`;
    }
    if (v.state === 'OCR' && v.ocrPending) return `${v.ocrPending} pages left to read`;
    if (v.storage) return clean(v.storage, 64);
    if (v.uploadSkipped) return `${v.uploadSkipped} pages already OCR'd`;
    return '';
  }

  /** One volume rendered as one or two lines. */
  renderVolume(v) {
    const mark = v.state === 'complete' ? this.paint('✓', 'green')
      : v.state === 'error' ? this.paint('✗', 'red')
      : this.paint(SPINNER[this.spin % SPINNER.length], 'cyan');
    const name = this.paint(clean(v.name, this.compact ? 34 : 40), 'bold');
    const stage = this.paint(stageLabel(v).padEnd(9), 'dim');
    const lines = [`  ${mark} ${name}  ${stage} ${this.meter(v)}`];
    // Roomier layout for a single volume: show the destination / note.
    if (!this.compact) {
      const note = this.noteLine(v);
      if (note) lines.push('      ' + this.paint(note, 'dim'));
    }
    return lines;
  }

  draw(force = false) {
    if (this.quiet) return;
    const now = Date.now();
    // Throttling is what keeps the console from flooding under many volumes.
    if (!force && now - this.lastDraw < 80) return;
    this.lastDraw = now;
    this.spin++;

    const live = this.order.map(k => this.volumes.get(k))
      .filter(v => v.state !== 'complete' && v.state !== 'error');
    const finished = this.order.length - live.length;

    // Keep finished volumes summarised rather than listed, so the block height
    // stays bounded no matter how many volumes run.
    const shown = live.length ? live : this.order.slice(-1).map(k => this.volumes.get(k));
    const budget = Math.max(4, this.maxLines - 3);
    const clipped = shown.length > budget;
    const visible = clipped ? shown.slice(-budget) : shown;

    const lines = [];
    const el = (now - this.started) / 1000;
    if (this.header) {
      const tail = [
        this.order.length > 1 ? `${this.order.length} volumes` : '',
        finished ? `${finished} done` : '',
      ].filter(Boolean).join(' · ');
      lines.push(
        this.paint('ebj', 'cyan') + ' ' + this.header +
        (tail ? this.paint(` · ${tail}`, 'dim') : '') +
        '  ' + this.paint(humanTime(el), 'dim'));
    }
    if (clipped) lines.push('  ' + this.paint(`… ${shown.length - visible.length} more running`, 'dim'));
    for (const v of visible) lines.push(...this.renderVolume(v));
    // A single volume already shows its own result line; a "1 finished"
    // summary would just repeat it.
    if (finished && this.order.length > 1) lines.push('  ' + this.finishedLine());

    const totals = this.totalsLine();
    if (totals) lines.push(this.paint('─'.repeat(64), 'dim'), totals);

    if (this.tty) {
      if (this.prevLines) this.stream.write(`\x1b[${this.prevLines}A`);
      for (const line of lines) this.stream.write('\r\x1b[2K' + line + '\n');
      this.stream.write('\x1b[0J');
      this.prevLines = lines.length;
    } else if (force || now - this.sparseAt > 5000) {
      this.sparseAt = now;
      this.stream.write(lines.join('\n') + '\n');
    }
  }

  /** Clear the live block (call before printing final output). */
  done() {
    if (this.tty && this.prevLines) {
      this.stream.write(`\x1b[${this.prevLines}A`);
      for (let i = 0; i < this.prevLines; i++) this.stream.write('\r\x1b[2K\n');
      this.stream.write(`\x1b[${this.prevLines}A`);
      this.prevLines = 0;
    }
  }
}
