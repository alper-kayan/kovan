/**
 * Reads a string field out of JSON that is still being written, e.g. a tool call's arguments
 * mid-stream: `{"path":"a.ts","new_string":"const x = 1;\nconst` → field "new_string" is
 * "const x = 1;\nconst". Returns the value so far, whether it is complete, or null when the
 * field hasn't started. Only top-level string fields; good enough for edit tools.
 */
export function partialStringField(
  json: string,
  key: string,
): { value: string; complete: boolean } | null {
  // Tool arguments are flat objects, so the first `"key": "` is the field.
  const match = new RegExp(`"${key}"\\s*:\\s*"`).exec(json);
  if (!match) return null;
  const start = match.index + match[0].length;
  let out = '';
  for (let i = start; i < json.length; i++) {
    const ch = json[i]!;
    if (ch === '"') return { value: out, complete: true };
    if (ch !== '\\') {
      out += ch;
      continue;
    }
    const next = json[i + 1];
    if (next === undefined) break; // the escape itself is still being written
    i += 1;
    switch (next) {
      case 'n':
        out += '\n';
        break;
      case 't':
        out += '\t';
        break;
      case 'r':
        out += '\r';
        break;
      case 'b':
        out += '\b';
        break;
      case 'f':
        out += '\f';
        break;
      case 'u': {
        const hex = json.slice(i + 1, i + 5);
        if (hex.length < 4) return { value: out, complete: false };
        out += String.fromCharCode(parseInt(hex, 16));
        i += 4;
        break;
      }
      default:
        out += next; // \" \\ \/
    }
  }
  return { value: out, complete: false };
}

/** What an edit tool is writing, as far as the model has written it. */
export interface EditProgress {
  path: string | null;
  /** The text being replaced, once the model has finished writing it. */
  anchor: string | null;
  /** The new text so far. */
  text: string;
}

const NEW_TEXT_KEYS = ['new_string', 'content', 'newString', 'new_str'];
const PATH_KEYS = ['path', 'file_path', 'filePath'];
const ANCHOR_KEYS = ['old_string', 'oldString', 'old_str'];

/** Reads an edit or write tool's partial arguments; null for other tools or before any text. */
export function editProgress(argumentsJson: string): EditProgress | null {
  const first = (keys: string[]) => {
    for (const k of keys) {
      const v = partialStringField(argumentsJson, k);
      if (v) return v;
    }
    return null;
  };
  const text = first(NEW_TEXT_KEYS);
  if (!text) return null;
  const path = first(PATH_KEYS);
  const anchor = first(ANCHOR_KEYS);
  return {
    path: path?.complete ? path.value : null,
    anchor: anchor?.complete ? anchor.value : null,
    text: text.value,
  };
}
