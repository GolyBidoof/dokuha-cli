/**
 * Command-line interface for the headless CMOA downloader.
 *
 *   cmoa-headless <speed-reader-url | cid> [options]
 *
 * No browser, no extension, no cookies.
 */

import path from 'node:path';
import { openVolume, downloadVolume, volumeName, parseTarget } from './downloader.js';
import { normaliseFormat, FORMATS } from './codec.js';
import { DEFAULT_JPEG_QUALITY } from './jpeg_encode.js';
import { defaultJobCount } from './render_pool.js';
import { installSocketPool, socketPoolInfo } from './http.js';

const USAGE = `cmoa-headless — download a CMOA (コミックシーモア) speed-reader volume without a browser

Usage:
  cmoa-headless <url|cid> [options]

Arguments:
  url|cid                 a speed-reader URL such as
                          https://www.cmoa.jp/bib/speedreader/?cid=0000249510_jp_0001&u0=1
                          or just the cid, e.g. 0000249510_jp_0001

Options:
  -o, --out DIR           output directory (default: ./<cid>)
      --title-dir         name the default output directory after the title
  -c, --concurrency N     pages in flight (default: 12)
  -j, --jobs N            worker threads for decoding/encoding (default: cores - 1,
                          0 = render inline on the main thread)
  -f, --format FMT        ${FORMATS.join(' | ')} (default: jpeg)
                          "original" keeps the CDN bytes when a page is not scrambled
  -q, --quality N         JPEG quality 1-100 (default: ${DEFAULT_JPEG_QUALITY}); ignored for png
      --no-subsample      write 4:4:4 JPEG instead of 4:4:4 -> 4:2:0
      --quality-request Q CDN quality parameter, normally 1 (default: 1)
      --force             re-download pages that already exist
      --limit N           only the first N pages
      --info              print volume information and exit
      --inspect           print per-page scramble details while downloading
      --quiet             suppress progress output
      --json              print a machine-readable summary
      --max-sockets N     use a node:https connection pool with N sockets per
                          host instead of Node's built-in fetch pool (default: off)
      --retries N         attempts per request (default: 3)
      --timeout MS        per-request timeout in ms (default: 45000)
  -h, --help              show this help
      --version           show the version

Notes:
  Pages are written as 0001.jpg, 0002.jpg, ... plus a metadata.json.
  Re-running the same command skips pages that already exist, so it doubles as
  resume. Nothing here contacts the site's advertising or analytics endpoints.
`;

function parseArgs(argv) {
  const options = {
    out: null,
    titleDir: false,
    concurrency: 12,
    jobs: null,
    format: 'jpeg',
    quality: DEFAULT_JPEG_QUALITY,
    subsample: true,
    qualityRequest: '1',
    force: false,
    limit: 0,
    info: false,
    inspect: false,
    quiet: false,
    json: false,
    retries: 3,
    timeoutMs: 45000,
    maxSockets: 0,
  };
  const positionals = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => {
      const value = argv[++i];
      if (value === undefined) throw new Error(`${arg} requires a value`);
      return value;
    };
    switch (arg) {
      case '-h':
      case '--help':
        options.help = true;
        break;
      case '--version':
        options.version = true;
        break;
      case '-o':
      case '--out':
        options.out = next();
        break;
      case '-c':
      case '--concurrency':
        options.concurrency = Number(next());
        break;
      case '-j':
      case '--jobs':
        options.jobs = Number(next());
        break;
      case '-f':
      case '--format':
        options.format = next();
        break;
      case '-q':
      case '--quality':
        options.quality = Number(next());
        break;
      case '--quality-request':
        options.qualityRequest = next();
        break;
      case '--no-subsample':
        options.subsample = false;
        break;
      case '--force':
        options.force = true;
        break;
      case '--limit':
        options.limit = Number(next());
        break;
      case '--info':
        options.info = true;
        break;
      case '--inspect':
        options.inspect = true;
        break;
      case '--quiet':
        options.quiet = true;
        break;
      case '--json':
        options.json = true;
        break;
      case '--max-sockets':
        options.maxSockets = Number(next());
        break;
      case '--retries':
        options.retries = Number(next());
        break;
      case '--timeout':
        options.timeoutMs = Number(next());
        break;
      default:
        if (arg.startsWith('-') && arg !== '-') throw new Error(`unknown option ${arg}`);
        positionals.push(arg);
    }
  }
  return { options, positionals };
}

const C = {
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  bold: '\x1b[1m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  cyan: '\x1b[36m',
};

function humanBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KiB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1048576).toFixed(1)} MiB`;
  return `${(n / 1073741824).toFixed(2)} GiB`;
}

function humanDuration(ms) {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return `${m}m${String(s % 60).padStart(2, '0')}s`;
}

/**
 * Progress line that rewrites itself on a TTY and prints sparsely otherwise, so
 * piping to a file does not produce thousands of lines.
 */
function makeProgress(total, quiet) {
  let done = 0;
  let failed = 0;
  let bytes = 0;
  let lastDraw = 0;
  const isTty = process.stdout.isTTY && !quiet;
  const draw = (force) => {
    const now = Date.now();
    if (!force && now - lastDraw < 100) return;
    lastDraw = now;
    const pct = total ? Math.floor((done / total) * 100) : 0;
    const width = 24;
    const filled = Math.round((width * done) / (total || 1));
    const bar = '#'.repeat(filled) + '-'.repeat(width - filled);
    const line =
      `\r${C.cyan}${bar}${C.reset} ${String(pct).padStart(3)}%  ` +
      `${done}/${total} pages  ${humanBytes(bytes)}` +
      (failed ? `  ${C.red}${failed} failed${C.reset}` : '   ');
    if (isTty) process.stdout.write(line);
  };
  return {
    onProgress(event) {
      if (quiet) return;
      if (event.error) {
        failed++;
        if (isTty) process.stdout.write(`\r${' '.repeat(90)}\r`);
        process.stderr.write(`${C.red}page ${event.index + 1} failed: ${event.error}${C.reset}\n`);
      } else if (!event.skipped) {
        done++;
        bytes += event.bytes ?? 0;
      } else {
        done++;
      }
      draw(false);
    },
    finish() {
      if (isTty) process.stdout.write('\n');
    },
  };
}

export async function main(argv) {
  let parsed;
  try {
    parsed = parseArgs(argv);
  } catch (error) {
    process.stderr.write(`${error.message}\n\n${USAGE}`);
    return 2;
  }
  const { options, positionals } = parsed;

  if (options.help) {
    process.stdout.write(USAGE);
    return 0;
  }
  if (options.version) {
    const pkg = JSON.parse(
      await import('node:fs/promises').then((fs) =>
        fs.readFile(new URL('../package.json', import.meta.url), 'utf8'),
      ),
    );
    process.stdout.write(`${pkg.version}\n`);
    return 0;
  }
  if (!positionals.length) {
    process.stderr.write(`error: no URL or cid given\n\n${USAGE}`);
    return 2;
  }
  if (positionals.length > 1) {
    process.stderr.write('error: only one URL or cid may be given\n');
    return 2;
  }

  if (options.maxSockets > 0) installSocketPool(options.maxSockets);

  const say = (message) => {
    if (!options.quiet) process.stderr.write(`${C.dim}${message}${C.reset}\n`);
  };

  let volume;
  try {
    volume = await openVolume(positionals[0], {
      retries: options.retries,
      timeoutMs: options.timeoutMs,
      log: say,
    });
  } catch (error) {
    process.stderr.write(`${C.red}error: ${error.message}${C.reset}\n`);
    return 1;
  }

  if (options.info) {
    const info = {
      cid: volume.cid,
      title: volume.title,
      subtitle: volume.subtitle,
      author: volume.author,
      publisher: volume.publisher,
      pages: volume.pageCount,
      contentsServer: volume.servers,
      viewMode: volume.viewMode,
      contentDate: volume.contentDate,
      imageClass: volume.imageClass,
      viewerUrl: volume.viewerUrl,
    };
    process.stdout.write(
      options.json ? `${JSON.stringify(info, null, 2)}\n` : formatInfo(info),
    );
    return 0;
  }

  const outDir = options.out ?? path.resolve(process.cwd(), volumeName(volume, options.titleDir));
  if (!options.quiet) {
    process.stderr.write(
      `${C.bold}${volume.title}${C.reset}` +
        (volume.author ? `  ${C.dim}${volume.author}${C.reset}` : '') +
        `\n${C.dim}${volume.pageCount} pages -> ${outDir}${C.reset}\n`,
    );
  }

  const jobs = options.jobs ?? defaultJobCount();
  const poolSize = jobs > 0 ? Math.min(jobs, Math.max(1, volume.pageCount)) : 0;
  if (!options.quiet && !options.json) {
    process.stderr.write(
      `${C.dim}${poolSize || 1} render worker(s), ${options.concurrency} pages in flight` +
        `${socketPoolInfo() ? `, ${socketPoolInfo().maxSockets} sockets` : ''}${C.reset}\n`,
    );
  }

  const progress = makeProgress(options.limit > 0 ? Math.min(options.limit, volume.pageCount) : volume.pageCount, options.quiet);
  let result;
  try {
    result = await downloadVolume(volume, {
      outDir,
      concurrency: options.concurrency,
      jobs: poolSize,
      format: options.format,
      quality: options.qualityRequest,
      jpegQuality: options.quality,
      subsample: options.subsample,
      force: options.force,
      limit: options.limit,
      inspect: options.inspect,
      onProgress: progress.onProgress,
      log: say,
    });
  } catch (error) {
    progress.finish();
    process.stderr.write(`${C.red}error: ${error.message}${C.reset}\n`);
    return 1;
  }
  progress.finish();

  if (options.json) {
    process.stdout.write(
      `${JSON.stringify(
        {
          cid: volume.cid,
          title: volume.title,
          outDir: result.outDir,
          pages: result.total,
          downloaded: result.downloaded,
          skipped: result.skipped,
          failed: result.failed,
          bytes: result.bytes,
          elapsedMs: result.elapsedMs,
          failures: result.failures,
        },
        null,
        2,
      )}\n`,
    );
    return result.failed === 0 ? 0 : 1;
  }

  const summary =
    `${C.green}${result.downloaded} pages${C.reset}` +
    (result.skipped ? ` (${result.skipped} already present)` : '') +
    `  ${humanBytes(result.bytes)}  ${humanDuration(result.elapsedMs)}`;
  process.stderr.write(`${summary}\n`);
  if (result.failed) {
    process.stderr.write(`${C.red}${result.failed} page(s) failed${C.reset}\n`);
    for (const failure of result.failures.slice(0, 10)) {
      process.stderr.write(`  page ${failure.index + 1}: ${failure.error}\n`);
    }
    process.stderr.write('re-run the same command to retry the missing pages\n');
    return 1;
  }
  return 0;
}

function formatInfo(info) {
  const rows = [
    ['cid', info.cid],
    ['title', info.title],
    ['subtitle', info.subtitle],
    ['author', info.author],
    ['publisher', info.publisher],
    ['pages', String(info.pages)],
    ['contents server', info.contentsServer],
    ['view mode', info.viewMode],
    ['content date', info.contentDate],
    ['image class', info.imageClass],
  ];
  const width = Math.max(...rows.map(([k]) => k.length));
  return `${rows.map(([k, v]) => `${k.padEnd(width)}  ${v}`).join('\n')}\n`;
}
