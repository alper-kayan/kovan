import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadProvider } from './config.js';
import { chooseSetup } from './setup.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'kovan-setup-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function asked(answers: (string | null)[], signIn: () => Promise<boolean> = async () => false) {
  const said: string[] = [];
  const raw: string[] = [];
  const queue = [...answers];
  const file = join(dir, 'kovan', 'agent.json');
  const done = chooseSetup({
    out: (s) => said.push(s),
    write: (s) => raw.push(s),
    readLine: async () => (queue.length ? (queue.shift() ?? null) : null),
    file,
    signIn,
  });
  return { done, said, raw, file };
}

describe('choosing a model on first run', () => {
  it('saves a pasted OpenRouter key where only its owner can read it, takes it off the screen, and uses it', async () => {
    const s = asked(['1', 'sk-or-v1-abcdefghijklmnop']);
    expect(await s.done).toBe(true);
    expect(JSON.parse(readFileSync(s.file, 'utf8'))).toEqual({
      apiKey: 'sk-or-v1-abcdefghijklmnop',
    });
    if (process.platform !== 'win32') expect(statSync(s.file).mode & 0o777).toBe(0o600);
    expect(s.raw.join('')).toContain('\x1b[2K');
    // The saved key is the model from now on.
    const p = loadProvider({}, s.file);
    expect(p.ok && p.provider.apiKey).toBe('sk-or-v1-abcdefghijklmnop');
    expect(s.said.join('\n')).not.toContain('abcdefghijklmnop');
  });

  it('asks again for something that is not an OpenRouter key', async () => {
    const s = asked(['1', 'hello', '1', 'sk-or-v1-abcdefghijklmnop']);
    expect(await s.done).toBe(true);
    expect(s.said.join('\n')).toMatch(/start with sk-or-/);
  });

  it('signs in only when that is the choice', async () => {
    let signedIn = 0;
    const s = asked(['2'], async () => {
      signedIn++;
      return true;
    });
    expect(await s.done).toBe(true);
    expect(signedIn).toBe(1);
  });

  it('keeps a gateway of your own with its model', async () => {
    const s = asked(['3', 'http://localhost:11434/v1', 'llama3', '']);
    expect(await s.done).toBe(true);
    const p = loadProvider({}, s.file);
    expect(p.ok && p.provider.baseUrl).toBe('http://localhost:11434/v1');
    expect(p.ok && p.provider.model).toBe('llama3');
  });

  it('sets nothing up, and opens nothing, when the answer is no', async () => {
    let signedIn = 0;
    const s = asked(['q'], async () => {
      signedIn++;
      return true;
    });
    expect(await s.done).toBe(false);
    expect(signedIn).toBe(0);
    expect(() => readFileSync(s.file)).toThrow();
    expect(s.said.join('\n')).toMatch(/kovan setup/);
  });
});
