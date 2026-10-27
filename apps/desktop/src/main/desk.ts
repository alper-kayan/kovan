import type { DeskAction, Member, ServerMessage, Session } from '@kovan/shared';
import type { SessionForCheckout } from '@kovan/runner';

export interface DeskDeps {
  request<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T>;
  machineId(): string;
  /** A window here has the session's lane, or its workspace open. */
  canCarry(sessionId: string, workspaceId: string): Promise<boolean>;
  /** This machine has the workspace set up (a checkout bound to it). */
  hasWorkspace(workspaceId: string): Promise<boolean>;
  takeover(
    sessionId: string,
    laneUserId: string,
  ): Promise<{ status: string; resume: string | null }>;
  continueWith(handoffId: string): Promise<{ resume: string | null }>;
  handoff(sessionId: string, toUserId: string): Promise<unknown>;
  checkout(session: SessionForCheckout): Promise<{ root: string }>;
  launchSwarm(swarmId: string, root: string): Promise<unknown>;
  /** A prompt for the person's own lane: a new turn, or guidance for the one running. */
  prompt(session: Session, text: string): Promise<'started' | 'steered'>;
}

/**
 * Work the person asked for on their phone that needs this machine: it runs their agents and has
 * the checkout. A request reaches all their desktops; one that can do it here claims it (the
 * first claim wins), does it the same way the app's own buttons do, and reports back.
 */
export class Desk {
  constructor(private readonly deps: DeskDeps) {}

  async onMessage(message: ServerMessage): Promise<void> {
    if (message.type !== 'desk') return;
    const { id, action } = message.request;
    const session = await this.sessionOf(action).catch(() => null);
    if (!session || !(await this.canDo(action, session))) return;
    const machineId = this.deps.machineId();
    try {
      await this.deps.request('POST', `/api/desk/${id}/claim`, { machineId });
    } catch {
      return; // another of their computers took it
    }
    let ok = true;
    let text: string;
    try {
      text = await this.run(action, session);
    } catch (error) {
      ok = false;
      text = error instanceof Error ? error.message : String(error);
    }
    await this.deps
      .request('POST', `/api/desk/${id}/done`, { machineId, ok, message: text.slice(0, 500) })
      .catch((error: unknown) => console.warn('Desk report:', error));
  }

  /** A teammate's name: from the session, or the workspace when they have no lane here. */
  private async nameIn(session: Session, userId: string): Promise<string> {
    const lane = session.participants.find((p) => p.userId === userId);
    if (lane) return lane.name;
    const { members } = await this.deps
      .request<{ members: Member[] }>('GET', `/api/workspaces/${session.workspaceId}/members`)
      .catch(() => ({ members: [] as Member[] }));
    return members.find((m) => m.userId === userId)?.name ?? 'your teammate';
  }

  private async sessionOf(action: DeskAction): Promise<Session> {
    return (
      await this.deps.request<{ session: Session }>('GET', `/api/sessions/${action.sessionId}`)
    ).session;
  }

  private canDo(action: DeskAction, session: Session): Promise<boolean> {
    return action.kind === 'resume' || action.kind === 'launch' || action.kind === 'prompt'
      ? this.deps.hasWorkspace(session.workspaceId)
      : this.deps.canCarry(session.id, session.workspaceId);
  }

  private async run(action: DeskAction, session: Session): Promise<string> {
    switch (action.kind) {
      case 'takeover': {
        const name = await this.nameIn(session, action.laneUserId);
        const r = await this.deps.takeover(session.id, action.laneUserId);
        return r.status === 'requested'
          ? `Asked ${name}'s agent to stop at a safe checkpoint; your desktop carries on from there.`
          : (r.resume ?? `Your desktop carries on with ${name}'s work.`);
      }
      case 'continue': {
        const r = await this.deps.continueWith(action.handoffId);
        return r.resume ?? 'The work is yours: your agent carries on with it on your desktop.';
      }
      case 'handoff':
        await this.deps.handoff(session.id, action.toUserId);
        return `Handed to ${await this.nameIn(session, action.toUserId)}. Your agent stopped at a checkpoint and its work was snapshotted.`;
      case 'resume':
      case 'launch': {
        const { root } = await this.deps.checkout({
          id: session.id,
          workspaceId: session.workspaceId,
          title: session.title,
          branch: session.branch,
        });
        await this.deps.launchSwarm(action.swarmId, root);
        return action.kind === 'resume'
          ? 'The swarm is running again on your desktop.'
          : 'The swarm is running on your desktop, on your key.';
      }
      case 'prompt':
        return (await this.deps.prompt(session, action.text)) === 'steered'
          ? 'Your agent is working: it takes this before its next step.'
          : 'Your agent started on your desktop.';
    }
  }
}
