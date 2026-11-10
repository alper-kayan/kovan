import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseFrontmatter, type SkillPlaces } from '@kovan/harness';
import { desktopDataDir } from './paths.js';

/**
 * What Claude Code reads that `kovan` reads too, in the same formats, so what you already wrote for Claude works here:
 *
 *  - skills: `SKILL.md` folders. The repository's `.kovan/skills` and `.claude/skills`, the desktop app's own skill folder (the same one
 *    its Settings manage), and Claude's `~/.claude/skills`. The harness lists them to the model and loads one on demand (`use_skill`, or
 *    `/skill-name` typed by you).
 *  - your own notes: `~/.kovan/KOVAN.md` and Claude's `~/.claude/CLAUDE.md`, on top of the repository's KOVAN.md / AGENTS.md / CLAUDE.md the
 *    harness already reads (and the rules kept in subfolders, read as the agent reaches them).
 *  - custom slash commands: `.kovan/commands/<name>.md` and `.claude/commands/<name>.md` in the repository, and `~/.claude/commands`. The file is the prompt;
 *    `$ARGUMENTS` and `$1`…`$9` are replaced by what you typed after the name.
 *
 * `KOVAN_NO_CLAUDE=1` leaves everything of Claude's alone (skills, notes, commands).
 *
 * Not here: hooks, MCP servers from `.mcp.json`, plugins, and `@file` / `!command` inside a command. The harness has an MCP client, but this prompt does
 * not start servers yet.
 */
export interface ExtrasDeps {
  env: Record<string, string | undefined>;
  home: string;
}

const claudeOn = (env: Record<string, string | undefined>) => env['KOVAN_NO_CLAUDE'] !== '1';

export function skillPlaces(root: string, d: ExtrasDeps): SkillPlaces {
  return {
    root,
    userDir: join(desktopDataDir(d.env, process.platform, d.home), 'skills'),
    claudeDir: claudeOn(d.env) ? join(d.home, '.claude', 'skills') : null,
  };
}

const NOTES_BUDGET = 8_000;

/** Your own standing instructions, as one block for the system prompt; empty when there are none. */
export async function userNotes(d: ExtrasDeps): Promise<string> {
  const files: [string, string][] = [[join(d.home, '.kovan', 'KOVAN.md'), '~/.kovan/KOVAN.md']];
  if (claudeOn(d.env)) files.push([join(d.home, '.claude', 'CLAUDE.md'), '~/.claude/CLAUDE.md']);
  const parts: string[] = [];
  for (const [path, label] of files) {
    const text = (await readFile(path, 'utf8').catch(() => '')).trim();
    if (text) parts.push(`The user's own notes (${label}):\n${text.slice(0, NOTES_BUDGET)}`);
  }
  return parts.join('\n\n');
}

export interface CustomCommand {
  name: string;
  description: string | null;
  body: string;
  source: string;
}

const NAME = /^[a-z0-9][a-z0-9_-]{0,63}$/i;

/** The command file for `/name`, repository first, then your own. */
export async function findCommand(
  name: string,
  root: string,
  d: ExtrasDeps,
): Promise<CustomCommand | null> {
  if (!NAME.test(name)) return null;
  const dirs = [
    join(root, '.kovan', 'commands'),
    ...(claudeOn(d.env) ? [join(root, '.claude', 'commands')] : []),
    join(d.home, '.kovan', 'commands'),
    ...(claudeOn(d.env) ? [join(d.home, '.claude', 'commands')] : []),
  ];
  for (const dir of dirs) {
    const raw = await readFile(join(dir, `${name}.md`), 'utf8').catch(() => null);
    if (raw === null) continue;
    const fm = parseFrontmatter(raw);
    return {
      name,
      description: fm?.data['description']?.trim() || null,
      body: (fm ? fm.body : raw).trim(),
      source: dir,
    };
  }
  return null;
}

/** `$ARGUMENTS` is everything you typed after the name; `$1`…`$9` are its words. With no placeholder, the arguments follow the text. */
export function expandCommand(body: string, args: string): string {
  const words = args.split(/\s+/).filter(Boolean);
  let used = false;
  const out = body
    .replace(/\$ARGUMENTS\b/g, () => ((used = true), args))
    .replace(/\$([1-9])\b/g, (_m, n: string) => ((used = true), words[Number(n) - 1] ?? ''));
  return used || !args ? out : `${out}\n\n${args}`;
}
