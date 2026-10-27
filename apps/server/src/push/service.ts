import { PUSH_CATEGORY, redact, type PushData, type PushKind } from '@kovan/shared';
import { and, eq, gt, inArray, isNull } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { authSessions, pushDevices, sessionParticipants, sessions, users } from '../db/schema.js';
import type { Apns, SendResult } from './apns.js';
import type { Fcm } from './fcm.js';

/** Something that happened that someone away from their desk wants to know. */
export type PushEvent =
  | {
      kind: 'approval';
      sessionId: string;
      laneUserId: string;
      requestId: string;
      title: string;
      detail: string;
      /** Who called an AI teammate in with @: its approvals are theirs to answer too. */
      askerId?: string | null;
    }
  | { kind: 'finished'; sessionId: string; laneUserId: string; reason: string }
  | {
      kind: 'handoff';
      sessionId: string;
      fromUserId: string;
      toUserId: string;
      reason: string | null;
    }
  | {
      kind: 'swarm';
      sessionId: string;
      status: 'done' | 'stopped' | 'paused';
      reason: string | null;
      launchedBy: string | null;
      actorId: string | null;
      spent: number;
    }
  | { kind: 'task'; sessionId: string; stepId: string; title: string; reason: string | null }
  | { kind: 'limit'; sessionId: string; laneUserId: string; reason: string }
  | {
      kind: 'message';
      sessionId: string;
      toUserId: string;
      fromName: string;
      messageKind: 'note' | 'question' | 'answer' | 'blocker';
      text: string;
    };

/** One notification, to some people. */
export interface Notice {
  userIds: string[];
  kind: PushKind;
  title: string;
  /** The session it is about, shown under the title. */
  subtitle: string;
  body: string;
  data: PushData;
  category?: string;
  /** A newer notification about the same thing replaces this one. */
  collapseId?: string;
}

/** Where services report events; a no-op until push is set up. */
export interface PushSink {
  emit(event: PushEvent): void;
}

export const NO_PUSH: PushSink = { emit: () => undefined };

export interface PushOut {
  /** One of the person's desktops has a window in use: they see it there. */
  isActive(userId: string): boolean;
}

const usd = (n: number) => `$${n < 1 ? n.toFixed(4) : n.toFixed(2)}`;
const short = (text: string, max: number) =>
  text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;

/**
 * Push notifications for a phone whose person is away from their desk. Who gets what follows
 * whose work it is: your agent's approvals and turns, work handed to you, the swarms you
 * launched, and agents in your sessions that ran out. Texts are one short line: no code, no
 * prompts, secrets redacted, since they pass through Apple's and Google's servers.
 */
export class PushService {
  constructor(
    private readonly db: Db,
    private readonly out: PushOut,
    private readonly senders: { apns: Apns | null; fcm: Fcm | null },
    private readonly nameOf: (userId: string) => Promise<string>,
    private readonly log: (message: string) => void = () => undefined,
  ) {}

  get enabled(): boolean {
    return Boolean(this.senders.apns || this.senders.fcm);
  }

  /** Fire and forget: a push never holds up (or breaks) what caused it. */
  emit(event: PushEvent): void {
    if (!this.enabled) return;
    void this.handle(event).catch((error: unknown) =>
      this.log(`push: ${error instanceof Error ? error.message : String(error)}`),
    );
  }

  async handle(event: PushEvent): Promise<void> {
    const notice = await this.compose(event);
    if (notice && notice.userIds.length) await this.deliver(notice);
  }

  /** Whose phone it goes to and what it says. */
  async compose(event: PushEvent): Promise<Notice | null> {
    const [session] = await this.db
      .select({ title: sessions.title })
      .from(sessions)
      .where(eq(sessions.id, event.sessionId));
    if (!session) return null;
    const lanes = await this.db
      .select({
        userId: sessionParticipants.userId,
        mode: sessionParticipants.mode,
        hostId: sessionParticipants.hostId,
        kind: users.kind,
      })
      .from(sessionParticipants)
      .innerJoin(users, eq(users.id, sessionParticipants.userId))
      .where(eq(sessionParticipants.sessionId, event.sessionId));
    const lane = (userId: string) => lanes.find((l) => l.userId === userId);
    // A person's own lane is theirs; an AI teammate's belongs to whoever runs it.
    const ownerOf = (userId: string) => {
      const l = lane(userId);
      return l?.kind === 'agent' ? l.hostId : userId;
    };
    const subtitle = session.title;
    const base = { subtitle, data: { kind: event.kind, sessionId: event.sessionId } };

    switch (event.kind) {
      case 'approval': {
        const owner = ownerOf(event.laneUserId);
        if (!owner) return null;
        const whose =
          owner === event.laneUserId ? 'Your agent' : `${await this.nameOf(event.laneUserId)}`;
        return {
          ...base,
          userIds: [...new Set([owner, ...(event.askerId ? [event.askerId] : [])])],
          kind: 'approval',
          title: `${whose} asks: ${short(event.title, 60)}`,
          body: short(redact(event.detail.split('\n')[0] ?? ''), 160) || 'Approve or deny it.',
          data: {
            ...base.data,
            laneUserId: event.laneUserId,
            requestId: event.requestId,
          },
          category: PUSH_CATEGORY.approval,
          collapseId: `a:${event.requestId}`.slice(0, 64),
        };
      }
      case 'finished': {
        // AI teammates' turns are a swarm's business; it says when it is done.
        if (lane(event.laneUserId)?.kind !== 'human') return null;
        const ended =
          {
            done: 'Your agent finished',
            stopped: 'Your agent stopped',
            error: 'Your agent hit an error',
            step_limit: 'Your agent stopped at its step limit',
          }[event.reason] ?? 'Your agent finished';
        return {
          ...base,
          userIds: [event.laneUserId],
          kind: 'finished',
          title: ended,
          body: 'Open the session to see what it did.',
        };
      }
      case 'handoff':
        return {
          ...base,
          userIds: [event.toUserId],
          kind: 'handoff',
          title: `${await this.nameOf(event.fromUserId)} handed you their work`,
          body: event.reason ? short(event.reason, 160) : 'Pick it up on your desktop.',
        };
      case 'swarm': {
        // The launcher's own machine says done; a stop or pause they made themselves is no news.
        if (!event.launchedBy) return null;
        if (event.status !== 'done' && event.launchedBy === event.actorId) return null;
        // Someone pausing it by hand says so in the app; a swarm pausing itself (budget,
        // monthly limit) is what its owner must hear about.
        if (event.status === 'paused' && !event.reason) return null;
        const by = event.actorId ? await this.nameOf(event.actorId) : null;
        return {
          ...base,
          userIds: [event.launchedBy],
          kind: 'swarm',
          title:
            event.status === 'done'
              ? 'Your swarm finished'
              : event.status === 'stopped'
                ? `${by ?? 'Someone'} stopped your swarm`
                : 'Your swarm paused itself',
          body:
            event.status === 'paused'
              ? short(event.reason ?? '', 160)
              : `Spent ${usd(event.spent)}. Its report is in the swarm chat.`,
        };
      }
      case 'task': {
        // Whoever runs the swarm's agents (it launched them); else who started the session.
        const [row] = await this.db
          .select({ createdBy: sessions.createdBy })
          .from(sessions)
          .where(eq(sessions.id, event.sessionId));
        const owners = lanes
          .filter((l) => l.kind === 'agent' && l.hostId)
          .map((l) => l.hostId!)
          .filter((id, i, all) => all.indexOf(id) === i);
        const to = owners.length ? owners : row?.createdBy ? [row.createdBy] : [];
        return {
          ...base,
          userIds: to,
          kind: 'task',
          title: `A swarm task needs a yes: ${short(event.title, 60)}`,
          body: event.reason ? short(event.reason, 160) : 'Approve or reject it.',
          data: { ...base.data, stepId: event.stepId },
          category: PUSH_CATEGORY.task,
          collapseId: `t:${event.stepId}`.slice(0, 64),
        };
      }
      case 'message':
        return {
          ...base,
          userIds: [event.toUserId],
          kind: 'message',
          title:
            event.messageKind === 'question'
              ? `${event.fromName} asks you`
              : event.messageKind === 'blocker'
                ? `${event.fromName} is stuck`
                : `${event.fromName} wrote to you`,
          body: short(redact(event.text.split('\n')[0] ?? ''), 160),
        };
      case 'limit': {
        const people = lanes
          .filter((l) => l.kind === 'human' && l.mode === 'join')
          .map((l) => l.userId);
        const name = await this.nameOf(event.laneUserId);
        return {
          ...base,
          userIds: people,
          kind: 'limit',
          title: `${name}'s agent stopped: ${short(event.reason.replace(/\.$/, ''), 60)}`,
          body: 'It waits for someone to take over.',
          data: { ...base.data, laneUserId: event.laneUserId },
        };
      }
    }
  }

  /** To each phone of each person who isn't at a desktop right now and wants this kind. */
  async deliver(notice: Notice): Promise<{ sent: number; failed: number }> {
    const away = notice.userIds.filter((id) => !this.out.isActive(id));
    if (!away.length) return { sent: 0, failed: 0 };
    const devices = await this.db
      .select({
        id: pushDevices.id,
        platform: pushDevices.platform,
        token: pushDevices.token,
        sandbox: pushDevices.sandbox,
        muted: pushDevices.muted,
      })
      .from(pushDevices)
      .innerJoin(authSessions, eq(authSessions.id, pushDevices.authSessionId))
      .where(
        and(
          inArray(pushDevices.userId, away),
          isNull(authSessions.revokedAt),
          gt(authSessions.expiresAt, new Date()),
        ),
      );
    let sent = 0;
    let failed = 0;
    for (const device of devices) {
      if (device.muted.includes(notice.kind)) continue;
      const result = await this.sendTo(device, notice);
      if (result.ok) sent++;
      else {
        failed++;
        if (result.gone) await this.db.delete(pushDevices).where(eq(pushDevices.id, device.id));
        else this.log(`push to ${device.platform} failed: ${result.reason}`);
      }
    }
    return { sent, failed };
  }

  private async sendTo(
    device: { platform: 'ios' | 'android'; token: string; sandbox: boolean },
    n: Notice,
  ): Promise<SendResult> {
    if (device.platform === 'ios') {
      if (!this.senders.apns) return { ok: false, gone: false, reason: 'APNs is not set up' };
      return this.senders.apns.send(device.token, device.sandbox, {
        payload: {
          aps: {
            alert: { title: n.title, subtitle: n.subtitle, body: n.body },
            sound: 'default',
            'thread-id': n.data.sessionId,
            ...(n.category ? { category: n.category } : {}),
          },
          // expo-notifications reads a remote notification's data from "body".
          body: n.data,
        },
        ...(n.collapseId ? { collapseId: n.collapseId } : {}),
      });
    }
    if (!this.senders.fcm) return { ok: false, gone: false, reason: 'FCM is not set up' };
    // A data message, so the app draws it with its buttons (the fields expo-notifications reads).
    return this.senders.fcm.send(device.token, {
      title: n.title,
      message: `${n.subtitle} · ${n.body}`,
      body: JSON.stringify(n.data),
      channelId: n.kind === 'approval' || n.kind === 'task' ? 'asks' : 'updates',
      ...(n.category ? { categoryId: n.category } : {}),
      ...(n.collapseId ? { tag: n.collapseId } : {}),
    });
  }
}
