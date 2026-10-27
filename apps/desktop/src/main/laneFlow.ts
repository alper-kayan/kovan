import type { Handoff, Outcome, ServerMessage, Session } from '@kovan/shared';
import { randomUUID } from 'node:crypto';
import type { SessionLink } from '../shared/agent.js';
import type { TakeoverResult } from '../shared/api.js';
import type { Settings } from '../shared/settings.js';
import type { BrainClient } from './brain.js';
import type { Bindings } from '@kovan/runner';
import { applySnapshot, pushSnapshot, snapshotRef } from '@kovan/runner';
import type { WindowContext } from './windowContext.js';

export interface LaneFlowDeps {
  brain: BrainClient;
  bindings: Bindings;
  contexts: () => WindowContext[];
  settings: () => Promise<Settings>;
  /** The session's checkout on this machine, made when needed. */
  checkout: (session: Session) => Promise<string>;
}

function ago(iso: string | null): string {
  if (!iso) return 'no snapshot was taken';
  const minutes = Math.round((Date.now() - new Date(iso).getTime()) / 60_000);
  return minutes < 1 ? 'a snapshot from just now' : `a snapshot from ${minutes} min ago`;
}

/**
 * Work changing hands between machines: a takeover asked of this machine (stop at a safe
 * checkpoint, snapshot, hand over), a takeover this machine makes (apply the snapshot, carry
 * on with a new turn on this person's account), handoffs, and teammates' steering.
 */
export class LaneFlow {
  /** Takeovers this machine asked for, continued as soon as they are ready. */
  private readonly mine = new Set<string>();

  constructor(private readonly deps: LaneFlowDeps) {}

  private me() {
    return this.deps.brain.status().user;
  }

  /** The window that has the session's lane, or that has its workspace open. */
  private async windowFor(
    sessionId: string,
    workspaceId: string,
  ): Promise<{ ctx: WindowContext; conversation: string | null } | null> {
    for (const ctx of this.deps.contexts()) {
      const conversation = ctx.agents?.laneConversation(sessionId) ?? null;
      if (conversation) return { ctx, conversation };
    }
    const root = (await this.deps.bindings.all())[workspaceId];
    const ctx = this.deps.contexts().find((c) => c.workspace?.root === root && c.agents);
    return ctx ? { ctx, conversation: null } : null;
  }

  /** Whether this machine can carry a session's lane: a window has it or its workspace open. */
  async canCarry(sessionId: string, workspaceId: string): Promise<boolean> {
    const found = await this.windowFor(sessionId, workspaceId);
    return Boolean(found?.ctx.agents);
  }

  async onMessage(message: ServerMessage): Promise<void> {
    const me = this.me();
    if (!me) return;
    if (message.type === 'steer' && message.laneUserId === me.id) {
      for (const ctx of this.deps.contexts()) {
        const conversation = ctx.agents?.laneConversation(message.sessionId);
        if (!conversation) continue;
        ctx.agents!.steer(conversation, {
          id: message.id,
          text: message.text,
          fromUserId: message.fromUserId,
          fromName: message.fromName,
        });
        return;
      }
      return;
    }
    if (message.type !== 'handoff') return;
    const h = message.handoff;
    if (h.status === 'requested' && h.fromUserId === me.id)
      await this.checkpoint(h, message.workspaceId);
    if (h.status === 'ready' && h.toUserId === me.id && this.mine.has(h.id)) {
      this.mine.delete(h.id);
      await this.continueWith(h.id).catch((error: unknown) =>
        console.warn('Takeover failed:', error),
      );
    }
  }

  /** Someone takes over this machine's lane: stop at a safe checkpoint, snapshot, hand it over. */
  private async checkpoint(h: Handoff, workspaceId: string): Promise<void> {
    const found = await this.windowFor(h.sessionId, workspaceId);
    const me = this.me()!;
    let snapshot: { sha: string; ref: string } | null = null;
    let context = {
      lastPrompts: [] as string[],
      lastReply: null as string | null,
      touchedFiles: [] as string[],
      reason: 'taken over',
    };
    if (found?.conversation && found.ctx.agents) {
      await found.ctx.agents.stopAtCheckpoint(found.conversation);
      context = found.ctx.agents.laneContext(found.conversation, 'taken over by a teammate');
    }
    const root = found?.ctx.workspace?.isRepo ? found.ctx.workspace.root : null;
    if (root)
      snapshot = await pushSnapshot(
        root,
        snapshotRef(h.sessionId, me.id),
        `Kovan snapshot: ${me.name}, handed over`,
      ).catch(() => null);
    await this.deps.brain.request('POST', `/api/handoffs/${h.id}/ready`, {
      snapshot: { sha: snapshot?.sha ?? null, ref: snapshot?.ref ?? null },
      context,
    });
  }

  /** Asks to take over a teammate's lane; continues at once when it's ready. */
  async takeover(sessionId: string, laneUserId: string): Promise<TakeoverResult> {
    const { handoff } = await this.deps.brain.request<{ handoff: Handoff }>(
      'POST',
      `/api/sessions/${sessionId}/takeover`,
      { laneUserId },
    );
    if (handoff.status !== 'ready') {
      this.mine.add(handoff.id);
      return { status: 'requested', resume: null, applied: 'none' };
    }
    return this.continueWith(handoff.id);
  }

  /** Gives this person's own lane to a teammate (who may not have an agent at all). */
  async handoff(sessionId: string, toUserId: string): Promise<Handoff> {
    const { session } = await this.deps.brain.request<{ session: Session }>(
      'GET',
      `/api/sessions/${sessionId}`,
    );
    const found = await this.windowFor(sessionId, session.workspaceId);
    const me = this.me()!;
    let context = {
      lastPrompts: [] as string[],
      lastReply: null as string | null,
      touchedFiles: session.touchedFiles.slice(0, 30),
      reason: `${me.name} handed it over`,
    };
    if (found?.conversation && found.ctx.agents) {
      await found.ctx.agents.stopAtCheckpoint(found.conversation);
      context = found.ctx.agents.laneContext(found.conversation, `${me.name} handed it over`);
    }
    const root = found?.ctx.workspace?.isRepo ? found.ctx.workspace.root : null;
    const snapshot = root
      ? await pushSnapshot(
          root,
          snapshotRef(sessionId, me.id),
          `Kovan snapshot: ${me.name}, handed over`,
        ).catch(() => null)
      : null;
    const { handoff } = await this.deps.brain.request<{ handoff: Handoff }>(
      'POST',
      `/api/sessions/${sessionId}/handoff`,
      { toUserId, snapshot: { sha: snapshot?.sha ?? null, ref: snapshot?.ref ?? null }, context },
    );
    return handoff;
  }

  /** This person's lane in a session: joined with their agent if they weren't yet. */
  private async ensureLane(session: Session, ctx: WindowContext, root: string) {
    const s = await this.deps.settings();
    const me = this.me()!;
    const harness = s.agentHarness;
    if (!session.participants.some((p) => p.userId === me.id && p.mode === 'join'))
      await this.deps.brain.request('POST', `/api/sessions/${session.id}/join`, {
        mode: 'join',
        harness,
        model: harness === 'kovan' ? s.agentModel : 'default',
      });
    const link: SessionLink = {
      id: session.id,
      workspaceId: session.workspaceId,
      title: session.title,
    };
    return (
      (await ctx.agents!.laneOf(root, session.id)) ??
      (await ctx.agents!.create(
        root,
        {
          harness,
          model: harness === 'kovan' ? s.agentModel : 'default',
          effort: harness === 'kovan' ? s.agentEffort : null,
          mode: 'request',
        },
        link,
      ))
    );
  }

  /**
   * A prompt for this person's own agent, sent from their phone. A working agent takes it as
   * guidance before its next step; an idle one starts a turn with it, in the session's checkout
   * (made when needed), in a window that has the session or its workspace open, else any window.
   */
  async prompt(session: Session, text: string): Promise<'started' | 'steered'> {
    const me = this.me();
    if (!me) throw new Error('This desktop is signed out.');
    for (const ctx of this.deps.contexts()) {
      const conversation = ctx.agents?.laneConversation(session.id);
      if (!conversation) continue;
      if (ctx.agents!.running(conversation)) {
        const steer = { id: randomUUID(), text, fromUserId: me.id, fromName: me.name };
        if (ctx.agents!.steer(conversation, steer)) return 'steered';
        throw new Error(
          "Your agent is busy and can't take guidance mid-turn; send it again when it finishes.",
        );
      }
      await ctx.agents!.send(ctx.agents!.rootOf(conversation)!, conversation, text, []);
      return 'started';
    }
    const root = await this.deps.checkout(session);
    const mainRoot = (await this.deps.bindings.all())[session.workspaceId];
    const windows = this.deps.contexts().filter((c) => c.agents);
    const ctx =
      windows.find((c) => c.workspace?.root === root) ??
      windows.find((c) => c.workspace?.root === mainRoot) ??
      windows[0];
    if (!ctx) throw new Error('Open a Kovan window on your desktop so your agent can work.');
    const lane = await this.ensureLane(session, ctx, root);
    await ctx.agents!.send(root, lane.id, text, []);
    return 'started';
  }

  /**
   * Picks up a lane handed to this person: accept, bring the snapshot into this checkout, and
   * start a new turn on this person's own account that resumes from the plan.
   */
  async continueWith(handoffId: string): Promise<TakeoverResult> {
    const { handoff: h, resumeStep } = await this.deps.brain.request<{
      handoff: Handoff;
      resumeStep: { index: number; total: number; title: string } | null;
    }>('POST', `/api/handoffs/${handoffId}/accept`);
    const { session } = await this.deps.brain.request<{ session: Session }>(
      'GET',
      `/api/sessions/${h.sessionId}`,
    );
    const found = await this.windowFor(h.sessionId, session.workspaceId);
    if (!found?.ctx.workspace || !found.ctx.agents)
      throw new Error('Open the workspace in a window to continue the work there.');
    const root = found.ctx.workspace.root;
    let applied: TakeoverResult['applied'] = 'none';
    if (h.snapshotSha && h.snapshotRef && found.ctx.workspace.isRepo)
      applied = await applySnapshot(root, h.snapshotRef, h.snapshotSha);

    const lane = await this.ensureLane(session, found.ctx, root);

    const { outcomes } = await this.deps.brain
      .request<{ outcomes: Outcome[] }>('GET', `/api/workspaces/${session.workspaceId}/flow`)
      .catch(() => ({ outcomes: [] as Outcome[] }));
    const unknown = outcomes.filter(
      (o) => o.sessionId === session.id && o.laneUserId === h.fromUserId,
    );
    const from = session.participants.find((p) => p.userId === h.fromUserId)?.name ?? 'a teammate';
    const c = h.context;
    const resume = resumeStep
      ? `Resuming at step ${resumeStep.index} of ${resumeStep.total}.`
      : null;
    const prompt = [
      resume
        ? `${resume} Start your reply with exactly "${resume}" and continue with that step: ${resumeStep!.title}.`
        : 'Continue the work below.',
      '',
      `You are taking over ${from}'s work in the shared session "${session.title}"${c?.reason ? ` (${c.reason})` : ''}. ` +
        (applied === 'none'
          ? 'No snapshot of their checkout could be applied; check the code before assuming anything.'
          : `Their work is in this checkout now, from ${ago(h.snapshotAt)}.`),
      ...(c?.lastPrompts.length
        ? ['', 'What they asked their agent:', ...c.lastPrompts.map((p) => `- ${p}`)]
        : []),
      ...(c?.lastReply ? ['', `Their agent's last words: ${c.lastReply}`] : []),
      ...(c?.touchedFiles.length ? ['', `Files they changed: ${c.touchedFiles.join(', ')}`] : []),
      ...(unknown.length
        ? [
            '',
            'These actions were cut off mid-flight and their outcome is unknown. Do NOT run them again; tell the person they need recording:',
            ...unknown.map((o) => `- ${o.command}`),
          ]
        : []),
      '',
      'Check the code first, then carry on. Mark plan steps with the kovan tools as you finish them.',
    ].join('\n');
    await found.ctx.agents.send(root, lane.id, prompt, []);
    return { status: 'continued', resume, applied };
  }
}
