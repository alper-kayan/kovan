import type { PermissionMode } from '@kovan/harness';
import { execFile } from 'node:child_process';

/** How Kovan's MCP server is started; the same server Claude Code gets in its config file. */
export interface McpServerSpec {
  command: string;
  args: string[];
  env: Record<string, string>;
}

/**
 * Kovan's permission modes as Codex sandboxes. `codex exec` can't pause for approval mid-run, so
 * Request runs read-only like Plan; step-by-step approval is in Codex's own TUI (the terminal).
 */
export const CODEX_SANDBOX: Record<PermissionMode, string> = {
  plan: 'read-only',
  request: 'read-only',
  allow: 'workspace-write',
  full: 'danger-full-access',
};

/** TOML for one `-c key=value` override; JSON strings, arrays and inline tables are close enough. */
export function toml(value: unknown): string {
  if (typeof value === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(toml).join(',')}]`;
  if (value && typeof value === 'object')
    return `{${Object.entries(value)
      .map(([k, v]) => `${/^[A-Za-z0-9_-]+$/.test(k) ? k : JSON.stringify(k)}=${toml(v)}`)
      .join(',')}}`;
  return String(value);
}

/** The `-c` flags that add Kovan's MCP server to a Codex run without touching ~/.codex. */
export function codexMcpArgs(server: McpServerSpec): string[] {
  return [
    ['mcp_servers.kovan.command', server.command],
    ['mcp_servers.kovan.args', server.args],
    ['mcp_servers.kovan.env', server.env],
    // Kovan's own coordination tools never need a permission prompt.
    ['mcp_servers.kovan.default_tools_approval_mode', 'approve'],
  ].flatMap(([key, value]) => ['-c', `${key as string}=${toml(value)}`]);
}

const appServer = new Map<string, Promise<boolean>>();

/** Whether this Codex has the app server (older ones only run `codex exec`). Asked once. */
export function codexHasAppServer(binary: string, pathEnv: string): Promise<boolean> {
  let known = appServer.get(binary);
  if (!known) {
    known = new Promise((resolve) =>
      execFile(
        binary,
        ['app-server', '--help'],
        { timeout: 10_000, env: { ...process.env, PATH: pathEnv } },
        (error) => resolve(!error),
      ),
    );
    appServer.set(binary, known);
  }
  return known;
}
