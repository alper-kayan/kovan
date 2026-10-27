/** One line of a hunk, with its numbers in the old and the new file. */
export interface DiffLine {
  kind: 'add' | 'del' | 'ctx';
  text: string;
  oldNo: number | null;
  newNo: number | null;
}

export interface DiffHunk {
  header: string;
  lines: DiffLine[];
}

export interface DiffFile {
  path: string;
  /** Where it came from, for a rename. */
  oldPath: string | null;
  status: 'added' | 'deleted' | 'modified' | 'renamed';
  binary: boolean;
  added: number;
  removed: number;
  hunks: DiffHunk[];
}

const HUNK = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/;

function unquote(path: string): string {
  // Git quotes paths with unusual characters: "a/sp ace.ts".
  return path.startsWith('"') && path.endsWith('"') ? path.slice(1, -1) : path;
}

function strip(path: string): string {
  const p = unquote(path.trim());
  return p.startsWith('a/') || p.startsWith('b/') ? p.slice(2) : p;
}

/** A unified diff (`git diff`) as files and hunks. Anything it doesn't know is skipped. */
export function parseDiff(text: string): DiffFile[] {
  const files: DiffFile[] = [];
  let file: DiffFile | null = null;
  let hunk: DiffHunk | null = null;
  let oldNo = 0;
  let newNo = 0;
  for (const raw of text.split('\n')) {
    if (raw.startsWith('diff --git ')) {
      const m = /^diff --git (?:"?a\/)(.+?)"? (?:"?b\/)(.+?)"?$/.exec(raw);
      file = {
        path: m?.[2] ?? raw.slice(11),
        oldPath: null,
        status: 'modified',
        binary: false,
        added: 0,
        removed: 0,
        hunks: [],
      };
      hunk = null;
      files.push(file);
      continue;
    }
    if (!file) continue;
    if (!hunk) {
      if (raw.startsWith('new file mode')) file.status = 'added';
      else if (raw.startsWith('deleted file mode')) file.status = 'deleted';
      else if (raw.startsWith('rename from ')) {
        file.status = 'renamed';
        file.oldPath = raw.slice(12);
      } else if (raw.startsWith('rename to ')) file.path = raw.slice(10);
      else if (raw.startsWith('Binary files ')) file.binary = true;
      else if (raw.startsWith('+++ ') && raw.slice(4) !== '/dev/null')
        file.path = strip(raw.slice(4));
      else if (raw.startsWith('--- ') && file.status === 'deleted' && raw.slice(4) !== '/dev/null')
        file.path = strip(raw.slice(4));
    }
    const h = HUNK.exec(raw);
    if (h) {
      oldNo = Number(h[1]);
      newNo = Number(h[2]);
      hunk = { header: (h[3] ?? '').trim(), lines: [] };
      file.hunks.push(hunk);
      continue;
    }
    if (!hunk) continue;
    const mark = raw[0];
    if (mark === '+') {
      hunk.lines.push({ kind: 'add', text: raw.slice(1), oldNo: null, newNo: newNo++ });
      file.added++;
    } else if (mark === '-') {
      hunk.lines.push({ kind: 'del', text: raw.slice(1), oldNo: oldNo++, newNo: null });
      file.removed++;
    } else if (mark === ' ') {
      hunk.lines.push({ kind: 'ctx', text: raw.slice(1), oldNo: oldNo++, newNo: newNo++ });
    }
    // "\ No newline at end of file" and the truncation note are not lines of the file.
  }
  return files;
}
