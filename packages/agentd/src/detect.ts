import { execFile } from 'node:child_process';
import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

export interface FoundAgent {
  name: string;
  version: string | null;
  ready: boolean;
  /** The one that runs work here (set once the daemon knows). */
  works?: boolean;
}

/**
 * The agents this machine can run. Kovan's own agent is ready when it has a model key; the
 * CLIs are reported when they answer `--version` (agentd runs only Kovan's agent for now).
 */
export async function detectAgents(
  hasModelKey: boolean,
  path = process.env['PATH'],
): Promise<FoundAgent[]> {
  const found: FoundAgent[] = [{ name: 'kovan', version: null, ready: hasModelKey }];
  for (const name of ['claude', 'codex', 'opencode']) {
    const out = await run(name, ['--version'], {
      timeout: 5_000,
      env: { ...process.env, PATH: path },
    })
      .then((r) => r.stdout.trim().split('\n')[0]!.slice(0, 80))
      .catch(() => null);
    if (out !== null)
      found.push({ name, version: /\d+\.\d+[\w.-]*/.exec(out)?.[0] ?? out, ready: true });
  }
  return found;
}

/**
 * The checkouts behind the configured paths: each a git repository with a remote. A path
 * ending in `/*` stands for the repositories directly inside that folder.
 */
export async function findRepos(paths: string[]): Promise<{ remote: string; path: string }[]> {
  const candidates: string[] = [];
  for (const p of paths) {
    if (!p.endsWith('/*')) {
      candidates.push(p);
      continue;
    }
    const dir = p.slice(0, -2);
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const e of entries)
      if (e.isDirectory() && !e.name.startsWith('.')) candidates.push(join(dir, e.name));
  }
  const repos: { remote: string; path: string }[] = [];
  for (const path of candidates) {
    const isRepo = await stat(join(path, '.git')).then(
      () => true,
      () => false,
    );
    if (!isRepo) continue;
    const remote = await run('git', ['-C', path, 'remote', 'get-url', 'origin'], { timeout: 5_000 })
      .then((r) => r.stdout.trim())
      .catch(() => null);
    if (remote) repos.push({ remote, path });
  }
  return repos;
}
