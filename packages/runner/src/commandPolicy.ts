/**
 * What an agent running unattended (agentd) may run without asking anyone: checks of its own
 * work (tests, type checks, linters, builds) and looking around (read-only commands, read-only
 * git). Everything else is refused, and so is anything chained, piped, redirected or
 * substituted: nothing that pushes, publishes, deletes, installs or reaches out.
 *
 * Tests run the repository's own code, which the agent can edit: this list keeps an agent from
 * doing harm by accident, it is not a sandbox. Run agentd as its own user, without push
 * credentials or sudo.
 */
export function commandAllowed(command: string): boolean {
  const text = command.trim();
  if (!text || text.length > 500) return false;
  // One plain command: no chaining, pipes, redirects, substitution, background jobs, globs
  // that reach outside, or environment assignments in front.
  if (/[;&|<>`$\\\n\r]|\(\s*\)|\.\.\//.test(text)) return false;
  const words = text.split(/\s+/);
  if (/^\w+=/.test(words[0]!)) return false;
  const [cmd, ...args] = words as [string, ...string[]];
  const sub = args[0] ?? '';

  if (READ_ONLY.has(cmd)) return !args.some((a) => /^\//.test(a) && !a.startsWith('./'));
  if (cmd === 'find')
    return !args.some((a) =>
      ['-delete', '-exec', '-execdir', '-ok', '-okdir', '-fprint', '-fls'].includes(a),
    );
  if (cmd === 'git')
    return GIT_READ.has(sub) && !args.some((a) => /^-(d|D|m|M|f)$|^--(delete|force|move)/.test(a));
  if (['npm', 'pnpm', 'yarn', 'bun'].includes(cmd)) {
    if (CHECK_SCRIPTS.has(sub)) return true;
    if (sub === 'run') return CHECK_SCRIPTS.has(args[1] ?? '');
    if (sub === 'exec' || (cmd === 'pnpm' && sub === 'dlx')) return checkTool(args.slice(1));
    return false;
  }
  if (cmd === 'npx' || cmd === 'bunx') return checkTool(args);
  if (cmd === 'node') return sub === '--test';
  if (cmd === 'pytest') return true;
  if (cmd === 'python' || cmd === 'python3') return sub === '-m' && args[1] === 'pytest';
  if (cmd === 'go') return ['test', 'vet', 'build'].includes(sub);
  if (cmd === 'cargo')
    return (
      ['test', 'check', 'build', 'clippy', 'fmt'].includes(sub) &&
      (sub !== 'fmt' || args.includes('--check'))
    );
  if (cmd === 'make') return args.length > 0 && args.every((a) => CHECK_SCRIPTS.has(a));
  if (cmd === 'deno') return ['test', 'check', 'lint'].includes(sub);
  return false;
}

const READ_ONLY = new Set([
  'ls',
  'cat',
  'head',
  'tail',
  'wc',
  'grep',
  'rg',
  'tree',
  'pwd',
  'diff',
  'file',
  'stat',
]);
const GIT_READ = new Set([
  'status',
  'diff',
  'log',
  'show',
  'branch',
  'rev-parse',
  'ls-files',
  'blame',
  'grep',
]);
const CHECK_SCRIPTS = new Set([
  'test',
  'tests',
  'check',
  'lint',
  'typecheck',
  'build',
  'format:check',
  'test:unit',
]);
const CHECK_TOOLS = new Set(['vitest', 'jest', 'tsc', 'eslint', 'mocha', 'ava', 'tsx', 'biome']);

function checkTool(args: string[]): boolean {
  const tool = (args[0] ?? '').replace(/@[\w.-]+$/, '');
  if (tool === 'prettier') return args.includes('--check');
  if (tool === 'tsx') return false;
  return CHECK_TOOLS.has(tool);
}
