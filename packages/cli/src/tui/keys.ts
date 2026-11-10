import { StringDecoder } from 'node:string_decoder';

/**
 * Bytes from a terminal in raw mode become keys. Enough of the xterm vocabulary for an editor: arrows, home/end, delete, page keys, the modifiers on
 * them, Alt+key, Ctrl+letter, bracketed paste. A lone Escape is ambiguous with the start of a sequence, so it is held until `flush()` (the app calls
 * it when no more bytes follow).
 */
export interface Key {
  /** `char` carries printable text; `paste` carries pasted text; otherwise a key name. */
  name: string;
  text?: string;
  ctrl?: boolean;
  alt?: boolean;
  shift?: boolean;
}

const CSI_FINAL: Record<string, string> = {
  A: 'up',
  B: 'down',
  C: 'right',
  D: 'left',
  H: 'home',
  F: 'end',
  Z: 'backtab',
};
const TILDE: Record<string, string> = {
  '1': 'home',
  '2': 'insert',
  '3': 'delete',
  '4': 'end',
  '5': 'pageup',
  '6': 'pagedown',
  '7': 'home',
  '8': 'end',
};

function mods(param: string | undefined): Pick<Key, 'ctrl' | 'alt' | 'shift'> {
  const m = Number(param ?? '1') - 1;
  return {
    ...(m & 1 ? { shift: true } : {}),
    ...(m & 2 ? { alt: true } : {}),
    ...(m & 4 ? { ctrl: true } : {}),
  };
}

export class KeyParser {
  private decoder = new StringDecoder('utf8');
  private pending = '';
  private pasting: string | null = null;

  feed(data: Buffer | string): Key[] {
    this.pending += typeof data === 'string' ? data : this.decoder.write(data);
    return this.drain(false);
  }

  /** Called when no more bytes are coming: whatever is held is a key of its own (a lone Escape). */
  flush(): Key[] {
    return this.drain(true);
  }

  private drain(final: boolean): Key[] {
    const out: Key[] = [];
    const s = this.pending;
    let i = 0;
    let chars = '';
    const emitChars = () => {
      if (chars) out.push({ name: 'char', text: chars });
      chars = '';
    };

    while (i < s.length) {
      if (this.pasting !== null) {
        const end = s.indexOf('\u001b[201~', i);
        if (end === -1) {
          this.pasting += s.slice(i);
          i = s.length;
          break;
        }
        out.push({ name: 'paste', text: this.pasting + s.slice(i, end) });
        this.pasting = null;
        i = end + 6;
        continue;
      }
      const c = s[i]!;
      if (c === '\u001b') {
        emitChars();
        const rest = s.slice(i);
        if (rest.startsWith('\u001b[200~')) {
          this.pasting = '';
          i += 6;
          continue;
        }
        if (rest.length === 1) {
          if (!final) break; // maybe the start of a sequence
          out.push({ name: 'escape' });
          i += 1;
          continue;
        }
        if (rest[1] === '[') {
          // eslint-disable-next-line no-control-regex
          const m = /^\u001b\[([0-9;?<]*)([ -/]*)([@-~])/.exec(rest);
          if (!m) {
            if (!final) break; // an unfinished sequence
            i += 1;
            continue;
          }
          const [whole, params = '', , fin = ''] = m;
          const [p0, p1] = params.split(';');
          if (fin === '~') {
            const name = TILDE[p0 ?? ''];
            if (name) out.push({ name, ...mods(p1) });
          } else if (CSI_FINAL[fin]) {
            out.push({ name: CSI_FINAL[fin]!, ...mods(p1) });
          }
          i += whole.length;
          continue;
        }
        if (rest[1] === 'O' && rest.length >= 3) {
          const name = CSI_FINAL[rest[2]!];
          if (name) out.push({ name });
          i += 3;
          continue;
        }
        if (rest[1] === 'O') {
          if (!final) break;
          i += 2;
          continue;
        }
        // Alt + a key
        const ch = rest[1]!;
        if (ch === '\r') out.push({ name: 'enter', alt: true });
        else if (ch === '\u007f' || ch === '\b') out.push({ name: 'backspace', alt: true });
        else out.push({ name: 'char', text: ch, alt: true });
        i += 2;
        continue;
      }
      if (c === '\r') {
        emitChars();
        out.push({ name: 'enter' });
      } else if (c === '\n') {
        emitChars();
        out.push({ name: 'newline' });
      } else if (c === '\t') {
        emitChars();
        out.push({ name: 'tab' });
      } else if (c === '\u007f' || c === '\b') {
        emitChars();
        out.push({ name: 'backspace' });
      } else if (c < ' ') {
        emitChars();
        out.push({ name: String.fromCharCode(c.charCodeAt(0) + 96), ctrl: true });
      } else {
        chars += c;
      }
      i += 1;
    }
    emitChars();
    this.pending = s.slice(i);
    return out;
  }
}
