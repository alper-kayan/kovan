import {
  ClientMessageSchema,
  type LaneEvent,
  type PresenceEntry,
  type ServerMessage,
} from '@kovan/shared';
import { randomUUID } from 'node:crypto';
import type { WebSocket } from 'ws';
import { toUser, type UserRow } from '../users.js';

const HEARTBEAT_MS = 20_000;
const HELLO_TIMEOUT_MS = 10_000;
/** Messages one socket may send per window: far above live typing and lane batches. */
export const MESSAGE_LIMIT = 2_000;
const MESSAGE_WINDOW_MS = 10_000;

/** How much of each workspace's changes is kept for apps that reconnect. */
const JOURNAL_MAX = 500;
const JOURNAL_MS = 15 * 60_000;
/** Who is online is sent whole on every change: nothing to replay. */
const NOT_JOURNALED = new Set<ServerMessage['type']>(['presence']);

interface Journal {
  seq: number;
  items: { seq: number; at: number; text: string }[];
}

/** Close codes the desktop app understands. */
export const CLOSE = { unauthorized: 4401, badMessage: 4400, timeout: 4408, flood: 4429 } as const;

interface Connection {
  socket: WebSocket;
  user: UserRow | null;
  machineId: string;
  /** Phones get everything a machine gets, but run no agents and show no presence. */
  client: 'desktop' | 'mobile';
  subscriptions: Set<string>;
  /** Sessions followed live, with the workspace each belongs to. */
  sessions: Map<string, string>;
  status: 'active' | 'idle';
  /** The workspace this machine has open. */
  openWorkspace: string | null;
  alive: boolean;
}

export interface HubDeps {
  authenticate(token: string): Promise<UserRow | null>;
  /** The caller's current role in a workspace, read fresh each time. */
  roleOf(workspaceId: string, userId: string): Promise<string | null>;
  log?: (message: string) => void;
}

/** Session messages are handled by the session service; the hub only routes them. */
export interface SessionHandler {
  snapshot(
    sessionId: string,
    userId: string,
    subscribe: (message: ServerMessage, workspaceId: string) => void,
  ): Promise<void>;
  laneEvents(
    sessionId: string,
    userId: string,
    events: LaneEvent[],
    touched: string[],
    agentId?: string,
  ): Promise<void>;
  answer(
    sessionId: string,
    userId: string,
    laneUserId: string,
    requestId: string,
    approved: boolean,
  ): Promise<unknown>;
  steer(
    sessionId: string,
    fromUserId: string,
    laneUserId: string,
    id: string,
    text: string,
  ): Promise<void>;
}

/** Errors with an HTTP-like code become `error` messages the app can show. */
function errorCode(error: unknown): { code: string; message: string } | null {
  const e = error as { code?: unknown; message?: unknown; status?: unknown };
  return typeof e.status === 'number' && typeof e.code === 'string' && typeof e.message === 'string'
    ? { code: e.code, message: e.message }
    : null;
}

/**
 * Live coordination for one server process: who is connected, which workspaces they watch, and
 * presence per workspace. Membership is checked against the database on every subscribe.
 */
export class Hub {
  private readonly connections = new Set<Connection>();
  private readonly heartbeat: NodeJS.Timeout;
  /** This process: a reconnecting app with another epoch missed everything, and resyncs. */
  readonly epoch = randomUUID();
  private readonly journals = new Map<string, Journal>();
  private sessionHandler: SessionHandler | null = null;

  constructor(private readonly deps: HubDeps) {
    this.heartbeat = setInterval(() => this.sweep(), HEARTBEAT_MS);
    this.heartbeat.unref();
  }

  attachSessions(handler: SessionHandler): void {
    this.sessionHandler = handler;
  }

  close(): void {
    clearInterval(this.heartbeat);
    for (const conn of this.connections) conn.socket.terminate();
    this.connections.clear();
  }

  handle(socket: WebSocket): void {
    const conn: Connection = {
      socket,
      user: null,
      machineId: '',
      client: 'desktop',
      subscriptions: new Set(),
      sessions: new Map(),
      status: 'active',
      openWorkspace: null,
      alive: true,
    };
    this.connections.add(conn);
    const helloTimer = setTimeout(() => {
      if (!conn.user) socket.close(CLOSE.timeout, 'No hello');
    }, HELLO_TIMEOUT_MS);

    // A socket that floods is cut off: no honest app sends this much.
    let windowStart = Date.now();
    let inWindow = 0;
    socket.on('pong', () => (conn.alive = true));
    socket.on('message', (raw) => {
      const now = Date.now();
      if (now - windowStart > MESSAGE_WINDOW_MS) {
        windowStart = now;
        inWindow = 0;
      }
      if (++inWindow > MESSAGE_LIMIT) {
        socket.close(CLOSE.flood, 'Too many messages');
        return;
      }
      void this.onMessage(conn, raw.toString()).catch((error: unknown) => {
        const known = errorCode(error);
        if (known) {
          this.send(conn, { type: 'error', ...known });
          return;
        }
        this.deps.log?.(`hub: ${error instanceof Error ? error.message : String(error)}`);
        this.send(conn, { type: 'error', code: 'internal', message: 'Something went wrong' });
      });
    });
    socket.on('close', () => {
      clearTimeout(helloTimer);
      this.connections.delete(conn);
      for (const workspaceId of conn.subscriptions) this.broadcastPresence(workspaceId);
    });
  }

  private async onMessage(conn: Connection, raw: string): Promise<void> {
    let data: unknown;
    try {
      data = JSON.parse(raw);
    } catch {
      conn.socket.close(CLOSE.badMessage, 'Bad JSON');
      return;
    }
    const parsed = ClientMessageSchema.safeParse(data);
    if (!parsed.success) {
      this.send(conn, { type: 'error', code: 'bad_message', message: 'Unknown message' });
      return;
    }
    const message = parsed.data;

    if (message.type === 'hello') {
      const user = await this.deps.authenticate(message.token);
      if (!user) {
        conn.socket.close(CLOSE.unauthorized, 'Sign in again');
        return;
      }
      conn.user = user;
      conn.machineId = message.machineId;
      conn.client = message.client;
      this.send(conn, { type: 'welcome', user: toUser(user) });
      return;
    }
    if (!conn.user) {
      conn.socket.close(CLOSE.unauthorized, 'Say hello first');
      return;
    }

    switch (message.type) {
      case 'ping':
        this.send(conn, { type: 'pong' });
        return;
      case 'subscribe': {
        const role = await this.deps.roleOf(message.workspaceId, conn.user.id);
        if (!role) {
          this.send(conn, { type: 'error', code: 'not_found', message: 'Workspace not found' });
          return;
        }
        conn.subscriptions.add(message.workspaceId);
        this.catchUp(conn, message.workspaceId, message.since);
        this.broadcastPresence(message.workspaceId);
        return;
      }
      case 'unsubscribe':
        if (conn.subscriptions.delete(message.workspaceId))
          this.broadcastPresence(message.workspaceId);
        return;
      case 'presence': {
        const before = new Set([...conn.subscriptions]);
        conn.status = message.status;
        conn.openWorkspace = message.workspaceId;
        for (const workspaceId of before) this.broadcastPresence(workspaceId);
        return;
      }
      case 'session.subscribe': {
        const user = conn.user;
        await this.sessions().snapshot(message.sessionId, user.id, (snapshot, workspaceId) => {
          conn.sessions.set(message.sessionId, workspaceId);
          this.send(conn, snapshot);
        });
        return;
      }
      case 'session.unsubscribe':
        conn.sessions.delete(message.sessionId);
        return;
      case 'lane.events':
        await this.sessions().laneEvents(
          message.sessionId,
          conn.user.id,
          message.events,
          message.touched,
          message.agentId,
        );
        return;
      case 'lane.steer':
        await this.sessions().steer(
          message.sessionId,
          conn.user.id,
          message.laneUserId,
          message.id,
          message.text,
        );
        return;
      case 'approval.answer':
        await this.sessions().answer(
          message.sessionId,
          conn.user.id,
          message.laneUserId,
          message.requestId,
          message.approved,
        );
        return;
    }
  }

  /** Who is online in a workspace: one entry per person, merged across their machines. */
  presenceOf(workspaceId: string): PresenceEntry[] {
    const byUser = new Map<string, PresenceEntry>();
    for (const conn of this.connections) {
      // Phones and machines (agentd) aren't people at a desk.
      if (
        !conn.user ||
        conn.client === 'mobile' ||
        conn.user.kind === 'service' ||
        !conn.subscriptions.has(workspaceId)
      )
        continue;
      const existing = byUser.get(conn.user.id);
      const inWorkspace = conn.openWorkspace === workspaceId;
      byUser.set(conn.user.id, {
        userId: conn.user.id,
        name: conn.user.name,
        avatarUrl: conn.user.avatarUrl,
        status: existing?.status === 'active' || conn.status === 'active' ? 'active' : 'idle',
        inWorkspace: (existing?.inWorkspace ?? false) || inWorkspace,
      });
    }
    return [...byUser.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  private broadcastPresence(workspaceId: string): void {
    this.sendWorkspace(workspaceId, {
      type: 'presence',
      workspaceId,
      online: this.presenceOf(workspaceId),
    });
  }

  sendWorkspace(workspaceId: string, message: ServerMessage): void {
    const text = this.record(workspaceId, message);
    for (const conn of this.connections) {
      if (conn.subscriptions.has(workspaceId)) this.sendText(conn, text);
    }
  }

  /**
   * Numbers a workspace change and keeps it a while, so an app that reconnects gets what it
   * missed in order. Returns the text to send (with `seq`).
   */
  private record(workspaceId: string, message: ServerMessage): string {
    if (NOT_JOURNALED.has(message.type)) return JSON.stringify(message);
    const journal = this.journals.get(workspaceId) ?? { seq: 0, items: [] };
    this.journals.set(workspaceId, journal);
    const seq = ++journal.seq;
    const text = JSON.stringify({ ...message, seq, seqWorkspace: workspaceId });
    const now = Date.now();
    journal.items.push({ seq, at: now, text });
    while (
      journal.items.length > JOURNAL_MAX ||
      (journal.items.length && now - journal.items[0]!.at > JOURNAL_MS)
    )
      journal.items.shift();
    return text;
  }

  /** A (re)subscribing app: where the journal stands, then what it missed, in order. */
  private catchUp(
    conn: Connection,
    workspaceId: string,
    since: { epoch: string; seq: number } | undefined,
  ): void {
    const journal = this.journals.get(workspaceId) ?? { seq: 0, items: [] };
    let missed: string[] = [];
    let resync = false;
    if (since) {
      const oldest = journal.items[0]?.seq ?? journal.seq + 1;
      if (since.epoch !== this.epoch || since.seq > journal.seq || since.seq + 1 < oldest)
        resync = true;
      else missed = journal.items.filter((i) => i.seq > since.seq).map((i) => i.text);
    }
    this.send(conn, {
      type: 'subscribed',
      workspaceId,
      epoch: this.epoch,
      seq: journal.seq,
      replayed: missed.length,
      resync,
    });
    for (const text of missed) this.sendText(conn, text);
  }

  private sessions(): SessionHandler {
    if (!this.sessionHandler) throw new Error('Sessions are not available');
    return this.sessionHandler;
  }

  /** To everyone following a session, plus (optionally) all of one person's machines. */
  sendSession(sessionId: string, message: ServerMessage, alsoUserId?: string): void {
    for (const conn of this.connections) {
      if (conn.sessions.has(sessionId) || (alsoUserId && conn.user?.id === alsoUserId))
        this.send(conn, message);
    }
  }

  /** Once to each machine following the workspace or the session (or the given person's). */
  sendRoom(
    workspaceId: string,
    sessionId: string,
    message: ServerMessage,
    alsoUserId?: string,
  ): void {
    const text = this.record(workspaceId, message);
    for (const conn of this.connections) {
      if (
        conn.subscriptions.has(workspaceId) ||
        conn.sessions.has(sessionId) ||
        (alsoUserId && conn.user?.id === alsoUserId)
      )
        this.sendText(conn, text);
    }
  }

  /** Whether any of this person's machines (not phones: they run no agents) is connected now. */
  isOnline(userId: string): boolean {
    for (const conn of this.connections)
      if (conn.user?.id === userId && conn.client === 'desktop') return true;
    return false;
  }

  /** Whether the person has a desktop window in use now (they see things there). */
  isActive(userId: string): boolean {
    for (const conn of this.connections)
      if (conn.user?.id === userId && conn.client === 'desktop' && conn.status === 'active')
        return true;
    return false;
  }

  /** To this person's desktops only: the machines that run agents. */
  sendMachines(userId: string, message: ServerMessage): void {
    for (const conn of this.connections)
      if (conn.user?.id === userId && conn.client === 'desktop') this.send(conn, message);
  }

  sendUser(userId: string, message: ServerMessage): void {
    for (const conn of this.connections) {
      if (conn.user?.id === userId) {
        if (message.type === 'user')
          conn.user = { ...conn.user, name: message.user.name, avatarUrl: message.user.avatarUrl };
        this.send(conn, message);
      }
    }
  }

  /** The account is gone: every app it is signed in to is told to sign out. */
  signOutUser(userId: string): void {
    for (const conn of this.connections)
      if (conn.user?.id === userId) conn.socket.close(CLOSE.unauthorized, 'Account deleted');
  }

  /** Stops sending a workspace to someone who lost access to it. */
  dropSubscription(userId: string, workspaceId: string): void {
    let changed = false;
    for (const conn of this.connections) {
      if (conn.user?.id !== userId) continue;
      if (conn.subscriptions.delete(workspaceId)) changed = true;
      // Their live session views in that workspace stop too.
      for (const [sessionId, ws] of conn.sessions)
        if (ws === workspaceId) conn.sessions.delete(sessionId);
    }
    if (changed) this.broadcastPresence(workspaceId);
  }

  private send(conn: Connection, message: ServerMessage): void {
    this.sendText(conn, JSON.stringify(message));
  }

  private sendText(conn: Connection, text: string): void {
    if (conn.socket.readyState === conn.socket.OPEN) conn.socket.send(text);
  }

  /** Drops connections that stopped answering pings (closed laptops, dead networks). */
  private sweep(): void {
    for (const conn of this.connections) {
      if (!conn.alive) {
        conn.socket.terminate();
        continue;
      }
      conn.alive = false;
      conn.socket.ping();
    }
  }
}
