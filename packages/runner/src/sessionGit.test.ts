import { git } from '@kovan/git-engine';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  applySnapshot,
  currentBranch,
  defaultBranch,
  finalDiff,
  liveDiff,
  pushProblem,
  pushSnapshot,
  snapshotRef,
  switchToBranch,
} from './sessionGit.js';

let dir: string;
let repo: string;
let remote: string;

async function sh(cwd: string, ...args: string[]) {
  return git(cwd, args);
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'kovan-session-git-'));
  remote = join(dir, 'remote.git');
  repo = join(dir, 'repo');
  await sh(dir, 'init', '--bare', '-b', 'main', remote);
  await sh(dir, 'init', '-b', 'main', repo);
  await sh(repo, 'config', 'user.email', 't@kovan.test');
  await sh(repo, 'config', 'user.name', 'T');
  await writeFile(join(repo, 'a.txt'), 'one\n');
  await sh(repo, 'add', '.');
  await sh(repo, 'commit', '-m', 'init');
  await sh(repo, 'remote', 'add', 'origin', remote);
  await sh(repo, 'push', '-u', 'origin', 'main');
});
afterEach(async () => {
  await chmod(remote, 0o755).catch(() => {});
  await rm(dir, { recursive: true, force: true });
});

describe('session git checks', () => {
  it('switches to the session branch, creating it when needed', async () => {
    await switchToBranch(repo, 'kovan/lobby-race');
    expect(await currentBranch(repo)).toBe('kovan/lobby-race');
    await switchToBranch(repo, 'main');
    await switchToBranch(repo, 'kovan/lobby-race');
    expect(await currentBranch(repo)).toBe('kovan/lobby-race');
    await expect(switchToBranch(repo, '--force')).rejects.toThrow();
  });

  it('passes the push check with access, even when behind, and explains when not', async () => {
    expect(await pushProblem(repo, 'kovan/x')).toBeNull();

    // Someone else pushed to main: this checkout is behind, but access is still proven.
    const other = join(dir, 'other');
    await sh(dir, 'clone', remote, other);
    await sh(other, 'config', 'user.email', 'o@kovan.test');
    await sh(other, 'config', 'user.name', 'O');
    await writeFile(join(other, 'b.txt'), 'two\n');
    await sh(other, 'add', '.');
    await sh(other, 'commit', '-m', 'other');
    await sh(other, 'push');
    expect(await pushProblem(repo, 'main')).toBeNull();

    await sh(repo, 'remote', 'set-url', 'origin', join(dir, 'missing.git'));
    expect(await pushProblem(repo, 'kovan/x')).toMatch(/^You can't push to origin: /);
  });

  it('passes repos without a remote', async () => {
    await sh(repo, 'remote', 'remove', 'origin');
    expect(await pushProblem(repo, 'kovan/x')).toBeNull();
  });

  it('builds the final diff from where the branch left main, committed or not', async () => {
    expect(await finalDiff(repo, 'main')).toBeNull();
    await switchToBranch(repo, 'kovan/work');
    await writeFile(join(repo, 'a.txt'), 'one\ntwo\n');
    await sh(repo, 'commit', '-am', 'two');
    await writeFile(join(repo, 'a.txt'), 'one\ntwo\nthree\n');
    const diff = await finalDiff(repo, 'main');
    expect(diff).toContain('+two');
    expect(diff).toContain('+three');
  });
});

describe('live changes', () => {
  it('includes new files without touching the staging area', async () => {
    expect(await defaultBranch(repo)).toBe('main');
    await switchToBranch(repo, 'kovan/work');
    await writeFile(join(repo, 'a.txt'), 'one\ntwo\n');
    await sh(repo, 'commit', '-am', 'two');
    await writeFile(join(repo, 'new.txt'), 'brand new\n');
    await writeFile(join(repo, '.gitignore'), 'secret.env\n');
    await writeFile(join(repo, 'secret.env'), 'KEY=1\n');
    const head = (await sh(repo, 'rev-parse', 'HEAD')).trim();
    const view = await liveDiff(repo, 'main');
    expect(view.commit).toBe(head);
    expect(view.diff).toContain('+two');
    expect(view.diff).toContain('diff --git a/new.txt b/new.txt');
    expect(view.diff).toContain('+brand new');
    expect(view.diff).not.toContain('KEY=1');
    // The person's own index is as it was: new.txt is still untracked.
    expect(await sh(repo, 'status', '--porcelain')).toContain('?? new.txt');
    expect(await finalDiff(repo, 'main')).not.toContain('new.txt');
    // Back on main with nothing changed: nothing to show.
    await sh(repo, 'clean', '-fdx');
    await sh(repo, 'switch', 'main');
    expect((await liveDiff(repo, 'main')).diff).toBeNull();
  });
});

describe('checkpoint snapshots', () => {
  it('snapshots work in progress without touching the branch, and a teammate continues from it', async () => {
    await switchToBranch(repo, 'kovan/race');
    await writeFile(join(repo, 'a.txt'), 'one\ntwo\n');
    await writeFile(join(repo, 'new.txt'), 'brand new\n');
    const headBefore = (await sh(repo, 'rev-parse', 'HEAD')).trim();
    const snap = await pushSnapshot(repo, snapshotRef('s1', 'bob'), 'Kovan snapshot of bob');
    expect(snap?.ref).toBe('refs/kovan/snapshots/s1/bob');
    // Bob's branch, index and files are as they were.
    expect((await sh(repo, 'rev-parse', 'HEAD')).trim()).toBe(headBefore);
    expect(await sh(repo, 'status', '--porcelain')).toContain('?? new.txt');
    expect((await sh(remote, 'rev-parse', snap!.ref)).trim()).toBe(snap!.sha);

    // Alice, on a clean clone of the branch, picks it up.
    const alice = join(dir, 'alice');
    await sh(dir, 'clone', '-q', remote, alice);
    await sh(alice, 'switch', '-c', 'kovan/race');
    expect(await applySnapshot(alice, snap!.ref, snap!.sha)).toBe('fast-forward');
    expect(await readFile(join(alice, 'new.txt'), 'utf8')).toBe('brand new\n');

    // A dirty checkout is refused, not overwritten.
    await writeFile(join(alice, 'a.txt'), 'mine\n');
    await expect(applySnapshot(alice, snap!.ref, snap!.sha)).rejects.toThrow(/uncommitted changes/);
  });
});
