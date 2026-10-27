import type { LaneEvent, PresenceEntry, ServerMessage, User, Workspace } from '@kovan/shared';
import { safeStorage, shell } from 'electron';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ConnectionState } from '../shared/api.js';

const POLL_MS = 1500;
const MAX_BACKOFF_MS = 30_000;
/** Lane events go out in small batches: often enough to look live, few enough to be cheap. */
const LANE_BATCH_MS = 120;
const LANE_BATCH_MAX = 200;
/** What a lane keeps while offline; the agent keeps working and catches the team up later. */
const LANE_OUTBOX_MAX = 5000;
const LANE_BATCH_BYTES = 400_000;
const LANE_FIELD_MAX = 20_000;

/** Long strings (tool output, file contents) are cut before they leave the machine. */
function clipEvent<T>(value: T): T {
  if (typeof value === 'string')
    return (value.length > LANE_FIELD_MAX ? `${value.slice(0, LANE_FIELD_MAX)}\n…` : value) as T;
  if (Array.isArray(value)) return value.map(clipEvent) as T;
  if (value && typeof value === 'object')
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, clipEvent(v)])) as T;
  return value;
}

export class BrainError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
  ) {
    super(message);
    this.name = 'BrainError';
  }
}

export interface BrainEvents {
  user(user: User | null): void;
  connection(state: ConnectionState): void;
  message(message: ServerMessage): void;
}

/**
 * The desktop side of the Brain: the session token (kept in the OS keychain via safeStorage),
 * REST calls, the browser sign-in hand-off and the realtime socket. Everything fails open:
 * without the server the app keeps working locally and reconnects on its own.
 */
export class BrainClient {
  private token: string | null = null;
  private user: User | null = null;
  private socket: WebSocket | null = null;
  private state: ConnectionState = 'offline';
  private backoff = 1000;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private loginAbort: AbortController | null = null;
  private presence: { workspaceId: string | null; status: 'active' | 'idle' } = {
    workspaceId: null,
    status: 'active',
  };
  private subscriptions = new Set<string>();
  /** How far each workspace's changes were received, to get what was missed after a reconnect. */
  private readonly cursors = new Map<string, { epoch: string; seq: number }>();
  /** Latest presence per workspace, for the agents' team context. */
  private readonly teamPresence = new Map<string, PresenceEntry[]>();
  /** Sessions this machine follows live; followed again after a reconnect. */
  private readonly sessionSubs = new Map<string, number>();
  /** This machine's lane events waiting to go out, per session. */
  private readonly outbox = new Map<string, { events: LaneEvent[]; touched: Set<string> }>();
  private outboxTimer: NodeJS.Timeout | null = null;
  machineId = '';

  constructor(
    readonly serverUrl: string,
    private readonly dataDir: string,
    private readonly events: BrainEvents,
    private readonly appVersion: string,
  ) {}

  /**
   * Kovan's managed model endpoint and the token that bills this person, when signed in. Only
   * this app's own model client uses it; it is never handed to agents or tools.
   */
  managedEndpoint(): { baseUrl: string; token: string } | null {
    if (!this.token) return null;
    return { baseUrl: `${this.serverUrl.replace(/\/$/, '')}/api/inference/v1`, token: this.token };
  }

  private get tokenFile() {
    return join(this.dataDir, 'session.bin');
  }

  async init(): Promise<void> {
    const idFile = join(this.dataDir, 'machine-id');
    this.machineId = (await readFile(idFile, 'utf8').catch(() => '')).trim();
    if (!this.machineId) {
      this.machineId = randomUUID();
      await writeFile(idFile, this.machineId);
    }
    if (safeStorage.isEncryptionAvailable()) {
      const stored = await readFile(this.tokenFile).catch(() => null);
      if (stored) {
        try {
          this.token = safeStorage.decryptString(stored);
        } catch {
          await rm(this.tokenFile, { force: true });
        }
      }
    }
    if (this.token) {
      // Load the account without blocking start-up; offline is fine.
      void this.refreshUser().then(
        () => this.connect(),
        () => this.connect(),
      );
    }
  }

  status() {
    return {
      serverUrl: this.serverUrl,
      signedIn: this.token !== null,
      user: this.user,
      connection: this.state,
    };
  }

  private async saveToken(token: string | null): Promise<void> {
    this.token = token;
    if (!token) {
      await rm(this.tokenFile, { force: true });
      return;
    }
    // Without OS encryption the token lives only in memory for this run.
    if (safeStorage.isEncryptionAvailable())
      await writeFile(this.tokenFile, safeStorage.encryptString(token));
  }

  private setUser(user: User | null): void {
    this.user = user;
    this.events.user(user);
  }

  private setState(state: ConnectionState): void {
    if (this.state === state) return;
    this.state = state;
    this.events.connection(state);
  }

  /** Calls the Brain's REST API as the signed-in user. */
  async request<T = unknown>(
    method: string,
    path: string,
    body?: unknown,
    options: { fence?: string } = {},
  ): Promise<T> {
    if (!path.startsWith('/api/')) throw new Error('Only /api/ paths can be requested');
    if (!this.token) throw new BrainError('Sign in to use team features', 401, 'unauthorized');
    let response: Response;
    try {
      response = await fetch(this.serverUrl + path, {
        method,
        headers: {
          Authorization: `Bearer ${this.token}`,
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
          // The run of a swarm this request belongs to; refused once it is stale.
          ...(options.fence ? { 'x-kovan-fence': options.fence } : {}),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(15_000),
      });
    } catch {
      throw new BrainError(
        "Can't reach the Kovan server. Your local work is unaffected.",
        0,
        'offline',
      );
    }
    if (response.status === 204) return undefined as T;
    const data = (await response.json().catch(() => ({}))) as {
      error?: { code: string; message: string };
    };
    if (!response.ok) {
      if (response.status === 401) await this.signedOut();
      throw new BrainError(
        data.error?.message ?? `Request failed (${response.status})`,
        response.status,
        data.error?.code ?? 'error',
      );
    }
    return data as T;
  }

  async refreshUser(): Promise<User | null> {
    const { user } = await this.request<{ user: User }>('GET', '/api/me');
    this.setUser(user);
    return user;
  }

  /**
   * Opens the browser to sign in (or, with "link", to connect another account) and waits until
   * the browser part is done. The token is collected with a secret only this process knows.
   */
  async login(intent: 'login' | 'link'): Promise<User> {
    this.loginAbort?.abort();
    const abort = new AbortController();
    this.loginAbort = abort;
    const secret = randomBytes(32).toString('base64url');
    const secretHash = createHash('sha256').update(secret).digest('base64url');

    let start: Response;
    try {
      start = await fetch(`${this.serverUrl}/auth/desktop/start`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(intent === 'link' && this.token ? { Authorization: `Bearer ${this.token}` } : {}),
        },
        body: JSON.stringify({ secretHash, intent, machineId: this.machineId }),
        signal: AbortSignal.timeout(15_000),
      });
    } catch {
      throw new BrainError(`Can't reach the Kovan server at ${this.serverUrl}`, 0, 'offline');
    }
    if (!start.ok)
      throw new BrainError(
        `Could not start signing in (${start.status})`,
        start.status,
        'start_failed',
      );
    const { loginId, url, expiresInSeconds } = (await start.json()) as {
      loginId: string;
      url: string;
      expiresInSeconds: number;
    };
    // Dev end-to-end checks finish the browser part themselves instead of opening a browser.
    if (process.env['KOVAN_E2E_NO_BROWSER'] && !process.env['NODE_ENV']?.startsWith('prod'))
      console.log(`[e2e] sign-in url ${url}`);
    else await shell.openExternal(url);

    const deadline = Date.now() + expiresInSeconds * 1000;
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, POLL_MS));
      if (abort.signal.aborted) throw new BrainError('Sign-in cancelled', 0, 'cancelled');
      let result: { status: string; token?: string | null; user?: User | null; error?: string };
      try {
        const res = await fetch(`${this.serverUrl}/auth/desktop/poll`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ loginId, secret }),
          signal: AbortSignal.timeout(10_000),
        });
        if (!res.ok) throw new BrainError('Sign-in expired. Try again.', res.status, 'expired');
        result = (await res.json()) as typeof result;
      } catch (error) {
        if (error instanceof BrainError) throw error;
        continue; // A blip while waiting; keep polling.
      }
      if (result.status === 'pending') continue;
      if (result.status === 'failed')
        throw new BrainError(result.error ?? 'Sign-in failed', 0, 'failed');
      if (intent === 'login' && result.token) {
        await this.saveToken(result.token);
        this.connect();
      }
      const user = intent === 'link' ? await this.refreshUser() : result.user;
      if (!user) throw new BrainError('Sign-in finished without an account', 0, 'failed');
      this.setUser(user);
      return user;
    }
    throw new BrainError('Sign-in expired. Try again.', 0, 'expired');
  }

  cancelLogin(): void {
    this.loginAbort?.abort();
  }

  async logout(): Promise<void> {
    const token = this.token;
    if (token) {
      await fetch(`${this.serverUrl}/auth/logout`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
      }).catch(() => undefined);
    }
    await this.signedOut();
  }

  private async signedOut(): Promise<void> {
    await this.saveToken(null);
    this.disconnect();
    this.subscriptions.clear();
    this.setUser(null);
  }

  // ---------- realtime ----------

  private connect(): void {
    if (!this.token || this.socket) return;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.setState('connecting');
    const socket = new WebSocket(this.serverUrl.replace(/^http/, 'ws') + '/ws');
    this.socket = socket;
    socket.onopen = () => {
      socket.send(
        JSON.stringify({
          type: 'hello',
          token: this.token,
          machineId: this.machineId,
          clientVersion: this.appVersion,
        }),
      );
    };
    socket.onmessage = (event) => {
      let message: ServerMessage;
      try {
        message = JSON.parse(String(event.data)) as ServerMessage;
      } catch {
        return;
      }
      if (message.type === 'welcome') {
        this.backoff = 1000;
        this.setUser(message.user);
        this.setState('online');
        void this.resubscribe();
      }
      if (message.type === 'subscribed') {
        this.cursors.set(message.workspaceId, { epoch: message.epoch, seq: message.seq });
        // What was missed is gone (or the server restarted): the app reads this workspace again.
        if (message.resync)
          this.events.message({ type: 'resync', workspaceId: message.workspaceId });
        // Replayed changes follow, each moving the cursor; it starts where this app left off.
        if (message.replayed) {
          const at = this.cursors.get(message.workspaceId)!;
          at.seq = message.seq - message.replayed;
        }
      }
      const seq = (message as { seq?: unknown; seqWorkspace?: unknown }).seq;
      const of = (message as { seqWorkspace?: unknown }).seqWorkspace;
      if (typeof seq === 'number' && typeof of === 'string') {
        const at = this.cursors.get(of);
        if (at && seq > at.seq) at.seq = seq;
      }
      if (message.type === 'user') this.setUser(message.user);
      if (message.type === 'presence') this.teamPresence.set(message.workspaceId, message.online);
      if (
        message.type === 'membership' &&
        message.role &&
        !this.subscriptions.has(message.workspaceId)
      ) {
        this.subscribe(message.workspaceId);
      }
      this.events.message(message);
    };
    socket.onclose = (event) => {
      this.socket = null;
      this.setState('offline');
      if (event.code === 4401) {
        void this.signedOut();
        return;
      }
      if (!this.token) return;
      const delay = Math.min(MAX_BACKOFF_MS, this.backoff) * (0.8 + Math.random() * 0.4);
      this.backoff = Math.min(MAX_BACKOFF_MS, this.backoff * 2);
      this.reconnectTimer = setTimeout(() => this.connect(), delay);
    };
  }

  private disconnect(): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    const socket = this.socket;
    this.socket = null;
    socket?.close();
    this.setState('offline');
  }

  /** After (re)connecting, follow every workspace the user belongs to. */
  private async resubscribe(): Promise<void> {
    try {
      const { workspaces } = await this.request<{ workspaces: Workspace[] }>(
        'GET',
        '/api/workspaces',
      );
      this.subscriptions = new Set(workspaces.map((w) => w.id));
    } catch {
      // Keep whatever we had.
    }
    for (const id of this.subscriptions) {
      const since = this.cursors.get(id);
      this.send({ type: 'subscribe', workspaceId: id, ...(since ? { since } : {}) });
    }
    this.send({ type: 'presence', ...this.presence });
    // A fresh snapshot of each followed session replaces whatever was missed, then lane events
    // written while offline go out.
    for (const sessionId of this.sessionSubs.keys())
      this.send({ type: 'session.subscribe', sessionId });
    this.flushOutbox();
  }

  /** Follows a session live (counted, so two views of one session share a subscription). */
  followSession(sessionId: string): void {
    const n = this.sessionSubs.get(sessionId) ?? 0;
    this.sessionSubs.set(sessionId, n + 1);
    // Every new view asks for a snapshot, even when the session is already followed.
    this.send({ type: 'session.subscribe', sessionId });
  }

  unfollowSession(sessionId: string): void {
    const n = (this.sessionSubs.get(sessionId) ?? 0) - 1;
    if (n > 0) {
      this.sessionSubs.set(sessionId, n);
      return;
    }
    this.sessionSubs.delete(sessionId);
    this.send({ type: 'session.unsubscribe', sessionId });
  }

  /** Guidance for someone's running lane (the Brain passes it to their machine). */
  steer(sessionId: string, laneUserId: string, id: string, text: string): boolean {
    if (this.state !== 'online') return false;
    this.send({ type: 'lane.steer', sessionId, laneUserId, id, text });
    return true;
  }

  /**
   * Queues one of this machine's lane events for the team: the person's own lane, or an AI
   * teammate's lane this machine runs.
   */
  laneEvent(sessionId: string, event: LaneEvent, touched: string[], agentId?: string): void {
    const key = agentId ? `${sessionId}|${agentId}` : sessionId;
    let box = this.outbox.get(key);
    if (!box) this.outbox.set(key, (box = { events: [], touched: new Set() }));
    // A newer view of an edit being typed replaces the one still waiting to go out.
    const last = box.events.at(-1);
    if (
      event.type === 'tool_progress' &&
      last?.type === 'tool_progress' &&
      last['id'] === event['id']
    )
      box.events[box.events.length - 1] = event;
    else box.events.push(event);
    for (const t of touched) box.touched.add(t);
    if (box.events.length > LANE_OUTBOX_MAX)
      box.events.splice(0, box.events.length - LANE_OUTBOX_MAX);
    this.outboxTimer ??= setTimeout(() => {
      this.outboxTimer = null;
      this.flushOutbox();
    }, LANE_BATCH_MS);
  }

  private flushOutbox(): void {
    if (this.state !== 'online' || this.socket?.readyState !== WebSocket.OPEN) return;
    for (const [key, box] of this.outbox) {
      const [sessionId, agentId] = key.split('|') as [string, string | undefined];
      while (box.events.length) {
        // Batches stay well under the server's message limit, whatever the tool output.
        const events: LaneEvent[] = [];
        let size = 0;
        while (box.events.length && events.length < LANE_BATCH_MAX) {
          const next = clipEvent(box.events[0]!);
          const length = JSON.stringify(next).length;
          if (events.length && size + length > LANE_BATCH_BYTES) break;
          events.push(next);
          box.events.shift();
          size += length;
        }
        const touched = [...box.touched].slice(0, 200);
        box.touched.clear();
        this.send({
          type: 'lane.events',
          sessionId,
          events,
          touched,
          ...(agentId ? { agentId } : {}),
        });
      }
      this.outbox.delete(key);
    }
  }

  presenceOf(workspaceId: string): PresenceEntry[] {
    return this.teamPresence.get(workspaceId) ?? [];
  }

  /** Follows a workspace's presence and changes. Repeat calls are no-ops. */
  subscribe(workspaceId: string): void {
    if (this.subscriptions.has(workspaceId)) return;
    this.subscriptions.add(workspaceId);
    this.send({ type: 'subscribe', workspaceId });
  }

  setPresence(workspaceId: string | null, status: 'active' | 'idle'): void {
    this.presence = { workspaceId, status };
    this.send({ type: 'presence', workspaceId, status });
  }

  private send(message: object): void {
    if (this.socket?.readyState === WebSocket.OPEN && this.state === 'online')
      this.socket.send(JSON.stringify(message));
  }

  /** Sends a crash or failure report when signed in and the person allows it. Never prompts or code. */
  async reportError(
    source: 'main' | 'renderer',
    message: string,
    stack: string | null,
  ): Promise<void> {
    if (!this.token || !this.user?.errorReports) return;
    await this.request('POST', '/api/error-reports', {
      source,
      message: message.slice(0, 2000),
      stack: stack?.slice(0, 20_000) ?? null,
      appVersion: this.appVersion,
      platform: process.platform,
    }).catch(() => undefined);
  }
}
