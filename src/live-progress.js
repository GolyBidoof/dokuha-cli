import { C, useColor, humanBytes, humanTime, displayWidth, padTo, clampLine, truncate } from './ansi.js';

const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

const PHASES = ['queued', 'downloading', 'uploading', 'ocr', 'finalizing', 'done', 'error'];

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

export class LiveProgress {

  constructor({ stream = process.stderr, quiet = false, plain = false, width = null, maxLines = 10 } = {}) {
    this.stream = stream;
    this.quiet = quiet;
    this.color = useColor(stream);

    this.tty = !plain && !quiet && Boolean(stream && stream.isTTY);

    this.maxLines = maxLines;
    this.compact = false;

    this.keyboard = null;
    this.width = width || (stream && stream.columns) || 100;
    this.volumes = [];
    this.byKey = new Map();
    this.started = Date.now();
    this.drawnLines = 0;
    this.lastDraw = 0;
    this.spin = 0;
    this.phase = '';
    this.timer = null;

    this.bufferRow = 0;

    this.anchorOffset = 0;
    this.anchored = false;

    this.misuseCount = 0;
    this.misuseDetail = '';
  }

  misuse(detail) {
    this.misuseCount++;
    if (!this.misuseDetail) this.misuseDetail = detail;
  }

  paint(text, color) {
    return this.color && color ? `${C[color]}${text}${C.reset}` : String(text);
  }

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

      completed: 0,

      errorPhase: null,
      startedAt: Date.now(),
      endedAt: 0,
    };
    this.volumes.push(volume);
    this.byKey.set(key, volume);
    return volume;
  }

  update(key, patch = {}) {
    const volume = this.byKey.get(key);
    if (!volume) {

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

  finish(key, { error = '', bytes = 0, returned = false, tag = '' } = {}) {
    const volume = this.byKey.get(key);
    if (!volume) {
      this.misuse(`finish for key ${JSON.stringify(key)}`);
      return;
    }
    if (bytes) volume.bytes = bytes;

    if (returned) volume.returned = true;

    if (tag) volume.tag = tag;
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

  note(text) {
    if (this.quiet) return;
    if (!this.tty) {
      this.stream.write(text.endsWith('\n') ? text : `${text}\n`);
      return;
    }

    this.clear();
    this.anchored = false;
    const line = text.endsWith('\n') ? text : `${text}\n`;
    this.stream.write(line);

    this.anchorOffset += (line.match(/\n/g) || []).length;
    this.bufferRow = this.anchorOffset;
    this.drawnLines = 0;
    this.draw(true);
  }

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

        return volume.uploadBytesTotal > 0
          ? ratio(volume.uploadBytes || 0, volume.uploadBytesTotal)
          : 1;
      case 'done':
        return 1;
      case 'error': {

        const carried = this.fraction({ ...volume, phase: volume.errorPhase });
        if (carried !== null) return carried;
        return ratio(volume.done, volume.total) ?? 0;
      }
      default:
        return null;
    }
  }

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

        if (volume.uploadFile) {
          parts.push(truncate(volume.uploadFile, 34));

          if (volume.uploadBytes > 0 || volume.uploadSpeed) {
            if (volume.uploadPercent != null) parts.push(`${Math.floor(volume.uploadPercent)}%`);
            if (volume.uploadSpeed) parts.push(volume.uploadSpeed);
          } else {
            parts.push('waiting');
          }
        } else {
          parts.push('assembling .mokuro');
        }
        break;
      case 'done':
        if (volume.total) parts.push(`${volume.done}/${volume.total} pages`);
        if (volume.bytes) parts.push(humanBytes(volume.bytes));
        if (volume.returned) parts.push('returned');
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

  meter(volume, width = 12) {
    return this.bar(this.fraction(volume), this.meterColor(volume.phase), width);
  }

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

  renderVolume(volume) {
    const marker = this.marker(volume);
    const tag = this.paint(volume.tag, volume.phase === 'error' ? 'red' : 'cyan');
    const phase = this.paint(PHASE_LABEL[volume.phase].padEnd(8), 'dim');
    const meter = this.paint(this.meter(volume), volume.phase === 'error' ? 'red' : 'green');
    const detail = this.paint(this.detail(volume), volume.phase === 'done' ? 'green' : '');

    const labelWidth = Math.max(12, Math.min(46, this.width - 46));
    const label = this.paint(padTo(truncate(volume.label, labelWidth), labelWidth), 'bold');

    const used = 2 + 1 + 1 + 4 + 1 + labelWidth + 1 + 8 + 1 + 12 + 1;
    const detailText = truncate(detail, Math.max(6, this.width - used));

    return `  ${marker} ${tag} ${label} ${phase} ${meter} ${detailText}`.trimEnd();
  }

  phaseCounts() {
    const counts = new Map();
    for (const v of this.volumes) counts.set(v.phase, (counts.get(v.phase) || 0) + 1);
    return counts;
  }

  totals() {
    const sum = (fn) => this.volumes.reduce((a, v) => a + fn(v), 0);
    const downloaded = sum((v) => v.done || 0);
    const known = sum((v) => v.total || 0);

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

  overallColor(t) {
    if (t.total > 0 && t.finished + t.failed === t.total) return t.failed ? 'red' : 'green';
    if (t.counts.get('ocr')) return 'yellow';
    if (t.counts.get('finalizing')) return 'magenta';
    if (t.counts.get('uploading')) return 'white';
    if (t.counts.get('downloading')) return 'cyan';
    return null;
  }

  overallFraction(t) {
    if (!t.known) return null;

    return Math.min(1, Math.max(t.downloaded, t.completed) / t.known);
  }

  phaseBreakdown(t) {
    const active = PHASES
      .filter((phase) => phase !== 'queued' && phase !== 'done' && phase !== 'error' && t.counts.has(phase))
      .map((phase) => this.paint(`${t.counts.get(phase)} ${PHASE_SHORT[phase]}`, this.meterColor(phase)));
    const queued = t.counts.get('queued') || 0;
    if (queued) active.push(this.paint(`${queued} queued`, 'dim'));
    return active;
  }

  footer() {
    const t = this.totals();
    const elapsed = (Date.now() - this.started) / 1000;

    const barWidth = Math.max(10, this.width - 8);

    const fraction = this.overallFraction(t);
    const bar = this.bar(fraction, this.overallColor(t), barWidth);
    const pct = fraction === null ? '   -' : `${Math.floor(fraction * 100)}%`.padStart(4);
    const barLine = clampLine(`  ${bar} ${this.paint(pct, 'dim')}`, this.width);

    const counts = [];
    counts.push(`${t.finished}/${t.total} done`);
    if (t.known) counts.push(`${t.downloaded}/${t.known} pages`);
    if (t.ocr) counts.push(this.paint(`${t.ocr} OCR'd`, 'yellow'));
    if (t.failed) counts.push(this.paint(`${t.failed} failed`, 'red'));
    counts.push(humanTime(elapsed));

    const phases = this.phaseBreakdown(t);
    const sep = this.paint(' · ', 'dim');
    const line2 = phases.length
      ? `  ${counts.join(sep)}${sep}${phases.join(sep)}`
      : `  ${counts.join(sep)}`;

    const hint = this.keyboard
      ? `${sep}${this.paint(this.compact ? 'c: expand' : 'c: compact', 'dim')}`
      : '';
    return [barLine, clampLine(this.paint(line2, 'dim') + hint, this.width)];
  }

  clear() {
    if (!this.anchored) return;
    this.moveToAnchor();
    this.stream.write('\x1b[0J');
  }

  moveToAnchor() {
    const up = this.bufferRow > this.anchorOffset ? this.bufferRow - this.anchorOffset : 0;
    if (up > 0) this.stream.write(`\x1b[${up}A`);
    this.bufferRow = this.anchorOffset;
  }

  draw(force = false) {
    if (!this.tty || this.quiet) return;
    const now = Date.now();

    if (!force && now - this.lastDraw < 80) return;
    this.lastDraw = now;
    this.spin++;

    const lines = [];
    const done = this.volumes.filter((v) => v.phase === 'done').length;
    const failed = this.volumes.filter((v) => v.phase === 'error').length;

    const budget = this.rowBudget();

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

      this.moveToAnchor();
      this.stream.write(`\x1b[0J${body}`);
    } else {

      this.stream.write(body);
      this.anchorOffset = this.bufferRow;
      this.anchored = true;
    }
    this.bufferRow += lines.length;
    this.drawnLines = lines.length;
  }

  plainLine(volume) {
    if (this.quiet) return;
    const mark = volume.phase === 'done' ? this.paint('✓', 'green') : this.paint('✗', 'red');
    const elapsed = humanTime(((volume.endedAt || Date.now()) - volume.startedAt) / 1000);
    const detail = this.detail(volume);
    this.stream.write(`  ${mark} ${volume.tag} ${truncate(volume.label, 44)}  ${detail}  ${elapsed}\n`);
  }

  tick() {
    if (!this.tty) return;
    this.draw();
  }

  startTicker(intervalMs = 120) {
    if (!this.tty || this.timer) return;
    this.timer = setInterval(() => this.draw(), intervalMs);
    this.timer.unref?.();
    this.attachKeyboard();
  }

  stopTicker() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  rowBudget() {
    if (this.compact) return Math.max(3, this.maxLines - 3);
    const rows = Number(this.stream?.rows) || 24;
    return Math.max(3, rows - 4);
  }

  attachKeyboard() {
    const stdin = process.stdin;
    if (!this.tty || this.keyboard || !stdin || !stdin.isTTY || !stdin.setRawMode) return;

    const onData = (chunk) => {
      const key = String(chunk);
      if (key === '\u0003') {
        this.detachKeyboard();
        process.kill(process.pid, 'SIGINT');
        return;
      }
      if (key === 'c' || key === 'C') {
        this.compact = !this.compact;
        this.draw(true);
      }
    };
    const onEnd = () => this.detachKeyboard();

    const onExit = () => this.detachKeyboard();

    this.keyboard = { stdin, onData, onEnd, onExit };
    process.once('exit', onExit);
    stdin.setRawMode(true);
    stdin.resume();
    stdin.on('data', onData);
    stdin.on('end', onEnd);

    stdin.unref?.();
  }

  detachKeyboard() {
    const state = this.keyboard;
    if (!state) return;
    this.keyboard = null;
    process.off('exit', state.onExit);
    try {
      state.stdin.off('data', state.onData);
      state.stdin.off('end', state.onEnd);
      state.stdin.setRawMode(false);
      state.stdin.pause();
    } catch {

    }
  }

  done() {
    this.stopTicker();
    this.detachKeyboard();
    if (!this.tty) return;

    if (this.anchored) {
      this.draw(true);
      this.anchored = false;
      this.drawnLines = 0;

      this.stream.write('\n');
      this.bufferRow += 1;
    }
  }
}

