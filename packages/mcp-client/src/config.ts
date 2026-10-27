import { createHash } from 'node:crypto';

/**
 * One MCP server, as Claude Code's `.mcp.json` writes it: a command to start (stdio) or a URL
 * to talk to (Streamable HTTP; "sse" is read as HTTP, which most servers also accept).
 */
export type McpServerConfig =
  | {
      type: 'stdio';
      command: string;
      args: string[];
      env: Record<string, string>;
      /** Where the command runs; the workspace when not set. */
      cwd?: string;
    }
  | { type: 'http'; url: string; headers: Record<string, string> };

export interface McpServers {
  servers: Record<string, McpServerConfig>;
  /** Entries that couldn't be used, and why. */
  problems: { name: string; problem: string }[];
}

const SERVER_NAME = /^[A-Za-z0-9_-]{1,40}$/;

function strings(value: unknown): string[] | null {
  return Array.isArray(value) && value.every((v) => typeof v === 'string') ? value : null;
}

function record(value: unknown): Record<string, string> | null {
  if (value === undefined) return {};
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(value)) {
    if (typeof v !== 'string') return null;
    out[k] = v;
  }
  return out;
}

/**
 * `${VAR}` and `${VAR:-default}` from the environment, as Claude Code expands them. A variable
 * that isn't set and has no default is reported, not left as an empty string.
 */
export function expandVars(
  text: string,
  env: Record<string, string | undefined>,
  missing: Set<string>,
): string {
  return text.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g, (_, name: string, def) => {
    const value = env[name];
    if (value !== undefined && value !== '') return value;
    if (def !== undefined) return def as string;
    missing.add(name);
    return '';
  });
}

/** Reads `{ "mcpServers": { name: {...} } }` (a whole `.mcp.json`) or just the inner map. */
export function parseMcpConfig(
  raw: unknown,
  env: Record<string, string | undefined> = {},
): McpServers {
  const result: McpServers = { servers: {}, problems: [] };
  const root = raw as { mcpServers?: unknown } | null;
  const map =
    root && typeof root === 'object' && 'mcpServers' in root ? root.mcpServers : (raw as unknown);
  if (!map || typeof map !== 'object' || Array.isArray(map)) {
    result.problems.push({ name: '', problem: 'Expected an "mcpServers" object' });
    return result;
  }
  for (const [name, value] of Object.entries(map as Record<string, unknown>)) {
    const fail = (problem: string) => result.problems.push({ name, problem });
    if (!SERVER_NAME.test(name)) {
      fail('Names use letters, digits, "-" and "_", at most 40');
      continue;
    }
    if (!value || typeof value !== 'object') {
      fail('Not an object');
      continue;
    }
    const v = value as Record<string, unknown>;
    const missing = new Set<string>();
    const x = (s: string) => expandVars(s, env, missing);
    const type = typeof v['type'] === 'string' ? v['type'] : v['url'] ? 'http' : 'stdio';
    if (type === 'stdio') {
      const args = v['args'] === undefined ? [] : strings(v['args']);
      const vars = record(v['env']);
      if (typeof v['command'] !== 'string' || !v['command'].trim()) fail('No "command"');
      else if (!args) fail('"args" must be a list of strings');
      else if (!vars) fail('"env" must map names to strings');
      else {
        const config: McpServerConfig = {
          type: 'stdio',
          command: x(v['command']),
          args: args.map(x),
          env: Object.fromEntries(Object.entries(vars).map(([k, s]) => [k, x(s)])),
          ...(typeof v['cwd'] === 'string' ? { cwd: x(v['cwd']) } : {}),
        };
        if (missing.size) fail(`Not set: ${[...missing].join(', ')}`);
        else result.servers[name] = config;
      }
    } else if (type === 'http' || type === 'sse' || type === 'streamable-http') {
      const headers = record(v['headers']);
      if (typeof v['url'] !== 'string') fail('No "url"');
      else if (!headers) fail('"headers" must map names to strings');
      else {
        const url = x(v['url']);
        let ok = false;
        try {
          ok = ['http:', 'https:'].includes(new URL(url).protocol);
        } catch {
          // reported below
        }
        if (!ok) fail(`Not an http(s) URL: ${url}`);
        else if (missing.size) fail(`Not set: ${[...missing].join(', ')}`);
        else
          result.servers[name] = {
            type: 'http',
            url,
            headers: Object.fromEntries(Object.entries(headers).map(([k, s]) => [k, x(s)])),
          };
      }
    } else fail(`Unknown type "${type}"`);
  }
  return result;
}

/** Changes whenever anything that starts or reaches the server changes. */
export function configKey(config: McpServerConfig): string {
  return createHash('sha256').update(JSON.stringify(config)).digest('hex').slice(0, 16);
}

/** The values that must never be shown: env values and headers (tokens, keys). */
export function secretValues(config: McpServerConfig): string[] {
  const values =
    config.type === 'stdio' ? Object.values(config.env) : Object.values(config.headers);
  // Short values ("1", "true") would mask ordinary text; real secrets are longer.
  return values.filter((v) => v.length >= 6);
}

/**
 * The model-facing name of a server's tool: `mcp__<server>__<tool>`, in the characters and
 * length (64) model APIs accept. A name that doesn't fit is cut and given a short hash.
 */
export function mcpToolName(server: string, tool: string): string {
  const clean = (s: string) => s.replace(/[^A-Za-z0-9_-]/g, '_');
  const full = `mcp__${clean(server)}__${clean(tool)}`;
  if (full.length <= 64) return full;
  const hash = createHash('sha256').update(`${server}\0${tool}`).digest('hex').slice(0, 8);
  return `${full.slice(0, 55)}_${hash}`;
}
