/** One side (index or working tree) of a file's status, from `git status --porcelain=v2`. */
export type ChangeCode = '.' | 'M' | 'T' | 'A' | 'D' | 'R' | 'C' | 'U';

export interface FileStatus {
  path: string;
  /** Previous path for renames and copies. */
  origPath?: string;
  kind: 'tracked' | 'renamed' | 'conflicted' | 'untracked';
  /** Staged change. */
  index: ChangeCode;
  /** Unstaged change. */
  worktree: ChangeCode;
}

export interface RepoStatus {
  /** Branch name, or null when HEAD is detached. */
  branch: string | null;
  /** Commit HEAD points at, or null before the first commit. */
  head: string | null;
  upstream: string | null;
  ahead: number;
  behind: number;
  files: FileStatus[];
}

/** Splits `str` on single spaces into at most `count` fields; the last field keeps any spaces. */
function fields(str: string, count: number): string[] {
  const out: string[] = [];
  let rest = str;
  for (let i = 0; i < count - 1; i++) {
    const at = rest.indexOf(' ');
    if (at === -1) break;
    out.push(rest.slice(0, at));
    rest = rest.slice(at + 1);
  }
  out.push(rest);
  return out;
}

function codes(xy: string): { index: ChangeCode; worktree: ChangeCode } {
  return { index: (xy[0] ?? '.') as ChangeCode, worktree: (xy[1] ?? '.') as ChangeCode };
}

/** Parses the output of `git status --porcelain=v2 --branch -z`. */
export function parseStatus(output: string): RepoStatus {
  const status: RepoStatus = {
    branch: null,
    head: null,
    upstream: null,
    ahead: 0,
    behind: 0,
    files: [],
  };
  const entries = output.split('\0');
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    if (!entry) continue;
    const type = entry[0];

    if (type === '#') {
      const [, key, value = ''] = fields(entry, 3);
      if (key === 'branch.oid') status.head = value === '(initial)' ? null : value;
      else if (key === 'branch.head') status.branch = value === '(detached)' ? null : value;
      else if (key === 'branch.upstream') status.upstream = value;
      else if (key === 'branch.ab') {
        const match = /^\+(\d+) -(\d+)$/.exec(value);
        if (match) {
          status.ahead = Number(match[1]);
          status.behind = Number(match[2]);
        }
      }
    } else if (type === '1') {
      const f = fields(entry, 9);
      status.files.push({ path: f[8] ?? '', kind: 'tracked', ...codes(f[1] ?? '') });
    } else if (type === '2') {
      const f = fields(entry, 10);
      // With -z the original path follows as its own entry.
      const origPath = entries[++i] ?? '';
      status.files.push({ path: f[9] ?? '', origPath, kind: 'renamed', ...codes(f[1] ?? '') });
    } else if (type === 'u') {
      const f = fields(entry, 11);
      status.files.push({ path: f[10] ?? '', kind: 'conflicted', index: 'U', worktree: 'U' });
    } else if (type === '?') {
      status.files.push({ path: entry.slice(2), kind: 'untracked', index: '.', worktree: '.' });
    }
  }
  return status;
}
