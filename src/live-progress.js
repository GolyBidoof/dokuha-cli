import { C, useColor, humanBytes, humanTime, displayWidth, padTo, clampLine, truncate, wrapLine } from './ansi.js';

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

  constructor({ stream = process.stderr, quiet = false, plain = false, width = null, maxLines = 10, pipelineExpected = true } = {}) {
    this.stream = stream;
    this.quiet = quiet;
    this.color = useColor(stream);

    this.tty = !plain && !quiet && Boolean(stream && stream.isTTY);

    this.maxLines = maxLines;
    this.compact = false;
    // Pausing is for the human, not the run: the terminal redraw that keeps the
    // block current is also what makes mouse selection impossible during a download.
    // While paused nothing is painted, progress events keep updating the state, and
    // notes are held until resume so a warning cannot shift the frozen block.
    this.paused = false;
    this.pendingNotes = [];

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
    this.bridgeStatus = null;

    // Whether this run has a destination to send to, which the bar needs before it
    // can show an assembling band. The run sets it once it knows the method.
    this.uploadExpected = false;
    // Whether OCR or an upload follows the download. The stage weights below were
    // measured on a mokuro run, where the download is only its first 30 percent. A
    // download-only run using them could not pass 30 percent until a volume finished,
    // so its footer bar was full while its own percentage still read 56. run() clears
    // this when no bridge is in play; a volume that reaches a bridge phase re-enables
    // it even if the flag was never set.
    this.pipelineExpected = pipelineExpected;
    // High water marks for the two footer numbers, so a late page total or a volume
    // that leaves a stage cannot make the display step backwards.
    this.bestOverall = 0;
    this.bandBest = null;
    // The last few notes, so a resize can rebuild the screen with them in place.
    this.recentNotes = [];

    // The terminal can be resized mid-run, and Node reports it on the tty
    // stream. Without this the block keeps the width it started with and wraps
    // or leaves a ragged edge until the run ends.
    this.onResize = () => {
      const cols = (stream && stream.columns) || process.stdout.columns;
      if (!cols || cols === this.width) return;
      this.width = cols;
      // Clear and rebuild, debounced so a drag does not do it per pixel. This is the
      // deterministic option and the only one that cannot duplicate rows: after the
      // terminal rewraps, the block's position on screen cannot be derived from what we
      // tracked, and every attempt to move the cursor back to it left rows behind. The
      // recent notes are reprinted so the screen does not look like the run restarted.
      if (this.resizeTimer) clearTimeout(this.resizeTimer);
      this.resizeTimer = setTimeout(() => {
        this.resizeTimer = null;
        const settled = (stream && stream.columns) || process.stdout.columns;
        if (settled) this.width = settled;
        // A paused block is being read or selected; a resize redraw would clear the
        // screen under the selection. Resume will pick up the new width.
        if (this.paused) return;
        const notes = this.recentNotes.length ? `${this.recentNotes.join('\n')}\n` : '';
        this.stream.write(`\x1b[2J\x1b[H${notes}`);
        this.anchored = false;
        this.anchorOffset = this.recentNotes.length;
        this.bufferRow = this.recentNotes.length;
        this.drawnLines = 0;
        this.draw(true);
      }, 150);
      this.resizeTimer.unref?.();
    };
    if (this.tty) {
      // One registration per distinct target. A terminal normally reports the same
      // tty on all three streams, and registering on each meant three calls per event.
      const targets = new Set([stream, process.stdout, process.stderr].filter(Boolean));
      for (const target of targets) {
        if (typeof target.on === 'function') target.on('resize', this.onResize);
      }
    }
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
      // Sizes of the files the bridge produces for this volume. The page bytes above
      // are the manga as downloaded; these are the outputs, tracked separately so the
      // footer can total both without counting the archive twice.
      artifacts: { webp: 0, cbz: 0, mokuro: 0, series: 0 },
      upload: 0,
      uploadTotal: 0,
      uploadCached: 0,
      ocr: 0,
      ocrTotal: 0,
      ocrPending: 0,
      bridgeState: '',
      bridgeOcrDone: 0,
      bridgeOcrTotal: 0,
      bridgeOcrPending: 0,
      bridgeOcrProcessing: 0,
      bridgeWorker: '',
      bridgeQueueDepth: 0,
      bridgeProcessingDepth: 0,
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

  // The row a key belongs to, for call sites that need a counter they are about to
  // increment. Without this the BookWalker adapter's failure path threw: it read
  // `progress.get(key)?.failed` on an object that only had a private map.
  get(key) {
    return this.byKey.get(key) || null;
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
    // Bridge finalization streams OCR updates followed by remote-upload updates.
    // This is the one valid backwards-index transition in the otherwise forward
    // pipeline: `finalizing` represents remote upload after OCR has completed.
    const bridgePhaseTransition = phase === 'finalizing' && volume.phase === 'ocr';
    if (phase && (PHASES.indexOf(phase) > PHASES.indexOf(volume.phase) || bridgePhaseTransition)) {

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

  /**
   * Record the final size of one artifact the bridge wrote for a volume.
   *
   * The upload stream reports each file as it transfers (cover, archive, .mokuro),
   * and the terminal `done` frame carries the complete list, which is the only place
   * the per-series `series.json` size exists. Sizes are totals, not deltas, so an
   * update can be repeated without inflating the footer.
   */
  artifact(key, kind, bytes) {
    const volume = this.byKey.get(key);
    if (!volume || !volume.artifacts || !(kind in volume.artifacts)) return;
    const size = Number(bytes);
    if (!Number.isFinite(size) || size < 0) return;
    if (volume.artifacts[kind] === size) return;
    volume.artifacts[kind] = size;
    this.tick();
  }

  updateBridgeStatus(status) {
    this.bridgeStatus = status || null;
    this.tick();
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
      // The last wait_ocr frame can carry one page still pending while the bridge has
      // already finished: a done row then left the footer reading "275 OCR'd" for 297
      // pages. A finished volume has OCR'd everything the bridge received.
      if (volume.ocrTotal) {
        volume.ocr = volume.ocrTotal;
        volume.ocrPending = 0;
      }
      // The bridge state line described a live session; the row no longer has one.
      volume.bridgeState = '';
      volume.phase = 'done';
    }
    volume.endedAt = Date.now();
    // Finishing a volume updates the frozen frame's state but must not repaint it:
    // a paused block is a copy target, and the next paint is the user's resume.
    if (this.tty) {
      if (!this.paused) this.draw(true);
    } else {
      this.plainLine(volume);
    }
  }

  note(text) {
    if (this.quiet) return;
    if (this.paused) {
      // Printable notes are the one thing that could move a frozen block, so they
      // wait for the resume and the footer says how many are waiting.
      this.pendingNotes.push(String(text));
      if (this.pendingNotes.length > 100) this.pendingNotes.shift();
      return;
    }
    if (!this.tty) {
      this.stream.write(text.endsWith('\n') ? text : `${text}\n`);
      return;
    }

    // Wrap to the terminal width first, then count the rows that actually reach
    // the screen. Counting only the explicit newlines undercounts a wrapped note
    // such as a long non-fatal warning, and the redraw below then clears the
    // wrong number of rows and mangles the block.
    const rows = [];
    for (const line of String(text).replace(/\n+$/, '').split('\n')) {
      rows.push(...wrapLine(line, this.width));
    }

    // Kept so a resize can rebuild the screen. After a reflow the block's position cannot
    // be derived from anything we tracked, so the only deterministic redraw is a clear,
    // and reprinting these stops that from looking like the run restarted.
    this.recentNotes.push(...rows);
    if (this.recentNotes.length > 20) {
      this.recentNotes.splice(0, this.recentNotes.length - 20);
    }

    this.clear();
    this.anchored = false;
    this.stream.write(`${rows.join('\n')}\n`);

    this.anchorOffset += rows.length;
    this.bufferRow = this.anchorOffset;
    this.drawnLines = 0;
    this.draw(true);
  }

  /**
   * Freeze or unfreeze the live block so its text can be selected and copied.
   *
   * The block repaints every 120 ms, and every repaint moves the cursor and rewrites
   * the same rows, which is what makes a drag-selection jump while a download runs.
   * Pausing stops all painting; the run itself continues and the next resume paints
   * the current state, with any notes that arrived meanwhile printed above it.
   */
  togglePause() {
    if (!this.tty) return;
    if (!this.paused) {
      this.paused = true;
      // Paint once with the paused footer, then stop until resume.
      this.draw(true);
      return;
    }
    this.resumeForEnd();
    this.draw(true);
  }

  /** Leave pause mode and flush notes held while the block was frozen. */
  resumeForEnd() {
    if (!this.paused) return;
    this.paused = false;
    const held = this.pendingNotes.splice(0);
    for (const text of held) this.note(text);
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
      case 'finalizing': {
        // A local finalize reports nothing, so a full bar is the honest reading: there
        // is no upload to measure. An upload that has started but has not yet sent its
        // byte total is the opposite case, and reporting 1 there showed 100% for the
        // whole transfer while the speed indicator was still moving.
        const uploading = volume.uploadBytesTotal > 0
          || volume.uploadBytes > 0
          || Boolean(volume.uploadSpeed);
        // A finalizing volume never shows a full bar. The archive exists, but the volume
        // is not done until the bridge closes its session, and a full bar beside an
        // upload at zero percent reads as finished when nothing has been sent. The
        // bridge's own percent can reach 100 while MEGA is still confirming the file,
        // so even a complete byte count stays one cell short.
        if (!uploading) return 0.99;
        return volume.uploadBytesTotal > 0
          ? Math.min(0.99, ratio(volume.uploadBytes || 0, volume.uploadBytesTotal) ?? 0)
          : 0;
      }
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
        if (volume.bridgeState) parts.push(volume.bridgeState);
        else if (volume.ocrPending) parts.push(`${volume.ocrPending} pending`);
        break;
      }
      case 'finalizing':

        if (volume.uploadFile) {
          parts.push(truncate(volume.uploadFile, 34));

          // Only the archive counts, and the bridge latches that flag when it is up. The
          // cover and the mokuro file finish early, so their byte counters read complete
          // while the archive has not started, which made every volume claim to be
          // finishing the moment its cover landed.
          if (volume.archiveUploaded) {
            // The archive is up and only the small sidecars and the bridge closing the
            // session are left. Saying so beats a full bar with a dash beside it, which
            // reads as a volume that finished but never became done.
            parts.push('finishing');
          } else if (volume.uploadBytes > 0 || volume.uploadSpeed) {
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
        if (volume.bridgeState) parts.push(volume.bridgeState);
        if (volume.returned) parts.push('returned');
        break;
      case 'error':
        parts.push(truncate(volume.error || 'failed', 60));
        break;
      default:
        parts.push('waiting');
    }
    if (volume.bytes > 0) parts.push(humanBytes(volume.bytes));
    if (volume.failed) parts.push(`${volume.failed} failed`);
    return parts.filter(Boolean).join('  ');
  }

  meterColor(phase, volume = null) {
    switch (phase) {
      case 'downloading':
        return 'blue';
      case 'uploading':
        return 'magenta';
      case 'ocr':
        return 'yellow';
      case 'finalizing':
        return volume?.uploadFile ? 'magenta' : 'cyan';
      case 'done':
        return 'green';
      case 'error':
        return 'red';
      default:
        return null;
    }
  }

  meter(volume, width = 12) {
    // The bar describes the stage named beside it, so it has to match that stage's own
    // numbers: "3/171 pages" beside a two thirds full bar reads as a bug. The pipeline
    // weight was continuous, but it measured something the row was not showing.
    return this.bar(this.fraction(volume), this.meterColor(volume.phase, volume), width);
  }

  bar(fraction, color, width) {
    if (fraction === null) return ' '.repeat(width);
    // A bar only reads complete at a fraction of one. Rounding filled the last cell from
    // 0.99, so a volume that was still finalizing looked finished, which is the same
    // false completion the weights already guard against.
    const filled = fraction >= 1
      ? width
      : Math.max(0, Math.min(width - 1, Math.floor(fraction * width)));
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

    // Keep enough room for the page count and downloaded size on ordinary
    // terminal widths; a 46-column title used to truncate the MiB figure away.
    const labelWidth = Math.max(8, Math.min(28, this.width - 58));
    const label = this.paint(padTo(truncate(volume.label, labelWidth), labelWidth), 'bold');

    const used = 2 + 1 + 1 + 4 + 1 + labelWidth + 1 + 8 + 1 + 12 + 1;
    const detailText = truncate(detail, Math.max(6, this.width - used));

    // Below roughly 48 columns the fixed columns alone do not fit, and a wrapped row
    // is not a cosmetic problem here: the redraw counts rows it wrote, and a wrapped
    // one makes every following clear land a line too high. Clamping keeps one row per
    // volume at every width.
    return clampLine(`  ${marker} ${tag} ${label} ${phase} ${meter} ${detailText}`.trimEnd(), this.width);
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
    const artifacts = { webp: 0, cbz: 0, mokuro: 0, series: 0 };
    for (const volume of this.volumes) {
      for (const kind of ['webp', 'cbz', 'mokuro']) artifacts[kind] += volume.artifacts?.[kind] || 0;
      // series.json is one shared file per series, reported by every volume in that
      // series. Summing it would multiply one small file by the volume count, so the
      // footer counts it once. A run spanning several series shows the largest one,
      // which is the closest a per-volume display can get without series keys.
      artifacts.series = Math.max(artifacts.series, volume.artifacts?.series || 0);
    }

    return {
      downloaded: known ? Math.min(downloaded, known) : downloaded,
      known,
      // Bytes of the downloaded pages, and of the bridge's outputs. The archive
      // repeats the pages, so it is shown but not added to the "extras" total.
      bytes: sum((v) => v.bytes || 0),
      artifacts,
      extras: artifacts.webp + artifacts.mokuro + artifacts.series,
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
    if (t.counts.get('finalizing')) {
      return this.volumes.some((volume) => volume.phase === 'finalizing' && volume.uploadFile)
        ? 'magenta'
        : 'cyan';
    }
    if (t.counts.get('uploading')) return 'magenta';
    if (t.counts.get('downloading')) return 'blue';
    return null;
  }

  overallFraction(t) {
    if (!t.total) return null;
    // A volume's share of the run is its page count, not its existence. Counting every
    // volume equally meant a twelve-page sampler finishing advanced the bar as far as a
    // two-hundred-page volume finishing, so a run could show green progress while the
    // real work had barely started.
    let weighted = 0;
    let pages = 0;
    for (const volume of this.volumes) {
      const share = Number(volume.total) > 0 ? Number(volume.total) : 1;
      weighted += this.volumeWeight(volume) * share;
      pages += share;
    }
    return pages > 0 ? weighted / pages : 0;
  }

  // What the footer is allowed to show. The raw fraction can dip when a queued
  // volume's page total arrives (the denominator grows before its numerator does),
  // and a stable-looking progress number is worth more than an honest one-pixel
  // regression. Nothing is shown as complete until every row has settled: a
  // plain download that has fetched every page still waits for its last volume to
  // report done, so 100 percent cannot appear beside a row that says "download".
  displayedFraction(t) {
    const raw = this.overallFraction(t);
    if (raw === null) return null;
    this.bestOverall = Math.max(this.bestOverall, raw);
    const settled = t.total > 0 && t.finished + t.failed === t.total;
    return settled ? this.bestOverall : Math.min(this.bestOverall, 0.99);
  }

  // A bridge phase in the row list means the pipeline is real even if the run never
  // set `pipelineExpected` (a resumed session discovered after the block was built).
  // Only the two phases that exist solely on the bridge count: a local `finalizing`
  // is ebookjapan or BookWalker zipping pages after the download, not an OCR hand-off.
  pipelineUnderway() {
    return this.volumes.some((volume) => volume.phase === 'uploading'
      || volume.phase === 'ocr');
  }

  volumeWeight(volume) {
    if (!this.pipelineExpected && !this.pipelineUnderway()) {
      // A download-only run: fetching the pages is the whole job, so a volume that
      // has fetched them counts as complete and one still fetching counts by its own
      // fraction. The mokuro weights below would cap every unfinished volume at 30
      // percent and held the run's own percentage below its bar for the whole download.
      if (volume.phase === 'downloading') {
        return volume.total > 0 ? Math.min(1, Math.max(0, volume.done / volume.total)) : 0;
      }
      if (volume.phase === 'done') return 1;
      // ebookjapan and BookWalker zip their pages locally after the download, which
      // reports `finalizing` without any bridge. Those pages are already on disk, so
      // the download stage is complete for them.
      if (volume.phase === 'finalizing' || volume.phase === 'uploading' || volume.phase === 'ocr') return 1;
      // A failed volume contributes only what it actually finished: counting it as a
      // whole unit made a run with one failed volume read 100 percent, and a volume
      // that died after 20 of 200 pages advance the footer as far as a finished one.
      if (volume.phase === 'error') return this.fraction(volume) ?? 0;
      return 0;
    }
    // The weights follow how long each stage really takes on a mokuro run, where the
    // download is the quick part and OCR is the long one: download 30, the handover to
    // the bridge and the loan return 10, OCR 45, building the archive 5, destination
    // upload 10. They used to give the download 40, so a fast download raced to 40
    // percent and the run then crawled through the stages that own the rest.
    switch (volume.phase) {
      case 'downloading':
        return volume.total > 0 ? Math.min(1, Math.max(0, volume.done / volume.total)) * 0.3 : 0;
      case 'uploading':
        return volume.uploadTotal > 0
          ? 0.3 + Math.min(1, Math.max(0, (volume.upload + volume.uploadCached) / volume.uploadTotal)) * 0.1
          : 0.3;
      case 'ocr': {
        const total = volume.ocrTotal || volume.uploadTotal;
        const done = volume.ocrPending && total ? total - volume.ocrPending : volume.ocr;
        return 0.4 + (total > 0 ? Math.min(1, Math.max(0, done / total)) * 0.45 : 0);
      }
      case 'finalizing': {
        // Building the archive is the small band before the upload reports a byte
        // total, and the transfer is the rest. A local destination never reports one,
        // so it holds the building weight and completes when the volume does.
        if (!(volume.uploadBytesTotal > 0)) return 0.85;
        // The band tops out just short of complete. The last stretch of a finalize is
        // the sidecar upload and the bridge closing the session, and letting the bytes
        // reach 1.0 there made the run's own percentage read 100% while rows still
        // showed an upload in flight. Only a finished volume is worth a whole unit.
        return 0.9 + Math.min(1, Math.max(0, (volume.uploadBytes || 0) / volume.uploadBytesTotal)) * 0.09;
      }
      case 'done':
        return 1;
      case 'error':
        // Same rule as the download-only branch: a failure carries the fraction it
        // reached, so the run's percentage cannot claim work that never happened.
        return this.fraction(volume) ?? 0;
      default:
        return 0;
    }
  }

  // The overall bar is a pipeline, not one fraction: a cell is coloured by the
  // most advanced stage that has reached it, so a run with every volume
  // downloaded but OCR still going shows a full blue bar rather than a short one.
  // The three fractions come from fields the pipeline already publishes; no new
  // counters are kept here.
  //
  // - download: `done`/`total` while a volume is downloading, and a finished 1
  //   once it has moved past the download stage.
  // - ocr: `ocr` against `ocrTotal` (or `uploadTotal`, the page count the bridge
  //   was handed), with `ocrPending` preferred when the bridge reports it.
  // - upload: `uploadBytes`/`uploadBytesTotal` from the destination upload during
  //   `finalizing`. The separate `uploading` phase pushes pages to the bridge
  //   before OCR, so painting it as the upload stage would put magenta ahead of
  //   yellow and hide OCR entirely.
  pipelineFractions() {
    if (!this.volumes.length) return { download: 0, ocr: 0, assemble: 0, upload: 0, done: 0 };
    const mean = (fn) => this.volumes.reduce((sum, volume) => sum + fn(volume), 0) / this.volumes.length;
    // Each band is the share of volumes that have reached that stage, read from the
    // same per-phase fraction the volume rows draw. The bar used to derive three
    // stages of its own while the rows knew six, which is why it had no colour for
    // assembling the archive or for a finished upload: the information was there,
    // the bar just was not looking at it.
    const share = (volume, phase) => {
      // A done volume counts as downloaded whatever its counters say. One that completed
      // in an earlier run and was skipped on resume carries no byte counters, and reading
      // that as zero left the bar dyed cyan from the assemble band alone while the volume
      // was in fact finished. Only the download band is forced: a volume that skipped OCR
      // on purpose must not light the OCR colour.
      if (phase === 'downloading' && volume.phase === 'done') return 1;
      return this.fraction({ ...volume, phase }) ?? 0;
    };
    const uploaded = (volume) => {
      // uploadPercent is the volume's aggregate over its artifact trio, which the
      // per-file byte counters cannot express: the cover finishing on its own would
      // otherwise read as the whole volume being uploaded. A volume without the
      // aggregate still reports from its own byte counters.
      if (typeof volume.uploadPercent === 'number') {
        return Math.min(1, Math.max(0, volume.uploadPercent / 100));
      }
      if (volume.uploadBytesTotal > 0) {
        return Math.min(1, Math.max(0, (volume.uploadBytes || 0) / volume.uploadBytesTotal));
      }
      return 0;
    };
    const rawBands = {
      download: mean((volume) => share(volume, 'downloading')),
      ocr: mean((volume) => share(volume, 'ocr')),
      // Assembling the archive is a stage in its own right, and it happens before the
      // upload reports anything. It is a pipeline stage whether or not the destination
      // is remote: a local bridge still assembles, and suppressing the band there left
      // the bar fully blue beside rows that said "assembling .mokuro". The band stays
      // lit once a volume has reached finalize: the archive exists from that point on.
      assemble: mean((volume) => {
        if (!this.pipelineExpected) return 0;
        return volume.phase === 'finalizing' || volume.phase === 'done' || volume.phase === 'error' ? 1 : 0;
      }),
      upload: mean(uploaded),
      // A volume that is done is done. Requiring upload bytes hid the green band for
      // every local destination and for a volume whose session was already complete,
      // which turned a 100 percent run into a fully cyan bar.
      done: mean((volume) => (volume.phase === 'done' ? 1 : 0)),
    };

    // Stages only move forward, and a late-arriving page total can shrink a stage's
    // fraction before its next update. A progress bar that steps backwards reads as a
    // bug even when the underlying counters are honest, so each band keeps its high
    // water mark.
    if (!this.bandBest) this.bandBest = { download: 0, ocr: 0, assemble: 0, upload: 0, done: 0 };
    const bands = {};
    for (const [name, value] of Object.entries(rawBands)) {
      const reached = Math.min(1, Math.max(0, Number(value) || 0));
      this.bandBest[name] = Math.max(this.bandBest[name] || 0, reached);
      bands[name] = this.bandBest[name];
    }
    return bands;
  }

  stageRatio(done, total) {
    return total > 0 ? Math.min(1, Math.max(0, done / total)) : 0;
  }

  pipelineBar(width) {
    if (!this.pipelineExpected && !this.pipelineUnderway()) {
      // One basis for both halves of the footer line: with no bridge stages to paint,
      // the bar is the run's own completion, which is exactly the percentage beside it.
      const fraction = this.displayedFraction(this.totals());
      const filled = fraction === null ? 0 : Math.min(width, Math.max(0, Math.round(fraction * width)));
      return [
        filled > 0 ? this.paint('█'.repeat(filled), 'blue') : '',
        width - filled > 0 ? this.paint('░'.repeat(width - filled), 'dim') : '',
      ].join('');
    }
    const { download, ocr, assemble, upload, done } = this.pipelineFractions();
    const cells = (fraction) => Math.min(width, Math.max(0, Math.round(fraction * width)));
    // Round each cumulative boundary once, then take run lengths by subtraction,
    // so the coloured runs are adjacent, never overlap, and always add up to the
    // filled length. The running max keeps a run from going negative if a stage
    // is skipped (its fraction is zero) or briefly reports ahead of an earlier one.
    // The most advanced band is leftmost, matching the volume rows: green when the
    // upload is complete, magenta while it runs, cyan while the archive is being
    // assembled, yellow for OCR, blue for the download, then the empty remainder.
    const greenEnd = cells(done);
    const magentaEnd = Math.max(greenEnd, cells(upload));
    const cyanEnd = Math.max(magentaEnd, cells(assemble));
    const yellowEnd = Math.max(cyanEnd, cells(ocr));
    const blueEnd = Math.max(yellowEnd, cells(download));
    return [
      ['green', greenEnd],
      ['magenta', magentaEnd - greenEnd],
      ['cyan', cyanEnd - magentaEnd],
      ['yellow', yellowEnd - cyanEnd],
      ['blue', blueEnd - yellowEnd],
      ['empty', width - blueEnd],
    ].map(([color, count]) => {
      if (count <= 0) return '';
      if (color === 'empty') return this.paint('░'.repeat(count), 'dim');
      return this.paint('█'.repeat(count), color);
    }).join('');
  }

  phaseBreakdown(t, { skipOcr = false } = {}) {
    const active = PHASES
      .filter((phase) => phase !== 'queued' && phase !== 'done' && phase !== 'error' && t.counts.has(phase))
      // With the bridge line showing, the OCR phase count would be a second "ocr"
      // beside the page count, measured in volumes rather than pages and reading as a
      // contradiction. The bridge line already reports the OCR work, so the phase
      // entry is the one to drop.
      .filter((phase) => !(skipOcr && phase === 'ocr'))
      .map((phase) => this.paint(`${t.counts.get(phase)} ${PHASE_SHORT[phase]}`,
        this.meterColor(phase, this.volumes.find((volume) => volume.phase === phase))));
    const queued = t.counts.get('queued') || 0;
    if (queued) active.push(this.paint(`${queued} queued`, 'dim'));
    return active;
  }

  footer() {
    const t = this.totals();
    const elapsed = (Date.now() - this.started) / 1000;

    const barWidth = Math.max(10, this.width - 8);

    const fraction = this.displayedFraction(t);
    const bar = this.pipelineBar(barWidth);
    const pct = fraction === null ? '   -' : `${Math.floor(fraction * 100)}%`.padStart(4);
    const barLine = clampLine(`  ${bar} ${this.paint(pct, 'dim')}`, this.width);

    const counts = [];
    counts.push(`${t.finished}/${t.total} done`);
    if (t.known) counts.push(`${t.downloaded}/${t.known} pages`);
    // The downloaded page bytes are the manga's size; the extras are the bridge's
    // small outputs. Both are cumulative across every volume in the run.
    if (t.bytes) counts.push(`${humanBytes(t.bytes)} manga`);
    if (t.extras) counts.push(`${humanBytes(t.extras)} extras`);
    if (t.ocr) counts.push(this.paint(`${t.ocr} OCR'd`, 'yellow'));
    if (t.failed) counts.push(this.paint(`${t.failed} failed`, 'red'));
    if (this.bridgeStatus) {
      const { worker, processing, pending, activeUploads = 0 } = this.bridgeStatus;
      // One group of counts rather than a state label beside two numbers that already
      // said the same thing: "bridge OCR processing · 8 active · 185 queued" spelled out
      // processing three times over. The counts are the part worth reading, and the
      // state only earns its place when there is nothing in flight to imply it.
      const busy = processing || pending || activeUploads;
      if (busy) {
        const parts = [];
        if (processing) parts.push(`${processing} active`);
        if (pending) parts.push(`${pending} queued`);
        if (activeUploads) parts.push(`${activeUploads} uploading`);
        counts.push(parts.join(' · '));
      } else if (worker && worker !== 'unknown') {
        counts.push(`bridge ${worker}`);
      }
    }
    if (this.paused) {
      counts.push(this.paint('paused', 'yellow'));
      if (this.pendingNotes.length) counts.push(`${this.pendingNotes.length} notes held`);
    }
    counts.push(humanTime(elapsed));

    const phases = this.phaseBreakdown(t, { skipOcr: Boolean(this.bridgeStatus) });
    const sep = this.paint(' · ', 'dim');
    const line2 = phases.length
      ? `  ${counts.join(sep)}${sep}${phases.join(sep)}`
      : `  ${counts.join(sep)}`;

    const hints = [];
    if (this.keyboard) {
      hints.push(this.compact ? 'c: expand' : 'c: compact');
      hints.push(this.paused ? 'p: resume' : 'p: pause');
    }
    const hint = hints.length ? `${sep}${this.paint(hints.join(' · '), 'dim')}` : '';
    // Clamp the status, never the hint: trimming the whole line from the right
    // is what cut the key help down to "p: pau" on a long run.
    const statusWidth = Math.max(20, this.width - displayWidth(hint));
    const artifactLine = this.artifactLine(t);
    return [
      barLine,
      clampLine(this.paint(line2, 'dim'), statusWidth) + hint,
      ...(artifactLine ? [artifactLine] : []),
    ];
  }

  /**
   * The bridge's output sizes, one line below the run totals.
   *
   * Each upload event reports the file's final byte count, so the sizes are exact
   * rather than an estimate. The `.cbz` repeats the pages already counted as the
   * manga, which is why it is listed here but not folded into "extras".
   */
  artifactLine(t) {
    const labelled = [
      ['webp', '.webp cover'],
      ['cbz', '.cbz archive'],
      ['mokuro', '.mokuro OCR'],
      ['series', 'series.json'],
    ];
    const known = labelled.filter(([kind]) => t.artifacts[kind] > 0);
    if (!known.length) return '';
    const parts = known.map(([kind, label]) => `${label} ${humanBytes(t.artifacts[kind])}`);
    return clampLine(`  ${this.paint(`output: ${parts.join(' · ')}`, 'dim')}`, this.width);
  }

  hasArtifacts() {
    return this.volumes.some((volume) => volume.artifacts
      && Object.values(volume.artifacts).some((size) => size > 0));
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
    // A paused block is a copy target: no timer tick, progress update or bridge poll
    // may move the rows. Force is reserved for the pause/resume paints and the end.
    if (this.paused && !force) return;
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
    if (this.resizeTimer) {
      clearTimeout(this.resizeTimer);
      this.resizeTimer = null;
    }
    if (this.onResize) {
      for (const target of [this.stream, process.stdout, process.stderr]) {
        if (target && typeof target.off === 'function') target.off('resize', this.onResize);
      }
    }
  }

  rowBudget() {
    // The footer grows a third line when the bridge starts reporting artifact sizes;
    // reserve that row too, or a full-height list would push the block off the screen.
    const extra = this.hasArtifacts() ? 1 : 0;
    if (this.compact) return Math.max(3, this.maxLines - 3 - extra);
    const rows = Number(this.stream?.rows) || 24;
    return Math.max(3, rows - 4 - extra);
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
        // While paused the next paint is the user's resume; changing the layout
        // under a selection would defeat the point of freezing it.
        if (!this.paused) this.draw(true);
        return;
      }
      if (key === 'p' || key === 'P' || key === ' ') {
        this.togglePause();
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
    if (typeof state.onExit === 'function') process.off('exit', state.onExit);
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

    // The run is over, so the frozen frame is no longer useful and the held notes
    // should not be lost. This also paints the final state if the block was paused.
    this.resumeForEnd();
    if (this.anchored) {
      this.draw(true);
      this.anchored = false;
      this.drawnLines = 0;

      this.stream.write('\n');
      this.bufferRow += 1;
    }
  }
}

