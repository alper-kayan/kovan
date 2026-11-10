import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { AgentEvent } from '@kovan/harness';
import { ClaudeLines, claudeAccounts, claudeEnv, mapTool } from './claude.js';

describe('claude accounts', () => {
  it('lists the desktop app’s Claude Code accounts, plus the default sign-in, with no setup', () => {
    const dir = mkdtempSync(join(tmpdir(), 'kv-'));
    writeFileSync(
      join(dir, 'agent-accounts.json'),
      JSON.stringify([
        { id: 'ab12', harness: 'claude-code', name: 'alper' },
        { id: 'cd34', harness: 'codex', name: 'x' },
        { id: '../evil', harness: 'claude-code', name: 'bad' },
      ]),
    );
    expect(claudeAccounts(dir)).toEqual([
      { id: 'ab12', name: 'alper' },
      { id: null, name: 'varsayılan' },
    ]);
    expect(claudeEnv(dir, 'ab12')).toEqual({
      CLAUDE_CONFIG_DIR: join(dir, 'agent-accounts', 'ab12'),
    });
    expect(claudeEnv(dir, null)).toEqual({});
  });
  it('no accounts file is just the default', () => {
    const dir = mkdtempSync(join(tmpdir(), 'kv-'));
    mkdirSync(dir, { recursive: true });
    expect(claudeAccounts(dir)).toEqual([{ id: null, name: 'varsayılan' }]);
  });
});

describe('claude stream', () => {
  it('turns stream-json lines into the events the screen draws', () => {
    const ev: AgentEvent[] = [];
    const c = new ClaudeLines('t', '/p', (e) => ev.push(e));
    c.push({ type: 'system', subtype: 'init', model: 'sonnet', session_id: 's1' });
    c.push({
      type: 'assistant',
      message: {
        content: [
          { type: 'text', text: 'Bakıyorum' },
          {
            type: 'tool_use',
            id: 'x',
            name: 'Edit',
            input: { file_path: '/p/a.ts', old_string: 'a', new_string: 'b' },
          },
        ],
      },
    });
    c.push({
      type: 'user',
      message: { content: [{ type: 'tool_result', tool_use_id: 'x', content: 'ok' }] },
    });
    c.push({ type: 'result', usage: { input_tokens: 5, output_tokens: 7 }, total_cost_usd: 0.01 });
    expect(c.sessionId).toBe('s1');
    expect(ev.map((e) => e.type)).toEqual([
      'turn_start',
      'text',
      'tool_start',
      'tool_end',
      'usage',
      'turn_end',
    ]);
    expect(ev[2]).toMatchObject({
      name: 'edit_file',
      args: { path: 'a.ts', old_string: 'a', new_string: 'b' },
    });
    expect(ev.at(-1)).toMatchObject({ reason: 'done' });
  });
  it('ends exactly once, and an error carries its text', () => {
    const ev: AgentEvent[] = [];
    const c = new ClaudeLines('t', '/p', (e) => ev.push(e));
    c.push({ type: 'result', is_error: true, result: 'giriş yok' });
    c.finish('stopped');
    expect(ev.filter((e) => e.type === 'turn_end')).toHaveLength(1);
    expect(ev.at(-1)).toMatchObject({ reason: 'error', error: 'giriş yok' });
  });
  it('maps Bash and Write to the shell and file rows', () => {
    expect(mapTool('Bash', { command: 'ls\nx' }, '/p')).toMatchObject({
      name: 'run_shell',
      args: { command: 'ls\nx' },
    });
    expect(mapTool('Write', { file_path: '/p/b.md', content: 'hi' }, '/p')).toMatchObject({
      name: 'write_file',
      args: { path: 'b.md' },
    });
  });
});
