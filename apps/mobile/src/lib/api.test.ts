import { afterEach, describe, expect, it, vi } from 'vitest';
import { request, TIMEOUT_MS } from './api';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('request', () => {
  it("says the server didn't answer when a request hangs", async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', (_url: string, init: { signal: AbortSignal }) => {
      return new Promise((_resolve, reject) =>
        init.signal.addEventListener('abort', () => reject(new Error('aborted'))),
      );
    });
    const pending = request('https://kovan.example', 't', 'GET', '/api/me');
    const caught = expect(pending).rejects.toMatchObject({
      status: 0,
      message: "kovan.example didn't answer. Check your connection and try again.",
    });
    await vi.advanceTimersByTimeAsync(TIMEOUT_MS);
    await caught;
  });

  it("explains a proxy's error page instead of a JSON error", async () => {
    vi.stubGlobal('fetch', async () => new Response('<html>Bad Gateway</html>', { status: 502 }));
    await expect(request('https://kovan.example', 't', 'GET', '/api/me')).rejects.toMatchObject({
      status: 502,
      code: 'unavailable',
      message: 'kovan.example is unavailable right now (HTTP 502). Try again in a moment.',
    });
  });

  it('passes the server’s own error message through', async () => {
    vi.stubGlobal(
      'fetch',
      async () =>
        new Response(JSON.stringify({ error: { code: 'forbidden', message: 'Not yours' } }), {
          status: 403,
        }),
    );
    await expect(request('https://kovan.example', 't', 'GET', '/api/x')).rejects.toMatchObject({
      status: 403,
      code: 'forbidden',
      message: 'Not yours',
    });
  });
});
