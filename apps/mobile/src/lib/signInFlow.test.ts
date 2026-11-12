import { createHash, randomBytes } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { normalizeServer } from './api';
import { base64url, pollSignIn, startSignIn, toBase64Url } from './signInFlow';

const nodeCrypto = {
  randomBytes: (n: number) => new Uint8Array(randomBytes(n)),
  sha256Base64: async (text: string) => createHash('sha256').update(text).digest('base64'),
};

afterEach(() => vi.unstubAllGlobals());

describe('base64url', () => {
  it('matches Node for every length', () => {
    for (let n = 0; n < 40; n++) {
      const bytes = new Uint8Array(randomBytes(n));
      expect(base64url(bytes)).toBe(Buffer.from(bytes).toString('base64url'));
    }
  });
});

describe('sign-in', () => {
  it('sends the hash the server checks the secret against, and returns the token once', async () => {
    const calls: { path: string; body: Record<string, unknown> }[] = [];
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
      const path = new URL(url).pathname;
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      calls.push({ path, body });
      const json =
        path === '/auth/desktop/start'
          ? { loginId: 'L1', url: 'https://k.test/auth/start?login=L1', expiresInSeconds: 600 }
          : { status: 'complete', token: 'tok', user: { id: 'u1', name: 'alice' } };
      return new Response(JSON.stringify(json), { status: 200 });
    });
    const pending = await startSignIn('https://k.test', nodeCrypto, 'kovan://signed-in');
    // The server stores sha256(secret) as base64url and compares the same way.
    const expected = createHash('sha256').update(pending.secret).digest('base64url');
    expect(calls[0]!.body).toEqual({
      secretHash: expected,
      intent: 'login',
      machineId: null,
      returnTo: 'kovan://signed-in',
    });
    expect(pending.url).toContain('login=L1');
    const done = await pollSignIn('https://k.test', pending);
    expect(done).toEqual({ status: 'complete', token: 'tok', user: { id: 'u1', name: 'alice' } });
    expect(calls[1]!.body).toEqual({ loginId: 'L1', secret: pending.secret });
  });

  it('gives up on an expired sign-in without asking the server', async () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    const result = await pollSignIn('https://k.test', {
      loginId: 'L',
      url: '',
      secret: 's',
      code: null,
      expiresAt: Date.now() - 1,
    });
    expect(result.status).toBe('failed');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('turns base64 into base64url', () => {
    expect(toBase64Url('a+b/c==')).toBe('a-b_c');
  });
});

describe('normalizeServer', () => {
  it('adds https and drops trailing slashes', () => {
    expect(normalizeServer('kovan.example.com/')).toBe('https://kovan.example.com');
    expect(normalizeServer(' http://192.168.1.5:4807 ')).toBe('http://192.168.1.5:4807');
    expect(normalizeServer('')).toBeNull();
    expect(normalizeServer('ftp://x')).toBeNull();
  });
});
