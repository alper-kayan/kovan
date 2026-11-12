import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { AgentEvent } from '@kovan/harness';
import { ClaudeLines, claudeAccounts, claudeEnv, engineAccounts, mapTool } from './claude.js';

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
    expect(claudeAccounts(dir)).toEqual([{ id: 'ab12', name: 'alper' }]);
    expect(claudeEnv(dir, 'ab12')).toEqual({
      CLAUDE_CONFIG_DIR: join(dir, 'agent-accounts', 'ab12'),
    });
    expect(claudeEnv(dir, null)).toEqual({});
  });
  it('no accounts file is no accounts: the CLI’s own sign-in is never offered', () => {
    const dir = mkdtempSync(join(tmpdir(), 'kv-'));
    mkdirSync(dir, { recursive: true });
    expect(claudeAccounts(dir)).toEqual([]);
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

import { CodexLines, bareCommand } from './codex.js';

describe('codex stream', () => {
  it('turns codex exec lines into events, and lists the app’s Codex accounts', () => {
    const ev: AgentEvent[] = [];
    const c = new CodexLines('t', '/p', 'default', (e) => ev.push(e));
    c.push({ type: 'thread.started', thread_id: 'th1' });
    c.push({ type: 'turn.started' });
    c.push({
      type: 'item.started',
      item: {
        id: 'a',
        type: 'command_execution',
        command: '/bin/zsh -lc "ls -la"',
        status: 'in_progress',
      },
    });
    c.push({
      type: 'item.completed',
      item: {
        id: 'a',
        type: 'command_execution',
        command: '/bin/zsh -lc "ls -la"',
        aggregated_output: 'x',
        exit_code: 0,
        status: 'completed',
      },
    });
    c.push({ type: 'item.completed', item: { id: 'b', type: 'agent_message', text: 'bitti' } });
    c.push({ type: 'turn.completed', usage: { input_tokens: 3, output_tokens: 4 } });
    expect(c.threadId).toBe('th1');
    expect(ev.map((e) => e.type)).toEqual([
      'turn_start',
      'tool_start',
      'tool_end',
      'text',
      'usage',
      'turn_end',
    ]);
    expect(ev[1]).toMatchObject({ name: 'run_shell', args: { command: 'ls -la' } });
    expect(bareCommand("/bin/bash -c 'echo hi'")).toBe('echo hi');
    const dir = mkdtempSync(join(tmpdir(), 'kv-'));
    writeFileSync(
      join(dir, 'agent-accounts.json'),
      JSON.stringify([{ id: 'x1', harness: 'codex', name: 'iş' }]),
    );
    expect(claudeAccounts(dir, 'codex')).toEqual([{ id: 'x1', name: 'iş' }]);
  });
});

import { createCipheriv, pbkdf2Sync, randomBytes } from 'node:crypto';
import { decryptSafeStorage, desktopProviders, providerKey } from './desktopKeys.js';

describe('desktop providers and their keys', () => {
  const seal = (text: string, secret: string) => {
    const key = pbkdf2Sync(secret, 'saltysalt', 1003, 16, 'sha1');
    const c = createCipheriv('aes-128-cbc', key, Buffer.alloc(16, 0x20));
    return Buffer.concat([Buffer.from('v10'), c.update(text, 'utf8'), c.final()]);
  };
  it('lists the providers from the app’s file, no key needed', () => {
    const dir = mkdtempSync(join(tmpdir(), 'kv-'));
    writeFileSync(
      join(dir, 'custom-providers.json'),
      JSON.stringify([
        {
          id: 'deepinfra',
          name: 'DeepInfra',
          baseUrl: 'https://api.deepinfra.com/v1/openai',
          models: [{ id: '@deepinfra/qwen/Qwen3' }],
        },
      ]),
    );
    expect(desktopProviders(dir)).toEqual([
      {
        id: 'deepinfra',
        name: 'DeepInfra',
        baseUrl: 'https://api.deepinfra.com/v1/openai',
        models: ['qwen/Qwen3'],
      },
    ]);
  });
  it('opens the app’s encrypted keys with the keychain secret, and says so when it cannot', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'kv-'));
    writeFileSync(
      join(dir, 'custom-provider-keys.bin'),
      seal(JSON.stringify({ deepinfra: 'sk-test' }), 'hunter2'),
    );
    expect(decryptSafeStorage(seal('merhaba', 's'), 's')).toBe('merhaba');
    expect(await providerKey(dir, 'deepinfra', 'darwin', { keychain: async () => 'hunter2' })).toBe(
      'sk-test',
    );
    await expect(
      providerKey(dir, 'other', 'darwin', { keychain: async () => 'hunter2' }),
    ).rejects.toThrow(/no key saved/);
    await expect(
      providerKey(dir, 'deepinfra', 'darwin', { keychain: async () => 'wrong' }),
    ).rejects.toThrow();
    await expect(
      providerKey(mkdtempSync(join(tmpdir(), 'kv-')), 'x', 'darwin', { keychain: async () => 'a' }),
    ).rejects.toThrow(/no saved keys/);
    // Where there is neither keychain nor DPAPI it says how to use the provider instead.
    await expect(providerKey(dir, 'deepinfra', 'linux')).rejects.toThrow(
      /macOS and Windows.*KOVAN_BASE_URL/,
    );
  });

  it('opens them on Windows too: the AES key from Local State, unsealed by DPAPI, then AES-256-GCM', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'kv-win-'));
    const aes = randomBytes(32);
    // What Chromium writes: "DPAPI" + the DPAPI blob of the key (here a stand-in that DPAPI below undoes).
    const sealedKey = Buffer.concat([Buffer.from('DPAPI'), Buffer.from('sealed:'), aes]);
    writeFileSync(
      join(dir, 'Local State'),
      JSON.stringify({ os_crypt: { encrypted_key: sealedKey.toString('base64') } }),
    );
    const nonce = randomBytes(12);
    const c = createCipheriv('aes-256-gcm', aes, nonce);
    const body = Buffer.concat([c.update(JSON.stringify({ deepinfra: 'sk-win' })), c.final()]);
    writeFileSync(
      join(dir, 'custom-provider-keys.bin'),
      Buffer.concat([Buffer.from('v10'), nonce, body, c.getAuthTag()]),
    );
    const unprotect = async (b: Buffer) => {
      expect(b.subarray(0, 7).toString()).toBe('sealed:'); // the "DPAPI" prefix is not part of the blob
      return b.subarray(7);
    };
    expect(await providerKey(dir, 'deepinfra', 'win32', { unprotect })).toBe('sk-win');
    // Another user's DPAPI gives another key: GCM refuses it rather than returning garbage.
    await expect(
      providerKey(dir, 'deepinfra', 'win32', { unprotect: async () => randomBytes(32) }),
    ).rejects.toThrow();
  });
});

import { findBinary, launch } from './claude.js';

describe('agent CLIs on Windows', () => {
  it('finds claude.exe or npm’s claude.cmd, in PATH or npm’s own folder', () => {
    const home = mkdtempSync(join(tmpdir(), 'kv-win-'));
    const npm = join(home, 'AppData', 'Roaming', 'npm');
    mkdirSync(npm, { recursive: true });
    writeFileSync(join(npm, 'codex.cmd'), '');
    writeFileSync(join(npm, 'codex'), ''); // npm's sh shim for Git Bash: not something Windows can start
    expect(findBinary('codex', {}, home, 'win32')).toBe(join(npm, 'codex.cmd'));
    const bin = join(home, '.local', 'bin');
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, 'claude.exe'), '');
    expect(findBinary('claude', { PATH: '' }, home, 'win32')).toBe(join(bin, 'claude.exe'));
    expect(findBinary('claude', {}, home, 'darwin')).toBeNull(); // no extension-less claude there
  });

  it('starts an npm shim’s script with this Node, so the prompt never passes through cmd.exe', () => {
    const shim = [
      '@ECHO off',
      'IF EXIST "%dp0%\\node.exe" (',
      '  SET "_prog=%dp0%\\node.exe"',
      ')',
      'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\@openai\\codex\\bin\\codex.js" %*',
    ].join('\r\n');
    const dir = join('C:', 'Users', 'a', 'AppData', 'Roaming', 'npm');
    const run = launch(join(dir, 'codex.cmd'), ['exec', 'a & b %PATH% "q"'], 'win32', () => shim);
    expect(run.file).toBe(process.execPath);
    expect(run.args).toEqual([
      join(dir, 'node_modules\\@openai\\codex\\bin\\codex.js'),
      'exec',
      'a & b %PATH% "q"',
    ]);
    // An .exe, and anything on macOS or Linux, starts as it is.
    expect(launch('C:\\x\\claude.exe', ['-p'], 'win32')).toEqual({
      file: 'C:\\x\\claude.exe',
      args: ['-p'],
    });
    expect(launch('/usr/local/bin/claude', ['-p'], 'darwin')).toEqual({
      file: '/usr/local/bin/claude',
      args: ['-p'],
    });
    expect(() => launch('C:\\x\\odd.cmd', [], 'win32', () => 'echo hi')).toThrow(/native build/);
  });
});

import { claudeCatalog, codexCatalog } from './catalogs.js';

describe('the CLIs’ own model lists', () => {
  it('reads Claude Code’s newest catalog: names, descriptions, sections, effort levels', () => {
    const dir = mkdtempSync(join(tmpdir(), 'kv-'));
    const cat = join(dir, 'cache', 'model-catalog');
    mkdirSync(cat, { recursive: true });
    const file = (at: number, ids: string[], surface = 'cc') =>
      JSON.stringify({
        fetchedAt: at,
        catalog: {
          surface,
          config: {
            models: ids.map((id, i) => ({
              id,
              name: id.toUpperCase(),
              description: `d-${id}`,
              section: i === 0 ? 'main' : 'overflow',
              runtime: { effort_levels: ['low', 'high'], default_effort: 'high' },
            })),
          },
        },
      });
    writeFileSync(join(cat, 'old-cc.json'), file(1, ['old-model']));
    writeFileSync(join(cat, 'new-cc.json'), file(5, ['m-new', 'm-older']));
    writeFileSync(join(cat, 'desktop-ccd.json'), file(9, ['desktop-only'], 'ccd'));
    const m = claudeCatalog(dir);
    expect(m.map((x) => x.id)).toEqual(['m-new', 'm-older']);
    expect(m[0]).toMatchObject({
      main: true,
      levels: ['low', 'high'],
      defaultLevel: 'high',
      description: 'd-m-new',
    });
    expect(m[1]!.main).toBe(false);
    expect(claudeCatalog(join(dir, 'none'))).toEqual([]);
  });
  it('reads Codex’s list without the models it hides', () => {
    const dir = mkdtempSync(join(tmpdir(), 'kv-'));
    writeFileSync(
      join(dir, 'models_cache.json'),
      JSON.stringify({
        models: [
          {
            slug: 'a',
            display_name: 'A',
            visibility: 'list',
            default_reasoning_level: 'medium',
            supported_reasoning_levels: [{ effort: 'low' }, { effort: 'high' }],
          },
          { slug: 'h', display_name: 'H', visibility: 'hide' },
        ],
      }),
    );
    expect(codexCatalog(dir)).toMatchObject([
      { id: 'a', name: 'A', levels: ['low', 'high'], defaultLevel: 'medium' },
    ]);
  });
});

describe('accounts the terminal offers', () => {
  it("adds this computer's own sign-in, once, and reads the app's home account as it", () => {
    const dir = mkdtempSync(join(tmpdir(), 'kovan-eng-'));
    writeFileSync(
      join(dir, 'agent-accounts.json'),
      JSON.stringify([
        { id: 'w1', harness: 'claude-code', name: 'Work' },
        { id: 'h1', harness: 'codex', name: 'This computer', home: true },
      ]),
    );
    expect(engineAccounts(dir)).toEqual([
      { id: 'w1', name: 'Work' },
      { id: null, name: 'this computer' },
    ]);
    // The app's "this computer" account runs with no folder of its own.
    expect(engineAccounts(dir, 'codex')).toEqual([{ id: null, name: 'This computer' }]);
    expect(claudeEnv(dir, null)).toEqual({});
    rmSync(dir, { recursive: true, force: true });
  });
});
