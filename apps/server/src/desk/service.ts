import { randomUUID } from 'node:crypto';
import type { DeskAction, DeskRequest, ServerMessage } from '@kovan/shared';
import { and, eq } from 'drizzle-orm';
import { authorize } from '../authz.js';
import type { Db } from '../db/client.js';
import { handoffs, sessionParticipants, swarms } from '../db/schema.js';
import { badRequest, conflict, forbidden, notFound } from '../errors.js';
import type { SessionService } from '../sessions/service.js';

/** How long a desktop has to say it will do the work, and then to do it. */
const CLAIM_MS = 15_000;
const WORK_MS = 5 * 60_000;

export interface DeskOut {
  isOnline(userId: string): boolean;
  sendMachines(userId: string, message: ServerMessage): void;
  sendUser(userId: string, message: ServerMessage): void;
}

interface Pending {
  request: DeskRequest;
  userId: string;
  claimedBy: string | null;
  timer: NodeJS.Timeout;
}

/**
 * Work asked for on a phone that only a desktop can do. The request goes to the person's own
 * machines; the first that can do it claims it (so two desktops don't both act), does it through
 * the usual endpoints (which check everything again) and reports back. Nothing is stored: a
 * request lives only while one of their desktops is connected to this server.
 */
export class DeskService {
  private readonly pending = new Map<string, Pending>();
  /**
   * With none of the person's desktops online, a swarm can still start on a machine the
   * workspace has (agentd): it resolves to that machine's name, or says why none can take it.
   */
  launchOnMachine?: (swarmId: string, userId: string) => Promise<string>;

  constructor(
    private readonly db: Db,
    private readonly out: DeskOut,
    private readonly sessions: SessionService,
  ) {}

  /** The same checks the real endpoint makes, so the phone hears no at once instead of later. */
  private async check(userId: string, action: DeskAction): Promise<void> {
    switch (action.kind) {
      case 'takeover': {
        const row = await this.sessions.visible(action.sessionId, userId);
        await authorize(this.db, row.workspaceId, userId, 'agent.takeover');
        if (row.status !== 'active') throw conflict('This session has ended');
        if (action.laneUserId === userId) throw badRequest("That's your own lane");
        return;
      }
      case 'handoff': {
        const row = await this.sessions.visible(action.sessionId, userId);
        await authorize(this.db, row.workspaceId, userId, 'session.join');
        if (row.status !== 'active') throw conflict('This session has ended');
        const [lane] = await this.db
          .select({ mode: sessionParticipants.mode })
          .from(sessionParticipants)
          .where(
            and(
              eq(sessionParticipants.sessionId, action.sessionId),
              eq(sessionParticipants.userId, userId),
            ),
          );
        if (lane?.mode !== 'join') throw badRequest("You don't have a lane in this session");
        if (action.toUserId === userId) throw badRequest("That's you");
        return;
      }
      case 'continue': {
        const [h] = await this.db.select().from(handoffs).where(eq(handoffs.id, action.handoffId));
        if (!h || h.toUserId !== userId || h.sessionId !== action.sessionId)
          throw notFound('Handoff not found');
        await this.sessions.visible(h.sessionId, userId);
        if (h.status !== 'ready') throw conflict(`This handoff is ${h.status}`);
        return;
      }
      case 'resume':
      case 'launch': {
        const [row] = await this.db.select().from(swarms).where(eq(swarms.id, action.swarmId));
        if (!row || row.sessionId !== action.sessionId) throw notFound('Swarm not found');
        const session = await this.sessions.visible(row.sessionId, userId);
        await authorize(this.db, session.workspaceId, userId, 'session.start');
        if (session.status !== 'active') throw conflict('This session has ended');
        if (row.status !== (action.kind === 'launch' ? 'draft' : 'paused'))
          throw conflict(`This swarm is ${row.status}`);
        if (action.kind === 'resume' && row.launchedBy && row.launchedBy !== userId)
          throw forbidden(`Only ${await this.sessions.nameOf(row.launchedBy)} can resume it`);
        return;
      }
      case 'prompt': {
        const row = await this.sessions.visible(action.sessionId, userId);
        await authorize(this.db, row.workspaceId, userId, 'session.join');
        if (row.status !== 'active') throw conflict('This session has ended');
        return;
      }
    }
  }

  /** Whether Kovan is open on one of the person's computers (a phone doesn't count). */
  desktopOnline(userId: string): boolean {
    return this.out.isOnline(userId);
  }

  async ask(userId: string, action: DeskAction): Promise<DeskRequest> {
    await this.check(userId, action);
    const request: DeskRequest = {
      id: randomUUID(),
      action,
      createdAt: new Date().toISOString(),
    };
    if (!this.out.isOnline(userId)) {
      if ((action.kind === 'launch' || action.kind === 'resume') && this.launchOnMachine) {
        let where: string;
        try {
          where = await this.launchOnMachine(action.swarmId, userId);
        } catch (error) {
          const why = error instanceof Error ? error.message : String(error);
          throw conflict(
            `Your computer is offline, and no machine of this workspace took it: ${why}`,
          );
        }
        // Answered like a desktop would, after the phone has the request (its answer is on
        // its way back while this goes out over the live connection).
        setTimeout(
          () =>
            this.out.sendUser(userId, {
              type: 'desk.done',
              id: request.id,
              ok: true,
              message: `Started on ${where}.`,
            }),
          1000,
        ).unref();
        return request;
      }
      throw conflict('Your computer is offline. Open Kovan on your desktop and try again.');
    }
    const timer = setTimeout(
      () =>
        this.finish(
          request.id,
          false,
          'None of your computers took it: open this workspace in Kovan on your desktop.',
        ),
      CLAIM_MS,
    );
    timer.unref();
    this.pending.set(request.id, { request, userId, claimedBy: null, timer });
    this.out.sendMachines(userId, { type: 'desk', request });
    return request;
  }

  /** A desktop takes the request; the first one wins. */
  claim(id: string, userId: string, machineId: string): void {
    const p = this.pending.get(id);
    if (!p || p.userId !== userId) throw notFound('Request not found');
    if (p.claimedBy) throw conflict('Another of your computers took it');
    p.claimedBy = machineId;
    clearTimeout(p.timer);
    p.timer = setTimeout(
      () => this.finish(id, false, 'Your computer did not finish it in time.'),
      WORK_MS,
    );
    p.timer.unref();
  }

  done(id: string, userId: string, machineId: string, ok: boolean, message: string): void {
    const p = this.pending.get(id);
    if (!p || p.userId !== userId) throw notFound('Request not found');
    if (p.claimedBy !== machineId) throw conflict('Claim it first');
    this.finish(id, ok, message);
  }

  private finish(id: string, ok: boolean, message: string): void {
    const p = this.pending.get(id);
    if (!p) return;
    clearTimeout(p.timer);
    this.pending.delete(id);
    this.out.sendUser(p.userId, { type: 'desk.done', id, ok, message });
  }

  close(): void {
    for (const p of this.pending.values()) clearTimeout(p.timer);
    this.pending.clear();
  }
}
