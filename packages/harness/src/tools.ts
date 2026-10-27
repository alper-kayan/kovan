import { git } from '@kovan/git-engine';
import type { ToolSpec } from '@kovan/model-gateway';
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { resolveInside, resolveReadable, toRelative } from './paths.js';
import { clip, runShell } from './shell.js';

/**
 * What a tool may do, which decides whether it needs approval in each mode. "team" tools only
 * talk to Kovan (plans, notes, team context): they never touch the repository or the machine.
 * "external" tools belong to someone else's program (an MCP server): what they do isn't known.
 */
export type ToolKind = 'read' | 'edit' | 'command' | 'team' | 'external';

export interface ToolContext {
  root: string;
  isRepo: boolean;
  signal: AbortSignal;
  /** Folders outside the workspace that read_file and list_dir may read (absolute paths). */
  readRoots?: readonly string[];
}

export interface ToolResult {
  /** Fed back to the model. */
  output: string;
  ok: boolean;
  /** For the UI: files touched and line counts. */
  meta?: { path?: string; added?: number; removed?: number; exitCode?: number | null };
}

export interface Tool {
  spec: ToolSpec;
  kind: ToolKind;
  /** One line for the transcript, e.g. "Edited src/a.ts". */
  describe(args: Record<string, unknown>): string;
  /** An external tool its server says only reads: the one kind Plan mode may use. */
  readOnly?: boolean;
  /**
   * The arguments as people may see them (approval card, transcript, the team's view):
   * secrets hidden. The tool itself still gets the real ones.
   */
  display?(args: Record<string, unknown>): Record<string, unknown>;
  /** The person chose "always allow" for this tool: it runs without asking. */
  allowed?(): boolean;
  /** For an external tool's approval card: whose tool it is, e.g. "github · create_issue". */
  origin?: string;
  run(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult>;
}

class ToolInputError extends Error {}

function str(args: Record<string, unknown>, key: string, required = true): string {
  const value = args[key];
  if (value === undefined || value === null) {
    if (required) throw new ToolInputError(`Missing "${key}"`);
    return '';
  }
  if (typeof value !== 'string') throw new ToolInputError(`"${key}" must be a string`);
  return value;
}

function num(args: Record<string, unknown>, key: string): number | undefined {
  const value = args[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value))
    throw new ToolInputError(`"${key}" must be a number`);
  return value;
}

/** Lines added and removed between two texts (multiset count, cheap and good enough for "+14 −3"). */
export function lineStat(before: string, after: string): { added: number; removed: number } {
  const count = (text: string) => {
    const map = new Map<string, number>();
    for (const line of text === '' ? [] : text.split('\n')) map.set(line, (map.get(line) ?? 0) + 1);
    return map;
  };
  const a = count(before);
  const b = count(after);
  let added = 0;
  let removed = 0;
  for (const [line, n] of b) added += Math.max(0, n - (a.get(line) ?? 0));
  for (const [line, n] of a) removed += Math.max(0, n - (b.get(line) ?? 0));
  return { added, removed };
}

const MAX_READ_LINES = 2000;
const SKIP_DIRS = new Set([
  '.git',
  'node_modules',
  'dist',
  'out',
  'build',
  '.turbo',
  '.next',
  'coverage',
]);

const readFileTool: Tool = {
  kind: 'read',
  spec: {
    name: 'read_file',
    description:
      'Read a text file in the workspace. Returns numbered lines. Use offset/limit (1-based line numbers) for large files.',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: "Path relative to the workspace root (or a skill file's full path)",
        },
        offset: { type: 'number', description: 'First line to read (1-based)' },
        limit: { type: 'number', description: `Number of lines (max ${MAX_READ_LINES})` },
      },
      required: ['path'],
    },
  },
  describe: (a) => `Read ${String(a['path'] ?? '')}`,
  async run(args, ctx) {
    const path = str(args, 'path');
    const file = await resolveReadable(ctx.root, path, ctx.readRoots);
    const text = await readFile(file, 'utf8');
    if (text.includes('\0')) return { ok: false, output: `${path} is a binary file` };
    const lines = text.split('\n');
    const start = Math.max(1, Math.floor(num(args, 'offset') ?? 1));
    const limit = Math.min(
      MAX_READ_LINES,
      Math.max(1, Math.floor(num(args, 'limit') ?? MAX_READ_LINES)),
    );
    const slice = lines.slice(start - 1, start - 1 + limit);
    const body = slice.map((line, i) => `${String(start + i).padStart(6)}\t${line}`).join('\n');
    const more =
      start - 1 + slice.length < lines.length
        ? `\n… ${lines.length - (start - 1 + slice.length)} more lines`
        : '';
    return { ok: true, output: clip(body + more, 200_000), meta: { path } };
  },
};

const listDirTool: Tool = {
  kind: 'read',
  spec: {
    name: 'list_dir',
    description: 'List a directory in the workspace. Directories end with "/".',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Directory relative to the workspace root; "." for the root',
        },
      },
      required: [],
    },
  },
  describe: (a) => `Listed ${String(a['path'] || '.')}`,
  async run(args, ctx) {
    const path = str(args, 'path', false) || '.';
    const dir = await resolveReadable(ctx.root, path, ctx.readRoots);
    const entries = await readdir(dir, { withFileTypes: true });
    const names = entries
      .filter((e) => e.name !== '.git')
      .map((e) => (e.isDirectory() ? `${e.name}/` : e.name))
      .sort((a, b) =>
        a.endsWith('/') === b.endsWith('/') ? a.localeCompare(b) : a.endsWith('/') ? -1 : 1,
      );
    return { ok: true, output: names.join('\n') || '(empty)', meta: { path } };
  },
};

async function walk(root: string, start: string, out: string[], limit: number): Promise<void> {
  if (out.length >= limit) return;
  let entries;
  try {
    entries = await readdir(start, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (out.length >= limit) return;
    const full = join(start, e.name);
    if (e.isDirectory()) {
      if (!SKIP_DIRS.has(e.name)) await walk(root, full, out, limit);
    } else if (e.isFile()) {
      out.push(toRelative(root, full));
    }
  }
}

const MAX_MATCHES = 200;

const grepTool: Tool = {
  kind: 'read',
  spec: {
    name: 'grep',
    description: `Search file contents with a regular expression. Returns "path:line: text" for up to ${MAX_MATCHES} matches.`,
    parameters: {
      type: 'object',
      properties: {
        pattern: {
          type: 'string',
          description: 'Regular expression (JavaScript / extended syntax)',
        },
        path: { type: 'string', description: 'Limit to this file or directory' },
        ignore_case: { type: 'boolean' },
      },
      required: ['pattern'],
    },
  },
  describe: (a) => `Searched for ${JSON.stringify(a['pattern'] ?? '')}`,
  async run(args, ctx) {
    const pattern = str(args, 'pattern');
    const path = str(args, 'path', false) || '.';
    await resolveInside(ctx.root, path);
    const ignoreCase = args['ignore_case'] === true;
    let regex: RegExp;
    try {
      regex = new RegExp(pattern, ignoreCase ? 'i' : '');
    } catch (error) {
      return { ok: false, output: `Invalid regular expression: ${(error as Error).message}` };
    }
    const files: string[] = [];
    if (ctx.isRepo) {
      const listed = await git(ctx.root, [
        'ls-files',
        '--cached',
        '--others',
        '--exclude-standard',
        '-z',
        '--',
        path,
      ]);
      files.push(...listed.split('\0').filter(Boolean));
    } else {
      await walk(ctx.root, await resolveInside(ctx.root, path), files, 20_000);
    }
    const matches: string[] = [];
    for (const file of files) {
      if (matches.length >= MAX_MATCHES || ctx.signal.aborted) break;
      const full = join(ctx.root, file);
      try {
        if ((await stat(full)).size > 2_000_000) continue;
        const text = await readFile(full, 'utf8');
        if (text.includes('\0')) continue;
        text.split('\n').forEach((line, i) => {
          if (matches.length < MAX_MATCHES && regex.test(line))
            matches.push(`${file}:${i + 1}: ${line.slice(0, 300)}`);
        });
      } catch {
        // Unreadable file: skip.
      }
    }
    const more =
      matches.length >= MAX_MATCHES
        ? `\n… stopped at ${MAX_MATCHES} matches; narrow the search`
        : '';
    return { ok: true, output: matches.length ? matches.join('\n') + more : 'No matches' };
  },
};

const writeFileTool: Tool = {
  kind: 'edit',
  spec: {
    name: 'write_file',
    description:
      'Create a file or replace its whole content. Prefer edit_file for changes to existing files.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Path relative to the workspace root' },
        content: { type: 'string', description: 'The complete new content' },
      },
      required: ['path', 'content'],
    },
  },
  describe: (a) => `Wrote ${String(a['path'] ?? '')}`,
  async run(args, ctx) {
    const path = str(args, 'path');
    const content = str(args, 'content');
    const file = await resolveInside(ctx.root, path);
    const before = await readFile(file, 'utf8').catch(() => '');
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, content, 'utf8');
    const stat_ = lineStat(before, content);
    return {
      ok: true,
      output: `Wrote ${path} (+${stat_.added} −${stat_.removed})`,
      meta: { path, ...stat_ },
    };
  },
};

const editFileTool: Tool = {
  kind: 'edit',
  spec: {
    name: 'edit_file',
    description:
      'Replace an exact piece of text in a file. old_string must match exactly (including whitespace) and be unique unless replace_all is true. Read the file first.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        old_string: { type: 'string', description: 'Exact text to replace' },
        new_string: { type: 'string', description: 'Replacement text' },
        replace_all: { type: 'boolean', description: 'Replace every occurrence' },
      },
      required: ['path', 'old_string', 'new_string'],
    },
  },
  describe: (a) => `Edited ${String(a['path'] ?? '')}`,
  async run(args, ctx) {
    const path = str(args, 'path');
    const oldString = str(args, 'old_string');
    const newString = str(args, 'new_string');
    if (oldString === '')
      throw new ToolInputError('old_string is empty; use write_file to create files');
    const file = await resolveInside(ctx.root, path);
    const before = await readFile(file, 'utf8');
    const count = before.split(oldString).length - 1;
    if (count === 0)
      return {
        ok: false,
        output: `old_string was not found in ${path}. Read the file and copy the text exactly.`,
      };
    if (count > 1 && args['replace_all'] !== true) {
      return {
        ok: false,
        output: `old_string appears ${count} times in ${path}. Add surrounding lines to make it unique, or set replace_all.`,
      };
    }
    const after =
      args['replace_all'] === true
        ? before.split(oldString).join(newString)
        : before.replace(oldString, () => newString);
    await writeFile(file, after, 'utf8');
    const s = lineStat(before, after);
    return { ok: true, output: `Edited ${path} (+${s.added} −${s.removed})`, meta: { path, ...s } };
  },
};

const runShellTool: Tool = {
  kind: 'command',
  spec: {
    name: 'run_shell',
    description:
      'Run a shell command in the workspace root (non-interactive). Use it for tests, builds and git. Output is truncated when long.',
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string' },
        timeout_ms: { type: 'number', description: 'Default 120000, max 600000' },
      },
      required: ['command'],
    },
  },
  describe: (a) => `Ran ${String(a['command'] ?? '')}`,
  async run(args, ctx) {
    const command = str(args, 'command');
    const timeoutMs = Math.min(600_000, Math.max(1000, num(args, 'timeout_ms') ?? 120_000));
    const result = await runShell(command, ctx.root, { timeoutMs, signal: ctx.signal });
    const status = result.aborted
      ? 'stopped'
      : result.timedOut
        ? `timed out after ${timeoutMs}ms`
        : `exit code ${result.exitCode}`;
    return {
      ok: result.exitCode === 0,
      output: `${result.output.trimEnd() || '(no output)'}\n[${status}]`,
      meta: { exitCode: result.exitCode },
    };
  },
};

export const ALL_TOOLS: Tool[] = [
  readFileTool,
  listDirTool,
  grepTool,
  writeFileTool,
  editFileTool,
  runShellTool,
];

/** Runs a tool, turning bad input and file errors into messages the model can recover from. */
export async function runTool(
  tool: Tool,
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolResult> {
  try {
    return await tool.run(args, ctx);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return { ok: false, output: `Not found: ${String(args['path'] ?? '')}` };
    return { ok: false, output: `Error: ${message}` };
  }
}
