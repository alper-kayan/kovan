import { describe, expect, it } from 'vitest';
import { parseStatus } from './status.js';

const z = (...entries: string[]) => entries.join('\0') + '\0';

describe('parseStatus', () => {
  it('reads branch headers', () => {
    const s = parseStatus(
      z(
        '# branch.oid abc123',
        '# branch.head main',
        '# branch.upstream origin/main',
        '# branch.ab +2 -1',
      ),
    );
    expect(s).toMatchObject({
      head: 'abc123',
      branch: 'main',
      upstream: 'origin/main',
      ahead: 2,
      behind: 1,
    });
  });

  it('handles an initial commit and detached HEAD', () => {
    const s = parseStatus(z('# branch.oid (initial)', '# branch.head (detached)'));
    expect(s.head).toBeNull();
    expect(s.branch).toBeNull();
  });

  it('parses ordinary, renamed, conflicted and untracked entries, keeping spaces in paths', () => {
    const s = parseStatus(
      z(
        '1 .M N... 100644 100644 100644 aaa bbb src/my file.ts',
        '2 R. N... 100644 100644 100644 aaa bbb R100 new name.ts',
        'old name.ts',
        'u UU N... 100644 100644 100644 100644 a b c conflict.ts',
        '? notes/todo.md',
      ),
    );
    expect(s.files).toEqual([
      { path: 'src/my file.ts', kind: 'tracked', index: '.', worktree: 'M' },
      { path: 'new name.ts', origPath: 'old name.ts', kind: 'renamed', index: 'R', worktree: '.' },
      { path: 'conflict.ts', kind: 'conflicted', index: 'U', worktree: 'U' },
      { path: 'notes/todo.md', kind: 'untracked', index: '.', worktree: '.' },
    ]);
  });
});
