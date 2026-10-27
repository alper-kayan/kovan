import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { git } from './git.js';
import {
  checkout,
  commit,
  createBranch,
  discard,
  findRepoRoot,
  getDiffSides,
  getRemoteUrl,
  getStatus,
  listBranches,
  stage,
  unstage,
} from './repo.js';

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'kovan-git-'));
  await git(root, ['init', '-q', '-b', 'main']);
  await git(root, ['config', 'user.email', 'test@kovan.dev']);
  await git(root, ['config', 'user.name', 'Kovan Test']);
  await git(root, ['config', 'commit.gpgsign', 'false']);
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('repo operations', () => {
  it('finds the repo root and returns null outside a repo', async () => {
    expect(await findRepoRoot(root)).toContain('kovan-git-');
    expect(await findRepoRoot(tmpdir())).toBeNull();
  });

  it('stages, unstages before the first commit, and commits', async () => {
    await writeFile(join(root, 'a.txt'), 'one\n');
    expect((await getStatus(root)).files).toEqual([
      { path: 'a.txt', kind: 'untracked', index: '.', worktree: '.' },
    ]);

    await stage(root, ['a.txt']);
    expect((await getStatus(root)).files[0]).toMatchObject({ index: 'A' });

    await unstage(root, ['a.txt']);
    expect((await getStatus(root)).files[0]).toMatchObject({ kind: 'untracked' });

    await stage(root, ['a.txt']);
    const hash = await commit(root, 'first commit');
    const status = await getStatus(root);
    expect(status.head).toBe(hash);
    expect(status.branch).toBe('main');
    expect(status.files).toEqual([]);
  });

  it('returns both sides of staged and unstaged diffs', async () => {
    await writeFile(join(root, 'a.txt'), 'one\n');
    await stage(root, ['a.txt']);
    await commit(root, 'first');

    await writeFile(join(root, 'a.txt'), 'two\n');
    expect(await getDiffSides(root, 'a.txt', false)).toEqual({ original: 'one\n', modified: null });

    await stage(root, ['a.txt']);
    expect(await getDiffSides(root, 'a.txt', true)).toEqual({
      original: 'one\n',
      modified: 'two\n',
    });
  });

  it('discards tracked edits and deletes untracked files', async () => {
    await writeFile(join(root, 'a.txt'), 'one\n');
    await stage(root, ['a.txt']);
    await commit(root, 'first');
    await writeFile(join(root, 'a.txt'), 'changed\n');
    await writeFile(join(root, 'b.txt'), 'new\n');

    await discard(root, ['a.txt', 'b.txt']);
    expect((await getStatus(root)).files).toEqual([]);
  });

  it('creates, lists and switches branches, rejecting option-like names', async () => {
    await writeFile(join(root, 'a.txt'), 'one\n');
    await stage(root, ['a.txt']);
    await commit(root, 'first');

    await createBranch(root, 'feature/x');
    expect((await listBranches(root)).find((b) => b.current)?.name).toBe('feature/x');

    await checkout(root, 'main');
    expect((await getStatus(root)).branch).toBe('main');

    await expect(checkout(root, '--orphan')).rejects.toThrow();
  });

  it('reads the origin remote, or null without one', async () => {
    expect(await getRemoteUrl(root)).toBeNull();
    await git(root, ['remote', 'add', 'origin', 'git@github.com:kovan-dev/kovan.git']);
    expect(await getRemoteUrl(root)).toBe('git@github.com:kovan-dev/kovan.git');
  });

  it('rejects an empty commit message', async () => {
    await expect(commit(root, '   ')).rejects.toThrow('empty');
  });
});
