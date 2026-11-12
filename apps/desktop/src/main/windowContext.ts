import { findRepoRoot } from '@kovan/git-engine';
import type { BrowserWindow } from 'electron';
import { stat } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import type { ConnectionState, EventChannel, EventContract, WorkspaceInfo } from '../shared/api.js';
import { PRODUCT_NAME } from '@kovan/shared';
import { watchWorkspace } from './files.js';
import type { AgentManager } from './agents.js';
import type { SessionCheckout } from '@kovan/runner';
import { TerminalManager } from './terminals.js';

/** Everything one window owns: its open workspace, file watcher and terminals. */
export class WindowContext {
  workspace: WorkspaceInfo | null = null;
  connection: ConnectionState = 'offline';
  readonly terminals: TerminalManager;
  /** Set right after construction; conversations with the native agent. */
  agents: AgentManager | null = null;
  private stopWatching: (() => void) | null = null;
  private stopWatchingChats: (() => void) | null = null;

  constructor(
    readonly window: BrowserWindow,
    private readonly sessionCheckout: (root: string) => Promise<SessionCheckout | null> = () =>
      Promise.resolve(null),
    private readonly hooks: {
      /** Saved files changed in the open workspace. */
      files?(root: string): void;
      /** The window stopped showing a workspace. */
      closed?(root: string): void;
    } = {},
  ) {
    this.terminals = new TerminalManager({
      data: (id, data) => this.send('terminal:data', id, data),
      exit: (id, code) => this.send('terminal:exit', id, code),
    });
  }

  send<C extends EventChannel>(channel: C, ...args: EventContract[C]): void {
    if (!this.window.isDestroyed()) this.window.webContents.send(channel, ...args);
  }

  /** Root of the open workspace; throws when none is open. */
  requireRoot(): string {
    if (!this.workspace) throw new Error('No workspace is open');
    return this.workspace.root;
  }

  async openWorkspace(folder: string): Promise<WorkspaceInfo> {
    const absolute = resolve(folder);
    const info = await stat(absolute).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT')
        throw new Error(
          `The folder ${basename(absolute)} isn't there any more (it was moved or deleted). It's off your recent list now; open it from where it is.`,
          { cause: error },
        );
      throw error;
    });
    if (!info.isDirectory()) throw new Error(`${basename(absolute)} is a file, not a folder.`);

    const repoRoot = await findRepoRoot(absolute);
    const root = repoRoot ?? absolute;
    const checkout = repoRoot ? await this.sessionCheckout(root) : null;
    this.close();
    this.workspace = checkout
      ? {
          root,
          name: `${basename(checkout.mainRoot)} · ${checkout.title}`,
          isRepo: true,
          repoRoot: checkout.mainRoot,
          session: {
            id: checkout.sessionId,
            workspaceId: checkout.workspaceId,
            branch: checkout.branch,
            title: checkout.title,
          },
        }
      : { root, name: basename(root), isRepo: repoRoot !== null };
    this.stopWatching = watchWorkspace(root, (event) => {
      this.send('fs:changed', event);
      if (event.paths.length > 0) this.hooks.files?.(root);
    });
    // Chats written from elsewhere (the terminal agent) show up without reopening the folder.
    this.stopWatchingChats =
      this.agents?.watch(root, (ids) => this.send('agent:changed', ids)) ?? null;
    this.updateTitle();
    return this.workspace;
  }

  updateTitle(): void {
    if (this.window.isDestroyed()) return;
    const name = this.workspace ? `${this.workspace.name} — ${PRODUCT_NAME}` : PRODUCT_NAME;
    this.window.setTitle(`${name} (${this.connection})`);
  }

  /** Stops watching and kills terminals. Safe to call more than once. */
  close(): void {
    this.stopWatching?.();
    this.stopWatching = null;
    this.stopWatchingChats?.();
    this.stopWatchingChats = null;
    this.terminals.killAll();
    this.agents?.stopAll();
    if (this.workspace) this.hooks.closed?.(this.workspace.root);
    this.workspace = null;
  }
}
