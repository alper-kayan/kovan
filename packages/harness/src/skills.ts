import { readdir, readFile, realpath, stat } from 'node:fs/promises';
import { isAbsolute, join, relative, sep } from 'node:path';
import type { Tool } from './tools.js';

/**
 * Skills: instructions for a kind of task, in Claude Code's format, so one skill works in both
 * agents. A skill is a folder with a SKILL.md (frontmatter `name` and `description`) and any
 * files it refers to. Only names and descriptions go into the prompt; the agent loads the rest
 * with `use_skill` when a task calls for it. A skill is guidance, never a permission: what it
 * asks for still goes through the lane's permission mode.
 */

/** Where a skill was found, highest priority first. */
export type SkillSource = 'repo' | 'repo-claude' | 'user' | 'plugin' | 'claude-code';

export interface Skill {
  name: string;
  description: string;
  source: SkillSource;
  /** The skill's folder (absolute). */
  dir: string;
  /** SKILL.md without its frontmatter. */
  body: string;
  /** Turned off in Settings: listed there, not given to agents. */
  enabled: boolean;
  /** The plugin it came with; its name is then `plugin:skill`, as in Claude Code. */
  plugin?: string;
}

export interface SkillWarning {
  path: string;
  problem: string;
}

export interface SkillSet {
  skills: Skill[];
  warnings: SkillWarning[];
}

export interface SkillPlaces {
  /** The workspace: its `.kovan/skills/` and `.claude/skills/` (none without a workspace). */
  root: string | null;
  /** The person's Kovan skills (`userData/skills`). */
  userDir: string | null;
  /** The person's Claude Code skills (`~/.claude/skills`), when they chose to use them. */
  claudeDir: string | null;
  /** Skill folders of the plugins on in this workspace. */
  plugins?: readonly { name: string; dir: string }[];
  /** Names turned off in Settings. */
  off?: readonly string[];
}

export const SKILL_FILE = 'SKILL.md';
const NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;
const MAX_SKILL_BYTES = 200_000;
const MAX_DESCRIPTION = 1024;

/** Every skill folder, highest priority first. */
export function skillDirs(
  places: SkillPlaces,
): { dir: string; source: SkillSource; plugin?: string }[] {
  const { root } = places;
  return [
    ...(root
      ? [
          { dir: join(root, '.kovan', 'skills'), source: 'repo' as const },
          { dir: join(root, '.claude', 'skills'), source: 'repo-claude' as const },
        ]
      : []),
    ...(places.userDir ? [{ dir: places.userDir, source: 'user' as const }] : []),
    ...(places.plugins ?? []).map((p) => ({
      dir: p.dir,
      source: 'plugin' as const,
      plugin: p.name,
    })),
    ...(places.claudeDir ? [{ dir: places.claudeDir, source: 'claude-code' as const }] : []),
  ];
}

/**
 * The frontmatter between `---` lines: plain `key: value` pairs, quoted strings and folded
 * (`>`) or literal (`|`) blocks. Lists and other keys are read past. Null when there is none
 * or it isn't closed.
 */
export function parseFrontmatter(
  text: string,
): { data: Record<string, string>; body: string } | null {
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/);
  if (lines[0]?.trim() !== '---') return null;
  const end = lines.findIndex((l, i) => i > 0 && l.trim() === '---');
  if (end === -1) return null;
  const data: Record<string, string> = {};
  for (let i = 1; i < end; i++) {
    const m = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(lines[i]!);
    if (!m) continue;
    const key = m[1]!;
    let value = m[2]!.trim();
    if (value === '>' || value === '|' || value === '>-' || value === '|-') {
      const block: string[] = [];
      while (i + 1 < end && (/^\s+\S/.test(lines[i + 1]!) || lines[i + 1]!.trim() === ''))
        block.push(lines[++i]!.trim());
      value = value.startsWith('>') ? block.filter(Boolean).join(' ') : block.join('\n').trim();
    } else if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.startsWith('"')
        ? value.slice(1, -1).replace(/\\"/g, '"').replace(/\\n/g, '\n')
        : value.slice(1, -1).replace(/''/g, "'");
    }
    data[key] = value;
  }
  return {
    data,
    body: lines
      .slice(end + 1)
      .join('\n')
      .trim(),
  };
}

async function readSkill(
  dir: string,
  folder: string,
  source: SkillSource,
  plugin?: string,
): Promise<Skill | SkillWarning> {
  const path = join(dir, SKILL_FILE);
  const info = await stat(path);
  if (info.size > MAX_SKILL_BYTES)
    return { path, problem: `${SKILL_FILE} is larger than ${MAX_SKILL_BYTES / 1000} KB` };
  const parsed = parseFrontmatter(await readFile(path, 'utf8'));
  if (!parsed) return { path, problem: 'No frontmatter (--- name / description --- at the top)' };
  const name = parsed.data['name']?.trim() || folder;
  if (!NAME.test(name))
    return {
      path,
      problem: `Name "${name}" isn't valid: lowercase letters, digits and hyphens, at most 64`,
    };
  const description = parsed.data['description']?.trim();
  if (!description) return { path, problem: 'No description in the frontmatter' };
  return {
    name: plugin ? `${plugin}:${name}` : name,
    description: description.slice(0, MAX_DESCRIPTION),
    source,
    dir,
    body: parsed.body,
    enabled: true,
    ...(plugin ? { plugin } : {}),
  };
}

/**
 * Finds the skills in the four places. On a name clash the higher place wins; a skill whose
 * frontmatter can't be read is skipped with a warning.
 */
export async function discoverSkills(places: SkillPlaces): Promise<SkillSet> {
  const off = new Set(places.off ?? []);
  const skills: Skill[] = [];
  const warnings: SkillWarning[] = [];
  const seen = new Set<string>();
  for (const { dir, source, plugin } of skillDirs(places)) {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      continue; // no such folder
    }
    const found: Skill[] = [];
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name.startsWith('.')) continue;
      const folder = join(dir, entry.name);
      // A linked skill folder counts as a folder.
      if (!entry.isDirectory() && !(entry.isSymbolicLink() && (await isDir(folder)))) continue;
      try {
        const read = await readSkill(folder, entry.name, source, plugin);
        if ('problem' in read) warnings.push(read);
        else found.push(read);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
          warnings.push({ path: join(folder, SKILL_FILE), problem: (error as Error).message });
      }
    }
    for (const skill of found) {
      if (seen.has(skill.name)) continue;
      seen.add(skill.name);
      skills.push({ ...skill, enabled: !off.has(skill.name) });
    }
  }
  return { skills, warnings };
}

async function isDir(path: string): Promise<boolean> {
  return (await stat(path).catch(() => null))?.isDirectory() ?? false;
}

const LIST_BUDGET = 8_000;

/** The list that goes into the prompt: names and descriptions only, within a budget. */
export function skillCatalog(skills: readonly Skill[]): string | null {
  const usable = skills.filter((s) => s.enabled);
  if (usable.length === 0) return null;
  const lines: string[] = [];
  let used = 0;
  for (const [i, skill] of usable.entries()) {
    const line = `- ${skill.name}: ${skill.description.replace(/\s+/g, ' ').slice(0, 300)}`;
    if (used + line.length > LIST_BUDGET) {
      lines.push(`- … and ${usable.length - i} more: call use_skill with a name to see it`);
      break;
    }
    lines.push(line);
    used += line.length;
  }
  return [
    'Skills: instructions the team or the user wrote for particular tasks. When a request matches a skill, call use_skill with its name before you start and follow what it says. A skill is guidance, not permission: edits and commands it asks for still go through the current mode.',
    ...lines,
  ].join('\n');
}

/** Where a skill lives, as the agent should refer to it: inside the workspace, relative. */
export function skillPath(skill: Skill, root: string): string {
  const rel = relative(root, skill.dir);
  return rel && !rel.startsWith('..') && !isAbsolute(rel) ? rel.split(sep).join('/') : skill.dir;
}

async function listFiles(dir: string, base = dir, out: string[] = []): Promise<string[]> {
  if (out.length >= 100) return out;
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (e.name.startsWith('.') || out.length >= 100) continue;
    const full = join(dir, e.name);
    if (e.isDirectory()) await listFiles(full, base, out);
    else if (e.isFile() && e.name !== SKILL_FILE)
      out.push(relative(base, full).split(sep).join('/'));
  }
  return out;
}

/** What the model gets when it loads a skill: where it is, its other files, its instructions. */
export async function skillText(skill: Skill, root: string): Promise<string> {
  const where = skillPath(skill, root);
  const files = await listFiles(skill.dir);
  const head = [`Skill "${skill.name}". Its folder: ${where}`];
  if (files.length)
    head.push(
      `Its other files (read them with read_file at ${where}/<file> when the instructions point to them): ${files.join(', ')}`,
    );
  return `${head.join('\n')}\n\n${skill.body}`;
}

/** The tool that loads a skill's instructions. Reading a skill needs no approval. */
export function useSkillTool(skills: readonly Skill[], root: string): Tool {
  const usable = skills.filter((s) => s.enabled);
  return {
    kind: 'read',
    spec: {
      name: 'use_skill',
      description:
        'Load a skill: its instructions for a particular kind of task. Call it before starting a task that matches a skill in the list.',
      parameters: {
        type: 'object',
        properties: {
          name: {
            type: 'string',
            description: "The skill name, e.g. release-notes (a plugin's: plugin:skill)",
          },
        },
        required: ['name'],
      },
    },
    describe: (a) => `Used skill ${String(a['name'] ?? '')}`,
    async run(args) {
      const name = String(args['name'] ?? '').replace(/^\//, '');
      const skill = usable.find((s) => s.name === name);
      if (!skill) {
        const known = usable.map((s) => s.name).join(', ') || 'none';
        return { ok: false, output: `No skill named "${name}". Skills: ${known}.` };
      }
      return { ok: true, output: await skillText(skill, root) };
    },
  };
}

/**
 * The person invoked a skill directly ("/release-notes for 2.1"): the skill and the rest of
 * the message, or null when it isn't one of the skills.
 */
export function parseSkillCommand(
  text: string,
  skills: readonly Skill[],
): { skill: Skill; rest: string } | null {
  const m = /^\/([a-z0-9][a-z0-9-]*(?::[a-z0-9][a-z0-9-]*)?)(?:\s+([\s\S]*))?$/.exec(text.trim());
  if (!m) return null;
  const skill = skills.find((s) => s.enabled && s.name === m[1]);
  return skill ? { skill, rest: (m[2] ?? '').trim() } : null;
}

/**
 * Folders outside the workspace the agent may read (the person's own skill folders), real
 * paths so links can't step outside them.
 */
export async function skillReadRoots(skills: readonly Skill[], root: string): Promise<string[]> {
  const roots = new Set<string>();
  for (const s of skills) {
    if (!s.enabled || skillPath(s, root) !== s.dir) continue;
    roots.add(await realpath(s.dir).catch(() => s.dir));
  }
  return [...roots];
}
