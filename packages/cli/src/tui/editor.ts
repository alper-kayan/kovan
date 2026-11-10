import { charWidth, strWidth } from './text.js';

/**
 * The text you are typing: several lines, a cursor, the usual line-editing keys, and a history of what you sent before. Pure, so it can be
 * tested without a terminal. `cursor` is an index into `value` (UTF-16 units), never inside a surrogate pair.
 */
export class LineEditor {
  value = '';
  cursor = 0;
  private history: string[] = [];
  /** Where in the history you are, or -1 when you are on what you are typing now. */
  private at = -1;
  private draft = '';

  constructor(history: string[] = []) {
    this.history = history;
  }

  get empty(): boolean {
    return this.value.length === 0;
  }

  setValue(v: string): void {
    this.value = v;
    this.cursor = v.length;
  }

  clear(): void {
    this.value = '';
    this.cursor = 0;
    this.at = -1;
  }

  insert(text: string): void {
    const clean = text.replace(/\r\n?/g, '\n');
    this.value = this.value.slice(0, this.cursor) + clean + this.value.slice(this.cursor);
    this.cursor += clean.length;
    this.at = -1;
  }

  newline(): void {
    this.insert('\n');
  }

  private prevIndex(i: number): number {
    if (i <= 0) return 0;
    const lo = this.value.charCodeAt(i - 1);
    return lo >= 0xdc00 && lo <= 0xdfff && i >= 2 ? i - 2 : i - 1;
  }
  private nextIndex(i: number): number {
    if (i >= this.value.length) return this.value.length;
    const hi = this.value.charCodeAt(i);
    return hi >= 0xd800 && hi <= 0xdbff && i + 2 <= this.value.length ? i + 2 : i + 1;
  }

  backspace(): void {
    if (this.cursor === 0) return;
    const p = this.prevIndex(this.cursor);
    this.value = this.value.slice(0, p) + this.value.slice(this.cursor);
    this.cursor = p;
  }
  del(): void {
    if (this.cursor >= this.value.length) return;
    this.value = this.value.slice(0, this.cursor) + this.value.slice(this.nextIndex(this.cursor));
  }
  left(): void {
    this.cursor = this.prevIndex(this.cursor);
  }
  right(): void {
    this.cursor = this.nextIndex(this.cursor);
  }

  private lineStart(i = this.cursor): number {
    return this.value.lastIndexOf('\n', i - 1) + 1;
  }
  private lineEnd(i = this.cursor): number {
    const e = this.value.indexOf('\n', i);
    return e === -1 ? this.value.length : e;
  }
  home(): void {
    this.cursor = this.lineStart();
  }
  end(): void {
    this.cursor = this.lineEnd();
  }

  /** Moves up a line, keeping the column. False when already on the first line. */
  up(): boolean {
    const start = this.lineStart();
    if (start === 0) return false;
    const col = this.cursor - start;
    const prevStart = this.lineStart(start - 1);
    this.cursor = Math.min(prevStart + col, start - 1);
    return true;
  }
  down(): boolean {
    const end = this.lineEnd();
    if (end >= this.value.length) return false;
    const col = this.cursor - this.lineStart();
    const nextStart = end + 1;
    this.cursor = Math.min(nextStart + col, this.lineEnd(nextStart));
    return true;
  }

  wordLeft(): void {
    let i = this.cursor;
    while (i > 0 && /\s/.test(this.value[i - 1]!)) i--;
    while (i > 0 && !/\s/.test(this.value[i - 1]!)) i--;
    this.cursor = i;
  }
  wordRight(): void {
    let i = this.cursor;
    while (i < this.value.length && /\s/.test(this.value[i]!)) i++;
    while (i < this.value.length && !/\s/.test(this.value[i]!)) i++;
    this.cursor = i;
  }

  killToStart(): void {
    const s = this.lineStart();
    this.value = this.value.slice(0, s) + this.value.slice(this.cursor);
    this.cursor = s;
  }
  killToEnd(): void {
    const e = this.lineEnd();
    // At the end of a line the next newline goes, so Ctrl+K can join lines.
    const stop = this.cursor === e && e < this.value.length ? e + 1 : e;
    this.value = this.value.slice(0, this.cursor) + this.value.slice(stop);
  }
  killWord(): void {
    const to = this.cursor;
    this.wordLeft();
    this.value = this.value.slice(0, this.cursor) + this.value.slice(to);
  }

  /** What you sent, newest last. Sending adds to it (a repeat of the last one does not). */
  remember(text: string): void {
    const t = text.trim();
    if (t && this.history.at(-1) !== t) this.history.push(t);
    this.at = -1;
  }
  historyPrev(): boolean {
    if (this.history.length === 0) return false;
    if (this.at === -1) {
      this.draft = this.value;
      this.at = this.history.length - 1;
    } else if (this.at > 0) this.at -= 1;
    else return false;
    this.setValue(this.history[this.at]!);
    return true;
  }
  historyNext(): boolean {
    if (this.at === -1) return false;
    if (this.at < this.history.length - 1) {
      this.at += 1;
      this.setValue(this.history[this.at]!);
    } else {
      this.at = -1;
      this.setValue(this.draft);
    }
    return true;
  }

  /** The text split into lines, and where the cursor sits as (row, column in columns). */
  lines(): string[] {
    return this.value.split('\n');
  }
  cursorRowCol(): { row: number; col: number } {
    const before = this.value.slice(0, this.cursor);
    const rows = before.split('\n');
    return { row: rows.length - 1, col: strWidth(rows.at(-1)!) };
  }
}

/** Splits a logical line into pieces of at most `width` columns, for drawing a long line in a box. */
export function hardWrap(line: string, width: number): string[] {
  if (width <= 0) return [line];
  const out: string[] = [];
  let cur = '';
  let w = 0;
  for (const ch of line) {
    const cw = charWidth(ch.codePointAt(0)!);
    if (w + cw > width && cur) {
      out.push(cur);
      cur = '';
      w = 0;
    }
    cur += ch;
    w += cw;
  }
  out.push(cur);
  return out;
}
