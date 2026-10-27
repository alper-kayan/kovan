import type { ServerMessage } from '@kovan/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEAD_MS, Live, QUIET_MS, type Connection, type LiveOptions } from './realtime';

class FakeSocket {
  readyState = 0;
  sent: Record<string, unknown>[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: ((event: { code: number }) => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(readonly url: string) {}
  send(data: string) {
    this.sent.push(JSON.parse(data) as Record<string, unknown>);
  }
  close() {
    this.readyState = 3;
  }
  open() {
    this.readyState = 1;
    this.onopen?.();
  }
  receive(message: ServerMessage) {
    this.onmessage?.({ data: JSON.stringify(message) });
  }
  drop(code = 1006) {
    this.readyState = 3;
    this.onclose?.({ code });
  }
}

const welcome: ServerMessage = {
  type: 'welcome',
  user: {
    id: 'u',
    name: 'Alice',
    email: null,
    emailVerified: true,
    avatarUrl: null,
    githubLogin: null,
    onboarding: {},
    errorReports: false,
  },
};

let sockets: FakeSocket[];
let states: Connection[];
let options: LiveOptions;
const types = (s: FakeSocket) => s.sent.map((m) => m['type']);

beforeEach(() => {
  vi.useFakeTimers();
  sockets = [];
  states = [];
  options = {
    server: 'https://kovan.example',
    token: 'kvn_t',
    version: '1',
    open: (url) => {
      const s = new FakeSocket(url);
      sockets.push(s);
      return s;
    },
    onMessage: vi.fn(),
    onOnline: vi.fn(),
    onConnection: (s) => states.push(s),
    onUnauthorized: vi.fn(),
  };
});
afterEach(() => vi.useRealTimers());

describe('the live connection', () => {
  it('says hello as a phone and sends nothing else until the server welcomes it', () => {
    const live = new Live(options);
    live.followWorkspaces(['w1']);
    live.start('mobile-1');
    const s = sockets[0]!;
    expect(s.url).toBe('wss://kovan.example/ws');
    s.open();
    live.followSession('s1');
    expect(s.sent).toEqual([
      {
        type: 'hello',
        token: 'kvn_t',
        machineId: 'mobile-1',
        clientVersion: '1',
        client: 'mobile',
      },
    ]);
    s.receive(welcome);
    expect(types(s)).toEqual(['hello', 'subscribe', 'session.subscribe']);
    expect(states.at(-1)).toBe('online');
    expect(options.onOnline).toHaveBeenCalledTimes(1);
  });

  it('reconnects with backoff and follows the same things again', () => {
    const live = new Live(options);
    live.start('m');
    sockets[0]!.open();
    sockets[0]!.receive(welcome);
    live.followWorkspaces(['w1', 'w2']);
    const stop = live.followSession('s1');
    sockets[0]!.drop();
    expect(states.at(-1)).toBe('offline');

    vi.advanceTimersByTime(999);
    expect(sockets).toHaveLength(1);
    vi.advanceTimersByTime(1);
    const again = sockets[1]!;
    again.open();
    again.receive(welcome);
    expect(again.sent.slice(1)).toEqual([
      { type: 'subscribe', workspaceId: 'w1' },
      { type: 'subscribe', workspaceId: 'w2' },
      { type: 'session.subscribe', sessionId: 's1' },
    ]);

    // A second screen on the same session shares it; the last one out unsubscribes.
    const second = live.followSession('s1');
    live.snapshot('s1');
    expect(again.sent.at(-1)).toEqual({ type: 'session.subscribe', sessionId: 's1' });
    stop();
    expect(types(again)).not.toContain('session.unsubscribe');
    second();
    expect(again.sent.at(-1)).toEqual({ type: 'session.unsubscribe', sessionId: 's1' });
    live.followWorkspaces(['w2']);
    expect(again.sent.at(-1)).toEqual({ type: 'unsubscribe', workspaceId: 'w1' });
  });

  it('notices a socket that went silent, and checks the line when the app comes back', () => {
    const live = new Live(options);
    live.start('m');
    const first = sockets[0]!;
    first.open();
    first.receive(welcome);
    // Quiet for a while: it asks; an answer keeps the line.
    vi.advanceTimersByTime(QUIET_MS + 5000);
    expect(first.sent.at(-1)).toEqual({ type: 'ping' });
    first.receive({ type: 'pong' });
    vi.advanceTimersByTime(QUIET_MS - 5000);
    expect(sockets).toHaveLength(1);
    // No answer: the socket is given up (without waiting for a close) and a new one opens.
    vi.advanceTimersByTime(DEAD_MS);
    expect(first.readyState).toBe(3);
    expect(states).toContain('offline');
    expect(sockets).toHaveLength(2);

    // Back in the foreground with a socket that looks open: asked at once, replaced if silent.
    const second = sockets[1]!;
    second.open();
    second.receive(welcome);
    live.wake();
    expect(second.sent.at(-1)).toEqual({ type: 'ping' });
    vi.advanceTimersByTime(10_000);
    expect(second.readyState).toBe(3);
    live.stop();
  });

  it('stops for good when the server refuses the token', () => {
    const live = new Live(options);
    live.start('m');
    sockets[0]!.open();
    sockets[0]!.drop(4401);
    vi.advanceTimersByTime(60_000);
    expect(sockets).toHaveLength(1);
    expect(options.onUnauthorized).toHaveBeenCalled();
    live.wake();
    expect(sockets).toHaveLength(1);
  });

  it('comes straight back when the app wakes up instead of waiting out the backoff', () => {
    const live = new Live(options);
    live.start('m');
    for (let i = 0; i < 4; i++) {
      sockets.at(-1)!.drop();
      vi.advanceTimersByTime(20_000);
    }
    const count = sockets.length;
    sockets.at(-1)!.drop();
    live.wake();
    expect(sockets).toHaveLength(count + 1);
  });
});
