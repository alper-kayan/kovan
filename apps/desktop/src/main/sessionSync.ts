import {
  git,
  gitDir,
  revParse,
  snapshotCommit,
  syncFromSnapshot,
  writeWorkingFile,
  type SyncResult,
} from '@kovan/git-engine';
import type { LaneEvent, Participant, ServerMessage, Session } from '@kovan/shared';
import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { SyncState, SyncVersion } from '../shared/api.js';
import { readJson } from '@kovan/runner';
import { currentBranch, pushRemote, snapshotRef } from '@kovan/runner';

/** Saved changes go out at most this often, batched. */
export const SYNC_BATCH_MS = 5_000;
/** How often a session checkout's branch is checked for a manual switch. */
const BRANCH_CHECK_MS = 3_000;
/** How long a teammate's avatar stays on a file they changed. */
const EDITOR_TTL_MS = 120_000;

const SNAPSHOT_REF = /^refs\/kovan\/snapshots\/[0-9a-f-]{36}\/[0-9a-f-]{36}$/i;

export interface SessionLinkForSync {
  sessionId: string;
  workspaceId: string;
  branch: string;
}

export interface SessionSyncDeps {
  userData: string;
  me(): { id: string; name: string } | null;
  /** The Brain: the session's participants and their snapshots. */
  request<T>(method: 'GET', path: string): Promise<T>;
  /** Sends one of this person's lane events for the session (they reach the whole room). */
  laneEvent(sessionId: string, event: LaneEvent): void;
  /** Files in a session checkout may have changed (its live diff goes out). */
  changed?(sessionId: string, root: string): void;
  /** Shows the state in the windows that have this checkout open. */
  emit(root: string, state: SyncState): void;
  /** Whether this person's agent has a turn running in this checkout's session lane. */
  laneRunning(sessionId: string): boolean;
  /** Batch window for saved changes (tests shorten it). */
  batchMs?: number;
}

interface VersionFile extends SyncVersion {
  /** Their content, base64; absent when they deleted the file. */
  content?: string;
}

interface Attached extends SessionLinkForSync {
  root: string;
  enabled: boolean;
  paused: SyncState['paused'];
  lastPushAt: number | null;
  lastPullAt: number | null;
  lastTree: string | null;
  /** HEAD at the last check: a commit changes no files but still has to go out. */
  lastHead: string | null;
  pushTimer: NodeJS.Timeout | null;
  branchTimer: NodeJS.Timeout;
  /** Teammates' snapshots already looked at, and those held back while the agent works. */
  seen: Map<string, string>;
  held: Map<string, Participant>;
  editors: Map<string, Map<string, { name: string; at: number }>>;
  versions: SyncVersion[];
  queue: Promise<unknown>;
  syncing: boolean;
}

/** Why the remote refused a push or fetch, in words people can act on; null if it's not that. */
export function syncTrouble(error: unknown): string | null {
  const stderr = (error as { stderr?: unknown } | null)?.stderr;
  const text =
    typeof stderr === 'string' && stderr
      ? stderr
      : error instanceof Error
        ? error.message
        : String(error);
  const line =
    text
      .split('\n')
      .map((l) => l.replace(/^(fatal|error|remote):\s*/i, '').trim())
      .find((l) => l && !/^To /.test(l)) ?? 'the remote refused it';
  if (/GH013|rule violation|ruleset|protected|pre-receive hook declined|refusing to/i.test(text))
    return `The repository's rules don't let Kovan save work there, so yours isn't reaching your teammates. Ask an owner of the repository to allow refs/kovan/*, or push your branch yourself. (Git said: ${line})`;
  if (
    /Authentication failed|could not read Username|Permission denied|403|401|terminal prompts disabled|access denied|not authorized/i.test(
      text,
    )
  )
    return `Git couldn't sign in to the repository with your account, so your work isn't reaching your teammates. Check that you can push to it (try a push from Source Control), then Retry. (Git said: ${line})`;
  if (/Could not resolve host|unable to access|Connection (refused|timed out)|Network/i.test(text))
    return `Can't reach the repository's server (offline?), so your work isn't reaching your teammates. It's safe here; Retry once you're back online. (Git said: ${line})`;
  return null;
}

/**
 * Keeps a session checkout in step with the teammates in the session. Saved changes go out as
 * snapshots (a WIP commit on the person's remote, under a shadow ref, with their credentials)
 * at most every five seconds; teammates' snapshots come in checked three ways, and when both
 * changed the same lines both versions are kept ("2 versions"). Nothing is overwritten silently.
 * A manual branch switch in the checkout pauses the session until the person resumes it.
 */
export class SessionSync {
  private readonly attached = new Map<string, Attached>();

  constructor(private readonly deps: SessionSyncDeps) {}

  /**
   * The workspace's automatic Git sync switch: one for everyone in it, kept by the Brain (on
   * unless someone turned it off). Unreachable: on, as it was.
   */
  async enabledFor(workspaceId: string): Promise<boolean> {
    try {
      const { workspace } = await this.deps.request<{ workspace?: { autoGitSync?: boolean } }>(
        'GET',
        `/api/workspaces/${workspaceId}`,
      );
      return workspace?.autoGitSync !== false;
    } catch {
      return true;
    }
  }

  /** The switch changed (here or by a teammate): the checkouts of that workspace follow. */
  setEnabled(workspaceId: string, on: boolean): void {
    for (const a of this.attached.values()) {
      if (a.workspaceId !== workspaceId || a.enabled === on) continue;
      a.enabled = on;
      this.emit(a);
      if (on) {
        this.schedulePush(a, 0);
        void this.pullAll(a);
      }
    }
  }

  state(root: string): SyncState | null {
    const a = this.attached.get(root);
    return a ? this.view(a) : null;
  }

  /** Why agents in this checkout must wait (a manual branch switch), or null. */
  pausedReason(root: string): string | null {
    const a = this.attached.get(root);
    return a?.paused?.kind === 'branch' ? a.paused.reason : null;
  }

  /** Starts syncing a session checkout (idempotent). */
  async attach(root: string, link: SessionLinkForSync): Promise<SyncState> {
    const existing = this.attached.get(root);
    if (existing?.sessionId === link.sessionId) return this.view(existing);
    if (existing) this.detach(root);
    const a: Attached = {
      ...link,
      root,
      enabled: await this.enabledFor(link.workspaceId),
      paused: null,
      lastPushAt: null,
      lastPullAt: null,
      lastTree: null,
      lastHead: null,
      pushTimer: null,
      branchTimer: setInterval(() => void this.checkBranch(a), BRANCH_CHECK_MS),
      seen: new Map(),
      held: new Map(),
      editors: new Map(),
      versions: await this.readVersions(root, link.sessionId),
      queue: Promise.resolve(),
      syncing: false,
    };
    this.attached.set(root, a);
    this.deps.changed?.(a.sessionId, root);
    await this.checkBranch(a);
    this.schedulePush(a, 0);
    void this.pullAll(a);
    return this.view(a);
  }

  detach(root: string): void {
    const a = this.attached.get(root);
    if (!a) return;
    clearInterval(a.branchTimer);
    if (a.pushTimer) clearTimeout(a.pushTimer);
    this.attached.delete(root);
  }

  /** Resolves when everything queued for a checkout has run (tests, shutdown). */
  async settled(root: string): Promise<void> {
    const a = this.attached.get(root);
    if (!a) return;
    while (a.pushTimer) await new Promise((r) => setTimeout(r, 20));
    let last: Promise<unknown> | null = null;
    while (last !== a.queue) {
      last = a.queue;
      await last;
    }
  }

  detachAll(): void {
    for (const root of [...this.attached.keys()]) this.detach(root);
  }

  /** Saved files changed in a checkout: they go out with the next batch. */
  onFilesChanged(root: string): void {
    const a = this.attached.get(root);
    if (!a) return;
    this.schedulePush(a, this.deps.batchMs ?? SYNC_BATCH_MS);
    this.deps.changed?.(a.sessionId, root);
  }

  /** A session changed: teammates' new snapshots come in. */
  onMessage(message: ServerMessage): void {
    const session =
      message.type === 'session' || message.type === 'session.snapshot' ? message.session : null;
    if (!session) return;
    for (const a of this.attached.values())
      if (a.sessionId === session.id) void this.pullFrom(a, session);
  }

  /** The lane's turn ended: snapshots held back while it worked apply now. */
  laneIdle(sessionId: string): void {
    for (const a of this.attached.values()) {
      if (a.sessionId !== sessionId || a.held.size === 0) continue;
      const held = [...a.held.values()];
      a.held.clear();
      for (const p of held) void this.enqueue(a, () => this.apply(a, p));
    }
  }

  /** "Retry" on the sync paused banner, and "Resume" after switching back to the branch. */
  async resume(root: string): Promise<SyncState | null> {
    const a = this.attached.get(root);
    if (!a) return null;
    if (a.paused?.kind === 'branch') {
      const current = await currentBranch(root);
      if (current !== a.branch) {
        a.paused = {
          kind: 'branch',
          reason: `Still on ${current ?? 'a detached HEAD'}; switch back to ${a.branch} to resume.`,
        };
        this.emit(a);
        return this.view(a);
      }
    }
    const was = a.paused;
    a.paused = null;
    a.lastTree = null;
    await this.enqueue(a, () => this.push(a));
    if (!a.paused) {
      if (was) this.deps.laneEvent(a.sessionId, { type: 'resumed' });
      await this.pullAll(a);
    }
    this.emit(a);
    return this.view(a);
  }

  /** Switches the checkout back to the session's branch (the banner's fix), then resumes. */
  async switchBack(root: string): Promise<SyncState | null> {
    const a = this.attached.get(root);
    if (!a) return null;
    await git(root, ['switch', a.branch]);
    return this.resume(root);
  }

  // ---------- versions ----------

  private async versionsDir(root: string, sessionId: string): Promise<string> {
    return join(await gitDir(root), 'kovan', 'versions', sessionId);
  }

  private async readVersions(root: string, sessionId: string): Promise<SyncVersion[]> {
    const dir = await this.versionsDir(root, sessionId);
    const names = await readdir(dir).catch(() => [] as string[]);
    const list: SyncVersion[] = [];
    for (const name of names.filter((n) => n.endsWith('.json'))) {
      const v = (await readJson(join(dir, name))) as VersionFile | null;
      if (v?.id && v.path) list.push(stripContent(v));
    }
    return list.sort((x, y) => x.path.localeCompare(y.path));
  }

  private async keepVersion(
    a: Attached,
    path: string,
    peer: { id: string; name: string },
    theirs: Buffer | null,
  ): Promise<void> {
    const id = createHash('sha1').update(`${path}\0${peer.id}`).digest('hex').slice(0, 16);
    const v: VersionFile = {
      id,
      path,
      peerId: peer.id,
      peerName: peer.name,
      at: Date.now(),
      deleted: theirs === null,
      ...(theirs ? { content: theirs.toString('base64') } : {}),
    };
    const dir = await this.versionsDir(a.root, a.sessionId);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, `${id}.json`), JSON.stringify(v), { mode: 0o600 });
    a.versions = [...a.versions.filter((x) => x.id !== id), stripContent(v)].sort((x, y) =>
      x.path.localeCompare(y.path),
    );
  }

  private async dropVersion(a: Attached, id: string): Promise<void> {
    await rm(join(await this.versionsDir(a.root, a.sessionId), `${id}.json`), { force: true });
    a.versions = a.versions.filter((v) => v.id !== id);
  }

  /** A teammate's kept version, to compare with yours. */
  async versionContent(root: string, id: string): Promise<string | null> {
    const a = this.attached.get(root);
    if (!a || !/^[0-9a-f]{16}$/.test(id)) return null;
    const v = (await readJson(
      join(await this.versionsDir(root, a.sessionId), `${id}.json`),
    )) as VersionFile | null;
    return v?.content ? Buffer.from(v.content, 'base64').toString('utf8') : null;
  }

  /** Picks one of the two versions: yours stays, or theirs replaces it. */
  async resolveVersion(root: string, id: string, keep: 'mine' | 'theirs'): Promise<SyncState> {
    const a = this.attached.get(root);
    if (!a) throw new Error('This checkout is not syncing a session');
    const v = a.versions.find((x) => x.id === id);
    if (!v) throw new Error('That version was resolved already');
    if (keep === 'theirs') {
      const raw = (await readJson(
        join(await this.versionsDir(root, a.sessionId), `${id}.json`),
      )) as VersionFile | null;
      await writeWorkingFile(
        root,
        v.path,
        raw?.content ? Buffer.from(raw.content, 'base64') : null,
      );
    }
    await this.dropVersion(a, id);
    this.schedulePush(a, 0);
    this.emit(a);
    return this.view(a);
  }

  /**
   * Your unsaved buffer is about to replace a file that changed on disk meanwhile: the disk's
   * version is kept beside yours first, so saving never drops a teammate's change.
   */
  async keepDiskVersion(root: string, path: string): Promise<void> {
    const a = this.attached.get(root);
    if (!a) return;
    const content = await readFile(join(root, path)).catch(() => null);
    const editor = [...(a.editors.get(path)?.entries() ?? [])].at(-1);
    await this.keepVersion(
      a,
      path,
      editor ? { id: editor[0], name: editor[1].name } : { id: 'disk', name: 'the file on disk' },
      content,
    );
    this.emit(a);
  }

  // ---------- going out ----------

  private schedulePush(a: Attached, delay: number): void {
    if (a.pushTimer) return;
    a.pushTimer = setTimeout(() => {
      a.pushTimer = null;
      void this.enqueue(a, () => this.push(a));
    }, delay);
  }

  private async push(a: Attached): Promise<void> {
    const me = this.deps.me();
    if (!a.enabled || a.paused || !me || this.attached.get(a.root) !== a) return;
    const ref = snapshotRef(a.sessionId, me.id);
    try {
      const { sha, tree } = await snapshotCommit(a.root, `Kovan sync: ${me.name}`);
      // Only when the files (or HEAD) changed since the last snapshot that went out.
      const key = `${await revParse(a.root, 'HEAD')}:${tree}`;
      if (key === a.lastTree) return;
      a.syncing = true;
      this.emit(a);
      const remote = await pushRemote(a.root);
      if (!remote) return; // nowhere to sync through
      await git(a.root, ['push', '--force', '--no-verify', remote, `${sha}:${ref}`], {
        timeoutMs: 60_000,
      });
      a.lastTree = key;
      a.lastPushAt = Date.now();
      this.deps.laneEvent(a.sessionId, { type: 'sync', sha, ref });
    } catch (error) {
      const trouble = syncTrouble(error);
      a.paused = {
        kind: 'sync',
        reason:
          trouble ??
          `Your work couldn't be sent to your teammates (${(error as Error).message.split('\n')[0]}). It's safe here; Retry to send it again.`,
      };
      this.deps.laneEvent(a.sessionId, { type: 'paused', kind: 'sync', reason: a.paused.reason });
    } finally {
      a.syncing = false;
      this.emit(a);
    }
  }

  // ---------- coming in ----------

  private async pullAll(a: Attached): Promise<void> {
    const { session } = await this.deps
      .request<{ session: Session }>('GET', `/api/sessions/${a.sessionId}`)
      .catch(() => ({ session: null }));
    if (session) await this.pullFrom(a, session);
  }

  private async pullFrom(a: Attached, session: Session): Promise<void> {
    const me = this.deps.me();
    for (const p of session.participants) {
      if (p.userId === me?.id || !p.snapshotSha || !p.snapshotRef) continue;
      if (a.seen.get(p.userId) === p.snapshotSha) continue;
      if (!a.enabled || a.paused) continue; // picked up again on resume
      if (this.deps.laneRunning(a.sessionId)) {
        a.held.set(p.userId, p);
        continue;
      }
      await this.enqueue(a, () => this.apply(a, p));
    }
  }

  private async apply(a: Attached, p: Participant): Promise<void> {
    if (!p.snapshotSha || !p.snapshotRef || !SNAPSHOT_REF.test(p.snapshotRef)) return;
    if (a.seen.get(p.userId) === p.snapshotSha || !a.enabled || a.paused) return;
    if (this.attached.get(a.root) !== a) return;
    const remote = await pushRemote(a.root);
    a.syncing = true;
    this.emit(a);
    try {
      if (remote)
        await git(a.root, ['fetch', '--no-tags', remote, `+${p.snapshotRef}:${p.snapshotRef}`], {
          timeoutMs: 60_000,
        });
      const sha = await revParse(a.root, `${p.snapshotSha}^{commit}`);
      if (!sha) return; // not on the remote yet; the next announcement brings it
      const appliedRef = `refs/kovan/applied/${a.sessionId}/${p.userId}`;
      const base = await revParse(a.root, `${appliedRef}^{commit}`);
      const result = await syncFromSnapshot(a.root, sha, base);
      await git(a.root, ['update-ref', appliedRef, sha]);
      a.seen.set(p.userId, p.snapshotSha);
      a.lastPullAt = Date.now();
      await this.record(a, p, result);
    } catch (error) {
      const trouble = syncTrouble(error);
      if (trouble) {
        a.paused = { kind: 'sync', reason: trouble };
        this.deps.laneEvent(a.sessionId, { type: 'paused', kind: 'sync', reason: trouble });
      } else console.warn('Sync from', p.name, 'failed:', error);
    } finally {
      a.syncing = false;
      this.emit(a);
    }
  }

  private async record(a: Attached, p: Participant, r: SyncResult): Promise<void> {
    const now = Date.now();
    for (const path of [...r.taken, ...r.merged, ...r.conflicts.map((c) => c.path)]) {
      let who = a.editors.get(path);
      if (!who) a.editors.set(path, (who = new Map()));
      who.set(p.userId, { name: p.name, at: now });
    }
    // Their version now matches yours: nothing left to pick between.
    for (const path of [...r.same, ...r.taken]) {
      const v = a.versions.find((x) => x.path === path && x.peerId === p.userId);
      if (v) await this.dropVersion(a, v.id);
    }
    for (const c of r.conflicts) {
      await this.keepVersion(a, c.path, { id: p.userId, name: p.name }, c.theirs);
      this.deps.laneEvent(a.sessionId, { type: 'conflict', path: c.path, with: p.userId });
    }
  }

  // ---------- the branch ----------

  private async checkBranch(a: Attached): Promise<void> {
    if (this.attached.get(a.root) !== a || a.paused?.kind === 'branch') return;
    const current = await currentBranch(a.root).catch(() => a.branch);
    if (current === a.branch) {
      // A commit (here or in a terminal) moves HEAD without touching files: send it too.
      const head = await revParse(a.root, 'HEAD');
      if (a.lastHead && head !== a.lastHead) this.schedulePush(a, 0);
      a.lastHead = head;
      return;
    }
    a.paused = {
      kind: 'branch',
      reason: `You switched to ${current ?? 'a detached HEAD'} in this session's checkout; the session works on ${a.branch}. Nothing syncs and agents wait until you resume.`,
    };
    this.deps.laneEvent(a.sessionId, { type: 'paused', kind: 'branch', reason: a.paused.reason });
    this.emit(a);
  }

  // ---------- plumbing ----------

  private enqueue<T>(a: Attached, fn: () => Promise<T>): Promise<T | undefined> {
    const next = a.queue.then(fn, fn).catch((error: unknown) => {
      console.warn('Sync:', error);
      return undefined;
    });
    a.queue = next;
    return next;
  }

  private view(a: Attached): SyncState {
    const now = Date.now();
    const editors: SyncState['editors'] = {};
    for (const [path, who] of a.editors) {
      const live = [...who.entries()].filter(([, w]) => now - w.at < EDITOR_TTL_MS);
      if (live.length) editors[path] = live.map(([userId, w]) => ({ userId, name: w.name }));
    }
    return {
      sessionId: a.sessionId,
      workspaceId: a.workspaceId,
      root: a.root,
      branch: a.branch,
      enabled: a.enabled,
      status: a.paused ? 'paused' : !a.enabled ? 'off' : a.syncing ? 'syncing' : 'on',
      paused: a.paused,
      lastPushAt: a.lastPushAt,
      lastPullAt: a.lastPullAt,
      versions: a.versions,
      editors,
    };
  }

  private emit(a: Attached): void {
    if (this.attached.get(a.root) === a) this.deps.emit(a.root, this.view(a));
  }
}

function stripContent(v: VersionFile): SyncVersion {
  return {
    id: v.id,
    path: v.path,
    peerId: v.peerId,
    peerName: v.peerName,
    at: v.at,
    deleted: v.deleted,
  };
}
