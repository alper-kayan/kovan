import type { ApprovalRequest } from '@kovan/harness';

/** Programs whose second word is what they do (`git push`, `npm test`), not just an argument. */
const SUBCOMMANDS = new Set([
  'git',
  'npm',
  'pnpm',
  'yarn',
  'bun',
  'npx',
  'bunx',
  'deno',
  'cargo',
  'go',
  'dotnet',
  'mvn',
  'gradle',
  'gradlew',
  'docker',
  'podman',
  'kubectl',
  'helm',
  'terraform',
  'gh',
  'brew',
  'apt',
  'pip',
  'pip3',
  'uv',
  'poetry',
  'make',
  'just',
  'rails',
  'bundle',
  'mix',
  'composer',
  'swift',
  'flutter',
  'expo',
  'turbo',
  'nx',
  'vercel',
  'firebase',
  'supabase',
  'prisma',
  'drizzle-kit',
]);

/**
 * What an "always" answer covers for the rest of the session. A command is matched by what it
 * runs (its first word, and the second when that is a subcommand, so `npm test` covers
 * `npm test -- --watch` but not `npm publish`); a chained or substituted command only by itself,
 * word for word. Anything else (edits, MCP tools) by the tool.
 */
export function alwaysKey(r: Pick<ApprovalRequest, 'kind' | 'tool' | 'detail'>): string {
  if (r.kind !== 'command') return `tool:${r.tool}`;
  const command = r.detail.trim();
  // Chained, piped, redirected or substituted: only this very command.
  if (/[;&|`<>\n]|\$\(/.test(command)) return `exact:${command}`;
  const words = command.split(/\s+/);
  const program = words[0]!.replace(/^.*[\\/]/, '').replace(/\.(exe|cmd)$/i, '');
  const second = words[1];
  const head =
    SUBCOMMANDS.has(program) && second && /^[a-z][\w:-]*$/i.test(second)
      ? words.slice(0, 2)
      : words.slice(0, 1);
  return `cmd:${head.join(' ')}`;
}

/** The "always" choice in words: what it will allow without asking again. */
export function alwaysLabel(r: Pick<ApprovalRequest, 'kind' | 'tool' | 'detail'>): string {
  const key = alwaysKey(r);
  if (key.startsWith('cmd:')) return `always "${key.slice(4)} …" this session`;
  if (key.startsWith('exact:')) return 'always this exact command this session';
  return 'always this tool this session';
}
