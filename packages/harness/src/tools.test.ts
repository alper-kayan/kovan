import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ALL_TOOLS, lineStat, runTool, type ToolContext } from './tools.js';

let root: string;
let ctx: ToolContext;
const tool = (name: string) => ALL_TOOLS.find((t) => t.spec.name === name)!;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'kovan-tools-'));
  await mkdir(join(root, 'src'));
  await writeFile(join(root, 'src', 'a.ts'), 'export const a = 1;\nexport const b = 2;\n');
  ctx = { root, isRepo: false, signal: new AbortController().signal };
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('tools', () => {
  it('reads files with line numbers and ranges', async () => {
    const r = await runTool(tool('read_file'), { path: 'src/a.ts', offset: 2, limit: 1 }, ctx);
    expect(r.output).toBe('     2\texport const b = 2;\n… 1 more lines');
  });

  it('lists directories with folders first', async () => {
    await writeFile(join(root, 'README.md'), '');
    expect((await runTool(tool('list_dir'), {}, ctx)).output).toBe('src/\nREADME.md');
  });

  it('greps with a regular expression', async () => {
    const r = await runTool(tool('grep'), { pattern: 'const b' }, ctx);
    expect(r.output).toBe('src/a.ts:2: export const b = 2;');
  });

  it('edits exactly once, refusing missing or ambiguous text', async () => {
    const edit = tool('edit_file');
    expect(
      (await runTool(edit, { path: 'src/a.ts', old_string: 'nope', new_string: 'x' }, ctx)).ok,
    ).toBe(false);
    expect(
      (await runTool(edit, { path: 'src/a.ts', old_string: 'export const', new_string: 'x' }, ctx))
        .output,
    ).toContain('appears 2 times');
    const r = await runTool(
      edit,
      { path: 'src/a.ts', old_string: 'b = 2', new_string: 'b = 3' },
      ctx,
    );
    expect(r).toMatchObject({ ok: true, meta: { path: 'src/a.ts', added: 1, removed: 1 } });
    expect(await readFile(join(root, 'src/a.ts'), 'utf8')).toContain('b = 3');
  });

  it('writes new files into new folders', async () => {
    const r = await runTool(tool('write_file'), { path: 'docs/new.md', content: 'hi\n' }, ctx);
    expect(r.ok).toBe(true);
    expect(await readFile(join(root, 'docs/new.md'), 'utf8')).toBe('hi\n');
  });

  it('keeps every tool inside the workspace', async () => {
    for (const name of ['read_file', 'write_file', 'list_dir']) {
      const r = await runTool(tool(name), { path: '../escape.txt', content: 'x' }, ctx);
      expect(r).toMatchObject({ ok: false });
      expect(r.output).toContain('outside the workspace');
    }
  });

  it('runs shell commands and reports the exit code', async () => {
    const ok = await runTool(tool('run_shell'), { command: 'echo hello && exit 3' }, ctx);
    expect(ok.output).toBe('hello\n[exit code 3]');
    expect(ok.ok).toBe(false);
  });

  it('kills the whole process tree when stopped', async () => {
    const abort = new AbortController();
    const started = Date.now();
    const pending = runTool(
      tool('run_shell'),
      { command: 'sleep 30 & sleep 30; echo never' },
      { ...ctx, signal: abort.signal },
    );
    setTimeout(() => abort.abort(), 200);
    const r = await pending;
    expect(r.output).toContain('[stopped]');
    expect(Date.now() - started).toBeLessThan(5000);
  });

  it('reports bad arguments as recoverable errors', async () => {
    expect((await runTool(tool('read_file'), {}, ctx)).output).toBe('Error: Missing "path"');
  });
});

describe('lineStat', () => {
  it('counts added and removed lines', () => {
    expect(lineStat('a\nb\nc', 'a\nc\nd\ne')).toEqual({ added: 2, removed: 1 });
    expect(lineStat('', 'x\ny')).toEqual({ added: 2, removed: 0 });
  });
});
