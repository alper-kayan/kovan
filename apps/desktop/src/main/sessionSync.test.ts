import { git } from '@kovan/git-engine';
import type { LaneEvent, Participant, Session } from '@kovan/shared';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { SyncState } from '../shared/api.js';
import { SessionSync, syncTrouble } from './sessionSync.js';

const SESSION = '11111111-1111-4111-8111-111111111111';
const WORKSPACE = '22222222-2222-4222-8222-222222222222';
const ALICE = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const BOB = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const BRANCH = 'kovan/seats';

let dir: string;
const sh = (cwd: string, ...args: string[]) => git(cwd, args);

/** One person's machine: their clone, their sync, and what it sent the Brain. */
interface Machine {
  root: string;
  sync: SessionSync;
  sent: LaneEvent[];
  states: SyncState[];
  running: boolean;
}

/** A tiny Brain: each machine's latest snapshot, as participants in the session. */
const snapshots = new Map<string, { sha: string; ref: string }>();
function session(): Session {
  const person = (userId: string, name: string): Participant => ({
    userId,
    name,
    avatarUrl: null,
    mode: 'join',
    harness: 'kovan',
    model: null,
    state: 'idle',
    joinedAt: new Date().toISOString(),
    awaitingReason: null,
    snapshotAt: null,
    snapshotSha: snapshots.get(userId)?.sha ?? null,
    snapshotRef: snapshots.get(userId)?.ref ?? null,
    paused: null,
    kind: 'human',
    hostId: null,
    hostName: null,
  });
  return {
    id: SESSION,
    workspaceId: WORKSPACE,
    title: 'Seats',
    branch: BRANCH,
    status: 'active',
    createdBy: ALICE,
    createdAt: '',
    updatedAt: '',
    endedAt: null,
    participants: [person(ALICE, 'Alice'), person(BOB, 'Bob')],
    touchedFiles: [],
    running: [],
    pendingApprovals: 0,
    cost: 0,
    plan: { done: 0, total: 0 },
    tasks: { waiting: 0, running: 0, done: 0, failed: 0, blocked: 0, cancelled: 0 },
    taskApprovals: [],
    locks: [],
    unknownOutcomes: 0,
    subagents: 0,
    swarm: null,
    pr: null,
    issue: null,
    machine: null,
    worktreePath: null,
  };
}

async function machine(name: string, userId: string): Promise<Machine> {
  const root = join(dir, name);
  await sh(dir, 'clone', '-q', join(dir, 'remote.git'), root);
  await sh(root, 'config', 'user.email', `${name}@kovan.test`);
  await sh(root, 'config', 'user.name', name);
  await sh(root, 'switch', '-q', BRANCH);
  const m: Machine = { root, sent: [], states: [], running: false, sync: null! };
  m.sync = new SessionSync({
    userData: join(dir, `${name}-data`),
    me: () => ({ id: userId, name }),
    request: async <T>() => ({ session: session() }) as T,
    laneEvent: (_sessionId, event) => {
      m.sent.push(event);
      if (event.type === 'sync')
        snapshots.set(userId, { sha: String(event['sha']), ref: String(event['ref']) });
    },
    emit: (_root, state) => m.states.push(state),
    laneRunning: () => m.running,
    batchMs: 10,
  });
  await m.sync.attach(root, { sessionId: SESSION, workspaceId: WORKSPACE, branch: BRANCH });
  await m.sync.settled(root);
  return m;
}

/** Saves happen, the batch goes out, and the other machine hears about it. */
async function save(from: Machine, to: Machine): Promise<void> {
  from.sync.onFilesChanged(from.root);
  await from.sync.settled(from.root);
  to.sync.onMessage({ type: 'session', session: session() });
  await new Promise((r) => setTimeout(r, 20));
  await to.sync.settled(to.root);
}

const read = (m: Machine, path: string) => readFile(join(m.root, path), 'utf8');
const last = (m: Machine) => m.states.at(-1)!;

let alice: Machine;
let bob: Machine;

beforeEach(async () => {
  snapshots.clear();
  dir = await mkdtemp(join(tmpdir(), 'kovan-session-sync-'));
  await sh(dir, 'init', '-q', '--bare', '-b', 'main', join(dir, 'remote.git'));
  const seed = join(dir, 'seed');
  await sh(dir, 'clone', '-q', join(dir, 'remote.git'), seed);
  await writeFile(join(seed, 'seats.ts'), 'export const seats = 10;\nexport const rows = 2;\n');
  await sh(seed, 'add', '.');
  await sh(seed, '-c', 'user.name=s', '-c', 'user.email=s@k', 'commit', '-q', '-m', 'init');
  await sh(seed, 'push', '-q', 'origin', `HEAD:${BRANCH}`);
  alice = await machine('alice', ALICE);
  bob = await machine('bob', BOB);
});
afterEach(async () => {
  alice.sync.detachAll();
  bob.sync.detachAll();
  await rm(dir, { recursive: true, force: true });
});

describe('session sync between two machines', () => {
  it("brings a teammate's saved change over, and nothing comes back", async () => {
    await writeFile(
      join(bob.root, 'seats.ts'),
      'export const seats = 12;\nexport const rows = 2;\n',
    );
    await writeFile(join(bob.root, 'map.ts'), 'export const map = [];\n');
    await save(bob, alice);
    expect(await read(alice, 'seats.ts')).toContain('seats = 12');
    expect(await read(alice, 'map.ts')).toBe('export const map = [];\n');
    expect(last(alice).editors['map.ts']).toEqual([{ userId: BOB, name: 'Bob' }]);
    expect(bob.sent.filter((e) => e.type === 'sync')).toHaveLength(2); // attach + save

    // Alice's machine sends the same files back; Bob's has nothing to do.
    await save(alice, bob);
    expect(last(bob).versions).toEqual([]);
    expect(await read(bob, 'seats.ts')).toContain('seats = 12');
  });

  it('keeps both versions when both change the same line, and either side can pick', async () => {
    await writeFile(
      join(alice.root, 'seats.ts'),
      'export const seats = 20;\nexport const rows = 2;\n',
    );
    await writeFile(
      join(bob.root, 'seats.ts'),
      'export const seats = 30;\nexport const rows = 2;\n',
    );
    await save(bob, alice);
    // No silent overwrite: Alice keeps hers, Bob's is kept beside it.
    expect(await read(alice, 'seats.ts')).toContain('seats = 20');
    const [v] = last(alice).versions;
    expect(v).toMatchObject({ path: 'seats.ts', peerId: BOB, peerName: 'Bob', deleted: false });
    expect(await alice.sync.versionContent(alice.root, v!.id)).toContain('seats = 30');
    expect(alice.sent).toContainEqual({ type: 'conflict', path: 'seats.ts', with: BOB });

    // Bob sees the same clash from his side.
    await save(alice, bob);
    expect(last(bob).versions.map((x) => x.peerName)).toEqual(['Alice']);

    // Alice takes Bob's; once Bob hears her file matches his, his "2 versions" clears too.
    await alice.sync.resolveVersion(alice.root, v!.id, 'theirs');
    expect(await read(alice, 'seats.ts')).toContain('seats = 30');
    expect(last(alice).versions).toEqual([]);
    await save(alice, bob);
    expect(last(bob).versions).toEqual([]);
  });

  it('merges edits to different lines of the same file', async () => {
    await writeFile(
      join(alice.root, 'seats.ts'),
      'export const seats = 20;\nexport const rows = 2;\n',
    );
    await writeFile(
      join(bob.root, 'seats.ts'),
      'export const seats = 10;\nexport const rows = 2;\nexport const cols = 4;\n',
    );
    await save(bob, alice);
    expect(await read(alice, 'seats.ts')).toBe(
      'export const seats = 20;\nexport const rows = 2;\nexport const cols = 4;\n',
    );
    expect(last(alice).versions).toEqual([]);
  });

  it("holds teammates' changes while the agent works, then applies them", async () => {
    alice.running = true;
    await writeFile(join(bob.root, 'map.ts'), 'export const map = [];\n');
    await save(bob, alice);
    await expect(read(alice, 'map.ts')).rejects.toThrow();
    alice.running = false;
    alice.sync.laneIdle(SESSION);
    await new Promise((r) => setTimeout(r, 20));
    await alice.sync.settled(alice.root);
    expect(await read(alice, 'map.ts')).toBe('export const map = [];\n');
  });

  it("sends a commit, and the teammate's checkout follows it", async () => {
    await writeFile(join(alice.root, 'map.ts'), 'export const map = [];\n');
    await save(alice, bob);
    await sh(alice.root, 'add', '.');
    await sh(alice.root, 'commit', '-q', '-m', 'Add the map');
    // No file changed; the periodic check notices HEAD moved.
    await new Promise((r) => setTimeout(r, 3_300));
    await alice.sync.settled(alice.root);
    bob.sync.onMessage({ type: 'session', session: session() });
    await new Promise((r) => setTimeout(r, 50));
    await bob.sync.settled(bob.root);
    expect((await sh(bob.root, 'rev-parse', 'HEAD')).trim()).toBe(
      (await sh(alice.root, 'rev-parse', 'HEAD')).trim(),
    );
    expect((await sh(bob.root, 'status', '--porcelain')).trim()).toBe('');
  }, 10_000);

  it('pauses on a manual branch switch and resumes after switching back', async () => {
    await sh(alice.root, 'switch', '-q', '-c', 'experiment');
    await alice.sync.resume(alice.root); // the periodic check, run now
    await sh(alice.root, 'switch', '-q', BRANCH);
    await sh(alice.root, 'switch', '-q', 'experiment');
    // Detected by the branch check.
    await new Promise((r) => setTimeout(r, 3_200));
    expect(last(alice).paused?.kind).toBe('branch');
    expect(alice.sync.pausedReason(alice.root)).toMatch(/switched to experiment/);
    expect(alice.sent.at(-1)).toMatchObject({ type: 'paused', kind: 'branch' });

    // Bob's change waits while Alice is paused.
    await writeFile(join(bob.root, 'map.ts'), 'export const map = [];\n');
    await save(bob, alice);
    await expect(read(alice, 'map.ts')).rejects.toThrow();

    expect((await alice.sync.resume(alice.root))?.paused?.reason).toMatch(/Still on experiment/);
    await alice.sync.switchBack(alice.root);
    await alice.sync.settled(alice.root);
    expect(last(alice).paused).toBeNull();
    expect(alice.sent.at(-1)?.type).toBe('resumed');
    expect(await read(alice, 'map.ts')).toBe('export const map = [];\n');
  }, 10_000);

  it('pauses the sync with a clear reason when the remote refuses, and retries', async () => {
    await sh(alice.root, 'remote', 'set-url', '--push', 'origin', join(dir, 'missing.git'));
    await writeFile(join(alice.root, 'map.ts'), 'x\n');
    alice.sync.onFilesChanged(alice.root);
    await alice.sync.settled(alice.root);
    expect(last(alice)).toMatchObject({ status: 'paused', paused: { kind: 'sync' } });
    await sh(alice.root, 'remote', 'set-url', '--push', 'origin', join(dir, 'remote.git'));
    expect((await alice.sync.resume(alice.root))?.status).toBe('on');
  });

  it('turns off per workspace', async () => {
    await alice.sync.setEnabled(WORKSPACE, false);
    await writeFile(join(bob.root, 'map.ts'), 'export const map = [];\n');
    await save(bob, alice);
    await expect(read(alice, 'map.ts')).rejects.toThrow();
    expect(last(alice).status).toBe('off');
    await alice.sync.setEnabled(WORKSPACE, true);
    await new Promise((r) => setTimeout(r, 50));
    await alice.sync.settled(alice.root);
    expect(await read(alice, 'map.ts')).toBe('export const map = [];\n');
  });

  it("starts from the workspace's shared switch, as the Brain has it", async () => {
    const sync = new SessionSync({
      userData: join(dir, 'carol-data'),
      me: () => ({ id: 'c0000000-0000-4000-8000-000000000003', name: 'carol' }),
      request: async <T>(_method: 'GET', path: string) =>
        (path.startsWith('/api/workspaces/')
          ? { workspace: { autoGitSync: false } }
          : { session: session() }) as T,
      laneEvent: () => {},
      emit: () => {},
      laneRunning: () => false,
      batchMs: 10,
    });
    expect(await sync.enabledFor(WORKSPACE)).toBe(false);
    const down = new SessionSync({
      userData: join(dir, 'dave-data'),
      me: () => null,
      request: async () => {
        throw new Error('offline');
      },
      laneEvent: () => {},
      emit: () => {},
      laneRunning: () => false,
    });
    expect(await down.enabledFor(WORKSPACE)).toBe(true);
  });
});

describe('sync trouble', () => {
  it('names credential and ruleset refusals', () => {
    const err = (stderr: string) => Object.assign(new Error('git push failed'), { stderr });
    expect(syncTrouble(err('remote: error: GH013: Repository rule violations found'))).toMatch(
      /rules refused/,
    );
    expect(syncTrouble(err('fatal: Authentication failed for https://github.com/x'))).toMatch(
      /couldn't sign in/,
    );
    expect(syncTrouble(err('something else'))).toBeNull();
  });
});
