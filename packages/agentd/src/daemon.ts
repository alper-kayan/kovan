import { git } from '@kovan/git-engine';
import {
  Bindings,
  defaultBranch,
  liveDiff,
  pushRemote,
  SessionCheckouts,
  SubagentRunner,
  SwarmRunner,
  type DetachedRun,
} from '@kovan/runner';
import {
  normalizeRepoUrl,
  type LaneEvent,
  type Plan,
  type ServerMessage,
  type Session,
  type Swarm,
  type Workspace,
} from '@kovan/shared';
import type { AgentEvent } from '@kovan/harness';
import type { FoundAgent } from './detect.js';

type Method = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
type Work = { swarmId: string; sessionId: string };

/** What the daemon needs from the world; the real ones talk to the Brain and the disk. */
export interface DaemonDeps {
  request<T = unknown>(
    method: Method,
    path: string,
    body?: unknown,
    options?: { fence?: string },
  ): Promise<T>;
  follow(workspaceId: string): void;
  laneEvent(sessionId: string, event: LaneEvent, touched: string[], agentId: string): void;
  run(run: DetachedRun): Promise<Extract<AgentEvent, { type: 'turn_end' }>>;
  log(line: string): void;
  /** Wait between reports (30 s; tests make it short). */
  heartbeatMs?: number;
}

export interface MachineSetup {
  name: string;
  platform: string;
  slots: number;
  agents: FoundAgent[];
  repos: { remote: string; path: string }[];
  dataDir: string;
  /** What its machine key covers: one workspace, or every workspace of an organization. */
  scope: { workspaceId: string } | { orgId: string };
  pushWhenDone: boolean;
  endWhenDone?: boolean;
}

/**
 * agentd's core: registers the machine, reports in, and runs the swarms sent to it with the
 * same runner the desktop uses, in session worktrees of the checkouts it holds. A swarm it
 * can't run (no checkout, no branch, no slot) is paused with the reason, never left looking
 * busy.
 */
export class Daemon {
  private machineId: string | null = null;
  private me: { id: string; name: string } | null = null;
  private timer: NodeJS.Timeout | null = null;
  /** Swarms this machine is starting or running, with their checkout. */
  private readonly mine = new Map<
    string,
    {
      sessionId: string;
      root: string | null;
      branch: string | null;
      title: string;
      /** The run's fence: a newer one means it was launched again elsewhere. */
      fence: number;
    }
  >();
  readonly swarms: SwarmRunner;
  private readonly checkouts: SessionCheckouts;
  private readonly bindings: Bindings;
  private stopping = false;

  constructor(
    private readonly setup: MachineSetup,
    private readonly deps: DaemonDeps,
  ) {
    this.bindings = new Bindings(setup.dataDir);
    // agentd writes no local agent setup into worktrees (the desktop connects its own CLIs).
    this.checkouts = new SessionCheckouts(
      this.bindings,
      setup.dataDir,
      async () => undefined,
      async () => false,
    );
    const subagents = new SubagentRunner({
      request: (m, path, body) => deps.request(m, path, body),
      checkouts: this.checkouts,
      run: (run) => deps.run(run),
    });
    this.swarms = new SwarmRunner({
      request: (m, path, body, options) => deps.request(m, path, body, options),
      me: () => this.me,
      laneEvent: (sessionId, event, touched, agentId) =>
        deps.laneEvent(sessionId, event, touched, agentId),
      subagents,
      run: (run) => deps.run(run),
      checkoutOf: (session) => this.checkouts.existing(session),
      notify: (title, body) => deps.log(`${title}: ${body}`),
    });
  }

  get id(): string | null {
    return this.machineId;
  }

  async start(): Promise<void> {
    const { user } = await this.deps.request<{ user: { id: string; name: string } }>(
      'GET',
      '/api/me',
    );
    this.me = { id: user.id, name: user.name };
    const { machine, work } = await this.deps.request<{ machine: { id: string }; work: Work[] }>(
      'POST',
      'orgId' in this.setup.scope
        ? `/api/orgs/${this.setup.scope.orgId}/machines`
        : `/api/workspaces/${this.setup.scope.workspaceId}/machines`,
      {
        name: this.setup.name,
        platform: this.setup.platform,
        slots: this.setup.slots,
        agents: this.setup.agents,
        repos: this.setup.repos,
      },
    );
    this.machineId = machine.id;
    await this.followWorkspaces();
    this.deps.log(
      `Registered as ${this.setup.name} with ${this.setup.repos.length} checkout(s) and ${this.setup.slots} slot(s).`,
    );
    await this.take(work);
    const every = this.deps.heartbeatMs ?? 30_000;
    this.timer = setInterval(() => void this.report(), every);
  }

  /**
   * Follows live the workspaces whose work can come here: its own, or for an organization's
   * machine, those whose repository it holds (others are picked up when work arrives).
   */
  private async followWorkspaces(): Promise<void> {
    if ('workspaceId' in this.setup.scope) {
      this.deps.follow(this.setup.scope.workspaceId);
      return;
    }
    const held = new Set(this.setup.repos.map((r) => normalizeRepoUrl(r.remote) ?? r.remote));
    const { workspaces } = await this.deps.request<{ workspaces: Workspace[] }>(
      'GET',
      '/api/workspaces',
    );
    for (const w of workspaces) if (w.repoUrl && held.has(w.repoUrl)) this.deps.follow(w.id);
  }

  /** Reports in; starts what the Brain says should run here and doesn't yet. */
  async report(): Promise<void> {
    if (!this.machineId || this.stopping) return;
    try {
      const { work } = await this.deps.request<{ work: Work[] }>(
        'POST',
        `/api/machines/${this.machineId}/heartbeat`,
        {},
      );
      await this.take(work);
    } catch (error) {
      this.deps.log(`Report failed: ${(error as Error).message}`);
    }
  }

  onMessage(message: ServerMessage): void {
    this.swarms.onMessage(message);
    if (message.type !== 'swarm') return;
    const ours = this.mine.get(message.swarm.id);
    // A swarm started somewhere in the workspace: it may be for this machine.
    if (!ours && message.swarm.status === 'running') void this.report();
    // Launched again (on another machine, or here anew): this run's work is not the swarm's.
    if (ours && message.swarm.fence > ours.fence) {
      this.mine.delete(message.swarm.id);
      this.deps.log(`${ours.title || message.swarm.id} was launched again; this run stopped.`);
      return;
    }
    if (ours && message.swarm.status !== 'running') {
      this.mine.delete(message.swarm.id);
      const { root, branch } = ours;
      if (message.swarm.status === 'done' && root && branch)
        void this.finish(root, branch, `${ours.title}: ${message.swarm.goal}`).then(() =>
          this.setup.endWhenDone
            ? this.endSession(ours.sessionId, root)
            : this.shareChanges(ours.sessionId, root),
        );
    }
  }

  private async take(work: Work[]): Promise<void> {
    for (const w of work) {
      if (this.mine.has(w.swarmId) || this.swarms.isRunning(w.swarmId)) continue;
      if (this.mine.size >= this.setup.slots) {
        this.deps.log(`All ${this.setup.slots} slot(s) are busy; ${w.swarmId} waits.`);
        return;
      }
      this.mine.set(w.swarmId, {
        sessionId: w.sessionId,
        root: null,
        branch: null,
        title: '',
        fence: Infinity,
      });
      await this.start1(w).catch(async (error: unknown) => {
        this.mine.delete(w.swarmId);
        await this.refuse(w.swarmId, (error as Error).message);
      });
    }
  }

  private async start1(w: Work): Promise<void> {
    const { session } = await this.deps.request<{ session: Session }>(
      'GET',
      `/api/sessions/${w.sessionId}`,
    );
    const { workspace } = await this.deps.request<{ workspace: Workspace }>(
      'GET',
      `/api/workspaces/${session.workspaceId}`,
    );
    const repo = this.setup.repos.find(
      (r) => workspace.repoUrl && (normalizeRepoUrl(r.remote) ?? r.remote) === workspace.repoUrl,
    );
    if (!repo)
      throw new Error(
        `${this.setup.name} has no checkout of ${workspace.repoUrl ?? 'this repository'}`,
      );
    if (!session.branch) throw new Error('The session has no branch to work on');
    await this.bindings.set(session.workspaceId, repo.path);
    this.deps.follow(session.workspaceId);
    const { root } = await this.checkouts.ensure(session);
    await this.deps.request('PUT', `/api/sessions/${session.id}/checkout`, { path: root });
    const { swarm } = await this.deps.request<{ swarm: Swarm | null }>(
      'GET',
      `/api/sessions/${session.id}/swarm`,
    );
    if (!swarm || swarm.id !== w.swarmId || swarm.status !== 'running') {
      this.mine.delete(w.swarmId);
      return;
    }
    // Its agents already have unfinished plan steps: it is resuming that work.
    const { plan } = await this.deps.request<{ plan: Plan }>(
      'GET',
      `/api/sessions/${session.id}/plan`,
    );
    const ids = new Set(swarm.agents.map((a) => a.agentId));
    const resumed = plan.steps.some((s) => s.ownerId && ids.has(s.ownerId) && s.status !== 'done');
    this.mine.set(w.swarmId, {
      sessionId: session.id,
      root,
      branch: session.branch,
      title: session.title,
      fence: swarm.fence,
    });
    this.deps.log(
      `Running the swarm of "${session.title}" in ${root}${resumed ? ' (resuming)' : ''}.`,
    );
    await this.swarms.take(swarm, root, resumed);
  }

  /** A swarm this machine can't run is paused with why, so nobody waits on it. */
  private async refuse(swarmId: string, why: string): Promise<void> {
    this.deps.log(`Can't run ${swarmId}: ${why}`);
    await this.deps
      .request('POST', `/api/swarms/${swarmId}/status`, {
        status: 'paused',
        reason: `${why}.`.slice(0, 300),
      })
      .catch(() => undefined);
  }

  /**
   * A finished swarm's work is committed on the session branch (people at a desktop commit
   * themselves; here nobody would), then pushed when this machine may push.
   */
  async finish(root: string, branch: string, message: string): Promise<string | null> {
    const status = await git(root, ['status', '--porcelain']).catch(() => '');
    if (status.trim()) {
      await git(root, ['add', '-A']);
      await git(root, [
        '-c',
        `user.name=Kovan agentd (${this.setup.name})`,
        '-c',
        `user.email=agentd@${this.setup.name}.kovan`,
        'commit',
        '-q',
        '-m',
        message.slice(0, 2000),
      ]);
    }
    const sha = (await git(root, ['rev-parse', 'HEAD']).catch(() => '')).trim() || null;
    this.deps.log(`Committed the work on ${branch}${sha ? ` (${sha.slice(0, 7)})` : ''}.`);
    if (this.setup.pushWhenDone) await this.push(root, branch);
    return sha;
  }

  /**
   * The finished work's diff against the base branch, for the session's Changes (on the phone
   * and in the apps): what a desktop sends while it works, sent here once the work is done.
   */
  async shareChanges(sessionId: string, root: string): Promise<void> {
    try {
      const changes = await liveDiff(root, await defaultBranch(root));
      await this.deps.request('PUT', `/api/sessions/${sessionId}/changes`, changes);
    } catch (error) {
      this.deps.log(
        `Couldn't share the changes: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /** Ends the session with its final diff (KOVAN_END_WHEN_DONE). */
  async endSession(sessionId: string, root: string): Promise<void> {
    try {
      const { diff } = await liveDiff(root, await defaultBranch(root));
      await this.deps.request('POST', `/api/sessions/${sessionId}/end`, { diff });
      this.deps.log('Ended the session.');
    } catch (error) {
      this.deps.log(
        `Couldn't end the session: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private async push(root: string, branch: string): Promise<void> {
    const remote = await pushRemote(root);
    if (!remote) return;
    await git(root, ['push', remote, `HEAD:refs/heads/${branch}`], { timeoutMs: 120_000 })
      .then(() => this.deps.log(`Pushed ${branch}.`))
      .catch((e: unknown) => this.deps.log(`Push of ${branch} failed: ${(e as Error).message}`));
  }

  /** Stops: what runs here is paused with why (a person or system resumes it later). */
  async stop(reason: string): Promise<void> {
    this.stopping = true;
    if (this.timer) clearInterval(this.timer);
    const running = [...this.mine.keys()];
    this.swarms.stopAll();
    await Promise.all(
      running.map((id) =>
        this.deps
          .request('POST', `/api/swarms/${id}/status`, {
            status: 'paused',
            reason: `${this.setup.name}: ${reason}`.slice(0, 300),
          })
          .catch(() => undefined),
      ),
    );
    this.mine.clear();
  }
}
