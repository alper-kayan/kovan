import {
  addDetachedWorktree,
  addWorktree,
  findRepoRoot,
  git,
  listWorktrees,
  removeWorktree,
} from '@kovan/git-engine';
import { createHash } from 'node:crypto';
import { mkdir, stat } from 'node:fs/promises';
import { basename, join } from 'node:path';
import type { Bindings } from './bindings.js';
import { currentBranch, pushRemote } from './sessionGit.js';

export interface SessionForCheckout {
  id: string;
  workspaceId: string;
  title: string;
  branch: string | null;
}

const slug = (text: string) =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'session';

const exists = (path: string) =>
  stat(path)
    .then(() => true)
    .catch(() => false);

/**
 * Where a session's work happens on this machine. The main checkout when it is already on the
 * session's branch; otherwise a dedicated Git worktree, so joining a session never touches the
 * person's own checkout. When Git can't check the branch out twice, the worktree gets a session
 * branch that starts from it. Subagents get a detached worktree from a session snapshot.
 * A worktree is not a security boundary: commands still run as the person.
 */
export class SessionCheckouts {
  constructor(
    private readonly bindings: Bindings,
    private readonly userData: string,
    /** Writes Kovan's local agent setup into a new worktree when the main checkout has it. */
    private readonly connect: (root: string) => Promise<unknown>,
    private readonly isConnected: (root: string) => Promise<boolean>,
  ) {}

  private dirFor(mainRoot: string): string {
    const hash = createHash('sha1').update(mainRoot).digest('hex').slice(0, 8);
    return join(this.userData, 'worktrees', `${slug(basename(mainRoot))}-${hash}`);
  }

  /** The checkout a session uses here, if this machine has one already. */
  async existing(session: SessionForCheckout): Promise<string | null> {
    const mainRoot = (await this.bindings.all())[session.workspaceId];
    if (!mainRoot) return null;
    for (const [path, c] of Object.entries(await this.bindings.worktrees()))
      if (c.sessionId === session.id && (await exists(path))) return path;
    if (!session.branch || (await currentBranch(mainRoot)) === session.branch) return mainRoot;
    return null;
  }

  /** The session's checkout here, made when needed. */
  async ensure(session: SessionForCheckout): Promise<{ root: string; created: boolean }> {
    const mainRoot = (await this.bindings.all())[session.workspaceId];
    if (!mainRoot) throw new Error("This workspace isn't set up on this machine yet.");
    const found = await this.existing(session);
    if (found) return { root: found, created: false };
    const branch = session.branch!;

    // The branch may be checked out in a worktree already (one this person made by hand).
    const where = (await listWorktrees(mainRoot)).find((w) => w.branch === branch && !w.main);
    if (where) {
      await this.register(where.path, session, mainRoot, branch);
      return { root: where.path, created: false };
    }

    // Bring the branch from the remote when a teammate pushed it.
    const remote = await pushRemote(mainRoot);
    const fetched = remote
      ? await git(
          mainRoot,
          ['fetch', '--no-tags', remote, `+refs/heads/${branch}:refs/remotes/${remote}/${branch}`],
          {
            timeoutMs: 60_000,
          },
        )
          .then(() => true)
          .catch(() => false)
      : false;

    const dir = this.dirFor(mainRoot);
    await mkdir(dir, { recursive: true });
    const path = join(dir, `${slug(session.title)}-${session.id.slice(0, 8)}`);
    let used = branch;
    try {
      await addWorktree(mainRoot, path, branch);
    } catch (error) {
      // Git can't check the same branch out twice: a session branch from it instead.
      if (!/already (checked out|used by worktree)/i.test(String((error as Error).message)))
        throw error;
      used = `kovan/session-${session.id.slice(0, 8)}`;
      await addWorktree(mainRoot, path, used, branch);
    }
    const root = (await findRepoRoot(path)) ?? path;
    await this.register(root, session, mainRoot, used);
    // A branch that starts here goes to the remote, so teammates start from the same commit.
    if (remote && !fetched && used === branch)
      await git(root, ['push', '--no-verify', '-u', remote, `HEAD:refs/heads/${branch}`], {
        timeoutMs: 60_000,
      }).catch(() => undefined);
    if (await this.isConnected(mainRoot).catch(() => false))
      await this.connect(root).catch(() => undefined);
    return { root, created: true };
  }

  private async register(
    root: string,
    session: SessionForCheckout,
    mainRoot: string,
    branch: string,
  ): Promise<void> {
    await this.bindings.setWorktree(root, {
      workspaceId: session.workspaceId,
      sessionId: session.id,
      mainRoot,
      branch,
      title: session.title,
    });
  }

  /** Removes a session's worktree (when the session is over); the branch stays. */
  async remove(sessionId: string): Promise<void> {
    for (const [path, c] of Object.entries(await this.bindings.worktrees())) {
      if (c.sessionId !== sessionId) continue;
      await removeWorktree(c.mainRoot, path).catch(() => undefined);
      await this.bindings.setWorktree(path, null);
    }
  }

  /** A detached worktree at `commit` for a subagent. */
  async forSubagent(mainRoot: string, id: string, commit: string): Promise<string> {
    const dir = this.dirFor(mainRoot);
    await mkdir(dir, { recursive: true });
    const path = join(dir, `sub-${id.slice(0, 8)}`);
    await addDetachedWorktree(mainRoot, path, commit);
    return (await findRepoRoot(path)) ?? path;
  }

  async removeSubagent(mainRoot: string, path: string): Promise<void> {
    await removeWorktree(mainRoot, path);
  }
}
