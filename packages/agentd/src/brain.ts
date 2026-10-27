import type { LaneEvent, ServerMessage } from '@kovan/shared';

type Method = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';

export class BrainError extends Error {
  constructor(
    readonly status: number,
    message: string,
    /** The Brain's error code ("stale_run", "conflict", …). */
    readonly code = 'error',
  ) {
    super(message);
  }
}

const BATCH_MS = 150;
const BATCH_MAX = 200;
const BATCH_BYTES = 400_000;
const FIELD_MAX = 20_000;
/** What a lane keeps while the connection is down; the agent keeps working meanwhile. */
const OUTBOX_MAX = 5_000;

/** Long strings (tool output, file contents) are cut before they leave the machine. */
function clip<T>(value: T): T {
  if (typeof value === 'string')
    return (value.length > FIELD_MAX ? `${value.slice(0, FIELD_MAX)}\n…` : value) as T;
  if (Array.isArray(value)) return value.map(clip) as T;
  if (value && typeof value === 'object')
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, clip(v)])) as T;
  return value;
}

/**
 * The Brain as agentd talks to it: requests with its API key, and one live connection that
 * carries its agents' lanes out and the team's changes in. The connection comes back by
 * itself; lane events wait in an outbox meanwhile.
 */
export class Brain {
  private socket: WebSocket | null = null;
  private open = false;
  private closed = false;
  private retry = 1_000;
  private readonly outbox = new Map<string, { events: LaneEvent[]; touched: Set<string> }>();
  private timer: NodeJS.Timeout | null = null;
  private readonly workspaces = new Set<string>();

  constructor(
    private readonly serverUrl: string,
    private readonly apiKey: string,
    private readonly machineName: string,
    private readonly onMessage: (message: ServerMessage) => void,
    private readonly log: (line: string) => void,
  ) {}

  async request<T = unknown>(
    method: Method,
    path: string,
    body?: unknown,
    options: { fence?: string } = {},
  ): Promise<T> {
    const res = await fetch(`${this.serverUrl}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${this.apiKey}`,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        // The run of a swarm this request belongs to; refused once it is stale.
        ...(options.fence ? { 'x-kovan-fence': options.fence } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(60_000),
    });
    const text = await res.text();
    const data = text ? (JSON.parse(text) as unknown) : null;
    if (!res.ok) {
      const error = (data as { error?: { message?: string; code?: string } } | null)?.error;
      throw new BrainError(res.status, error?.message ?? `HTTP ${res.status}`, error?.code);
    }
    return data as T;
  }

  /** Follows a workspace live (its swarms, plans and chat). */
  follow(workspaceId: string): void {
    if (this.workspaces.has(workspaceId)) return;
    this.workspaces.add(workspaceId);
    if (this.open) this.send({ type: 'subscribe', workspaceId });
  }

  connect(): void {
    if (this.closed) return;
    const url = `${this.serverUrl.replace(/^http/, 'ws')}/ws`;
    const socket = new WebSocket(url);
    this.socket = socket;
    socket.addEventListener('open', () => {
      socket.send(
        JSON.stringify({
          type: 'hello',
          token: this.apiKey,
          machineId: `agentd:${this.machineName}`,
          clientVersion: 'agentd',
          client: 'desktop',
        }),
      );
    });
    socket.addEventListener('message', (e) => {
      let message: ServerMessage;
      try {
        message = JSON.parse(String(e.data)) as ServerMessage;
      } catch {
        return;
      }
      if (message.type === 'welcome') {
        this.open = true;
        this.retry = 1_000;
        for (const id of this.workspaces) this.send({ type: 'subscribe', workspaceId: id });
        this.flush();
        return;
      }
      this.onMessage(message);
    });
    socket.addEventListener('close', (e) => {
      this.open = false;
      if (this.closed) return;
      if (e.code === 4401) this.log('The server refused the API key: is it revoked?');
      setTimeout(() => this.connect(), this.retry);
      this.retry = Math.min(this.retry * 2, 30_000);
    });
    socket.addEventListener('error', () => undefined);
  }

  close(): void {
    this.closed = true;
    this.flush();
    this.socket?.close();
  }

  /** An AI teammate's lane event (this machine runs it); sent in small batches. */
  laneEvent(sessionId: string, event: LaneEvent, touched: string[], agentId: string): void {
    const key = `${sessionId}|${agentId}`;
    let box = this.outbox.get(key);
    if (!box) this.outbox.set(key, (box = { events: [], touched: new Set() }));
    const last = box.events.at(-1);
    if (
      event.type === 'tool_progress' &&
      last?.type === 'tool_progress' &&
      last['id'] === event['id']
    )
      box.events[box.events.length - 1] = event;
    else box.events.push(event);
    for (const t of touched) box.touched.add(t);
    if (box.events.length > OUTBOX_MAX) box.events.splice(0, box.events.length - OUTBOX_MAX);
    this.timer ??= setTimeout(() => {
      this.timer = null;
      this.flush();
    }, BATCH_MS);
  }

  private flush(): void {
    if (!this.open) return;
    for (const [key, box] of this.outbox) {
      const [sessionId, agentId] = key.split('|') as [string, string];
      while (box.events.length) {
        const events: LaneEvent[] = [];
        let size = 0;
        while (box.events.length && events.length < BATCH_MAX) {
          const next = clip(box.events[0]!);
          const length = JSON.stringify(next).length;
          if (events.length && size + length > BATCH_BYTES) break;
          events.push(next);
          box.events.shift();
          size += length;
        }
        const touched = [...box.touched].slice(0, 200);
        box.touched.clear();
        this.send({ type: 'lane.events', sessionId, events, touched, agentId });
      }
      this.outbox.delete(key);
    }
  }

  private send(message: object): void {
    if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(message));
  }
}
