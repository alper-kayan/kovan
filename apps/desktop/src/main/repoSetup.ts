import { git } from '@kovan/git-engine';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import type { McpServerSpec } from './harnesses/codex.js';

export const HOOK_EVENTS = ['UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Stop'] as const;

/** The marker that tells Kovan's own entries apart from the person's in shared config files. */
const MARK = 'kovan-hook';
const SECTION_START = '<!-- kovan:start -->';
const SECTION_END = '<!-- kovan:end -->';

export const AGENT_INSTRUCTIONS = `${SECTION_START}
## Working in Kovan

Teammates and their agents work on this repository at the same time.
- Call the kovan \`get_team_context\` tool at the start of a task: who is working on what, the session plan, locked files and the Brain notes.
- Don't edit files a teammate has locked; ask the person first.
- Follow the Brain notes. When one is FLAGGED and you work near its code, check the code and rewrite it with \`record_memory\` (replaces: its id).
- Work belongs to people: claim a free plan step with \`claim_plan_step\` before working on it, and mark it done with \`update_plan_step\`.
- Never re-run an action whose outcome is unknown (a push or deploy that was cut off); a person records what happened.
${SECTION_END}
`;

const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/** The shell command a hook entry runs: Kovan's hook script under Kovan's own Node. */
export function hookCommand(
  hook: { node: string; script: string; env: Record<string, string> },
  event: string,
): string {
  const env = Object.entries(hook.env)
    .map(([k, v]) => `${k}=${q(v)}`)
    .join(' ');
  return `${env} ${q(hook.node)} ${q(hook.script)} ${event} # ${MARK}`;
}

async function readJson(path: string): Promise<Record<string, unknown>> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
  } catch {
    return {};
  }
}

/** Claude Code's project settings with Kovan's hooks merged in; the person's own entries stay. */
export function mergeClaudeSettings(
  existing: Record<string, unknown>,
  command: (event: string) => string,
): Record<string, unknown> {
  const hooks = { ...((existing['hooks'] as Record<string, unknown[]> | undefined) ?? {}) };
  for (const event of HOOK_EVENTS) {
    const theirs = (hooks[event] ?? []).filter((entry) => !JSON.stringify(entry).includes(MARK));
    const ours = {
      ...(event === 'PreToolUse' || event === 'PostToolUse' ? { matcher: '*' } : {}),
      hooks: [
        {
          type: 'command',
          command: command(event),
          ...(event === 'PreToolUse' ? { timeout: 30 } : {}),
        },
      ],
    };
    hooks[event] = [...theirs, ours];
  }
  return { ...existing, hooks };
}

async function tracked(root: string, path: string): Promise<boolean> {
  return git(root, ['ls-files', '--error-unmatch', path])
    .then(() => true)
    .catch(() => false);
}

export interface SetupResult {
  written: string[];
  /** Kept local: listed in .git/info/exclude so they never end up in a commit. */
  excluded: string[];
  /** Already part of the repository: left as they are. */
  skipped: string[];
}

/**
 * Connects the agent CLIs in this repository to Kovan, the way the person would by hand: hooks
 * for Claude Code, the MCP server for Claude Code and Codex, and coordination instructions.
 * Files that aren't already part of the repository are kept local (never committed); tracked
 * files the team owns are not touched.
 */
export async function connectRepo(
  root: string,
  mcp: McpServerSpec,
  hook: { node: string; script: string; env: Record<string, string> },
): Promise<SetupResult> {
  const result: SetupResult = { written: [], excluded: [], skipped: [] };
  const write = async (path: string, content: string) => {
    if (await tracked(root, path)) {
      result.skipped.push(path);
      return;
    }
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), content);
    result.written.push(path);
  };

  const settings = mergeClaudeSettings(await readJson(join(root, '.claude/settings.json')), (e) =>
    hookCommand(hook, e),
  );
  await write('.claude/settings.json', `${JSON.stringify(settings, null, 2)}\n`);

  const mcpJson = await readJson(join(root, '.mcp.json'));
  const servers = {
    ...((mcpJson['mcpServers'] as Record<string, unknown> | undefined) ?? {}),
    kovan: mcp,
  };
  await write('.mcp.json', `${JSON.stringify({ ...mcpJson, mcpServers: servers }, null, 2)}\n`);

  const codexPath = '.codex/config.toml';
  const codex = await readFile(join(root, codexPath), 'utf8').catch(() => '');
  const section = [
    '[mcp_servers.kovan]',
    `command = ${JSON.stringify(mcp.command)}`,
    `args = ${JSON.stringify(mcp.args)}`,
    `env = { ${Object.entries(mcp.env)
      .map(([k, v]) => `${k} = ${JSON.stringify(v)}`)
      .join(', ')} }`,
    'default_tools_approval_mode = "approve"',
  ].join('\n');
  const withoutOurs = codex.replace(/\[mcp_servers\.kovan\][\s\S]*?(?=\n\[|$)/, '').trimEnd();
  await write(codexPath, `${withoutOurs ? `${withoutOurs}\n\n` : ''}${section}\n`);

  for (const doc of ['AGENTS.md', 'CLAUDE.md']) {
    const current = await readFile(join(root, doc), 'utf8').catch(() => null);
    const kept = current
      ?.replace(new RegExp(`${SECTION_START}[\\s\\S]*?${SECTION_END}\\n?`), '')
      .trimEnd();
    await write(doc, kept ? `${kept}\n\n${AGENT_INSTRUCTIONS}` : AGENT_INSTRUCTIONS);
  }

  // Keep what was written local to this machine.
  // Relative in a main checkout, absolute in a worktree (the exclude file is shared).
  const excludeFile = resolve(
    root,
    (await git(root, ['rev-parse', '--git-path', 'info/exclude'])).trim(),
  );
  const exclude = await readFile(excludeFile, 'utf8').catch(() => '');
  const missing = result.written.filter((p) => !exclude.split('\n').includes(`/${p}`));
  if (missing.length) {
    await mkdir(dirname(excludeFile), { recursive: true });
    await writeFile(
      excludeFile,
      `${exclude.trimEnd()}${exclude.trim() ? '\n' : ''}# Kovan setup files, kept local\n${missing.map((p) => `/${p}`).join('\n')}\n`,
    );
  }
  result.excluded = result.written;
  return result;
}

/** Whether this repository is connected (Kovan's hooks are in its Claude Code settings). */
export async function isConnected(root: string): Promise<boolean> {
  const text = await readFile(join(root, '.claude/settings.json'), 'utf8').catch(() => '');
  return text.includes(MARK);
}
