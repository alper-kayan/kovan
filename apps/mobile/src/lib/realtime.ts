import type { ClientMessage, ServerMessage } from '@kovan/shared';

export type Connection = 'connecting' | 'online' | 'offline';

/** The bits of WebSocket this uses, so tests can hand in a fake one. */
interface Socket {
  readyState: number;
  onopen: (() => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: ((event: { code: number }) => void) | null;
  onerror: (() => void) | null;
  send(data: string): void;
  close(): void;
}

const OPEN = 1;
/** The server closes with these when the token is no good: sign in again, don't retry. */
const UNAUTHORIZED = 4401;
const BACKOFF_MS = [1000, 2000, 5000, 10_000, 20_000];
/**
 * A phone can't see WebSocket pings, and a socket can look open long after the network went
 * (a switch from Wi-Fi to cellular, a sleep): after this long without a word it asks, and
 * after DEAD_MS without one it starts over.
 */
export const QUIET_MS = 25_000;
export const DEAD_MS = 35_000;
const CHECK_MS = 5_000;

export interface LiveOptions {
  server: string;
  token: string;
  version: string;
  open?: (url: string) => Socket;
  onMessage(message: ServerMessage): void;
  /** After every (re)connect: the moment to reload what may have been missed. */
  onOnline(): void;
  onConnection(state: Connection): void;
  onUnauthorized(): void;
}

/**
 * One live connection to the server, as a phone: it says hello as a mobile client (no agents run
 * here), keeps the workspaces and sessions it follows across reconnects, and backs off while the
 * network is gone.
 */
export class Live {
  private socket: Socket | null = null;
  /** The server has said welcome on this socket; nothing else may be sent before. */
  private ready = false;
  private attempt = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private closed = true;
  private readonly workspaces = new Set<string>();
  private readonly sessions = new Map<string, number>();
  private machineId = '';
  private heard = 0;
  private asked = false;
  private watchdog: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly options: LiveOptions) {}

  /** What it follows may be set before: it is all sent once the server says welcome. */
  start(machineId: string): void {
    this.machineId = machineId;
    this.closed = false;
    this.watchdog ??= setInterval(() => this.check(), CHECK_MS);
    this.connect();
  }

  stop(): void {
    this.closed = true;
    if (this.watchdog) clearInterval(this.watchdog);
    this.watchdog = null;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const socket = this.socket;
    this.socket = null;
    socket?.close();
  }

  /**
   * Reconnects now, e.g. when the app comes back to the foreground. A socket that still looks
   * open is asked whether it is: without an answer in a few seconds it is replaced.
   */
  wake(): void {
    if (this.closed) return;
    if (this.socket) {
      if (!this.ready) return;
      this.heard = Math.min(this.heard, Date.now() - (DEAD_MS - CHECK_MS));
      this.ask();
      return;
    }
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.attempt = 0;
    this.connect();
  }

  followWorkspaces(ids: readonly string[]): void {
    const next = new Set(ids);
    for (const id of this.workspaces)
      if (!next.has(id)) {
        this.workspaces.delete(id);
        this.send({ type: 'unsubscribe', workspaceId: id });
      }
    for (const id of next)
      if (!this.workspaces.has(id)) {
        this.workspaces.add(id);
        this.send({ type: 'subscribe', workspaceId: id });
      }
  }

  /** Follows a session's lanes live; the server answers with a snapshot. Counted, so screens nest. */
  followSession(id: string): () => void {
    const count = this.sessions.get(id) ?? 0;
    this.sessions.set(id, count + 1);
    if (count === 0) this.send({ type: 'session.subscribe', sessionId: id });
    let done = false;
    return () => {
      if (done) return;
      done = true;
      const left = (this.sessions.get(id) ?? 1) - 1;
      if (left > 0) return void this.sessions.set(id, left);
      this.sessions.delete(id);
      this.send({ type: 'session.unsubscribe', sessionId: id });
    };
  }

  /** Asks again for a followed session's snapshot (another screen opened it and needs one). */
  snapshot(id: string): void {
    if (this.sessions.has(id)) this.send({ type: 'session.subscribe', sessionId: id });
  }

  private ask(): void {
    this.asked = true;
    this.send({ type: 'ping' });
  }

  /** Quiet for a while: ask; quiet for too long: the line is dead, start over. */
  private check(): void {
    if (this.closed || !this.ready || !this.socket) return;
    const quiet = Date.now() - this.heard;
    if (quiet >= DEAD_MS) {
      const dead = this.socket;
      this.socket = null;
      dead.close();
      this.attempt = 0;
      this.retry();
    } else if (quiet >= QUIET_MS && !this.asked) this.ask();
  }

  private send(message: ClientMessage): void {
    if (this.ready && this.socket?.readyState === OPEN) this.socket.send(JSON.stringify(message));
  }

  private connect(): void {
    const { server, token, version } = this.options;
    const machineId = this.machineId;
    const url = `${server.replace(/^http/, 'ws')}/ws`;
    this.options.onConnection('connecting');
    let socket: Socket;
    try {
      socket = this.options.open
        ? this.options.open(url)
        : (new WebSocket(url) as unknown as Socket);
    } catch {
      return this.retry();
    }
    this.socket = socket;
    this.ready = false;
    socket.onopen = () => {
      socket.send(
        JSON.stringify({
          type: 'hello',
          token,
          machineId,
          clientVersion: version,
          client: 'mobile',
        } satisfies ClientMessage),
      );
    };
    socket.onmessage = (event) => {
      this.heard = Date.now();
      this.asked = false;
      let message: ServerMessage;
      try {
        message = JSON.parse(String(event.data)) as ServerMessage;
      } catch {
        return;
      }
      if (message.type === 'pong') return;
      if (message.type === 'welcome') {
        this.attempt = 0;
        this.ready = true;
        // A fresh socket follows nothing: say again what this phone watches.
        for (const id of this.workspaces) this.send({ type: 'subscribe', workspaceId: id });
        for (const id of this.sessions.keys())
          this.send({ type: 'session.subscribe', sessionId: id });
        this.options.onConnection('online');
        this.options.onOnline();
      }
      this.options.onMessage(message);
    };
    socket.onerror = () => undefined;
    socket.onclose = (event) => {
      if (this.socket !== socket) return;
      this.socket = null;
      this.ready = false;
      if (this.closed) return;
      if (event.code === UNAUTHORIZED) {
        this.closed = true;
        this.options.onConnection('offline');
        this.options.onUnauthorized();
        return;
      }
      this.retry();
    };
  }

  private retry(): void {
    this.socket = null;
    this.ready = false;
    this.options.onConnection('offline');
    if (this.closed) return;
    const wait = BACKOFF_MS[Math.min(this.attempt, BACKOFF_MS.length - 1)]!;
    this.attempt++;
    this.timer = setTimeout(() => {
      this.timer = null;
      if (!this.closed) this.connect();
    }, wait);
  }
}
