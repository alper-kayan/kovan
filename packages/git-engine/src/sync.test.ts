import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { git } from './git.js';
import { logGraph, push } from './repo.js';
import { snapshotCommit, syncFromSnapshot } from './sync.js';
import {
  addDetachedWorktree,
  addWorktree,
  listWorktrees,
  mainCheckout,
  removeWorktree,
  worktreeOfBranch,
} from './worktree.js';

let dir: string;
let remote: string;
let alice: string;
let bob: string;

const sh = (cwd: string, ...args: string[]) => git(cwd, args);
const read = (root: string, path: string) => readFile(join(root, path), 'utf8');

async function clone(name: string): Promise<string> {
  const path = join(dir, name);
  await sh(dir, 'clone', '-q', remote, path);
  await sh(path, 'config', 'user.email', `${name}@kovan.test`);
  await sh(path, 'config', 'user.name', name);
  return path;
}

/** Snapshots `from` and fetches it into `to`, as the sync does over the remote. */
async function share(from: string, to: string, ref: string): Promise<string> {
  const { sha } = await snapshotCommit(from, 'snapshot');
  await sh(from, 'push', '-q', '--force', 'origin', `${sha}:${ref}`);
  await sh(to, 'fetch', '-q', 'origin', `+${ref}:${ref}`);
  return sha;
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'kovan-sync-'));
  remote = join(dir, 'remote.git');
  await sh(dir, 'init', '-q', '--bare', '-b', 'main', remote);
  const seed = await clone('seed');
  await writeFile(join(seed, 'a.txt'), 'one\ntwo\nthree\nfour\nfive\n');
  await writeFile(join(seed, 'b.txt'), 'bee\n');
  await sh(seed, 'add', '.');
  await sh(seed, 'commit', '-q', '-m', 'init');
  await sh(seed, 'push', '-q', 'origin', 'HEAD:main');
  alice = await clone('alice');
  bob = await clone('bob');
});
afterEach(() => rm(dir, { recursive: true, force: true }));

describe('worktrees', () => {
  it('adds a session worktree on a branch and a detached one for a subagent', async () => {
    const session = join(dir, 'wt-session');
    await addWorktree(alice, session, 'kovan/race');
    const sub = join(dir, 'wt-sub');
    const { sha } = await snapshotCommit(session, 'base');
    await addDetachedWorktree(alice, sub, sha);

    const list = await listWorktrees(alice);
    expect(list.map((w) => w.main)).toEqual([true, false, false]);
    expect(list[1]).toMatchObject({ branch: 'kovan/race' });
    expect(list[2]).toMatchObject({ branch: null, head: sha });
    expect(await mainCheckout(session)).toBe(list[0]!.path);
    expect(await worktreeOfBranch(alice, 'kovan/race')).toBe(list[1]!.path);
    // Git refuses the same branch twice.
    await expect(addWorktree(alice, join(dir, 'wt-again'), 'kovan/race')).rejects.toThrow();

    await removeWorktree(alice, sub);
    expect(await listWorktrees(alice)).toHaveLength(2);
  });

  it('starts a new branch from the remote one when it exists there', async () => {
    await writeFile(join(bob, 'c.txt'), 'sea\n');
    await sh(bob, 'switch', '-q', '-c', 'kovan/shared');
    await sh(bob, 'add', '.');
    await sh(bob, 'commit', '-q', '-m', 'c');
    await sh(bob, 'push', '-q', 'origin', 'kovan/shared');
    await sh(alice, 'fetch', '-q');
    const wt = join(dir, 'wt-shared');
    await addWorktree(alice, wt, 'kovan/shared');
    expect(await read(wt, 'c.txt')).toBe('sea\n');
  });
});

describe('three-way snapshot sync', () => {
  const ref = 'refs/kovan/snapshots/s1/bob';

  it('takes files only they changed, merges separate edits, keeps both versions on a clash', async () => {
    await writeFile(join(bob, 'a.txt'), 'ONE\ntwo\nthree\nfour\nfive\n');
    await writeFile(join(bob, 'b.txt'), 'bob bee\n');
    await writeFile(join(bob, 'new.txt'), 'from bob\n');
    await writeFile(join(alice, 'a.txt'), 'one\ntwo\nthree\nfour\nFIVE\n');
    await writeFile(join(alice, 'b.txt'), 'alice bee\n');

    const snap = await share(bob, alice, ref);
    const r = await syncFromSnapshot(alice, snap, null);
    expect(r.taken).toEqual(['new.txt']);
    expect(r.merged).toEqual(['a.txt']);
    expect(r.conflicts.map((c) => [c.path, c.theirs?.toString()])).toEqual([
      ['b.txt', 'bob bee\n'],
    ]);
    expect(await read(alice, 'new.txt')).toBe('from bob\n');
    expect(await read(alice, 'a.txt')).toBe('ONE\ntwo\nthree\nfour\nFIVE\n');
    // No silent overwrite: Alice keeps hers.
    expect(await read(alice, 'b.txt')).toBe('alice bee\n');
  });

  it('does nothing the second time, and nothing when the change came back', async () => {
    await writeFile(join(bob, 'b.txt'), 'bob bee\n');
    const first = await share(bob, alice, ref);
    expect((await syncFromSnapshot(alice, first, null)).taken).toEqual(['b.txt']);
    // Alice's own snapshot now carries Bob's change back to him: nothing to do.
    const back = await share(alice, bob, 'refs/kovan/snapshots/s1/alice');
    const r = await syncFromSnapshot(bob, back, null);
    expect(r.taken).toEqual([]);
    expect(r.same).toEqual(['b.txt']);
    // From the last snapshot Alice took in, Bob's next edit is all that's new.
    await writeFile(join(bob, 'a.txt'), 'ONE\ntwo\nthree\nfour\nfive\n');
    const second = await share(bob, alice, ref);
    expect((await syncFromSnapshot(alice, second, first)).taken).toEqual(['a.txt']);
  });

  it('deletes what they deleted, unless it was changed here', async () => {
    await sh(bob, 'rm', '-q', 'b.txt');
    const snap = await share(bob, alice, ref);
    expect((await syncFromSnapshot(alice, snap, null)).taken).toEqual(['b.txt']);
    await expect(read(alice, 'b.txt')).rejects.toThrow();

    const carol = await clone('carol');
    await writeFile(join(carol, 'b.txt'), 'carol bee\n');
    await sh(carol, 'fetch', '-q', 'origin', `+${ref}:${ref}`);
    const r = await syncFromSnapshot(carol, snap, null);
    expect(r.conflicts).toEqual([{ path: 'b.txt', theirs: null }]);
    expect(await read(carol, 'b.txt')).toBe('carol bee\n');
  });

  it('follows their commits so they are not shown as local changes', async () => {
    await writeFile(join(bob, 'a.txt'), 'ONE\ntwo\nthree\nfour\nfive\n');
    await sh(bob, 'commit', '-q', '-am', 'bob commits');
    await writeFile(join(bob, 'b.txt'), 'wip\n');
    const snap = await share(bob, alice, ref);
    const r = await syncFromSnapshot(alice, snap, null);
    expect(r.movedHead).toBe(true);
    expect((await sh(alice, 'rev-parse', 'HEAD')).trim()).toBe(
      (await sh(bob, 'rev-parse', 'HEAD')).trim(),
    );
    expect((await sh(alice, 'status', '--porcelain')).trim()).toBe('M b.txt');
  });
});

describe('subagent integration', () => {
  it('reports without writing, and writes nothing at all when one file conflicts', async () => {
    const base = (await snapshotCommit(alice, 'base')).sha;
    const child = join(dir, 'child');
    await sh(alice, 'worktree', 'add', '-q', '--detach', child, base);
    await writeFile(join(child, 'a.txt'), 'ONE\ntwo\nthree\nfour\nfive\n');
    await writeFile(join(child, 'new.txt'), 'from the subagent\n');
    const work = (await snapshotCommit(child, 'work')).sha;

    const dry = await syncFromSnapshot(alice, work, base, { dryRun: true, followHead: false });
    expect(dry.taken.sort()).toEqual(['a.txt', 'new.txt']);
    await expect(read(alice, 'new.txt')).rejects.toThrow();

    // The parent changed the same line meanwhile: nothing of the child's lands.
    await writeFile(join(alice, 'a.txt'), 'uno\ntwo\nthree\nfour\nfive\n');
    const blocked = await syncFromSnapshot(alice, work, base, { atomic: true, followHead: false });
    expect(blocked.conflicts.map((c) => c.path)).toEqual(['a.txt']);
    await expect(read(alice, 'new.txt')).rejects.toThrow();
    expect(await read(alice, 'a.txt')).toBe('uno\ntwo\nthree\nfour\nfive\n');

    // Without the clash it all lands, and HEAD stays where the parent had it.
    await writeFile(join(alice, 'a.txt'), 'one\ntwo\nthree\nfour\nfive\n');
    const head = (await sh(alice, 'rev-parse', 'HEAD')).trim();
    await syncFromSnapshot(alice, work, base, { atomic: true, followHead: false });
    expect(await read(alice, 'new.txt')).toBe('from the subagent\n');
    expect((await sh(alice, 'rev-parse', 'HEAD')).trim()).toBe(head);
  });
});

describe('push and graph', () => {
  it('pushes a new branch with its upstream, then the history shows both lines', async () => {
    await sh(alice, 'switch', '-q', '-c', 'kovan/feature');
    await writeFile(join(alice, 'c.txt'), 'sea\n');
    await sh(alice, 'add', '.');
    await sh(alice, 'commit', '-q', '-m', 'Add c');
    expect(await push(alice)).toBe('origin');
    expect((await sh(remote, 'rev-parse', 'kovan/feature')).trim()).toBe(
      (await sh(alice, 'rev-parse', 'HEAD')).trim(),
    );
    await writeFile(join(alice, 'c.txt'), 'sea two\n');
    await sh(alice, 'commit', '-q', '-am', 'Change c');
    expect(await push(alice)).toBe('origin');

    const graph = await logGraph(alice);
    expect(graph.map((c) => c.subject)).toEqual(['Change c', 'Add c', 'init']);
    expect(graph[0]!.refs).toEqual(
      expect.arrayContaining(['kovan/feature', 'origin/kovan/feature']),
    );
    expect(graph[1]!.parents).toEqual([graph[2]!.sha]);
  });
});
