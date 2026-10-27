import { hostname, homedir, platform, arch } from 'node:os';
import { join, resolve } from 'node:path';

/** How agentd runs, from its environment (see `kovan-agentd --help`). */
export interface Config {
  serverUrl: string;
  /** A workspace API key with the `machine` scope. */
  apiKey: string;
  /** The machine's name in Kovan; unique in the workspace. */
  name: string;
  platform: string;
  /** Runs it takes at once. */
  slots: number;
  /** Checkouts it offers: repositories it holds, by folder. */
  repoPaths: string[];
  /** Where it keeps session worktrees and its own state. */
  dataDir: string;
  /** The key Kovan's agent uses for models. */
  openRouterKey: string | null;
  /** Push the session branch when a swarm finishes, so others can merge it. */
  pushWhenDone: boolean;
  /**
   * End the session when its swarm is done, with the final diff (a demo machine: its finished
   * sessions go to History and stop holding files the next sessions need).
   */
  endWhenDone: boolean;
  /**
   * Which agent runs the work: Claude Code on the person's own subscription, Codex on their
   * OpenAI plan, Kovan's own agent (OpenRouter), or "auto": Claude Code when this machine has
   * it, else Codex when it has that and no model key.
   */
  agent: 'claude' | 'codex' | 'kovan' | 'auto';
  /** The `claude` CLI, when it isn't on PATH. */
  claudeBinary: string | null;
  /** The `codex` CLI, when it isn't on PATH. */
  codexBinary: string | null;
  /** Fetch and push through Kovan (the workspace's git access), not this machine's git keys. */
  gitRelay: boolean;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const need = (name: string) => {
    const value = env[name]?.trim();
    if (!value) throw new Error(`Set ${name}.`);
    return value;
  };
  const apiKey = need('KOVAN_API_KEY');
  if (!apiKey.startsWith('kv_live_'))
    throw new Error(
      'KOVAN_API_KEY must be a workspace API key (kv_live_…) with the machine scope.',
    );
  const slots = Number(env['KOVAN_SLOTS'] ?? 2);
  if (!Number.isInteger(slots) || slots < 1 || slots > 32)
    throw new Error('KOVAN_SLOTS must be a whole number from 1 to 32.');
  const repoPaths = [
    ...(env['KOVAN_REPOS'] ?? '').split(','),
    ...(env['KOVAN_WORKSPACE_ROOT'] ? [`${env['KOVAN_WORKSPACE_ROOT']}/*`] : []),
  ]
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => resolve(p.replace(/^~(?=\/|$)/, homedir())));
  if (repoPaths.length === 0)
    throw new Error('Set KOVAN_REPOS (checkouts, comma separated) or KOVAN_WORKSPACE_ROOT.');
  return {
    serverUrl: need('KOVAN_SERVER_URL').replace(/\/+$/, ''),
    apiKey,
    name: env['KOVAN_MACHINE_NAME']?.trim() || hostname().split('.')[0]!,
    platform: `${platform()}-${arch()}`,
    slots,
    repoPaths,
    dataDir: resolve(env['KOVAN_DATA_DIR'] ?? join(homedir(), '.kovan-agentd')),
    openRouterKey: env['OPENROUTER_API_KEY']?.trim() || null,
    pushWhenDone: env['KOVAN_PUSH'] === '1' || env['KOVAN_PUSH'] === 'true',
    endWhenDone: env['KOVAN_END_WHEN_DONE'] === '1' || env['KOVAN_END_WHEN_DONE'] === 'true',
    agent: agentOf(env['KOVAN_AGENT']),
    claudeBinary: env['KOVAN_CLAUDE_BIN']?.trim() || null,
    codexBinary: env['KOVAN_CODEX_BIN']?.trim() || null,
    gitRelay: env['KOVAN_GIT_RELAY'] === '1' || env['KOVAN_GIT_RELAY'] === 'true',
  };
}

function agentOf(value: string | undefined): Config['agent'] {
  const v = (value ?? 'auto').trim().toLowerCase();
  if (v === 'claude' || v === 'codex' || v === 'kovan' || v === 'auto') return v;
  throw new Error('KOVAN_AGENT must be claude, codex, kovan or auto.');
}
