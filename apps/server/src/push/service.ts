import {
  can,
  LOCALES,
  mayActOnLane,
  pickLocale,
  type Locale,
  PUSH_CATEGORY,
  redact,
  swarmResult,
  type PushData,
  type PushKind,
  type SwarmOutcome,
} from '@kovan/shared';
import { and, eq, gt, inArray, isNull } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import {
  authSessions,
  pushDevices,
  sessionParticipants,
  sessions,
  users,
  workspaceMembers,
  workspaces,
} from '../db/schema.js';
import { tFor } from '../i18n/index.js';
import type { Apns, SendResult } from './apns.js';
import type { Fcm } from './fcm.js';

type Translate = (text: string, values?: Record<string, string | number>) => string;

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
      /** How its tasks ended, when done. */
      outcome?: SwarmOutcome | null;
    }
  | { kind: 'task'; sessionId: string; stepId: string; title: string; reason: string | null }
  | { kind: 'limit'; sessionId: string; laneUserId: string; reason: string }
  | {
      /** A comment in the session that calls them by name. */
      kind: 'mention';
      sessionId: string;
      toUserId: string;
      fromName: string;
      text: string;
    }
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
    // Each person gets it in the language they chose in an app (English when they didn't).
    for (const locale of LOCALES) {
      const tt = tFor(locale);
      const notice = await this.compose(event, tt);
      const team = await this.composeTeam(event, notice, tt);
      for (const n of [notice, team]) {
        if (!n?.userIds.length) continue;
        const mine = await this.inLocale(n.userIds, locale);
        if (mine.length) await this.deliver({ ...n, userIds: mine });
      }
    }
  }

  /** Who of these people reads `locale`: their saved language, English when none. */
  private async inLocale(userIds: string[], locale: Locale): Promise<string[]> {
    const rows = await this.db
      .select({ id: users.id, locale: users.locale })
      .from(users)
      .where(inArray(users.id, userIds));
    return userIds.filter((id) => pickLocale(rows.find((r) => r.id === id)?.locale) === locale);
  }

  /**
   * The same question for the rest of the team who could answer it (their role, and the
   * workspace's "others' agents" setting, allow it): sent as the "team" kind, which phones get
   * only when the person turned it on.
   */
  async composeTeam(
    event: PushEvent,
    main: Notice | null,
    tt: Translate = (x) => x,
  ): Promise<Notice | null> {
    if ((event.kind !== 'approval' && event.kind !== 'task') || !main) return null;
    const [row] = await this.db
      .select({ workspaceId: sessions.workspaceId, othersAgents: workspaces.othersAgents })
      .from(sessions)
      .innerJoin(workspaces, eq(workspaces.id, sessions.workspaceId))
      .where(eq(sessions.id, event.sessionId));
    if (!row) return null;
    const members = await this.db
      .select({ userId: workspaceMembers.userId, role: workspaceMembers.role })
      .from(workspaceMembers)
      .innerJoin(users, eq(users.id, workspaceMembers.userId))
      .where(and(eq(workspaceMembers.workspaceId, row.workspaceId), eq(users.kind, 'human')));
    const already = new Set(main.userIds);
    let to: string[];
    if (event.kind === 'approval') {
      const [lane] = await this.db
        .select({ hostId: sessionParticipants.hostId })
        .from(sessionParticipants)
        .where(
          and(
            eq(sessionParticipants.sessionId, event.sessionId),
            eq(sessionParticipants.userId, event.laneUserId),
          ),
        );
      to = members
        .filter((m) =>
          mayActOnLane({
            role: m.role,
            userId: m.userId,
            lane: { userId: event.laneUserId, hostId: lane?.hostId ?? null },
            othersAgents: row.othersAgents,
            action: 'approval.answer',
          }),
        )
        .map((m) => m.userId);
    } else to = members.filter((m) => can(m.role, 'approval.answer')).map((m) => m.userId);
    const userIds = to.filter((id) => !already.has(id));
    if (!userIds.length) return null;
    const title =
      event.kind === 'approval'
        ? tt("{name}'s agent asks: {title}", {
            name: await this.nameOf(event.laneUserId),
            title: short(event.title, 60),
          })
        : main.title;
    return { ...main, userIds, kind: 'team', title };
  }

  /** Whose phone it goes to and what it says. */
  async compose(event: PushEvent, tt: Translate = (x) => x): Promise<Notice | null> {
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
        const title = short(event.title, 60);
        return {
          ...base,
          userIds: [...new Set([owner, ...(event.askerId ? [event.askerId] : [])])],
          kind: 'approval',
          title:
            owner === event.laneUserId
              ? tt('Your agent asks: {title}', { title })
              : tt('{name} asks: {title}', { name: await this.nameOf(event.laneUserId), title }),
          body: short(redact(event.detail.split('\n')[0] ?? ''), 160) || tt('Approve or deny it.'),
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
            step_limit: 'Your agent stopped after too many steps',
          }[event.reason] ?? 'Your agent finished';
        return {
          ...base,
          userIds: [event.laneUserId],
          kind: 'finished',
          title: tt(ended),
          body: tt('Open the session to see what it did.'),
        };
      }
      case 'handoff':
        return {
          ...base,
          userIds: [event.toUserId],
          kind: 'handoff',
          title: tt('{name} handed you their work', { name: await this.nameOf(event.fromUserId) }),
          body: event.reason ? short(event.reason, 160) : tt('Open it to take it over.'),
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
              ? swarmResult({ status: 'done', outcome: event.outcome ?? null })?.ok === false
                ? tt('Your swarm ended with failed tasks')
                : tt('Your swarm finished')
              : event.status === 'stopped'
                ? tt('{name} stopped your swarm', { name: by ?? tt('Someone') })
                : tt('Your swarm paused itself'),
          body:
            event.status === 'paused'
              ? short(event.reason ?? '', 160)
              : `${(() => {
                  const r = swarmResult({ status: event.status, outcome: event.outcome ?? null });
                  return r ? `${tt(r.text)}. ` : '';
                })()}${tt('Spent {amount}. Its report is in the swarm chat.', { amount: usd(event.spent) })}`,
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
          title: tt('A Swarm task waits for your approval: {title}', {
            title: short(event.title, 60),
          }),
          body: event.reason ? short(event.reason, 160) : tt('Approve or reject it.'),
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
              ? tt('{name} asks you', { name: event.fromName })
              : event.messageKind === 'blocker'
                ? tt('{name} is stuck', { name: event.fromName })
                : tt('{name} wrote to you', { name: event.fromName }),
          body: short(redact(event.text.split('\n')[0] ?? ''), 160),
        };
      case 'mention':
        return {
          ...base,
          userIds: [event.toUserId],
          kind: 'mention',
          title: tt('{name} mentioned you', { name: event.fromName }),
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
          title: tt("{name}'s agent stopped: {reason}", {
            name,
            reason: short(event.reason.replace(/\.$/, ''), 60),
          }),
          body: tt('It waits for someone to take over.'),
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
