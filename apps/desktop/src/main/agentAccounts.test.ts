import { mkdtemp, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AgentAccounts } from './agentAccounts.js';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'kovan-accounts-'));
});
afterEach(() => rm(dir, { recursive: true, force: true }));

describe('agent accounts', () => {
  it('gives each account its own sign-in folder, in the variable its CLI reads', async () => {
    const accounts = new AgentAccounts(dir);
    const work = await accounts.add('claude-code', ' Work ');
    const side = await accounts.add('codex', 'Side');
    expect(work.name).toBe('Work');
    expect((await stat(accounts.dirOf(work.id))).mode & 0o777).toBe(0o700);
    expect(await accounts.env('claude-code', work.id)).toEqual({
      CLAUDE_CONFIG_DIR: join(dir, 'agent-accounts', work.id),
    });
    expect(await accounts.env('codex', side.id)).toEqual({
      CODEX_HOME: join(dir, 'agent-accounts', side.id),
    });
    // The default account is the CLI's own sign-in: nothing changes for it.
    expect(await accounts.env('claude-code', undefined)).toEqual({});
    // An account of the other agent, or one that doesn't exist, gives nothing.
    expect(await accounts.env('codex', work.id)).toEqual({});
    expect(await accounts.env('claude-code', 'nope')).toEqual({});
    // Kept across restarts.
    expect((await new AgentAccounts(dir).list()).map((a) => a.name)).toEqual(['Work', 'Side']);
  });

  it('refuses a name taken for that agent, and forgets an account with its sign-in', async () => {
    const accounts = new AgentAccounts(dir);
    const work = await accounts.add('claude-code', 'Work');
    await expect(accounts.add('claude-code', 'work')).rejects.toThrow('already an account');
    await expect(accounts.add('claude-code', '  ')).rejects.toThrow('Give the account a name');
    // The same name for the other agent is fine.
    await accounts.add('codex', 'Work');
    await accounts.remove(work.id);
    expect((await accounts.list()).map((a) => a.harness)).toEqual(['codex']);
    expect(await readdir(join(dir, 'agent-accounts'))).not.toContain(work.id);
    expect(() => accounts.dirOf('../x')).toThrow('Not an account id');
  });
});
