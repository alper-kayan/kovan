import { S, paint } from './style.js';
import { layoutSpans, strWidth, truncate, type Span } from './text.js';
import { hardWrap } from './editor.js';

/**
 * Markdown as a model writes it, for a terminal: code fences, headings, lists, quotes, and bold / italic / `code` / links inside a line.
 * Enough to read an answer comfortably; tables and HTML are shown as the plain text they are. It works on text that is still arriving: an
 * unclosed fence is drawn as code so far.
 */
export function inline(text: string, base = ''): Span[] {
  const out: Span[] = [];
  let buf = '';
  const flush = () => {
    if (buf) out.push({ text: buf, style: base });
    buf = '';
  };
  let i = 0;
  while (i < text.length) {
    const c = text[i]!;
    if (c === '`') {
      const j = text.indexOf('`', i + 1);
      if (j > i + 1) {
        flush();
        out.push({ text: text.slice(i + 1, j), style: base + S.code });
        i = j + 1;
        continue;
      }
    }
    if (c === '*' && text[i + 1] === '*') {
      const j = text.indexOf('**', i + 2);
      if (j > i + 2) {
        flush();
        out.push(...inline(text.slice(i + 2, j), base + S.bold));
        i = j + 2;
        continue;
      }
    }
    if (c === '*' || c === '_') {
      const j = text.indexOf(c, i + 1);
      const before = text[i - 1] ?? ' ';
      const after = text[j + 1] ?? ' ';
      const wordy = /\w/;
      const ok =
        j > i + 1 &&
        text[i + 1] !== ' ' &&
        text[j - 1] !== ' ' &&
        (c === '*' || (!wordy.test(before) && !wordy.test(after)));
      if (ok) {
        flush();
        out.push(...inline(text.slice(i + 1, j), base + S.italic));
        i = j + 1;
        continue;
      }
    }
    if (c === '[') {
      const m = /^\[([^\]]+)\]\(([^)\s]+)\)/.exec(text.slice(i));
      if (m) {
        flush();
        out.push({ text: m[1]!, style: base + S.underline });
        out.push({ text: ` (${m[2]})`, style: base + S.dim });
        i += m[0].length;
        continue;
      }
    }
    buf += c;
    i += 1;
  }
  flush();
  return out;
}

/** The text as lines for `width` columns, each already styled. `indent` is put in front of every line. */
export function renderMarkdown(text: string, width: number, indent = ''): string[] {
  const out: string[] = [];
  const room = Math.max(10, width - strWidth(indent));
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  let fence: { lang: string } | null = null;
  let blank = false;

  for (const raw of lines) {
    const fenceMatch = /^\s*```\s*([\w+-]*)\s*$/.exec(raw);
    if (fenceMatch) {
      if (fence) {
        fence = null;
      } else {
        fence = { lang: fenceMatch[1] ?? '' };
        out.push(`${indent}${paint(S.dim, `┌─ ${fence.lang || 'kod'}`)}`);
      }
      blank = false;
      continue;
    }
    if (fence) {
      for (const piece of hardWrap(raw.replace(/\t/g, '  '), room - 2))
        out.push(`${indent}${paint(S.dim, '│ ')}${paint(S.code, piece)}`);
      continue;
    }
    if (raw.trim() === '') {
      if (!blank && out.length) out.push('');
      blank = true;
      continue;
    }
    blank = false;

    const heading = /^(#{1,6})\s+(.*)$/.exec(raw);
    if (heading) {
      out.push(...layoutSpans(inline(heading[2]!, S.heading), room, indent, indent));
      continue;
    }
    if (/^\s*([-*_])\1{2,}\s*$/.test(raw)) {
      out.push(`${indent}${paint(S.dim, '─'.repeat(Math.min(room, 40)))}`);
      continue;
    }
    const quote = /^>\s?(.*)$/.exec(raw);
    if (quote) {
      out.push(
        ...layoutSpans(
          inline(quote[1]!, S.dim),
          room - 2,
          `${indent}${paint(S.dim, '▎ ')}`,
          `${indent}${paint(S.dim, '▎ ')}`,
        ),
      );
      continue;
    }
    const item = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(raw);
    if (item) {
      const depth = Math.floor((item[1] ?? '').length / 2);
      const bullet = /\d/.test(item[2]!) ? `${item[2]} ` : '• ';
      const pad = `${indent}${'  '.repeat(depth)}`;
      out.push(
        ...layoutSpans(
          inline(item[3]!),
          room - depth * 2,
          `${pad}${paint(S.accent, bullet)}`,
          `${pad}${' '.repeat(strWidth(bullet))}`,
        ),
      );
      continue;
    }
    if (/^\s*\|.*\|\s*$/.test(raw)) {
      out.push(`${indent}${truncate(raw, room)}`); // a table row: left as it is
      continue;
    }
    out.push(...layoutSpans(inline(raw), room, indent, indent));
  }
  return out;
}
