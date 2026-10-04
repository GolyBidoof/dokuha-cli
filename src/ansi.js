export const C = {
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  bold: '\x1b[1m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',

  white: '\x1b[97m',
};


export function useColor(stream) {
  if (process.env.NO_COLOR) return false;
  if (process.env.FORCE_COLOR) return true;
  return Boolean(stream && stream.isTTY);
}

export function humanBytes(n) {
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

export function padTo(text, width) {
  const s = String(text ?? '');
  const missing = width - displayWidth(s);
  return missing > 0 ? s + ' '.repeat(missing) : s;
}

export function clampLine(line, width) {
  if (displayWidth(line) <= width) return line;

  const suffix = line.endsWith(C.reset) ? C.reset : '';
  const body = suffix ? line.slice(0, -C.reset.length) : line;
  return truncate(body, width) + suffix;
}

export function truncate(text, max) {
  const s = String(text ?? '');
  if (displayWidth(s) <= max) return s;
  const reset = '\x1b[0m';
  let out = '';
  let width = 0;

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
