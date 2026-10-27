import { join } from 'node:path';
import { readJson, writeJson } from './jsonFile.js';

/**
 * Where each shared workspace lives on this machine. Kept locally: the server never learns
 * your folder paths.
 */
/** A checkout Kovan made for a session: a worktree of a bound workspace's repository. */
export interface SessionCheckout {
  workspaceId: string;
  sessionId: string;
  /** The repository's main checkout (the bound folder). */
  mainRoot: string;
  branch: string;
  title: string;
}

export class Bindings {
  private readonly file: string;
  private readonly worktreesFile: string;

  constructor(userDataDir: string) {
    this.file = join(userDataDir, 'workspace-bindings.json');
    this.worktreesFile = join(userDataDir, 'session-worktrees.json');
  }

  /** The shared workspace a folder belongs to: its binding, or the session worktree's. */
  async idFor(root: string): Promise<string | null> {
    const bound = Object.entries(await this.all()).find(([, p]) => p === root)?.[0];
    return bound ?? (await this.worktree(root))?.workspaceId ?? null;
  }

  async worktrees(): Promise<Record<string, SessionCheckout>> {
    const raw = await readJson(this.worktreesFile);
    if (typeof raw !== 'object' || raw === null) return {};
    return raw as Record<string, SessionCheckout>;
  }

  async worktree(root: string): Promise<SessionCheckout | null> {
    return (await this.worktrees())[root] ?? null;
  }

  async setWorktree(path: string, checkout: SessionCheckout | null): Promise<void> {
    const next = await this.worktrees();
    if (checkout === null) delete next[path];
    else next[path] = checkout;
    await writeJson(this.worktreesFile, next);
  }

  async all(): Promise<Record<string, string>> {
    const raw = await readJson(this.file);
    if (typeof raw !== 'object' || raw === null) return {};
    return Object.fromEntries(
      Object.entries(raw).filter((e): e is [string, string] => typeof e[1] === 'string'),
    );
  }

  async set(workspaceId: string, path: string | null): Promise<Record<string, string>> {
    const next = await this.all();
    if (path === null) delete next[workspaceId];
    else next[workspaceId] = path;
    await writeJson(this.file, next);
    return next;
  }
}
