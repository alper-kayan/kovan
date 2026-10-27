import { execFile } from 'node:child_process';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { readJson, writeJson } from '@kovan/runner';
import type { AgentAccount, ExternalHarness } from '../shared/agent.js';

/**
 * The person's other Claude Code and Codex accounts on this machine. Each keeps its sign-in in a
 * folder of its own under Kovan's data, which the CLI is pointed at when it runs for that account
 * (CLAUDE_CONFIG_DIR, CODEX_HOME). The CLI's usual sign-in (~/.claude, ~/.codex) is the default
 * account: it isn't listed and nothing here touches it.
 */
export class AgentAccounts {
  private accounts: AgentAccount[] | null = null;

  constructor(private readonly root: string) {}

  private get file(): string {
    return join(this.root, 'agent-accounts.json');
  }

  async list(): Promise<AgentAccount[]> {
    this.accounts ??= ((await readJson(this.file)) as AgentAccount[] | undefined) ?? [];
    return this.accounts;
  }

  async add(harness: ExternalHarness, name: string): Promise<AgentAccount> {
    const list = await this.list();
    const clean = name.trim().slice(0, 40);
    if (!clean) throw new Error('Give the account a name, like Work or Personal.');
    if (list.some((a) => a.harness === harness && a.name.toLowerCase() === clean.toLowerCase()))
      throw new Error(`There is already an account called ${clean}.`);
    const account: AgentAccount = {
      id: randomUUID().slice(0, 8),
      harness,
      name: clean,
      createdAt: Date.now(),
    };
    await mkdir(this.dirOf(account.id), { recursive: true, mode: 0o700 });
    this.accounts = [...list, account];
    await writeJson(this.file, this.accounts);
    return account;
  }

  /** Forgets the account and its sign-in (the folder goes; the account itself stays with Anthropic or OpenAI). */
  async remove(id: string): Promise<void> {
    const list = await this.list();
    if (!list.some((a) => a.id === id)) return;
    this.accounts = list.filter((a) => a.id !== id);
    await writeJson(this.file, this.accounts);
    await rm(this.dirOf(id), { recursive: true, force: true });
  }

  dirOf(id: string): string {
    if (!/^[a-z0-9-]{1,64}$/i.test(id)) throw new Error('Not an account id');
    return join(this.root, 'agent-accounts', id);
  }

  /**
   * What the CLI's process needs to run as the account: its folder in the variable the CLI
   * reads. Nothing for the default account, or one that no longer exists.
   */
  async env(
    harness: ExternalHarness,
    id: string | null | undefined,
  ): Promise<Record<string, string>> {
    if (!id) return {};
    const account = (await this.list()).find((a) => a.id === id && a.harness === harness);
    if (!account) return {};
    return harness === 'claude-code'
      ? { CLAUDE_CONFIG_DIR: this.dirOf(id) }
      : { CODEX_HOME: this.dirOf(id) };
  }
}

/**
 * Asks the CLI whether it is signed in, with the account's folder in `env` (`claude auth
 * status`, `codex login status`). Read-only: nothing is sent to a model.
 */
export function signedIn(
  binary: string,
  harness: ExternalHarness,
  env: Record<string, string>,
): Promise<{ signedIn: boolean; who: string | null }> {
  const args = harness === 'codex' ? ['login', 'status'] : ['auth', 'status'];
  return new Promise((resolve) =>
    execFile(
      binary,
      args,
      { env: { ...process.env, ...env }, timeout: 15_000 },
      (_error, stdout, stderr) => {
        const out = `${stdout}${stderr}`;
        if (harness === 'codex') {
          const yes = /logged in/i.test(out) && !/not logged in/i.test(out);
          resolve({
            signedIn: yes,
            who: yes ? (/using (.+)/i.exec(out)?.[1]?.trim() ?? null) : null,
          });
          return;
        }
        try {
          const status = JSON.parse(stdout) as { loggedIn?: boolean; email?: string };
          resolve({ signedIn: status.loggedIn === true, who: status.email ?? null });
        } catch {
          resolve({ signedIn: false, who: null });
        }
      },
    ),
  );
}
