import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (s: string) => Buffer.from(`enc:${s}`),
    decryptString: (b: Buffer) => b.toString().replace(/^enc:/, ''),
  },
}));

const { CustomProviders, normalizeBaseUrl } = await import('./customProviders.js');

describe('normalizeBaseUrl', () => {
  it('accepts what people paste', () => {
    expect(normalizeBaseUrl('http://localhost:11434')).toBe('http://localhost:11434/v1');
    expect(normalizeBaseUrl(' https://api.example.com/v1/ ')).toBe('https://api.example.com/v1');
    expect(normalizeBaseUrl('https://gw.corp/openai/v1')).toBe('https://gw.corp/openai/v1');
    expect(() => normalizeBaseUrl('file:///etc/passwd')).toThrow('http');
  });
});

describe('CustomProviders', () => {
  let dir: string;
  const seen: { url: string; auth: string | null }[] = [];

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'kovan-custom-'));
    seen.length = 0;
    vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
      const headers = (init?.headers ?? {}) as Record<string, string>;
      seen.push({ url, auth: headers['Authorization'] ?? null });
      if (url.startsWith('http://down')) throw new Error('connect ECONNREFUSED');
      return new Response(
        JSON.stringify({ data: [{ id: 'qwen3-coder:30b' }, { id: 'llama3.3' }] }),
      );
    });
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    await rm(dir, { recursive: true, force: true });
  });

  it('checks, saves and lists a provider with its models under its prefix', async () => {
    const store = new CustomProviders(dir);
    const list = await store.save({
      name: 'Local Ollama',
      baseUrl: 'http://localhost:11434',
      apiKey: 'secret',
    });
    expect(list).toEqual([
      {
        id: 'local-ollama',
        name: 'Local Ollama',
        baseUrl: 'http://localhost:11434/v1',
        hasKey: true,
        models: ['@local-ollama/qwen3-coder:30b', '@local-ollama/llama3.3'],
        fetchedAt: expect.any(Number),
      },
    ]);
    expect(seen[0]).toEqual({ url: 'http://localhost:11434/v1/models', auth: 'Bearer secret' });
    // The key is in the encrypted file only, never in the provider list.
    expect(await readFile(join(dir, 'custom-providers.json'), 'utf8')).not.toContain('secret');
    expect((await readFile(join(dir, 'custom-provider-keys.bin'))).toString()).toContain('enc:');

    // A fresh instance reads it all back, and resolves a model to the server's own id.
    const again = new CustomProviders(dir);
    expect((await again.models()).map((m) => m.provider)).toEqual(['Local Ollama', 'Local Ollama']);
    const resolved = await again.resolve('@local-ollama/qwen3-coder:30b');
    expect(resolved?.model).toBe('qwen3-coder:30b');
    expect(await again.resolve('openai/gpt-5.6-luna')).toBeNull();
  });

  it('keeps the key on edit unless told otherwise, and gives new providers unique ids', async () => {
    const store = new CustomProviders(dir);
    await store.save({ name: 'Ollama', baseUrl: 'http://localhost:11434', apiKey: 'k1' });
    await store.save({ id: 'ollama', name: 'Ollama', baseUrl: 'http://127.0.0.1:11434' });
    expect(seen.at(-1)).toEqual({ url: 'http://127.0.0.1:11434/v1/models', auth: 'Bearer k1' });
    let list = await store.save({
      id: 'ollama',
      name: 'Ollama',
      baseUrl: 'http://x',
      apiKey: null,
    });
    expect(list[0]!.hasKey).toBe(false);
    list = await store.save({ name: 'Ollama', baseUrl: 'http://localhost:1234' });
    expect(list.map((p) => p.id)).toEqual(['ollama', 'ollama-2']);
    list = await store.remove('ollama');
    expect(list.map((p) => p.id)).toEqual(['ollama-2']);
  });

  it("doesn't save a provider it can't reach", async () => {
    const store = new CustomProviders(dir);
    await expect(store.save({ name: 'Down', baseUrl: 'http://down:1' })).rejects.toThrow(
      "Down didn't list its models",
    );
    expect(await store.list()).toEqual([]);
  });
});
