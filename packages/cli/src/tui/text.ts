/**
 * Measuring and wrapping text for a terminal: what a column is, where a line may break, how to cut without splitting an escape sequence.
 * Everything here is pure, so the screen can be tested as strings.
 */
// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;

export const stripAnsi = (s: string): string => s.replace(ANSI, '');

/** Columns one code point takes: 0 for combining marks and joiners, 2 for wide (CJK, emoji), 1 otherwise. */
export function charWidth(cp: number): number {
  if (cp === 0 || cp < 32 || (cp >= 0x7f && cp < 0xa0)) return 0;
  if (
    (cp >= 0x300 && cp <= 0x36f) ||
    cp === 0x200d ||
    (cp >= 0xfe00 && cp <= 0xfe0f) ||
    (cp >= 0x200b && cp <= 0x200f)
  )
    return 0;
  if (
    (cp >= 0x1100 && cp <= 0x115f) ||
    (cp >= 0x2e80 && cp <= 0xa4cf) ||
    (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe30 && cp <= 0xfe6f) ||
    (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x1f300 && cp <= 0x1f64f) ||
    (cp >= 0x1f900 && cp <= 0x1f9ff) ||
    (cp >= 0x20000 && cp <= 0x3fffd)
  )
    return 2;
  return 1;
}

export function strWidth(s: string): number {
  let w = 0;
  for (const ch of stripAnsi(s)) w += charWidth(ch.codePointAt(0)!);
  return w;
}

/** The first `max` columns of a styled string, escape sequences kept whole, with a reset at the end if anything was cut. */
export function truncate(s: string, max: number, ellipsis = '…'): string {
  if (max <= 0) return '';
  if (strWidth(s) <= max) return s;
  const room = Math.max(0, max - strWidth(ellipsis));
  let out = '';
  let w = 0;
  let i = 0;
  while (i < s.length) {
    ANSI.lastIndex = i;
    const m = ANSI.exec(s);
    if (m && m.index === i) {
      out += m[0];
      i += m[0].length;
      continue;
    }
    const cp = s.codePointAt(i)!;
    const ch = String.fromCodePoint(cp);
    const cw = charWidth(cp);
    if (w + cw > room) break;
    out += ch;
    w += cw;
    i += ch.length;
  }
  return `${out}\u001b[0m${ellipsis}`;
}

/** Pads with spaces to `width` columns (a longer string is cut). */
export function padEnd(s: string, width: number): string {
  const w = strWidth(s);
  return w >= width ? truncate(s, width, '') : s + ' '.repeat(width - w);
}

export const padStart = (s: string, width: number): string => {
  const w = strWidth(s);
  return w >= width ? s : ' '.repeat(width - w) + s;
};

export interface Span {
  text: string;
  /** An SGR prefix such as "\u001b[1m", or ''. */
  style: string;
}

const RESET = '\u001b[0m';

/**
 * Lays styled spans out in lines of at most `width` columns, breaking at spaces (a word longer than the line is broken where it must be).
 * Every span closes its own style, so each line can be drawn on its own, and a line is never left in a colour.
 */
export function layoutSpans(spans: Span[], width: number, firstIndent = '', indent = ''): string[] {
  const lines: string[] = [];
  let line = firstIndent;
  let col = strWidth(firstIndent);
  let first = true;
  /** The column where text starts on the line being built. */
  const base = () => strWidth(first ? firstIndent : indent);
  const flush = () => {
    lines.push(line);
    first = false;
    line = indent;
    col = strWidth(indent);
  };
  const put = (text: string, style: string) => {
    line += style ? `${style}${text}${RESET}` : text;
    col += strWidth(text);
  };

  for (const span of spans) {
    // Words and the whitespace between them, so a break can fall on a space and a run of spaces survives.
    for (const part of span.text.split(/(\s+)/).filter((p) => p !== '')) {
      if (/^\s+$/.test(part)) {
        const breaks = part.split('\n').length - 1;
        if (breaks > 0) {
          for (let n = 0; n < breaks; n++) flush();
        } else if (col > base()) {
          if (strWidth(part) <= width - col) put(part, '');
          else flush();
        }
        continue;
      }
      const pw = strWidth(part);
      if (pw <= width - col) {
        put(part, span.style);
        continue;
      }
      if (col > base()) flush();
      if (pw <= width - col) {
        put(part, span.style);
        continue;
      }
      // A word wider than the whole line: break it by columns.
      let chunk = '';
      let cw = 0;
      for (const ch of part) {
        const w = charWidth(ch.codePointAt(0)!);
        if (col + cw + w > width && chunk) {
          put(chunk, span.style);
          flush();
          chunk = '';
          cw = 0;
        }
        chunk += ch;
        cw += w;
      }
      put(chunk, span.style);
    }
  }
  if (col > base() || lines.length === 0) lines.push(line);
  return lines.map((l) => l.replace(/ +$/, ''));
}

/** Plain text wrapped to `width`, keeping its own line breaks. */
export function wrapPlain(text: string, width: number, firstIndent = '', indent = ''): string[] {
  return text
    .split('\n')
    .flatMap((p, i) =>
      layoutSpans([{ text: p, style: '' }], width, i === 0 ? firstIndent : indent, indent),
    );
}
