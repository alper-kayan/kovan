import { git } from '@kovan/git-engine';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Bindings } from './bindings.js';
import { SessionCheckouts } from './sessionCheckouts.js';

const WS = '22222222-2222-4222-8222-222222222222';
const session = (branch: string | null) => ({
  id: '11111111-1111-4111-8111-111111111111',
  workspaceId: WS,
  title: 'Seat race',
  branch,
});
let dir: string;
const sh = (cwd: string, ...args: string[]) => git(cwd, args);

async function machine(name: string) {
  const root = join(dir, name);
  await sh(dir, 'clone', '-q', join(dir, 'remote.git'), root);
  const bindings = new Bindings(join(dir, `${name}-data`));
  await bindings.set(WS, root);
  const connected: string[] = [];
  const checkouts = new SessionCheckouts(
    bindings,
    join(dir, `${name}-data`),
    async (r) => connected.push(r),
    async () => true,
  );
  return { root, bindings, checkouts, connected };
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'kovan-checkouts-'));
  await sh(dir, 'init', '-q', '--bare', '-b', 'main', join(dir, 'remote.git'));
  const seed = join(dir, 'seed');
  await sh(dir, 'clone', '-q', join(dir, 'remote.git'), seed);
  await writeFile(join(seed, 'a.txt'), 'one\n');
  await sh(seed, 'add', '.');
  await sh(seed, '-c', 'user.name=s', '-c', 'user.email=s@k', 'commit', '-q', '-m', 'init');
  await sh(seed, 'push', '-q', 'origin', 'HEAD:main');
});
afterEach(() => rm(dir, { recursive: true, force: true }));

describe('session checkouts', () => {
  it('gives a session its own worktree, shared through the remote, and leaves main alone', async () => {
    const alice = await machine('alice');
    const bob = await machine('bob');
    const { root, created } = await alice.checkouts.ensure(session('kovan/seats'));
    expect(created).toBe(true);
    expect(root).not.toBe(alice.root);
    expect((await sh(alice.root, 'branch', '--show-current')).trim()).toBe('main');
    expect((await sh(root, 'branch', '--show-current')).trim()).toBe('kovan/seats');
    // The new branch went to the remote, so Bob starts from the same commit.
    expect((await sh(join(dir, 'remote.git'), 'rev-parse', 'kovan/seats')).trim()).toBeTruthy();
    expect(await alice.bindings.idFor(root)).toBe(WS);
    expect(await alice.bindings.worktree(root)).toMatchObject({
      mainRoot: alice.root,
      branch: 'kovan/seats',
    });
    // Agent setup follows into the worktree when the main checkout has it.
    expect(alice.connected).toEqual([root]);

    const b = await bob.checkouts.ensure(session('kovan/seats'));
    expect((await sh(b.root, 'rev-parse', 'HEAD')).trim()).toBe(
      (await sh(root, 'rev-parse', 'HEAD')).trim(),
    );
    // Asked again: the same checkout.
    expect((await alice.checkouts.ensure(session('kovan/seats'))).created).toBe(false);
    expect(await alice.checkouts.existing(session('kovan/seats'))).toBe(root);

    await alice.checkouts.remove(session('kovan/seats').id);
    expect(await alice.checkouts.existing(session('kovan/seats'))).toBeNull();
  });

  it('uses the main checkout when it is on the session branch already', async () => {
    const alice = await machine('alice');
    expect((await alice.checkouts.ensure(session('main'))).root).toBe(alice.root);
    expect((await alice.checkouts.ensure(session(null))).root).toBe(alice.root);
  });
});
