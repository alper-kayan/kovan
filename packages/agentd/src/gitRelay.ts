import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

/** One checkout's remote, and the Kovan address that stands in for it. */
export interface RelayRoute {
  /** The remote as the checkout has it (fetch or push URL). */
  remote: string;
  /** `<server>/api/workspaces/<id>/git`. */
  relay: string;
}

/**
 * Git config, as environment variables (inherited by every git this process starts; nothing is
 * written to a file), that sends each route's remote through Kovan with this machine's key.
 */
export function relayEnv(
  routes: RelayRoute[],
  apiKey: string,
  env: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const start = Number(env['GIT_CONFIG_COUNT'] ?? 0) || 0;
  const pairs: [string, string][] = [];
  for (const relay of new Set(routes.map((r) => r.relay)))
    pairs.push([`http.${relay}.extraHeader`, `Authorization: Bearer ${apiKey}`]);
  for (const r of routes) pairs.push([`url.${r.relay}.insteadOf`, r.remote]);
  const out: Record<string, string> = { GIT_CONFIG_COUNT: String(start + pairs.length) };
  pairs.forEach(([key, value], i) => {
    out[`GIT_CONFIG_KEY_${start + i}`] = key;
    out[`GIT_CONFIG_VALUE_${start + i}`] = value;
  });
  return out;
}

/**
 * Which checkouts go through Kovan: those whose workspace has git access set up. Each remote
 * (and a different push URL) is routed to the workspace's relay; others keep their own git.
 */
export async function relayRoutes(
  request: <T>(method: 'GET', path: string) => Promise<T>,
  serverUrl: string,
  repos: { remote: string; path: string }[],
  log: (line: string) => void,
): Promise<RelayRoute[]> {
  const routes: RelayRoute[] = [];
  for (const repo of repos) {
    const { workspaces } = await request<{ workspaces: { id: string; name: string }[] }>(
      'GET',
      `/api/workspaces?repo=${encodeURIComponent(repo.remote)}`,
    ).catch(() => ({ workspaces: [] as { id: string; name: string }[] }));
    const ws = workspaces[0];
    if (!ws) continue;
    const { access } = await request<{ access: { configured: boolean } }>(
      'GET',
      `/api/workspaces/${ws.id}/git-access`,
    ).catch(() => ({ access: { configured: false } }));
    if (!access.configured) {
      log(
        `Git relay: ${ws.name} has no git access set up in Kovan; ${repo.path} uses its own git.`,
      );
      continue;
    }
    const relay = `${serverUrl}/api/workspaces/${ws.id}/git`;
    const push = (
      await run('git', ['-C', repo.path, 'config', '--get', 'remote.origin.pushurl'], {
        timeout: 5_000,
      }).catch(() => ({ stdout: '' }))
    ).stdout.trim();
    routes.push({ remote: repo.remote, relay });
    if (push && push !== repo.remote) routes.push({ remote: push, relay });
    log(`Git relay: ${repo.path} fetches and pushes through Kovan (${ws.name}).`);
  }
  return routes;
}
