import { getStatus } from '@kovan/git-engine';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

export const RULES_FILE = 'KOVAN.md';

export interface WorkspaceContext {
  root: string;
  name: string;
  isRepo: boolean;
}

/** Files where a repository tells agents how to work in it, read in this order. */
export const AGENT_FILES = [RULES_FILE, 'AGENTS.md', 'CLAUDE.md'];
const RULES_BUDGET = 20_000;

/**
 * The repository's notes for agents: KOVAN.md, then AGENTS.md and CLAUDE.md (the ones Codex and
 * Claude Code read), within a budget. A line that only imports a file already here
 * (`@AGENTS.md`, Claude Code's way of sharing one file) is left out.
 */
export async function readAgentFiles(root: string): Promise<string | null> {
  const parts: string[] = [];
  const included = new Set<string>();
  let left = RULES_BUDGET;
  for (const file of AGENT_FILES) {
    if (left <= 0) break;
    const text = await readFile(join(root, file), 'utf8').catch(() => null);
    if (text === null) continue;
    const kept = text
      .split('\n')
      .filter((line) => {
        const m = /^@(\S+)\s*$/.exec(line.trim());
        return !m || !included.has(m[1]!.replace(/^\.\//, ''));
      })
      .join('\n')
      .trim();
    included.add(file);
    if (!kept) continue;
    const body = kept.slice(0, left);
    left -= body.length;
    parts.push(`The repository's ${file}:\n${body}`);
  }
  return parts.length ? parts.join('\n\n') : null;
}

/** The system prompt: who the agent is, how to work, and what this repository says about itself. */
export async function buildSystemPrompt(ws: WorkspaceContext): Promise<string> {
  const rules = await readAgentFiles(ws.root);
  let gitLine = 'This folder is not a git repository.';
  if (ws.isRepo) {
    const status = await getStatus(ws.root).catch(() => null);
    if (status)
      gitLine = `Git branch: ${status.branch ?? '(detached)'}; ${status.files.length} changed file(s).`;
  }
  return [
    `You are the Kovan coding agent, working in the "${ws.name}" repository on the user's own machine.`,
    'You can read and search files, edit them, and run shell commands, subject to the current permission mode.',
    '',
    'How to work:',
    '- Look before you change: read the relevant files and search for usages first.',
    '- Make focused, minimal changes that match the surrounding code style.',
    '- Use edit_file for changes to existing files; old_string must be copied exactly from read_file output (without line numbers).',
    '- After changing code, run the relevant tests or checks when there are any, and report the result honestly.',
    '- Never print or exfiltrate secrets. Avoid destructive commands (rm -rf, force pushes, resets) unless the user asked.',
    '- Remove temporary files you create for debugging before you finish. If an action was denied, say so in your final summary and list what was left undone.',
    '- Keep answers short. Reference files as path:line.',
    '',
    `Workspace root: ${ws.root}`,
    gitLine,
    rules ? `\nTeam rules for agents in this repository:\n\n${rules}` : '',
  ].join('\n');
}

/**
 * The repository's preparation commands: the code blocks (or `inline code` list items) under a
 * "Before Build" heading in KOVAN.md. Each block runs as one shell script, in order.
 */
export function parseBeforeBuild(markdown: string): string[] {
  return commandsUnder(markdown, /^#{1,6}\s+before build\s*:?\s*$/i);
}

/**
 * The checks a subagent's work must pass before it joins its parent: the commands under a
 * "Required Checks" heading in KOVAN.md, written like "Before Build".
 */
export function parseRequiredChecks(markdown: string): string[] {
  return commandsUnder(markdown, /^#{1,6}\s+required checks\s*:?\s*$/i);
}

export async function readRequiredChecks(root: string): Promise<string[]> {
  const rules = await readFile(join(root, RULES_FILE), 'utf8').catch(() => null);
  return rules ? parseRequiredChecks(rules) : [];
}

function commandsUnder(markdown: string, heading: RegExp): string[] {
  const lines = markdown.split('\n');
  const start = lines.findIndex((l) => heading.test(l.trim()));
  if (start === -1) return [];
  const level = /^#+/.exec(lines[start]!.trim())![0].length;
  const commands: string[] = [];
  let block: string[] | null = null;
  for (const line of lines.slice(start + 1)) {
    const fence = /^\s*(```|~~~)/.test(line);
    if (block) {
      if (fence) {
        const script = block.join('\n').trim();
        if (script) commands.push(script);
        block = null;
      } else block.push(line);
      continue;
    }
    const heading = /^(#{1,6})\s/.exec(line.trim());
    if (heading && heading[1]!.length <= level) break;
    if (fence) block = [];
    else {
      const item = /^\s*[-*]\s+`([^`]+)`\s*$/.exec(line);
      if (item) commands.push(item[1]!.trim());
    }
  }
  return commands;
}

export async function readBeforeBuild(root: string): Promise<string[]> {
  const rules = await readFile(join(root, RULES_FILE), 'utf8').catch(() => null);
  return rules ? parseBeforeBuild(rules) : [];
}
