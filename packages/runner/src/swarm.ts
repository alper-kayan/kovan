import { randomUUID } from 'node:crypto';
import { impactLine } from './impact.js';
import { liveWorkOf, WriteCheck, type LiveWork } from './writeCheck.js';
import type { Agent, AgentEvent, ApprovalRequest, Tool } from '@kovan/harness';
import {
  canMoveTask,
  graphProblem,
  nextTasks,
  orderTestOnlyTasks,
  serializeOverlaps,
  type AgentSpendReply,
  type AiAgent,
  type LaneEvent,
  type Learning,
  type MentionReply,
  type MentionStatus,
  type PathLock,
  type Plan,
  type ServerMessage,
  type Session,
  type AgentSpendStats,
  type ImpactLink,
  type Swarm,
  type SwarmMessage,
  type SwarmReportReply,
  type TaskState,
} from '@kovan/shared';
import { commandAllowed } from './commandPolicy.js';
import type { DetachedRun, LiveAgent } from './run.js';
import { isAbsolute, relative as relativePath } from 'node:path';
import type { ReviewInput, ReviewVerdict, SubagentOutcome, SubagentRunner } from './subagents.js';

/** A teammate called into a conversation with @. */
export interface CalledIn {
  /** The conversation so far, as the teammate should read it (cut to a readable size). */
  context: string | null;
  /** Where its answer goes. */
  reply?: MentionReply | undefined;
}

/** One task for an AI teammate outside a swarm: written in its lane, or a call with @. */
interface SoloTask {
  /** The lane message or call it answers. */
  id: string;
  text: string;
  fromUserId: string;
  fromName: string;
  mention?: CalledIn | undefined;
}

export interface SwarmDeps {
  request<T>(
    method: 'GET' | 'POST' | 'PATCH' | 'PUT',
    path: string,
    body?: unknown,
    /** `fence`: this request belongs to one run of a swarm (sent as `x-kovan-fence`). */
    options?: { fence?: string },
  ): Promise<T>;
  me(): { id: string; name: string } | null;
  /** Streams an AI teammate's lane (this machine runs it). */
  laneEvent(sessionId: string, event: LaneEvent, touched: string[], agentId: string): void;
  subagents: Pick<SubagentRunner, 'start' | 'discard' | 'rework'>;
  /** A turn of Kovan's agent in the session's checkout (the lead plans and reviews there). */
  run(run: DetachedRun): Promise<Extract<AgentEvent, { type: 'turn_end' }>>;
  /** The session's checkout on this machine, if it has one. */
  checkoutOf(session: Session): Promise<string | null>;
  /** Tells the person on this machine something (a task can't start here). */
  notify(title: string, body: string): void;
  /** How long one task may take, its reworks included (tests make it short). */
  taskTimeoutMs?: number;
  /** How often to look for an answer to an approval (tests make it short). */
  approvalPollMs?: number;
  /** How long an agent's question waits for its answer (tests make it short). */
  replyWaitMs?: number;
}

/** What the lead's assign tool produced: the tasks, and what to tell people about them. */
interface Split {
  tasks: Task[];
  assumptions: string[];
  questions: string[];
  /** The lead's call: no task starts until a person answers the questions. */
  waitForAnswers: boolean;
  /** Side-by-side tasks put in order because they change the same files. */
  ordered: string[];
}

/** The reason a task gives while the whole swarm waits for answers to the plan's questions. */
const HOLD = 'Waiting for answers to the open questions';

/** One task of the swarm's graph: what to do, who does it, and what it waits for. */
interface Task {
  /** The lead's id for it, or its plan step's id when the swarm resumes. */
  key: string;
  stepId: string | null;
  title: string;
  detail: string | null;
  /** What done means, checked by the agent and shown in the report. */
  acceptance: string | null;
  /** A command that proves it (a test of what the task changes), run after the project's checks. */
  acceptanceCheck: string | null;
  /** Set when a person must say yes before it starts, then their answer. */
  approval: 'pending' | 'approved' | 'rejected' | null;
  approvalReason: string | null;
  /** Keys of the tasks that must be done (their work verified and joined) first. */
  dependsOn: string[];
  /** The files the lead expects it to change (side-by-side tasks on the same file are ordered). */
  files: string[];
  /** Files its agent changed in the current attempt, for a handover. */
  touched: Set<string>;
  /** Notes from earlier attempts or agents, handed to whoever runs it next. */
  history: string[];
  /** Fresh starts after its work no longer applied to the checkout. */
  reruns: number;
  /** Set when the Brain said it spent past its own budget: why it was stopped. */
  overBudget?: string;
  /** What its reviewer noted beyond the verdict (limits, follow-ups). */
  reviewNotes?: string;
  /** A question a person must answer before it starts: the message asking it, and the answer. */
  question?: { text: string; messageId: string | null; answered: boolean };
  agentId: string;
  state: TaskState;
  /** Why it failed or is blocked, in a few words. */
  why: string | null;
  /** Runs of its agent: the first try plus reworks after failed checks. */
  attempts: number;
  /** Model spend of its runs (provider cost). */
  cost: number;
  /** Bumped when it is stopped or moved: an older run's outcome no longer counts. */
  run: number;
  /** Its state changes, sent to its plan step one after another. */
  sync: Promise<void>;
  /** Set while it runs: its subagent, and the agent to steer. */
  subagentId?: string | undefined;
  agent?: LiveAgent | undefined;
  outcome?: SubagentOutcome | undefined;
}

interface Running {
  swarm: Swarm;
  session: Session;
  root: string;
  abort: AbortController;
  agents: Map<string, AiAgent>;
  tasks: Task[];
  /** Messages for an agent that wasn't in a turn when they came (its next turn gets them). */
  inbox: Map<string, Note[]>;
  /** This run's fence: the swarm's at launch. A newer one means it was launched elsewhere. */
  fence: number;
  /** Chat messages already handled here: the Brain sends one again when it is delivered. */
  seen: Set<string>;
  /** Every chat message seen here, by id: for replies and read_messages. */
  messages: Map<string, SwarmMessage>;
  /** Messages handed to a running turn, by id, and the agents whose model doesn't have them yet. */
  steered: Map<string, Set<string>>;
  /** Per agent: messages its model has, until it says something after them (then they're read). */
  unanswered: Map<string, string[]>;
  /** Agents in a turn of their own to answer messages (between or after their tasks). */
  awake: Map<string, LiveAgent | null>;
  wakeTurns: Set<Promise<void>>;
  /** Times each agent was woken: by people (always, up to a limit) and by other agents. */
  wakes: Map<string, { people: number; agents: number }>;
  /** An agent's question waiting for its answer, by the question's id. */
  waiters: Map<string, { agentId: string; resolve: (answer: SwarmMessage) => void }>;
  /** Where the run is: the lead splits, the agents work, the lead replans or reviews. */
  phase: 'split' | 'work' | 'replan' | 'review' | 'end';
  /** Plans the lead added while the work ran (woken by a message). */
  added: number;
  /** The team's live work and locks, read at most every few seconds for the agents' notes. */
  live?: { at: number; value: Promise<{ work: LiveWork[]; locks: PathLock[] }> } | undefined;
  /** The launcher's own words to the swarm, for suggested preferences. */
  said: string[];
  /** Launched again after a pause: its agents' unfinished plan steps are the work. */
  resumed: boolean;
  /** This launch, for the subagents' request keys (a resume is another launch). */
  launchId: string;
  /** What the lead assumed and couldn't tell, for the report. */
  assumptions: string[];
  questions: string[];
  /**
   * The plan's open questions, asked of the person running the swarm: the message asking each,
   * whether it was answered, and whether nothing may start until it is.
   */
  asks: { text: string; messageId: string | null; answered: boolean; hold: boolean }[];
  /** Times the lead planned the rest after failures. */
  replans: number;
  /** Model calls that had no price (a custom provider, a model missing from the catalog). */
  unpriced: number;
  /** What the first split was expected to cost, from earlier tasks here; null: no ground. */
  estimate: { total: number; perTask: number; from: number } | null;
  /** The lead's agent while it plans or reviews. */
  lead?: LiveAgent | undefined;
  wake?: (() => void) | undefined;
}

/** A message waiting for an agent's next turn. */
interface Note {
  id: string;
  text: string;
  fromId: string;
  fromName: string;
  /** From a person (it always wakes an idle agent), not from another agent. */
  human: boolean;
  /** Written in the agent's lane, not in the swarm's chat (the Brain has no receipt for it). */
  lane?: boolean;
  /**
   * It wakes the agent when idle: a message to it does; one to everyone wakes only the lead,
   * and only when a person wrote it (agents' announcements wait for each one's next turn).
   */
  wake: boolean;
}

/** A task's proof is kept in its plan step's acceptance, so a resumed swarm runs it too. */
const PROOF = /\s*\(proof: `([^`]+)`\)$/;
const withProof = (acceptance: string | null, check: string | null) =>
  check ? `${acceptance ?? 'Its check passes'} (proof: \`${check}\`)` : acceptance;
const proofOf = (acceptance: string | null) => (acceptance && PROOF.exec(acceptance)?.[1]) ?? null;

/** Dollars as people read them: four decimals for small amounts. */
const usd = (n: number) => `$${n < 1 ? n.toFixed(4) : n.toFixed(2)}`;

const MAX_TASKS = 8;
/** Every task of one run, the lead's later additions included. */
const MAX_RUN_TASKS = 24;
/** An idle agent is woken for other agents' messages this often in one run; for people's, more. */
const MAX_AGENT_WAKES = 3;
const MAX_PEOPLE_WAKES = 10;
/** How long a question waits for its answer before the agent goes on without it. */
const REPLY_WAIT_MS = 10 * 60_000;
/** The messages a prompt shows at most; read_messages has the rest. */
const PROMPT_MESSAGES = 20;
/** A task whose checks fail goes back to its agent once with what failed. */
const MAX_ATTEMPTS = 2;
const TASK_TIMEOUT_MS = 30 * 60_000;
/** Work that no longer applies (others changed the same lines meanwhile) starts over this often. */
const MAX_RERUNS = 1;
/** After failures the lead may plan the rest this many times. */
const MAX_REPLANS = 1;
/** How often a swarm waiting for an approval looks at the plan (besides live updates). */
const APPROVAL_POLL_MS = 5_000;

function relative(event: AgentEvent, root: string): LaneEvent {
  // Teammates' checkouts live elsewhere: paths go out relative to the repository.
  const text = JSON.stringify(event).split(`${root}/`).join('');
  return JSON.parse(text) as LaneEvent;
}

/**
 * Runs a swarm on this machine: AI teammates on one goal in a session. The lead reads the code
 * and splits the goal into tasks (plan steps owned by the agents); workers take them in
 * parallel, each in its own worktree from the session's checkout, and their checked work joins
 * it exactly once (as subagents). Every model call's cost goes to the Brain, which pauses the
 * swarm at its budget; this machine then stops its agents. Agents talk to each other (and people
 * to them) in the swarm's chat. At the end the lead reviews the results; knowledge from checked
 * results is shared, preferences of the person running it are suggested to them, privately.
 */
export class SwarmRunner {
  private readonly running = new Map<string, Running>();
  /** Tasks people gave one AI teammate directly (outside a swarm), by agent. */
  private readonly solo = new Map<string, { agent?: LiveAgent | undefined; queue: SoloTask[] }>();
  /** A called-in teammate's approvals waiting for an answer, by `${agentId}:${requestId}`. */
  private readonly asks = new Map<string, (approved: boolean) => void>();

  constructor(private readonly deps: SwarmDeps) {}

  isRunning(swarmId: string): boolean {
    return this.running.has(swarmId);
  }

  /** The swarms running here now. */
  runningIds(): string[] {
    return [...this.running.keys()];
  }

  /** Launches (or resumes) a swarm here, working in the session checkout at `root`. */
  async launch(swarmId: string, root: string): Promise<Swarm> {
    if (this.running.has(swarmId)) throw new Error('This swarm is running here already.');
    const { swarm, resumed } = await this.deps.request<{ swarm: Swarm; resumed: boolean }>(
      'POST',
      `/api/swarms/${swarmId}/launch`,
    );
    return this.take(swarm, root, resumed);
  }

  /**
   * Runs a swarm someone else launched for this machine (agentd): the Brain already has it
   * running; this machine does the work. `resumed`: its agents have unfinished plan steps.
   */
  async take(swarm: Swarm, root: string, resumed: boolean): Promise<Swarm> {
    const swarmId = swarm.id;
    if (this.running.has(swarmId)) throw new Error('This swarm is running here already.');
    const { session } = await this.deps.request<{ session: Session }>(
      'GET',
      `/api/sessions/${swarm.sessionId}`,
    );
    const { agents } = await this.deps.request<{ agents: AiAgent[] }>(
      'GET',
      `/api/workspaces/${session.workspaceId}/agents`,
    );
    const state: Running = {
      swarm,
      session,
      root,
      abort: new AbortController(),
      agents: new Map(agents.map((a) => [a.id, a])),
      tasks: [],
      inbox: new Map(),
      fence: swarm.fence,
      seen: new Set(),
      messages: new Map(),
      steered: new Map(),
      unanswered: new Map(),
      awake: new Map(),
      wakeTurns: new Set(),
      wakes: new Map(),
      waiters: new Map(),
      phase: 'split',
      added: 0,
      said: [],
      resumed,
      launchId: randomUUID().slice(0, 8),
      assumptions: [],
      questions: [],
      asks: [],
      replans: 0,
      unpriced: 0,
      estimate: null,
    };
    this.running.set(swarmId, state);
    void this.drive(state)
      .catch(async (error: unknown) => {
        console.warn('Swarm failed:', error);
        await this.call(state, 'POST', `/api/swarms/${swarmId}/status`, {
          status: 'paused',
          reason: `It stopped on this machine: ${(error as Error).message}`.slice(0, 300),
        }).catch(() => undefined);
      })
      .finally(() => this.running.delete(swarmId));
    return swarm;
  }

  /**
   * Someone wrote in an AI teammate's lane (it runs here): guidance for its running task, or a
   * new task. A task runs like a swarm worker's: its own worktree, checks, joined once.
   */
  async direct(input: {
    sessionId: string;
    agentId: string;
    text: string;
    id: string;
    fromUserId: string;
    fromName: string;
    /** It was called in with @ from a conversation: it asks before edits and commands. */
    mention?: CalledIn | undefined;
  }): Promise<void> {
    const steer = {
      id: input.id,
      text: input.text,
      fromUserId: input.fromUserId,
      fromName: input.fromName,
    };
    // Its swarm runs here: the swarm hears it (into its turn, or it wakes on the swarm's budget).
    for (const state of this.running.values())
      if (
        state.swarm.sessionId === input.sessionId &&
        state.swarm.agents.some((a) => a.agentId === input.agentId)
      ) {
        this.hand(state, input.agentId, {
          id: input.id,
          text: `From ${input.fromName} (in your lane): ${input.text}`,
          fromId: input.fromUserId,
          fromName: input.fromName,
          human: true,
          lane: true,
          wake: true,
        });
        return;
      }
    const task: SoloTask = {
      id: input.id,
      text: input.text,
      fromUserId: input.fromUserId,
      fromName: input.fromName,
      mention: input.mention,
    };
    const busy = this.solo.get(input.agentId);
    if (busy) {
      // A call from a conversation is its own task, with its own context and asker.
      if (!input.mention && busy.agent?.steer(steer)) return;
      busy.queue.push(task);
      return;
    }
    const { session } = await this.deps.request<{ session: Session }>(
      'GET',
      `/api/sessions/${input.sessionId}`,
    );
    const lane = session.participants.find((p) => p.userId === input.agentId);
    if (lane?.kind !== 'agent' || lane.hostId !== this.deps.me()?.id) return;
    const root = await this.deps.checkoutOf(session);
    if (!root) {
      this.deps.notify(
        `${lane.name} has a task`,
        `Open "${session.title}" on this machine so ${lane.name} can work on it.`,
      );
      await this.answerCall(
        session.id,
        input.agentId,
        task,
        'failed',
        `the session isn't open on the machine that runs ${lane.name}`,
      );
      return;
    }
    const { agents } = await this.deps.request<{ agents: AiAgent[] }>(
      'GET',
      `/api/workspaces/${session.workspaceId}/agents`,
    );
    const agent = agents.find((a) => a.id === input.agentId);
    if (!agent) return;
    // Its own monthly limit, or the workspace's, is reached: the task doesn't start.
    const may = await this.spend(session.id, agent.id, 0);
    if (may?.over) {
      this.deps.laneEvent(
        session.id,
        { type: 'user', text: input.text, attachments: [], at: Date.now() },
        [],
        agent.id,
      );
      this.deps.laneEvent(
        session.id,
        { type: 'notice', tone: 'warn', text: `Not started: ${may.over}.` },
        [],
        agent.id,
      );
      this.deps.notify(`${lane.name} didn't start`, `${may.over}.`);
      await this.answerCall(session.id, agent.id, task, 'failed', may.over);
      return;
    }
    const job = { queue: [task], agent: undefined as Agent | undefined };
    this.solo.set(agent.id, job);
    try {
      while (job.queue.length) await this.solo1(session, root, agent, job.queue.shift()!, job);
    } finally {
      this.solo.delete(agent.id);
    }
  }

  private async solo1(
    session: Session,
    root: string,
    agent: AiAgent,
    task: SoloTask,
    job: { queue: SoloTask[]; agent?: LiveAgent | undefined },
  ): Promise<void> {
    const { text, fromUserId, fromName, mention } = task;
    let stopped = false;
    await this.answerCall(session.id, agent.id, task, 'working', null);
    const prompt = (
      mention
        ? [
            `You are ${agent.name}, an AI teammate in the shared session "${session.title}". ${fromName} called you into a conversation.`,
            agent.instructions ? `About you: ${agent.instructions}` : '',
            '',
            mention.context ? `The conversation so far:\n${mention.context}` : '',
            '',
            `${fromName} asked you: ${text}`,
            '',
            `Read the code here as much as you need (a copy of the session's repository, with the work so far). Do what the request needs: often that is a careful answer, sometimes a change. Editing files and running commands each wait for ${fromName}'s approval, so ask only for what you need; do not commit, push or switch branches.`,
            `Your reply goes back into the conversation, to ${fromName}: be concrete (files, lines, what is wrong and why, what to do). If you changed files, say what you changed.`,
          ]
        : [
            `You are ${agent.name}, an AI teammate in the shared session "${session.title}".`,
            agent.instructions ? `About you: ${agent.instructions}` : '',
            '',
            `${fromName} asked you: ${text}`,
            '',
            'You work alone in your own copy of the repository. Make the change in the files here; do not commit, push or switch branches.',
            'When you\'re done, reply in one or two sentences on what you changed. If you learned something durable about this codebase, end with one line starting with "Learned:".',
          ]
    )
      .filter((l, i, all) => l !== '' || all[i - 1] !== '')
      .join('\n');
    const outcome = await new Promise<SubagentOutcome>((resolve) => {
      this.deps.laneEvent(
        session.id,
        { type: 'user', text, attachments: [], at: Date.now() },
        [],
        agent.id,
      );
      void this.deps.subagents
        .start({
          sessionId: session.id,
          parentRoot: root,
          task: `${agent.name}: ${text.split('\n')[0]!.slice(0, 160)}`,
          model: agent.model,
          effort: agent.effort,
          parentMode: agent.mode,
          ...(mention ? { askFirst: (request) => this.ask(agent.id, request) } : {}),
          persona: {
            agentId: agent.id,
            name: agent.name,
            prompt,
            onEvent: (event) => {
              // Its approvals are for whoever called it in (their phone hears about them).
              this.deps.laneEvent(
                session.id,
                mention && event.type === 'approval'
                  ? { ...relative(event, root), askerId: fromUserId }
                  : relative(event, root),
                [],
                agent.id,
              );
              // What it spends counts against its limit and the workspace's; past either, it
              // stops (and what was queued for it with it).
              if (event.type === 'usage' && event.usage.cost)
                void this.spend(session.id, agent.id, event.usage.cost).then((r) => {
                  if (!r?.over || stopped) return;
                  stopped = true;
                  job.queue.length = 0;
                  job.agent?.stop();
                  this.deps.laneEvent(
                    session.id,
                    { type: 'notice', tone: 'warn', text: `Stopped: ${r.over}.` },
                    [],
                    agent.id,
                  );
                  this.deps.notify(`${agent.name} stopped`, `${r.over}.`);
                });
            },
            onAgent: (a) => (job.agent = a),
            onSettled: resolve,
          },
        })
        .catch((error: unknown) =>
          resolve({
            status: 'failed',
            detail: (error as Error).message,
            reply: null,
            checks: { passed: 0, total: 0 },
            results: [],
            verification: 'failed',
            untested: [],
            impact: null,
          }),
        );
    });
    job.agent = undefined;
    await this.answerCall(
      session.id,
      agent.id,
      task,
      outcome.status === 'answered'
        ? 'answered'
        : outcome.status === 'integrated'
          ? 'changed'
          : outcome.status === 'cancelled'
            ? 'stopped'
            : 'failed',
      outcome.status === 'answered' || outcome.status === 'integrated'
        ? (outcome.reply?.trim() ?? null)
        : (outcome.detail ?? outcome.reply?.trim() ?? null),
    );
    const learned = /^\s*Learned:\s*(.+)$/im.exec(outcome.reply ?? '')?.[1]?.trim();
    if (learned && outcome.status === 'integrated')
      await this.deps
        .request('POST', `/api/workspaces/${session.workspaceId}/learnings`, {
          kind: 'knowledge',
          text: learned.slice(0, 1000),
          verified: true,
          evidence: `${agent.name}: "${text.slice(0, 120)}" passed ${outcome.checks.passed}/${outcome.checks.total} checks`,
        })
        .catch(() => undefined);
  }

  /** Tells the conversation a teammate was called into how the call stands (nothing otherwise). */
  private async answerCall(
    sessionId: string,
    agentId: string,
    task: SoloTask,
    status: MentionStatus,
    text: string | null,
  ): Promise<void> {
    if (!task.mention?.reply) return;
    await this.deps
      .request('POST', `/api/sessions/${sessionId}/mention/answer`, {
        agentId,
        requestId: task.id,
        askerId: task.fromUserId,
        reply: task.mention.reply,
        status,
        text: text?.slice(0, 20_000) ?? null,
        asked: status === 'working' ? task.text : null,
      })
      .catch((error: unknown) => console.warn('Teammate answer not delivered:', error));
  }

  /** Waits for someone to answer a called-in teammate's approval (in the app or on a phone). */
  private ask(agentId: string, request: ApprovalRequest): Promise<boolean> {
    return new Promise((resolve) => this.asks.set(`${agentId}:${request.id}`, resolve));
  }

  /** What an AI teammate's direct task cost (0 asks); the Brain says when it must stop. */
  private spend(sessionId: string, agentId: string, amount: number) {
    return this.deps
      .request<AgentSpendReply>('POST', `/api/agents/${agentId}/spend`, { sessionId, amount })
      .catch(() => null);
  }

  stopAll(): void {
    for (const state of this.running.values()) this.halt(state);
  }

  /**
   * The app is closing: each swarm running here pauses (with why) before its agents stop, so
   * nobody takes it for still working. Waits `ms` at most for the Brain.
   */
  async pauseAll(reason: string, ms = 3_000): Promise<void> {
    const states = [...this.running.values()];
    if (states.length === 0) return;
    await Promise.race([
      Promise.allSettled(
        states.map((state) =>
          this.call(state, 'POST', `/api/swarms/${state.swarm.id}/status`, {
            status: 'paused',
            reason,
          }),
        ),
      ),
      new Promise((r) => setTimeout(r, ms)),
    ]);
    for (const state of states) this.halt(state);
  }

  /** Stops every agent of a swarm on this machine (budget reached, paused, stopped). */
  private halt(state: Running): void {
    state.abort.abort();
    state.lead?.stop();
    for (const a of state.awake.values()) a?.stop();
    for (const t of state.tasks)
      if (t.subagentId && t.state === 'running')
        void this.deps.subagents.discard(t.subagentId).catch(() => undefined);
    state.wake?.();
  }

  onMessage(message: ServerMessage): void {
    if (message.type === 'approval') {
      const { laneUserId, requestId, status } = message.approval;
      const key = `${laneUserId}:${requestId}`;
      const answer = this.asks.get(key);
      if (!answer || status === 'pending') return;
      this.asks.delete(key);
      answer(status === 'approved');
      return;
    }
    if (message.type === 'swarm') {
      const state = this.running.get(message.swarm.id);
      if (!state) return;
      state.swarm = message.swarm;
      // Launched again since (another machine took it over): this run is stale and stops.
      if (message.swarm.status !== 'running' || message.swarm.fence > state.fence) this.halt(state);
      return;
    }
    if (message.type === 'swarm.message') {
      const state = this.running.get(message.message.swarmId);
      if (state) this.deliver(state, message.message);
      return;
    }
    if (message.type === 'plan') {
      for (const state of this.running.values())
        if (state.swarm.sessionId === message.plan.sessionId)
          this.applyApprovals(state, message.plan);
      return;
    }
    if (message.type === 'swarm.control') {
      const state = this.running.get(message.swarmId);
      if (!state) return;
      for (const t of state.tasks) {
        if (t.agentId !== message.agentId || (t.state !== 'waiting' && t.state !== 'running'))
          continue;
        t.run += 1;
        if (t.subagentId) void this.deps.subagents.discard(t.subagentId).catch(() => undefined);
        t.subagentId = undefined;
        t.agent = undefined;
        t.outcome = undefined;
        if (message.action === 'reassign' && message.toId) {
          t.history.push(this.handoff(state, t, 'it was moved to another agent'));
          t.touched = new Set();
          t.agentId = message.toId;
          this.move(t, 'waiting', `Moved to ${this.name(state, message.toId)}`);
        } else {
          this.move(t, 'cancelled', 'Stopped by a person');
        }
      }
      void this.report(state, message.agentId, { status: 'stopped', task: null });
      state.wake?.();
    }
  }

  private isAgent(state: Running, id: string): boolean {
    return state.swarm.agents.some((a) => a.agentId === id);
  }

  private leadOf(state: Running): string {
    return state.swarm.leadAgentId ?? state.swarm.agents[0]!.agentId;
  }

  /**
   * A chat message as `agentId` reads it: who, what kind, its id (to answer it), and the text.
   */
  private noteOf(state: Running, m: SwarmMessage, agentId: string): Note {
    const kind = m.kind && m.kind !== 'note' ? ` (${m.kind})` : '';
    const answers = m.replyTo ? `, answering ${m.replyTo.slice(0, 8)}` : '';
    const human = !this.isAgent(state, m.fromId);
    return {
      id: m.id,
      text: `From ${m.fromName}${kind}${m.toId ? '' : ' to everyone'} [message ${m.id.slice(0, 8)}${answers}]: ${m.text}`,
      fromId: m.fromId,
      fromName: m.fromName,
      human,
      wake: m.toId !== null || (human && agentId === this.leadOf(state)),
    };
  }

  /**
   * A chat message: an answer someone waits for goes to them; for the agents it is to, straight
   * into their running turn, or it waits for their next one (and wakes an idle agent).
   */
  private deliver(state: Running, m: SwarmMessage): void {
    // Each message once: it comes again (with who has it) after it was delivered.
    if (state.seen.has(m.id)) return;
    state.seen.add(m.id);
    state.messages.set(m.id, m);
    const me = this.deps.me();
    if (m.fromId === me?.id) state.said.push(m.text);
    const human = !this.isAgent(state, m.fromId);
    // A person answered the question a task waits for: it can start, with the answer.
    if (m.replyTo && human)
      for (const t of state.tasks)
        if (t.question?.messageId === m.replyTo && !t.question.answered) {
          t.question.answered = true;
          t.history.push(`${m.fromName} answered "${t.question.text}": ${m.text}`);
          if (t.state === 'waiting_for_approval')
            this.move(t, 'waiting', `Answered by ${m.fromName}`);
          state.wake?.();
        }
    // A person answered one of the plan's open questions: every agent hears it, the tasks still
    // to come carry it, and once nothing the swarm waits for is open, the work goes on.
    const ask =
      m.replyTo && human
        ? state.asks.find((a) => a.messageId === m.replyTo && !a.answered)
        : undefined;
    if (ask) {
      ask.answered = true;
      const line = `${m.fromName} answered the open question "${ask.text}": ${m.text}`;
      for (const t of state.tasks)
        if (['waiting', 'waiting_for_approval', 'running'].includes(t.state)) t.history.push(line);
      for (const a of state.swarm.agents)
        if (a.agentId !== m.toId)
          this.hand(state, a.agentId, {
            id: `${m.id}:${a.agentId}`,
            text: line,
            fromId: m.fromId,
            fromName: m.fromName,
            human: true,
            lane: true,
            wake: false,
          });
      if (!state.asks.some((a) => a.hold && !a.answered))
        for (const t of state.tasks)
          if (t.state === 'waiting_for_approval' && t.why === HOLD)
            this.move(t, 'waiting', `Answered by ${m.fromName}`);
      state.wake?.();
    }
    const waiter = m.replyTo ? state.waiters.get(m.replyTo) : undefined;
    const to = m.toId
      ? this.isAgent(state, m.toId)
        ? [m.toId]
        : []
      : state.swarm.agents.map((a) => a.agentId).filter((id) => id !== m.fromId);
    for (const id of to) {
      if (id === m.fromId || (m.deliveredTo ?? []).includes(id)) continue;
      // The answer to its question: the waiting tool hands it over (the model reads it there).
      if (waiter?.agentId === id) {
        state.waiters.delete(m.replyTo!);
        waiter.resolve(m);
        continue;
      }
      this.hand(state, id, this.noteOf(state, m, id));
    }
  }

  /** The agent's running turn, if it has one now: its task, the lead's turn, or an answer. */
  private liveOf(state: Running, agentId: string): LiveAgent | undefined {
    if (agentId === this.leadOf(state) && state.lead?.running) return state.lead;
    const awake = state.awake.get(agentId);
    if (awake?.running) return awake;
    return state.tasks.find(
      (t) => t.agentId === agentId && t.agent?.running && t.state === 'running',
    )?.agent;
  }

  /**
   * Into the agent's running turn; or kept for its next turn, waking it if it is idle. Another
   * agent's announcement to everyone doesn't interrupt work: it waits for the next turn.
   */
  private hand(state: Running, agentId: string, note: Note): void {
    const live = note.human || note.wake ? this.liveOf(state, agentId) : undefined;
    if (
      live?.steer({
        id: note.id,
        text: note.text,
        fromUserId: note.fromId,
        fromName: note.fromName,
      })
    ) {
      // Delivered once its model has it (the turn says so), not now.
      if (!note.lane) {
        const who = state.steered.get(note.id) ?? new Set<string>();
        who.add(agentId);
        state.steered.set(note.id, who);
      }
      return;
    }
    this.queue(state, agentId, note);
    this.wakeIfIdle(state, agentId);
  }

  private queue(state: Running, agentId: string, note: Note): void {
    const box = state.inbox.get(agentId) ?? [];
    if (!box.some((n) => n.id === note.id)) box.push(note);
    state.inbox.set(agentId, box);
  }

  /** Whether the agent is in a turn, or about to be (its task runs, the lead plans or reviews). */
  private busy(state: Running, agentId: string): boolean {
    if (state.awake.has(agentId)) return true;
    if (state.tasks.some((t) => t.agentId === agentId && t.state === 'running')) return true;
    // The lead's split, replan and review read its messages; only the work phase leaves it idle.
    return agentId === this.leadOf(state) && (state.phase !== 'work' || Boolean(state.lead));
  }

  /**
   * An idle agent with messages gets a short turn to answer them: always for people's (up to a
   * limit), a few times a run for other agents', so two agents can't keep waking each other.
   */
  private wakeIfIdle(state: Running, agentId: string): void {
    if (this.stopped(state) || state.phase === 'end') return;
    const box = state.inbox.get(agentId);
    if (!box?.some((n) => n.wake) || this.busy(state, agentId)) return;
    // A worker with work still coming reads them in its next task's prompt (guidance belongs
    // there); only one with nothing left is woken. The lead coordinates, so it is woken anyway.
    if (agentId !== this.leadOf(state)) {
      if (state.phase === 'split' || state.phase === 'replan') return;
      if (
        state.tasks.some(
          (t) =>
            t.agentId === agentId && (t.state === 'waiting' || t.state === 'waiting_for_approval'),
        )
      )
        return;
    }
    const woken = state.wakes.get(agentId) ?? { people: 0, agents: 0 };
    if (box.some((n) => n.wake && n.human)) {
      if (woken.people >= MAX_PEOPLE_WAKES) return;
      woken.people += 1;
    } else {
      if (woken.agents >= MAX_AGENT_WAKES) return;
      woken.agents += 1;
    }
    state.wakes.set(agentId, woken);
    state.awake.set(agentId, null);
    const turn: Promise<void> = this.answer(state, agentId)
      .catch((error: unknown) => console.warn('Swarm answer turn failed:', error))
      .finally(() => {
        state.awake.delete(agentId);
        state.wakeTurns.delete(turn);
        state.wake?.();
        // More came while it answered (or its turn ended before its model had them).
        this.wakeIfIdle(state, agentId);
      });
    state.wakeTurns.add(turn);
  }

  /**
   * A turn of an idle agent for the messages it has: it reads the code (no edits), answers with
   * message_agent, and the lead, while the work runs, may add tasks. Paid from the swarm's budget.
   */
  private async answer(state: Running, agentId: string): Promise<void> {
    const leadId = this.leadOf(state);
    const isLead = agentId === leadId;
    const agent = state.agents.get(agentId);
    const name = this.name(state, agentId);
    const notes = this.inboxFor(state, agentId);
    if (notes.length === 0) return;
    const workers = state.swarm.agents.filter((a) => a.role === 'worker');
    const crew = workers.length ? workers : state.swarm.agents;
    const out: Split = {
      tasks: [],
      assumptions: [],
      questions: [],
      waitForAnswers: false,
      ordered: [],
    };
    const planning = isLead && state.phase === 'work';
    const prompt = [
      `You are ${name}, ${isLead ? 'the lead' : 'an AI teammate'} of a swarm working on: ${state.swarm.goal}`,
      agent?.instructions ? `About you: ${agent.instructions}` : '',
      '',
      'Where the work stands:',
      ...this.statusLines(state),
      '',
      ...notes,
      '',
      'You are not working on a task right now: you were woken for these messages. Answer what needs an answer with message_agent (set reply_to to the message you answer). You can read the code; you cannot edit here.',
      planning
        ? 'If a person asks for more work, or what you hear needs work nobody has, add it with assign_tasks: new ids, depending only on each other; it joins the running plan.'
        : '',
      'If nothing needs saying, reply "Nothing to add." and stop.',
    ]
      .filter((l, i, all) => l !== '' || all[i - 1] !== '')
      .join('\n');
    await this.report(state, agentId, { status: 'working', task: 'Answering messages' });
    await this.deps.run({
      root: state.root,
      model: agent?.model ?? 'openai/gpt-5.6-luna',
      effort: agent?.effort ?? null,
      mode: 'plan',
      task: prompt,
      tools: [
        ...(planning ? [this.assignTool(state, crew, `m${state.added + 1}:`, out)] : []),
        ...this.chatTools(state, agentId),
      ],
      approve: async () => false,
      onEvent: this.stream(state, agentId, state.root, 'Answering messages'),
      onAgent: (a) => state.awake.set(agentId, a),
      signal: state.abort.signal,
      ...this.coordination(state, state.root),
    });
    await this.report(state, agentId, { status: 'idle', task: null });
    if (out.tasks.length && !this.stopped(state)) {
      state.added += 1;
      await this.addToPlan(state, agentId, out);
      state.wake?.();
    }
  }

  /**
   * What every swarm run gets to stay out of others' way: a check before each write (the file
   * or its neighbours being changed or locked in another live session) and a note of the team's
   * work, read again between its steps.
   */
  private coordination(
    state: Running,
    root: string,
  ): Pick<DetachedRun, 'checkWrite' | 'turnContext'> {
    const check = new WriteCheck({
      root,
      others: async () => (await this.liveNow(state)).work,
    });
    return {
      checkWrite: (path) =>
        check.check(isAbsolute(path) ? relativePath(root, path).replace(/\\/g, '/') : path),
      turnContext: () => this.teamNote(state),
    };
  }

  private liveNow(state: Running): Promise<{ work: LiveWork[]; locks: PathLock[] }> {
    if (state.live && Date.now() - state.live.at < 10_000) return state.live.value;
    const workspaceId = state.session.workspaceId;
    const value = Promise.all([
      liveWorkOf(
        (method, path) => this.deps.request(method, path),
        workspaceId,
        state.swarm.sessionId,
      ).catch(() => [] as LiveWork[]),
      this.deps
        .request<{ locks: PathLock[] }>('GET', `/api/workspaces/${workspaceId}/locks`)
        .then((r) => r.locks)
        .catch(() => [] as PathLock[]),
    ]).then(([work, locks]) => ({ work, locks }));
    state.live = { at: Date.now(), value };
    return value;
  }

  /** The team note of a swarm run: its swarm's tasks, people's locks, other sessions' work. */
  private async teamNote(state: Running): Promise<string | null> {
    const { work, locks } = await this.liveNow(state);
    const theirs = locks.filter((l) => !this.isAgent(state, l.userId));
    const busy = work.filter((w) => w.touched.length || w.planned.length);
    return [
      'Your swarm now:',
      ...this.statusLines(state),
      ...(theirs.length
        ? [
            "LOCKED by people (don't edit these files; if you must, message them first):",
            ...theirs.map((l) => `- ${l.path} (locked by ${l.userName})`),
          ]
        : []),
      ...(busy.length
        ? [
            'Other sessions changing this code now (stay off their files, or message the people):',
            ...busy
              .slice(0, 8)
              .map(
                (w) =>
                  `- "${w.title}" (${w.people.join(', ') || 'a teammate'}): ${[...new Set([...w.touched, ...w.planned])].slice(0, 12).join(', ')}`,
              ),
          ]
        : []),
    ].join('\n');
  }

  /** One line per task for an agent: who does it and where it stands. */
  private statusLines(state: Running): string[] {
    if (state.tasks.length === 0) return ['- No tasks yet: the lead is splitting the goal.'];
    return state.tasks.map(
      (t) =>
        `- ${this.name(state, t.agentId)}: ${t.title} → ${t.state.replace(/_/g, ' ')}${t.why && t.state !== 'running' ? ` (${t.why.split('\n')[0]!.slice(0, 120)})` : ''}`,
    );
  }

  private async report(
    state: Running,
    agentId: string,
    input: {
      status?: 'idle' | 'working' | 'done' | 'stopped';
      task?: string | null;
      cost?: number;
      stepId?: string;
    },
  ): Promise<SwarmReportReply | null> {
    const r = await this.call<SwarmReportReply>(
      state,
      'POST',
      `/api/swarms/${state.swarm.id}/report`,
      {
        agentId,
        ...input,
      },
    ).catch(() => null);
    if (!r) return null;
    state.swarm = r.swarm;
    // The Brain keeps the budgets: past the swarm's or the workspace's, everything here stops.
    if (r.swarm.status !== 'running') this.halt(state);
    return r;
  }

  /**
   * A request made for a running swarm carries its run's fence: once the swarm is launched
   * again elsewhere, the Brain refuses it and this run stops instead of writing over the new.
   */
  private async call<T>(
    state: Running,
    method: 'GET' | 'POST' | 'PATCH' | 'PUT',
    path: string,
    body?: unknown,
  ): Promise<T> {
    try {
      return await this.deps.request<T>(method, path, body, {
        fence: `${state.swarm.id}:${state.fence}`,
      });
    } catch (error) {
      if ((error as { code?: unknown }).code === 'stale_run' && !state.abort.signal.aborted) {
        console.warn(`Swarm ${state.swarm.id}: started again elsewhere; this run stops.`);
        this.halt(state);
      }
      throw error;
    }
  }

  private stopped(state: Running): boolean {
    return state.abort.signal.aborted || state.swarm.status !== 'running';
  }

  // ---------- the run ----------

  private async drive(state: Running): Promise<void> {
    const sessionId = state.swarm.sessionId;
    const leadId = state.swarm.leadAgentId ?? state.swarm.agents[0]!.agentId;
    const known = await this.context(state);
    await this.unread(state);

    // Resuming: the agents' unfinished plan steps are the work; a new swarm is split first.
    if (state.resumed) {
      const { plan } = await this.call<{ plan: Plan }>(
        state,
        'GET',
        `/api/sessions/${sessionId}/plan`,
      );
      const ids = new Set(state.swarm.agents.map((a) => a.agentId));
      const done = new Set(plan.steps.filter((s) => s.status === 'done').map((s) => s.id));
      state.tasks = plan.steps
        .filter((s) => s.ownerId && ids.has(s.ownerId) && s.status !== 'done')
        .map((s) => ({
          key: s.id,
          stepId: s.id,
          title: s.title,
          detail: s.detail,
          acceptance: s.acceptance,
          acceptanceCheck: proofOf(s.acceptance),
          // Finished steps are behind it; the others are its graph.
          dependsOn: s.dependsOn.filter((d) => !done.has(d)),
          files: s.files,
          touched: new Set<string>(),
          history:
            s.runState === 'failed' && s.runDetail ? [`An earlier run failed: ${s.runDetail}`] : [],
          reruns: 0,
          agentId: s.ownerId!,
          approval: s.approval,
          approvalReason: s.approvalReason,
          // What a stop or a crash left: it runs again (failed and blocked work is retried).
          state: s.runState ?? 'waiting',
          why: s.runDetail,
          attempts: 0,
          cost: 0,
          run: 0,
          sync: Promise.resolve(),
          ...this.questionOf(state, s.title, s.runDetail),
        }));
      for (const t of state.tasks)
        if (t.state !== 'waiting' && t.state !== 'waiting_for_approval')
          this.move(t, 'waiting', null);
    }
    if (state.tasks.length === 0) {
      state.phase = 'split';
      await this.plan(state, leadId, known);
      if (this.stopped(state)) return;
      if (state.tasks.length === 0)
        throw new Error(`${this.name(state, leadId)} didn't split the goal into tasks`);
    }

    await this.work(state, known);
    if (this.stopped(state)) return this.wrapUp(state);
    if (await this.replan(state, leadId, known)) {
      await this.work(state, known);
      if (this.stopped(state)) return this.wrapUp(state);
    }
    state.phase = 'review';
    await this.review(state, leadId, known);
    // Agents still answering messages finish before the swarm says it is done.
    await Promise.allSettled([...state.wakeTurns]);
    state.phase = 'end';
    if (this.stopped(state)) return this.wrapUp(state);
    await this.wrapUp(state);
    // The facts last: what was verified, what failed or never ran, and what it cost.
    await this.call(state, 'POST', `/api/swarms/${state.swarm.id}/messages`, {
      fromId: leadId,
      toId: null,
      text: this.completionReport(state).slice(0, 4000),
    }).catch(() => undefined);
    for (const a of state.swarm.agents)
      await this.report(state, a.agentId, { status: 'done', task: null });
    const count = (s: TaskState) => state.tasks.filter((t) => t.state === s).length;
    await this.call(state, 'POST', `/api/swarms/${state.swarm.id}/status`, {
      status: 'done',
      // How the tasks ended, so "done" can't read as success when they failed.
      outcome: {
        tasks: state.tasks.length,
        done: count('done'),
        failed: count('failed'),
        blocked: count('blocked'),
        stopped: count('cancelled'),
      },
    });
  }

  /**
   * A resumed task that was waiting for a person's answer: its question from the chat, and the
   * answer if one came while the swarm was paused.
   */
  private questionOf(
    state: Running,
    title: string,
    detail: string | null,
  ): Pick<Task, 'question' | 'history'> | Record<string, never> {
    const prefix = 'Waiting for an answer: ';
    if (!detail?.startsWith(prefix)) return {};
    const text = detail.slice(prefix.length);
    const asked = [...state.messages.values()]
      .filter((m) => m.kind === 'question' && m.text.includes(`"${title}"`))
      .at(-1);
    const answer = asked
      ? [...state.messages.values()].find(
          (m) => m.replyTo === asked.id && !this.isAgent(state, m.fromId),
        )
      : undefined;
    return {
      question: { text, messageId: asked?.id ?? null, answered: Boolean(answer) || !asked },
      history: answer ? [`${answer.fromName} answered "${text}": ${answer.text}`] : [],
    };
  }

  /** What the team knows, and how the person running the swarm likes work done (accepted only). */
  private async context(state: Running): Promise<string[]> {
    const { learnings } = await this.call<{ learnings: Learning[] }>(
      state,
      'GET',
      `/api/workspaces/${state.session.workspaceId}/learnings`,
    ).catch(() => ({ learnings: [] as Learning[] }));
    const me = this.deps.me();
    const knowledge = learnings.filter((l) => l.kind === 'knowledge' && l.status === 'accepted');
    const prefs = learnings.filter(
      (l) => l.kind === 'preference' && l.status === 'accepted' && l.ownerId === me?.id,
    );
    return [
      ...(knowledge.length
        ? ['What the team has learned:', ...knowledge.slice(0, 20).map((l) => `- ${l.text}`)]
        : []),
      ...(prefs.length
        ? [
            `How ${me?.name ?? 'the person running this'} likes work done:`,
            ...prefs.map((l) => `- ${l.text}`),
          ]
        : []),
    ];
  }

  private name(state: Running, agentId: string): string {
    return (
      state.agents.get(agentId)?.name ??
      state.swarm.agents.find((a) => a.agentId === agentId)?.name ??
      'an agent'
    );
  }

  /** The people of the session (not AI teammates): agents may write to them. */
  private people(state: Running): { userId: string; name: string }[] {
    const people = state.session.participants
      .filter((p) => p.kind === 'human')
      .map((p) => ({ userId: p.userId, name: p.name }));
    // Whoever runs the swarm, even when they aren't in the session's lanes.
    const { launchedBy, launchedByName } = state.swarm;
    if (launchedBy && launchedByName && !people.some((p) => p.userId === launchedBy))
      people.push({ userId: launchedBy, name: launchedByName });
    return people;
  }

  /** A message id the agent gave (the first characters are enough), if this run has seen it. */
  private messageId(state: Running, given: unknown): string | null {
    const id = String(given ?? '')
      .trim()
      .toLowerCase();
    if (id.length < 4) return null;
    return [...state.messages.keys()].find((m) => m.startsWith(id)) ?? null;
  }

  /** The tools every agent of the swarm gets: talking to the others and to the people. */
  private chatTools(state: Running, agentId: string): Tool[] {
    const names = state.swarm.agents.filter((a) => a.agentId !== agentId).map((a) => a.name);
    const people = this.people(state).map((p) => p.name);
    const lead = this.name(state, this.leadOf(state));
    return [
      {
        spec: {
          name: 'message_agent',
          description: `Send a short message to another agent of your swarm (${names.join(', ') || 'none'}; "lead" is ${lead}), to everyone, or to a person of the session (${people.join(', ') || 'none'}): ask a question, warn about a change that touches their task, say what blocks you, or answer. Answering a message, set reply_to to its id. A question can wait for its answer (wait: true): use that when you can't go on without it. Don't use it for progress updates nobody needs.`,
          parameters: {
            type: 'object',
            properties: {
              to: {
                type: 'string',
                description: 'An agent\'s name, "lead", "everyone", or a person\'s name',
              },
              text: { type: 'string' },
              kind: {
                type: 'string',
                enum: ['note', 'question', 'answer', 'blocker'],
                description: 'What it is (default note; an answer when reply_to is set)',
              },
              reply_to: { type: 'string', description: 'The id of the message this answers' },
              wait: {
                type: 'boolean',
                description: 'For a question: wait here for the answer (up to some minutes)',
              },
            },
            required: ['to', 'text'],
            additionalProperties: false,
          },
        },
        kind: 'team',
        describe: (a) => `Messaged ${String(a['to'] ?? 'everyone')}`,
        run: async (a, ctx) => {
          const to = String(a['to'] ?? '')
            .trim()
            .toLowerCase();
          const target =
            to === 'lead'
              ? state.swarm.agents.find((x) => x.agentId === this.leadOf(state))
              : state.swarm.agents.find((x) => x.name.toLowerCase() === to);
          const person = target
            ? undefined
            : this.people(state).find((p) => p.name.toLowerCase() === to);
          if (to !== 'everyone' && !target && !person)
            return {
              ok: false,
              output: `No one called ${String(a['to'])}; pick one of ${[...names, 'lead', 'everyone', ...people].join(', ')}`,
            };
          if (target?.agentId === agentId) return { ok: false, output: "That's you." };
          const replyTo = a['reply_to'] ? this.messageId(state, a['reply_to']) : null;
          if (a['reply_to'] && !replyTo)
            return { ok: false, output: `No message ${String(a['reply_to'])} here to answer.` };
          const kinds = ['note', 'question', 'answer', 'blocker'];
          const kind = kinds.includes(String(a['kind']))
            ? String(a['kind'])
            : replyTo
              ? 'answer'
              : 'note';
          const body = {
            fromId: agentId,
            toId: target?.agentId ?? person?.userId ?? null,
            text: String(a['text'] ?? '').slice(0, 4000),
            kind,
            replyTo,
            // The same message once, even if its request is sent again.
            key: randomUUID(),
          };
          const send = () =>
            this.call<{ message: SwarmMessage }>(
              state,
              'POST',
              `/api/swarms/${state.swarm.id}/messages`,
              body,
            );
          // A lost answer is sent again: the key keeps it one message.
          const { message } = await send().catch((error: unknown) =>
            (error as { status?: number }).status ? Promise.reject(error) : send(),
          );
          // Known here for replies; the Brain sends it back to hand it to its recipients.
          state.messages.set(message.id, message);
          // Answering it means it was read.
          if (replyTo) this.read(state, agentId, [replyTo]);
          if (!(a['wait'] === true && kind === 'question' && body.toId))
            return { ok: true, output: `Sent (message ${message.id.slice(0, 8)}).` };
          const waitMs = this.deps.replyWaitMs ?? REPLY_WAIT_MS;
          const answer = await new Promise<SwarmMessage | null>((resolve) => {
            const done = (m: SwarmMessage | null) => {
              clearTimeout(timer);
              ctx.signal.removeEventListener('abort', stop);
              state.waiters.delete(message.id);
              resolve(m);
            };
            const timer = setTimeout(() => done(null), waitMs);
            const stop = () => done(null);
            ctx.signal.addEventListener('abort', stop, { once: true });
            state.waiters.set(message.id, { agentId, resolve: done });
          });
          if (!answer)
            return {
              ok: true,
              output: `Sent (message ${message.id.slice(0, 8)}), but no answer came in ${Math.round(waitMs / 60_000) || 1} minute(s). Go on with what you have and say what you assumed; an answer that comes later reaches you as a message.`,
            };
          state.seen.add(answer.id);
          state.messages.set(answer.id, answer);
          this.delivered(state, agentId, [answer.id]);
          return { ok: true, output: `${answer.fromName} answered: ${answer.text}` };
        },
      },
      {
        spec: {
          name: 'read_messages',
          description:
            "The swarm chat's latest messages to you or to everyone (with their ids, to answer them). New ones also come to you by themselves while you work.",
          parameters: {
            type: 'object',
            properties: {
              limit: { type: 'number', description: 'How many, newest last (default 15)' },
            },
            additionalProperties: false,
          },
        },
        kind: 'team',
        describe: () => 'Read the swarm chat',
        run: async (a) => {
          const limit = Math.min(Math.max(Number(a['limit']) || 15, 1), 50);
          const mine = [...state.messages.values()]
            .filter((m) => m.fromId !== agentId && (m.toId === agentId || m.toId === null))
            .slice(-limit);
          if (mine.length === 0) return { ok: true, output: 'No messages for you.' };
          // They're seen now: not handed over again, and read.
          state.inbox.set(
            agentId,
            (state.inbox.get(agentId) ?? []).filter((n) => !mine.some((m) => m.id === n.id)),
          );
          this.read(
            state,
            agentId,
            mine.map((m) => m.id),
          );
          return {
            ok: true,
            output: mine.map((m) => `- ${this.noteOf(state, m, agentId).text}`).join('\n'),
          };
        },
      },
    ];
  }

  private stream(state: Running, agentId: string, root: string, title: string, task?: Task) {
    const sessionId = state.swarm.sessionId;
    this.deps.laneEvent(
      sessionId,
      { type: 'user', text: title, attachments: [], at: Date.now() },
      [],
      agentId,
    );
    return (event: AgentEvent) => {
      if (event.type === 'usage' && event.usage.cost)
        void this.report(state, agentId, {
          cost: event.usage.cost,
          ...(task?.stepId ? { stepId: task.stepId } : {}),
        }).then((r) => {
          // Past its own budget (the Brain's word), the task stops here.
          if (task && r?.step?.over && !task.overBudget) {
            task.overBudget = `It went over its budget: ${usd(r.step.spent)} of ${usd(r.swarm.taskBudget ?? 0)}`;
            if (task.subagentId)
              void this.deps.subagents.discard(task.subagentId).catch(() => undefined);
          }
        });
      // A call with no known price: the spend shown is lower than the real one.
      if (event.type === 'usage' && event.kind === 'model' && event.usage.cost === null)
        state.unpriced += 1;
      // A chat message handed to its turn: delivered once its model has it; back to its inbox
      // when the turn ended first.
      const waiting = event.type === 'steer' ? state.steered.get(event.id) : undefined;
      if (event.type === 'steer' && waiting?.has(agentId)) {
        waiting.delete(agentId);
        if (waiting.size === 0) state.steered.delete(event.id);
        const m = state.messages.get(event.id);
        if (event.status === 'delivered') this.delivered(state, agentId, [event.id]);
        else if (m) this.queue(state, agentId, this.noteOf(state, m, agentId));
      }
      // Its model said something after having them: they're read.
      if (event.type === 'text' || event.type === 'tool_start') this.answered(state, agentId);
      this.deps.laneEvent(sessionId, relative(event, root), [], agentId);
    };
  }

  /** The agent's waiting messages, for the prompt of its next turn (they're delivered then). */
  private inboxFor(state: Running, agentId: string): string[] {
    const box = state.inbox.get(agentId) ?? [];
    state.inbox.delete(agentId);
    if (box.length === 0) return [];
    this.delivered(
      state,
      agentId,
      box.map((m) => m.id),
    );
    const shown = box.slice(-PROMPT_MESSAGES);
    return [
      'Messages for you (answer with message_agent, reply_to their id):',
      ...(box.length > shown.length
        ? [`(${box.length - shown.length} older ones are left out here: read_messages shows them)`]
        : []),
      ...shown.map((m) => `- ${m.text}`),
    ];
  }

  /**
   * Messages written while the swarm wasn't running here (paused, or before it started):
   * each agent finds the ones it doesn't have yet at its next turn.
   */
  private async unread(state: Running): Promise<void> {
    const messages =
      (
        await this.call<{
          messages?: SwarmMessage[];
        }>(state, 'GET', `/api/swarms/${state.swarm.id}/messages`).catch(() => null)
      )?.messages ?? [];
    const ids = state.swarm.agents.map((a) => a.agentId);
    for (const m of messages) {
      // Already here from the live channel: once is enough.
      if (state.seen.has(m.id)) continue;
      state.seen.add(m.id);
      state.messages.set(m.id, m);
      for (const id of m.toId ? [m.toId] : ids) {
        if (id === m.fromId || !ids.includes(id)) continue;
        if ((m.readBy ?? []).includes(id)) continue;
        // In its model's context in an earlier run that ended: it gets it again.
        this.queue(state, id, this.noteOf(state, m, id));
      }
    }
  }

  /** Tells the swarm's chat that an agent's model has these messages now (queued until then). */
  private delivered(state: Running, agentId: string, ids: string[]): void {
    // Only the chat's own messages have a receipt (not what was written in a lane).
    const chat = ids.filter((id) => state.messages.has(id));
    if (chat.length === 0) return;
    const open = state.unanswered.get(agentId) ?? [];
    state.unanswered.set(agentId, [...open, ...chat.filter((id) => !open.includes(id))]);
    void this.call(state, 'POST', `/api/swarms/${state.swarm.id}/messages/delivered`, {
      agentId,
      ids: chat,
    }).catch(() => undefined);
  }

  /** Its model answered after it had them: the chat shows them read. */
  private answered(state: Running, agentId: string): void {
    const ids = state.unanswered.get(agentId);
    if (!ids?.length) return;
    state.unanswered.delete(agentId);
    this.read(state, agentId, ids);
  }

  private read(state: Running, agentId: string, ids: string[]): void {
    const chat = ids.filter((id) => state.messages.has(id));
    if (chat.length === 0) return;
    void this.call(state, 'POST', `/api/swarms/${state.swarm.id}/messages/read`, {
      agentId,
      ids: chat.slice(0, 100),
    }).catch(() => undefined);
  }

  /**
   * An independent review of a task's change once its checks pass: the lead reads it, or,
   * when the lead did the work, another agent of the swarm (the same agent only when there is
   * no other, then in a fresh context). It judges the diff against the task and what done
   * means; without a clear yes, the work doesn't join.
   */
  private async reviewTask(state: Running, task: Task, input: ReviewInput): Promise<ReviewVerdict> {
    const leadId = state.swarm.leadAgentId ?? state.swarm.agents[0]!.agentId;
    const reviewerId =
      leadId !== task.agentId
        ? leadId
        : (state.swarm.agents.find((a) => a.agentId !== task.agentId)?.agentId ?? leadId);
    const reviewer = state.agents.get(reviewerId);
    const by = this.name(state, reviewerId);
    let verdict: {
      approve: boolean;
      acceptanceMet: boolean | null;
      issues: string[];
      notes: string;
    } | null = null;
    const tool: Tool = {
      spec: {
        name: 'review_verdict',
        description:
          'Give your verdict on the change, once. Approve only if it does the task and meets what done means; otherwise list concrete problems the author can fix.',
        parameters: {
          type: 'object',
          properties: {
            approve: { type: 'boolean' },
            acceptance_met: {
              type: 'boolean',
              description: 'Whether the change meets "done means" (omit if the task has none)',
            },
            issues: {
              type: 'array',
              items: { type: 'string' },
              description: 'Concrete problems, each fixable ("median() ignores an empty list")',
            },
            notes: {
              type: 'string',
              description: 'Anything the team should know: limits, what is not covered',
            },
          },
          required: ['approve'],
          additionalProperties: false,
        },
      },
      kind: 'team',
      describe: (a) => (a['approve'] ? 'Approved the change' : 'Asked for changes'),
      run: async (a) => {
        verdict = {
          approve: a['approve'] === true,
          acceptanceMet: typeof a['acceptance_met'] === 'boolean' ? a['acceptance_met'] : null,
          issues: Array.isArray(a['issues'])
            ? a['issues'].map((x) => String(x).slice(0, 300)).slice(0, 10)
            : [],
          notes: typeof a['notes'] === 'string' ? a['notes'].slice(0, 600) : '',
        };
        return { ok: true, output: 'Verdict recorded. Reply with one sentence.' };
      },
    };
    const checks = input.results.map((c) => `- ${c.name}: ${c.status}`).join('\n');
    const prompt = [
      `You are ${by}, reviewing ${this.name(state, task.agentId)}'s change in a swarm working on: ${state.swarm.goal}`,
      reviewer?.instructions ? `About you: ${reviewer.instructions}` : '',
      reviewerId === task.agentId
        ? 'You wrote this change in another context; review it as if someone else had.'
        : '',
      '',
      `The task: ${task.title}`,
      task.detail ?? '',
      task.acceptance
        ? `Done means: ${task.acceptance}`
        : 'The task names no "done means"; judge it by the task itself.',
      '',
      'Its checks passed:',
      checks,
      '',
      input.impact && input.impact.links.length
        ? `What the change can reach (look at these too; "mentions" links are the least sure):\n${input.impact.links
            .slice(0, 15)
            .map((l: ImpactLink) => `- ${l.path} (${l.kind}, ${l.certainty.replace('_', ' ')})`)
            .join('\n')}`
        : '',
      '',
      'The change:',
      input.diff || '(no diff)',
      '',
      'You can read the files here to see the change in context; you cannot edit. Then call review_verdict once.',
    ]
      .filter((l, i, all) => l !== '' || all[i - 1] !== '')
      .join('\n');
    const end = await this.deps.run({
      root: input.root,
      model: reviewer?.model ?? 'openai/gpt-5.6-luna',
      effort: reviewer?.effort ?? null,
      mode: 'plan',
      task: prompt,
      tools: [tool],
      approve: async () => false,
      onEvent: this.stream(state, reviewerId, input.root, `Review: ${task.title}`, task),
      signal: state.abort.signal,
    });
    const v = verdict as {
      approve: boolean;
      acceptanceMet: boolean | null;
      issues: string[];
      notes: string;
    } | null;
    if (!v)
      return {
        approved: false,
        by,
        detail:
          end.reason === 'done'
            ? 'The reviewer gave no verdict'
            : `The review stopped: ${end.error ?? end.reason}`,
      };
    if (v.notes) task.reviewNotes = `${by}: ${v.notes}`;
    // "Done means" not met is a no, whatever else it says.
    const approved = v.approve && v.acceptanceMet !== false;
    const issues = [
      ...(v.acceptanceMet === false && task.acceptance
        ? [`It doesn't meet "${task.acceptance}"`]
        : []),
      ...v.issues,
    ];
    return {
      approved,
      by,
      detail: approved ? v.notes || null : issues.join('; ') || 'Not approved',
    };
  }

  /**
   * What the next agent on a task should know about the last attempt: who worked on it, why it
   * stopped, what it changed and said, which checks failed. Its changes are not kept.
   */
  private handoff(state: Running, task: Task, why: string, outcome?: SubagentOutcome): string {
    const failedChecks = (outcome?.results ?? []).filter((c) => c.status !== 'passed');
    return [
      `${this.name(state, task.agentId)} worked on this before and stopped: ${why}.`,
      task.touched.size ? `It changed: ${[...task.touched].join(', ')}.` : '',
      outcome?.reply ? `It said: ${outcome.reply.replace(/\n+/g, ' ').slice(0, 300)}` : '',
      failedChecks.length
        ? `Its checks: ${failedChecks.map((c) => `${c.name} ${c.status}${c.detail ? ` (${c.detail.split('\n')[0]!.slice(0, 160)})` : ''}`).join('; ')}.`
        : '',
      "Its changes were not kept: start from the files as they are now, and don't repeat what failed.",
    ]
      .filter(Boolean)
      .join('\n');
  }

  /** Takes people's answers from the plan: a yes lets a task start, a no stops it. */
  private applyApprovals(state: Running, plan: Plan): void {
    let changed = false;
    for (const step of plan.steps) {
      const task = state.tasks.find((t) => t.stepId === step.id);
      if (!task || task.approval === step.approval || !step.approval) continue;
      task.approval = step.approval;
      if (task.state !== 'waiting_for_approval') continue;
      const who =
        state.session.participants.find((p) => p.userId === step.approvedBy)?.name ?? 'a teammate';
      if (step.approval === 'approved') this.move(task, 'waiting', `Approved by ${who}`);
      if (step.approval === 'rejected') this.move(task, 'cancelled', `Rejected by ${who}`);
      changed = true;
    }
    if (changed) state.wake?.();
  }

  private async checkApprovals(state: Running): Promise<void> {
    const r = await this.call<{ plan: Plan }>(
      state,
      'GET',
      `/api/sessions/${state.swarm.sessionId}/plan`,
    ).catch(() => null);
    if (r) this.applyApprovals(state, r.plan);
  }

  /**
   * Moves a task to another state, here at once and on its plan step in order (the Brain checks
   * every move and records where the task ends up). A move the lifecycle doesn't allow is a bug.
   */
  private move(task: Task, to: TaskState, why: string | null): void {
    if (!canMoveTask(task.state, to)) {
      console.warn(`Swarm task "${task.title}" can't go from ${task.state} to ${to}`);
      return;
    }
    if (task.state === to && task.why === why) return;
    task.state = to;
    task.why = why;
    this.sendState(task);
  }

  private sendState(task: Task): void {
    const { stepId, state: runState, why: runDetail } = task;
    if (!stepId) return;
    // The run the task belongs to: its fence goes with the update.
    const state = [...this.running.values()].find((r) => r.tasks.includes(task));
    const body = { runState, runDetail: runDetail?.slice(0, 2000) ?? null };
    task.sync = task.sync.then(() =>
      (state
        ? this.call<unknown>(state, 'PATCH', `/api/plan-steps/${stepId}`, body)
        : this.deps.request<unknown>('PATCH', `/api/plan-steps/${stepId}`, body)
      )
        .then(() => undefined)
        .catch((error: unknown) => console.warn('Swarm task state not saved:', error)),
    );
  }

  /** A stopped swarm is over: whatever didn't finish is cancelled. */
  private async wrapUp(state: Running): Promise<void> {
    if (state.swarm.status === 'stopped')
      for (const t of state.tasks)
        if (t.state !== 'done' && t.state !== 'cancelled' && t.state !== 'failed')
          this.move(t, 'cancelled', 'The swarm was stopped');
    await Promise.all(state.tasks.map((t) => t.sync));
  }

  /**
   * The lead's tool for splitting work into a graph of tasks. Each task names its agent, what
   * done means, what it depends on, and, when a person must say yes first, why. The lead also
   * writes down what it assumed and what it couldn't tell. Keys get `prefix`, so a later plan
   * can't collide with the first one.
   */
  /**
   * The lead adds a teammate the team lacks (a database or security specialist, say) through
   * the workspace's agent factory; it joins the swarm and can take tasks right away.
   */
  private hireTool(state: Running, crew: Swarm['agents']): Tool {
    return {
      spec: {
        name: 'add_teammate',
        description:
          "Add a new AI teammate to the workspace and this swarm, only when nobody on the team fits a task (for example a database, security or accessibility specialist). Prefer the team you have; a swarm adds at most two. Give them a person's first name in English (Leo, Nora; never a model or tool name), their role in one or two sentences, and why the team needs them. Then give them tasks with assign_tasks.",
        parameters: {
          type: 'object',
          properties: {
            name: { type: 'string', description: "A person's first name in English" },
            role: { type: 'string', description: 'What they are good at and how they work' },
            reason: { type: 'string', description: 'Why the team needs them' },
          },
          required: ['name', 'role', 'reason'],
          additionalProperties: false,
        },
      },
      kind: 'team',
      describe: (a) => `Added ${String(a['name'] ?? 'a teammate')} to the team`,
      run: async (a) => {
        try {
          const { agent, swarm } = await this.call<{ agent: AiAgent; swarm: Swarm }>(
            state,
            'POST',
            `/api/swarms/${state.swarm.id}/agents`,
            { name: a['name'], instructions: a['role'], reason: a['reason'] },
          );
          if (swarm?.agents) state.swarm = { ...state.swarm, agents: swarm.agents };
          state.agents.set(agent.id, agent);
          const joined = state.swarm.agents.find((x) => x.agentId === agent.id);
          if (joined && !crew.some((c) => c.agentId === agent.id)) crew.push(joined);
          return {
            ok: true,
            output: `${agent.name} joined the team (${agent.instructions}). Give them tasks with assign_tasks.`,
          };
        } catch (error) {
          return { ok: false, output: `Not added: ${(error as Error).message}` };
        }
      },
    };
  }

  private assignTool(state: Running, crew: Swarm['agents'], prefix: string, out: Split): Tool {
    return {
      spec: {
        name: 'assign_tasks',
        description:
          'Split the work into tasks and give each to one agent of the swarm. Call it once, when you have read enough of the code. Tasks without dependencies run in parallel in separate copies of the repository, so make them touch different files. A task that needs another one finished first lists it in depends_on; it starts once that work is checked and joined. Use as few tasks as the goal needs: a small change is one task. Each task is checked on its own, in its own copy, with only the work of the tasks it depends on: the whole test suite of the repository must pass there. So keep code and its tests in the same task (or make the test task depend on the code), and let the acceptance of a task ask only for what that task changes. Mark a task needs_approval (with why) when it is risky: database migrations, deleting files, new dependencies, changes to public APIs, CI or deploy settings; it waits until a person says yes.',
        parameters: {
          type: 'object',
          properties: {
            tasks: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  id: { type: 'string', description: 'A short id, unique in this list ("t1")' },
                  agent: {
                    type: 'string',
                    description: `One of: ${crew.map((a) => a.name).join(', ')}`,
                  },
                  title: { type: 'string', description: 'What to do, in a short sentence' },
                  detail: {
                    type: 'string',
                    description: 'Files, constraints, how to go about it',
                  },
                  acceptance: {
                    type: 'string',
                    description:
                      'What done means, so it can be checked ("median() exists and its tests pass")',
                  },
                  check: {
                    type: 'string',
                    description:
                      'A command that proves the acceptance, run in the task\'s copy once it is done and the project\'s checks pass, e.g. "node --test test/stats.test.js" or "npm test". One plain test, type check, lint or build command; it fails the task when it fails.',
                  },
                  depends_on: {
                    type: 'array',
                    items: { type: 'string' },
                    description: 'Ids of tasks in this list that must be finished first',
                  },
                  needs_approval: {
                    type: 'string',
                    description: 'Only for risky tasks: why a person should say yes first',
                  },
                  needs_answer: {
                    type: 'string',
                    description:
                      'A question a person must answer before this task can start (it waits for the answer; the others go on)',
                  },
                  files: {
                    type: 'array',
                    items: { type: 'string' },
                    description:
                      'The files it will most likely change (paths from the repository root)',
                  },
                },
                required: ['id', 'agent', 'title'],
                additionalProperties: false,
              },
            },
            assumptions: {
              type: 'array',
              items: { type: 'string' },
              description: 'What you assumed where the goal or the code left it open',
            },
            wait_for_answers: {
              type: 'boolean',
              description:
                'true only when no task should start before a person answers your questions (the whole swarm waits; for one task, use its needs_answer)',
            },
            questions: {
              type: 'array',
              items: { type: 'string' },
              description: 'What you could not tell and a person should answer',
            },
          },
          required: ['tasks'],
          additionalProperties: false,
        },
      },
      kind: 'team',
      describe: (a) => `Assigned ${Array.isArray(a['tasks']) ? a['tasks'].length : 0} tasks`,
      run: async (a) => {
        const list = Array.isArray(a['tasks']) ? (a['tasks'] as Record<string, unknown>[]) : [];
        // Said, not cut: a silently shortened plan loses work.
        if (list.length > MAX_TASKS)
          return {
            ok: false,
            output: `At most ${MAX_TASKS} tasks at once: merge small ones, or leave the rest for later. Call it again.`,
          };
        if (state.tasks.length + list.length > MAX_RUN_TASKS)
          return {
            ok: false,
            output: `This swarm has ${state.tasks.length} tasks already; it takes at most ${MAX_RUN_TASKS}. Add only what can't wait.`,
          };
        const bad = list.find(
          (t) => !crew.some((c) => c.name.toLowerCase() === String(t['agent'] ?? '').toLowerCase()),
        );
        if (!list.length || bad)
          return {
            ok: false,
            output: `Give every task to one of: ${crew.map((c) => c.name).join(', ')}`,
          };
        const text = (v: unknown, max: number) =>
          typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null;
        // A proof runs unattended in the task's copy: only what an agent may run without asking.
        const unsafe = list.find((t) => {
          const check = text(t['check'], 500);
          return check !== null && !commandAllowed(check);
        });
        if (unsafe)
          return {
            ok: false,
            output: `The check of "${String(unsafe['title'] ?? '')}" (${String(unsafe['check'])}) isn't one Kovan runs on its own: give one plain test, type check, lint or build command (like "node --test test/cart.test.js" or "npm test"), or leave it out.`,
          };
        const drafts: Task[] = list.map((t, i) => {
          const approvalReason = text(t['needs_approval'], 500);
          const question = text(t['needs_answer'], 500);
          return {
            ...(question ? { question: { text: question, messageId: null, answered: false } } : {}),
            key: `${prefix}${String(t['id'] ?? '').trim() || `t${i + 1}`}`,
            stepId: null,
            title: String(t['title'] ?? '').slice(0, 200),
            detail: text(t['detail'], 2000),
            acceptance: withProof(text(t['acceptance'], 2000), text(t['check'], 500)),
            acceptanceCheck: text(t['check'], 500),
            dependsOn: Array.isArray(t['depends_on'])
              ? t['depends_on'].map((d) => `${prefix}${String(d)}`)
              : [],
            files: Array.isArray(t['files'])
              ? t['files'].map((f) => String(f).slice(0, 500)).slice(0, 50)
              : [],
            touched: new Set<string>(),
            history: [],
            reruns: 0,
            agentId: crew.find((c) => c.name.toLowerCase() === String(t['agent']).toLowerCase())!
              .agentId,
            approval: approvalReason ? 'pending' : null,
            approvalReason,
            state: 'waiting',
            why: null,
            attempts: 0,
            cost: 0,
            run: 0,
            sync: Promise.resolve(),
          };
        });
        const problem = graphProblem(drafts);
        if (problem)
          return {
            ok: false,
            output: `${problem.split(prefix).join('')}. Fix the split and call it again.`,
          };
        // Side by side on the same files, their changes would collide when they join: in order.
        const titleOf = (key: string) => drafts.find((d) => d.key === key)!.title;
        const ordered = [
          ...serializeOverlaps(drafts).map(
            (o) =>
              `"${titleOf(o.task)}" now waits for "${titleOf(o.after)}": both change ${o.files.join(', ')}`,
          ),
          // Tests alone fail in a copy without the code they test.
          ...orderTestOnlyTasks(drafts).map(
            (o) =>
              `"${titleOf(o.task)}" now waits for "${titleOf(o.after)}": it only changes tests, which need that code`,
          ),
        ];
        const lines = (v: unknown) =>
          Array.isArray(v)
            ? v
                .map((x) => String(x).trim())
                .filter(Boolean)
                .slice(0, 10)
                .map((x) => x.slice(0, 300))
            : [];
        out.tasks = drafts;
        out.assumptions = lines(a['assumptions']);
        out.questions = lines(a['questions']);
        out.waitForAnswers = a['wait_for_answers'] === true && out.questions.length > 0;
        out.ordered = ordered;
        const notes = [
          ...ordered.map((o) => `${o}.`),
          drafts.some((t) => t.dependsOn.length)
            ? 'Tasks with depends_on start once those are done.'
            : '',
          drafts.some((t) => t.approvalReason)
            ? 'Tasks marked needs_approval wait for a person.'
            : '',
          drafts.some((t) => t.question)
            ? 'Tasks with needs_answer wait until a person answers (the question goes to them).'
            : '',
        ].filter(Boolean);
        return {
          ok: true,
          output: `Assigned ${drafts.length} tasks. ${notes.join(' ')} Reply with one sentence on the split.`,
        };
      },
    };
  }

  /** One turn of the lead with the assign tool; returns what it assigned (maybe nothing). */
  private async leadSplit(
    state: Running,
    leadId: string,
    prompt: string,
    title: string,
    prefix: string,
  ): Promise<Split | null> {
    const lead = state.agents.get(leadId);
    const workers = state.swarm.agents.filter((a) => a.role === 'worker');
    const crew = workers.length ? workers : state.swarm.agents;
    const out: Split = {
      tasks: [],
      assumptions: [],
      questions: [],
      waitForAnswers: false,
      ordered: [],
    };
    await this.report(state, leadId, { status: 'working', task: title });
    const turn = (task: string) =>
      this.deps.run({
        root: state.root,
        model: lead?.model ?? 'openai/gpt-5.6-luna',
        effort: lead?.effort ?? null,
        mode: 'plan',
        task,
        tools: [
          this.assignTool(state, crew, prefix, out),
          this.hireTool(state, crew),
          ...this.chatTools(state, leadId),
        ],
        approve: async () => false,
        onEvent: this.stream(state, leadId, state.root, title),
        onAgent: (agent) => (state.lead = agent),
        signal: state.abort.signal,
        ...this.coordination(state, state.root),
      });
    let end = await turn(prompt);
    // Smaller models sometimes look around and stop without splitting: ask once more, plainly.
    if (end.reason === 'done' && out.tasks.length === 0 && !this.stopped(state))
      end = await turn(
        `${prompt}\n\nYour last turn ended without calling assign_tasks. Call assign_tasks now, even if the whole goal is one task; do not stop before you have called it.`,
      );
    state.lead = undefined;
    await this.report(state, leadId, { status: 'idle', task: null });
    if (end.reason !== 'done' || this.stopped(state)) return null;
    return out;
  }

  /** New tasks become plan steps, each owned by its agent, in order; then they join the graph. */
  private async addToPlan(state: Running, leadId: string, split: Split): Promise<void> {
    const { tasks } = split;
    if (tasks.length === 0) return;
    const index = new Map(tasks.map((t, i) => [t.key, i]));
    const { plan } = await this.call<{ plan: Plan }>(
      state,
      'POST',
      `/api/sessions/${state.swarm.sessionId}/plan/steps`,
      {
        steps: tasks.map((t) => ({
          title: t.title,
          detail: t.detail,
          ownerId: t.agentId,
          acceptance: t.acceptance,
          approvalReason: t.approvalReason,
          files: t.files,
          after: t.dependsOn.map((d) => index.get(d)!),
        })),
      },
    );
    const fresh = plan.steps.slice(-tasks.length);
    tasks.forEach((t, i) => (t.stepId = fresh[i]?.id ?? null));
    state.tasks.push(...tasks);
    for (const t of tasks) this.sendState(t);
    state.assumptions.push(...split.assumptions);
    state.questions.push(...split.questions);
    // What the lead took for granted is said out loud, before anyone builds on it.
    const said = [
      split.ordered.length ? `Plan:\n${split.ordered.map((x) => `- ${x}`).join('\n')}` : '',
      split.assumptions.length
        ? `Assumptions:\n${split.assumptions.map((x) => `- ${x}`).join('\n')}`
        : '',
    ].filter(Boolean);
    if (said.length)
      await this.call(state, 'POST', `/api/swarms/${state.swarm.id}/messages`, {
        fromId: leadId,
        toId: null,
        text: said.join('\n').slice(0, 4000),
      }).catch(() => undefined);
    // The plan's open questions go to the person running the swarm as questions they can reply
    // to (the phone's "Needs you" lists them); the lead may hold every task until they answer.
    for (const q of split.questions) {
      const ask = (toId: string | null) =>
        this.call<{ message: SwarmMessage }>(
          state,
          'POST',
          `/api/swarms/${state.swarm.id}/messages`,
          {
            fromId: leadId,
            toId,
            kind: 'question',
            text: `${split.waitForAnswers ? 'Before the work starts' : 'Open question'}: ${q}`,
            key: randomUUID(),
          },
        );
      const to = state.swarm.launchedBy;
      const asked = await (to ? ask(to).catch(() => ask(null)) : ask(null)).catch(() => null);
      if (asked) state.messages.set(asked.message.id, asked.message);
      state.asks.push({
        text: q,
        messageId: asked?.message.id ?? null,
        // Nobody could be asked: nothing waits for it, and the report still lists it.
        answered: !asked,
        hold: split.waitForAnswers && Boolean(asked),
      });
    }
    if (split.waitForAnswers && state.asks.some((a) => a.hold && !a.answered))
      this.deps.notify(
        `${this.name(state, leadId)} has questions before the swarm starts`,
        `${split.questions.length === 1 ? split.questions[0] : `${split.questions.length} questions`}. Answer them in the swarm chat.`,
      );
    // A task that can't start without an answer asks the person running the swarm (or, when
    // they can't be written to, everyone in the chat).
    for (const t of tasks) {
      if (!t.question) continue;
      const ask = (toId: string | null) =>
        this.call<{ message: SwarmMessage }>(
          state,
          'POST',
          `/api/swarms/${state.swarm.id}/messages`,
          {
            fromId: leadId,
            toId,
            kind: 'question',
            text: `Before "${t.title}" (${this.name(state, t.agentId)}) can start: ${t.question!.text}`,
            key: randomUUID(),
          },
        );
      const to = state.swarm.launchedBy;
      const asked = await (to ? ask(to).catch(() => ask(null)) : ask(null)).catch(() => null);
      if (!asked) {
        // Nobody can be asked: it goes on, and says what it assumed.
        t.question.answered = true;
        t.history.push(
          `Open question (nobody could be asked): ${t.question.text}. Say what you assumed.`,
        );
        continue;
      }
      t.question.messageId = asked.message.id;
      state.messages.set(asked.message.id, asked.message);
    }
  }

  /** The lead reads the code and splits the goal into a graph of tasks for the agents. */
  private async plan(state: Running, leadId: string, known: string[]): Promise<void> {
    const lead = state.agents.get(leadId);
    const workers = state.swarm.agents.filter((a) => a.role === 'worker');
    const crew = workers.length ? workers : state.swarm.agents;
    const prompt = [
      `You are ${lead?.name ?? 'the lead'}, the lead AI agent of a swarm in the shared session "${state.session.title}".`,
      lead?.instructions ? `About you: ${lead.instructions}` : '',
      `The goal: ${state.swarm.goal}`,
      '',
      'Your agents:',
      ...crew.map(
        (c) => `- ${c.name}: ${state.agents.get(c.agentId)?.instructions || 'a coding agent'}`,
      ),
      '',
      ...known,
      ...this.inboxFor(state, leadId),
      '',
      'Read what you need of the code (you cannot edit here), then call assign_tasks once: split the goal into tasks, each small enough for one agent, with what done means. Order dependent work with depends_on; keep independent tasks on different files; keep code and its tests in one task; mark risky tasks needs_approval. If nobody on the team fits a task, you may first add a teammate with add_teammate. Write down what you assumed and what you could not tell. Then reply with one sentence.',
    ]
      .filter((l) => l !== '')
      .join('\n');
    const split = await this.leadSplit(
      state,
      leadId,
      prompt,
      `Split the goal: ${state.swarm.goal}`,
      '',
    );
    if (!split) return;
    await this.addToPlan(state, leadId, split);
    await this.estimate(state, leadId, split.tasks.length);
  }

  /**
   * What the split will likely cost, from what finished tasks really cost in this workspace;
   * said in the chat before the work starts. With nothing to go on, it says so instead.
   */
  private async estimate(state: Running, leadId: string, tasks: number): Promise<void> {
    if (tasks === 0) return;
    const stats = await this.call<{ stats: AgentSpendStats }>(
      state,
      'GET',
      `/api/workspaces/${state.session.workspaceId}/agent-spend`,
    )
      .then((r) => r.stats)
      .catch(() => null);
    if (!stats) return;
    let text: string;
    if (stats.perTask) {
      state.estimate = {
        total: stats.perTask.average * tasks,
        perTask: stats.perTask.average,
        from: stats.tasks,
      };
      const high = stats.perTask.p90 * tasks;
      const budget = state.swarm.budget;
      text = `Estimate: ${tasks} task${tasks === 1 ? '' : 's'} × ~${usd(stats.perTask.average)} ≈ ${usd(state.estimate.total)} (up to ~${usd(high)}), from ${stats.tasks} finished task${stats.tasks === 1 ? '' : 's'} in this workspace; the lead's own turns come on top.${budget !== null && high > budget - state.swarm.spent ? ` That may be more than the budget left (${usd(budget - state.swarm.spent)}): the swarm pauses when it runs out.` : ''}`;
    } else
      text = `No estimate yet: no swarm task has finished in this workspace to learn its cost from. The budget (${state.swarm.budget === null ? 'unlimited' : usd(state.swarm.budget)}) still holds.`;
    if (stats.monthLimit !== null)
      text += ` This month the workspace's agents spent ${usd(stats.monthSpent)} of ${usd(stats.monthLimit)}.`;
    await this.call(state, 'POST', `/api/swarms/${state.swarm.id}/messages`, {
      fromId: leadId,
      toId: null,
      text,
    }).catch(() => undefined);
  }

  /**
   * Some work failed or was blocked: the lead sees what happened and may plan the rest once more
   * (new tasks, on top of what is already in the checkout). Returns whether it did.
   */
  private async replan(state: Running, leadId: string, known: string[]): Promise<boolean> {
    const stuck = state.tasks.filter((t) => t.state === 'failed' || t.state === 'blocked');
    if (stuck.length === 0 || state.replans >= MAX_REPLANS || this.stopped(state)) return false;
    state.replans += 1;
    state.phase = 'replan';
    const lead = state.agents.get(leadId);
    const prompt = [
      `You are ${lead?.name ?? 'the lead'}, the lead of the swarm on: ${state.swarm.goal}`,
      'The plan ran, but not all of it went through. Where it stands (from the checks, not from the agents):',
      ...this.resultLines(state),
      '',
      ...known,
      ...this.inboxFor(state, leadId),
      '',
      'Look at the code and the failures (you cannot edit). If the goal can still be reached, call assign_tasks with the remaining work only: new ids, dependencies only among the new tasks, and do not redo finished work (it is in this checkout already). If it cannot be reached, or a person must decide first, do not call it; reply with why in two sentences.',
    ]
      .filter((l) => l !== '')
      .join('\n');
    const split = await this.leadSplit(
      state,
      leadId,
      prompt,
      'Plan the rest after failures',
      `r${state.replans}:`,
    );
    if (!split || split.tasks.length === 0) return false;
    // Blocked work is taken over by the new plan; failed work stays failed, for the record.
    for (const t of stuck)
      if (t.state === 'blocked') this.move(t, 'cancelled', 'Replanned: the new plan takes it over');
    await this.addToPlan(state, leadId, split);
    return true;
  }

  /** One line per task: its state, from the checks, and why. */
  private resultLines(state: Running): string[] {
    return state.tasks.map((t) => {
      const failedCheck = t.outcome?.results.find((c) => c.status !== 'passed');
      return `- ${this.name(state, t.agentId)}: ${t.title} → ${t.state}${t.outcome?.verification === 'verified' ? ' (verified by its checks)' : ''}${t.outcome?.checks.total ? ` (${t.outcome.checks.passed}/${t.outcome.checks.total} checks)` : ''}${
        t.outcome?.results.some((c) => c.command && c.status === 'passed')
          ? `; Kovan ran and passed: ${t.outcome.results
              .filter((c) => c.command && c.status === 'passed')
              .map((c) => c.name)
              .join(', ')}`
          : ''
      }${failedCheck ? `; ${failedCheck.name} ${failedCheck.status}` : ''}${t.why && t.state !== 'done' ? `: ${t.why.split('\n')[0]}` : ''}${t.outcome?.untested.length ? `; no test covers ${t.outcome.untested.join(', ')}` : ''}${t.outcome?.reply ? `\n  ${t.outcome.reply.replace(/\n+/g, ' ').slice(0, 400)}` : ''}`;
    });
  }

  /**
   * Runs the graph: a task starts once everything it depends on is done, at most `maxParallel`
   * at once and one task per agent at a time. What depends on a failed task never runs: it is
   * blocked, and the report says why.
   */
  private async work(state: Running, known: string[]): Promise<void> {
    const busy = new Set<string>();
    const live: Promise<void>[] = [];
    const byKey = (key: string) => state.tasks.find((t) => t.key === key);
    // A dependency outside the swarm (a step someone else owns, still open) can't be waited for.
    const stateOf = (key: string): TaskState => byKey(key)?.state ?? 'blocked';
    state.phase = 'work';
    // The lead is idle while the work runs: what came for it (or for idle agents) wakes them.
    for (const a of state.swarm.agents) this.wakeIfIdle(state, a.agentId);
    for (;;) {
      if (this.stopped(state)) break;
      const { ready, blocked } = nextTasks(state.tasks, stateOf);
      for (const b of blocked) {
        const task = byKey(b.key)!;
        const by = byKey(b.by);
        this.move(
          task,
          'blocked',
          by
            ? `It depends on "${by.title}", which ${by.state === 'failed' ? 'failed' : by.state === 'cancelled' ? 'was stopped' : 'was blocked'}`
            : 'It depends on a plan step outside this swarm that is not done',
        );
      }
      if (blocked.length) continue;
      // The whole swarm waits for answers the lead said it needs before anything starts.
      const holding = state.asks.some((a) => a.hold && !a.answered);
      if (holding && ready.length) {
        for (const key of ready) this.move(byKey(key)!, 'waiting_for_approval', HOLD);
        continue;
      }
      // A risky task waits for a person's yes; a no stops it (and what depends on it).
      let gated = false;
      for (const key of ready) {
        const task = byKey(key)!;
        if (task.approval === 'pending') {
          this.move(task, 'waiting_for_approval', `Needs a yes: ${task.approvalReason ?? 'risky'}`);
          this.deps.notify(
            `${this.name(state, task.agentId)} needs your approval`,
            `"${task.title}": ${task.approvalReason ?? 'a risky task'}. Approve it in the session plan.`,
          );
          gated = true;
        } else if (task.approval === 'rejected') {
          this.move(task, 'cancelled', 'Rejected by a person');
          gated = true;
        } else if (task.question && !task.question.answered) {
          // A person's answer first: it waits, and the question is in the chat.
          this.move(task, 'waiting_for_approval', `Waiting for an answer: ${task.question.text}`);
          this.deps.notify(
            `${this.name(state, task.agentId)} needs an answer`,
            `"${task.title}": ${task.question.text}. Answer it in the swarm chat.`,
          );
          gated = true;
        }
      }
      if (gated) continue;
      const next = state.tasks.find(
        (t) => ready.includes(t.key) && !busy.has(t.agentId) && !state.awake.has(t.agentId),
      );
      if (next && busy.size < state.swarm.maxParallel) {
        const agentId = next.agentId;
        busy.add(agentId);
        this.move(next, 'running', null);
        const p = this.runTask(state, next, known)
          // A bug or a lost connection mid-task must not leave it "running" forever.
          .catch((error: unknown) => {
            console.warn('Swarm task failed:', error);
            this.move(next, 'failed', `It stopped on an error: ${(error as Error).message}`);
          })
          .finally(() => {
            busy.delete(agentId);
            state.wake?.();
          });
        live.push(p);
        continue;
      }
      const asking = state.tasks.some(
        (t) => t.state === 'waiting_for_approval' && t.approval === 'pending',
      );
      const answering =
        holding ||
        state.tasks.some(
          (t) => t.state === 'waiting_for_approval' && t.question && !t.question.answered,
        );
      // An answer turn may add tasks (the lead), and a question waits for its answer.
      if (busy.size === 0 && !next && !asking && !answering && state.awake.size === 0) break;
      // Waiting: for a running task, or for an answer (live, or found by looking at the plan).
      await new Promise<void>((resolve) => {
        state.wake = resolve;
        if (asking) setTimeout(resolve, this.deps.approvalPollMs ?? APPROVAL_POLL_MS);
      });
      state.wake = undefined;
      if (asking) await this.checkApprovals(state);
    }
    await Promise.allSettled(live);
  }

  private async runTask(state: Running, task: Task, known: string[]): Promise<void> {
    const run = task.run;
    const current = () => task.run === run && !this.stopped(state);
    const agent = state.agents.get(task.agentId);
    const name = this.name(state, task.agentId);
    if (task.stepId)
      await this.call(state, 'PATCH', `/api/plan-steps/${task.stepId}`, { status: 'doing' }).catch(
        () => undefined,
      );
    await this.report(state, task.agentId, { status: 'working', task: task.title });
    // Built for each attempt: what others finished and handed over changes as the swarm runs.
    const promptFor = () => {
      const others = state.tasks
        .filter((t) => t !== task && (t.state === 'waiting' || t.state === 'running'))
        .map((t) => `- ${this.name(state, t.agentId)}: ${t.title}`);
      const before = task.dependsOn
        .map((key) => state.tasks.find((t) => t.key === key))
        .filter((t): t is Task => Boolean(t?.outcome))
        .map(
          (t) => `- ${t.title}: ${t.outcome!.reply?.replace(/\n+/g, ' ').slice(0, 300) ?? 'done'}`,
        );
      return [
        `You are ${name}, an AI teammate working in a swarm on: ${state.swarm.goal}`,
        agent?.instructions ? `About you: ${agent.instructions}` : '',
        '',
        `Your task: ${task.title}`,
        task.detail ?? '',
        task.acceptance ? `Done means: ${task.acceptance}` : '',
        task.files.length ? `Files you'll most likely change: ${task.files.join(', ')}` : '',
        '',
        task.history.length ? 'Handed over to you:' : '',
        ...task.history.map((h) => `- ${h.replace(/\n/g, '\n  ')}`),
        '',
        before.length ? 'Finished before you (their work is in your copy):' : '',
        ...before,
        others.length ? 'The others are working on (in their own copies, at the same time):' : '',
        ...others,
        '',
        ...known,
        ...this.inboxFor(state, task.agentId),
        '',
        "You work alone in your own copy of the repository. Make the change in the files here; do not commit, push or switch branches. Keep to your task; use message_agent if your change affects someone else. Your work is checked when you're done: the repository's own tests and checks must pass.",
        'When you\'re done, reply in one or two sentences on what you changed. If you learned something durable about this codebase that will help future tasks, end with one line starting with "Learned:".',
      ]
        .filter((l, i, all) => l !== '' || all[i - 1] !== '')
        .join('\n');
    };

    // The whole task, reworks and fresh starts included, has a time limit; past it, it stops.
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      if (task.subagentId) void this.deps.subagents.discard(task.subagentId).catch(() => undefined);
    }, this.deps.taskTimeoutMs ?? TASK_TIMEOUT_MS);
    const stream = this.stream(state, task.agentId, state.root, task.title, task);
    const failed = (detail: string): SubagentOutcome => ({
      status: 'failed',
      detail,
      reply: null,
      checks: { passed: 0, total: 0 },
      results: [],
      verification: 'failed',
      untested: [],
      impact: null,
    });
    /** One start of its agent in a fresh copy, with reworks after failed checks. */
    const attempt = async (key: string): Promise<SubagentOutcome> => {
      task.touched = new Set();
      task.attempts += 1;
      let outcome = await new Promise<SubagentOutcome>((resolve) => {
        void this.deps.subagents
          .start({
            sessionId: state.swarm.sessionId,
            parentRoot: state.root,
            task: `${name}: ${task.title}`,
            model: agent?.model ?? 'openai/gpt-5.6-luna',
            effort: agent?.effort ?? null,
            parentMode: state.swarm.mode,
            requestKey: key,
            acceptanceCheck: task.acceptanceCheck,
            ...(state.swarm.review
              ? { review: (input: ReviewInput) => this.reviewTask(state, task, input) }
              : {}),
            persona: {
              agentId: task.agentId,
              name,
              prompt: promptFor(),
              tools: this.chatTools(state, task.agentId),
              coordination: (root) => this.coordination(state, root),
              onEvent: (event) => {
                if (event.type === 'usage' && event.usage.cost) task.cost += event.usage.cost;
                if (
                  event.type === 'tool_start' &&
                  (event.name === 'write_file' || event.name === 'edit_file') &&
                  typeof event.args['path'] === 'string'
                )
                  task.touched.add(
                    event.args['path'].startsWith(`${state.root}/`)
                      ? event.args['path'].slice(state.root.length + 1)
                      : event.args['path'],
                  );
                stream(event);
              },
              onAgent: (a) => (task.agent = a),
              onSettled: resolve,
            },
          })
          .then((sub) => {
            if (task.run === run) task.subagentId = sub.id;
          })
          .catch((error: unknown) => resolve(failed((error as Error).message)));
      });
      // Failed checks go back to the agent with what failed, in the same copy.
      let reworks = 0;
      while (
        current() &&
        !timedOut &&
        !task.overBudget &&
        outcome.status === 'failed' &&
        outcome.results.some((c) => c.status === 'failed') &&
        task.subagentId &&
        reworks < MAX_ATTEMPTS - 1
      ) {
        reworks += 1;
        task.attempts += 1;
        const feedback = outcome.results
          .filter((c) => c.status === 'failed')
          .map((c) => `- ${c.name}: ${c.detail ?? 'failed'}`)
          .join('\n');
        outcome = await this.deps.subagents
          .rework(task.subagentId, feedback)
          .catch((error: unknown) => failed((error as Error).message));
      }
      return outcome;
    };

    task.attempts = 0;
    const base = `${state.swarm.id}:${state.launchId}:${task.stepId ?? task.key}:${run}`;
    let outcome = await attempt(base);
    // Work that no longer applies (others changed the same lines meanwhile) starts over once
    // from the checkout as it is now, told what happened.
    while (
      current() &&
      !timedOut &&
      !task.overBudget &&
      outcome.status === 'conflict' &&
      task.reruns < MAX_RERUNS
    ) {
      task.reruns += 1;
      task.history.push(
        this.handoff(
          state,
          task,
          `its work no longer applied: ${outcome.detail ?? 'work joined meanwhile changed the same lines'}`,
          outcome,
        ),
      );
      if (task.subagentId)
        await this.deps.subagents.discard(task.subagentId).catch(() => undefined);
      task.subagentId = undefined;
      this.move(task, 'running', 'Starting over on the updated checkout after a conflict');
      outcome = await attempt(`${base}:rerun${task.reruns}`);
    }
    clearTimeout(timer);
    // Stopped or moved to another agent meanwhile: that run decides, not this one.
    if (task.run !== run) return;
    task.agent = undefined;
    if (outcome.status === 'cancelled' && this.stopped(state) && !timedOut && !task.overBudget) {
      // Halted (budget, pause): it runs again on resume.
      this.move(task, 'waiting', 'Stopped with its swarm; it runs again on resume');
      task.subagentId = undefined;
      return;
    }
    task.outcome = outcome;
    if (outcome.status === 'integrated') {
      this.move(
        task,
        'done',
        outcome.verification === 'unverified'
          ? 'Not verified: the repository has no checks of its own'
          : `Verified: ${outcome.checks.passed}/${outcome.checks.total} checks passed`,
      );
    } else if (task.overBudget) {
      this.move(task, 'failed', task.overBudget);
    } else if (timedOut) {
      this.move(
        task,
        'failed',
        `It took longer than ${Math.round((this.deps.taskTimeoutMs ?? TASK_TIMEOUT_MS) / 60_000)} minutes and was stopped`,
      );
    } else if (outcome.status === 'cancelled') {
      this.move(task, 'cancelled', 'Stopped by a person');
    } else {
      this.move(task, 'failed', outcome.detail ?? 'It failed');
    }
    if (task.stepId && task.state === 'done')
      await this.call(state, 'PATCH', `/api/plan-steps/${task.stepId}`, { status: 'done' }).catch(
        () => undefined,
      );
    await this.report(state, task.agentId, { status: 'idle', task: null });
    // Messages that came after its prompt (or while its checks ran) get their answer now.
    this.wakeIfIdle(state, task.agentId);

    // Knowledge only from work whose checks passed.
    const learned = /^\s*Learned:\s*(.+)$/im.exec(outcome.reply ?? '')?.[1]?.trim();
    if (learned && outcome.status === 'integrated')
      await this.call(state, 'POST', `/api/workspaces/${state.session.workspaceId}/learnings`, {
        kind: 'knowledge',
        text: learned.slice(0, 1000),
        swarmId: state.swarm.id,
        verified: true,
        evidence:
          `${name}: "${task.title}" passed ${outcome.checks.passed}/${outcome.checks.total} checks`.slice(
            0,
            1000,
          ),
      }).catch(() => undefined);
  }

  /**
   * The swarm's closing report, from what the checks said (not from what the agents said):
   * each task's state, its checks one by one, attempts and spend.
   */
  private completionReport(state: Running): string {
    const count = (s: TaskState) => state.tasks.filter((t) => t.state === s).length;
    const verified = state.tasks.filter((t) => t.outcome?.verification === 'verified').length;
    const unverified = state.tasks.filter((t) => t.outcome?.verification === 'unverified').length;
    const spent = state.tasks.reduce((sum, t) => sum + t.cost, 0);
    const mark: Record<string, string> = {
      passed: '✓',
      failed: '✗',
      not_run: '–',
      blocked: '⊘',
    };
    const head = [
      `${verified} of ${state.tasks.length} tasks verified`,
      unverified ? `${unverified} done without checks of their own` : '',
      count('failed') ? `${count('failed')} failed` : '',
      count('blocked') ? `${count('blocked')} blocked` : '',
      count('cancelled') ? `${count('cancelled')} stopped` : '',
      `tasks spent $${spent.toFixed(4)}${state.swarm.budget !== null ? ` · swarm so far $${state.swarm.spent.toFixed(4)} of $${state.swarm.budget.toFixed(2)}` : ''}`,
    ].filter(Boolean);
    // Asked and answered (the answer is in the chat), or still open.
    const open = state.questions.filter(
      (q) => !state.asks.some((a) => a.text === q && a.messageId && a.answered),
    );
    const lines = state.tasks.map((t) => {
      const who = this.name(state, t.agentId);
      const status =
        t.state === 'done'
          ? t.outcome?.verification === 'verified'
            ? 'verified'
            : 'done, not verified'
          : t.state;
      const checks = (t.outcome?.results ?? [])
        .map(
          (c) =>
            `${mark[c.status]} ${c.name}${c.ms !== null ? ` (${(c.ms / 1000).toFixed(1)}s)` : ''}`,
        )
        .join(', ');
      return [
        `- ${t.title} (${who}): ${status}${t.attempts > 1 ? ` after ${t.attempts} attempts` : ''} · $${t.cost.toFixed(4)}`,
        checks ? `  checks: ${checks}` : '',
        t.why && t.state !== 'done' ? `  ${t.why.split('\n')[0]!.slice(0, 300)}` : '',
        t.outcome?.untested.length
          ? `  not covered by any test: ${t.outcome.untested.join(', ')}`
          : '',
        t.outcome?.impact && impactLine(t.outcome.impact)
          ? `  reaches: ${impactLine(t.outcome.impact)}`
          : '',
        t.reviewNotes ? `  noted by ${t.reviewNotes}` : '',
      ]
        .filter(Boolean)
        .join('\n');
    });
    return [
      `Swarm report: ${head.join(' · ')}`,
      ...lines,
      state.estimate
        ? `Estimated ~${usd(state.estimate.total)} for the first plan (from ${state.estimate.from} earlier tasks); the tasks spent ${usd(spent)}.`
        : '',
      state.unpriced
        ? `${state.unpriced} model call${state.unpriced === 1 ? ' has' : 's have'} no known price (own provider or missing from the catalog): the real spend is higher than shown.`
        : '',
      state.replans
        ? `Replanned ${state.replans === 1 ? 'once' : `${state.replans} times`} after failures.`
        : '',
      state.assumptions.length
        ? `Assumed:\n${state.assumptions.map((x) => `- ${x}`).join('\n')}`
        : '',
      open.length ? `Still open:\n${open.map((x) => `- ${x}`).join('\n')}` : '',
    ]
      .filter(Boolean)
      .join('\n');
  }

  /** The lead looks over what came back, says so in the chat, and suggests preferences. */
  private async review(state: Running, leadId: string, known: string[]): Promise<void> {
    const lead = state.agents.get(leadId);
    const me = this.deps.me();
    const results = this.resultLines(state);
    let reply = '';
    const prompt = [
      `You are ${lead?.name ?? 'the lead'}, the lead of the swarm on: ${state.swarm.goal}`,
      'Your agents finished. Integrated work is in this checkout now. Results (states come from the checks, not from the agents):',
      ...results,
      '',
      ...known,
      ...this.inboxFor(state, leadId),
      ...(state.said.length
        ? [
            `What ${me?.name ?? 'the person running the swarm'} said to the swarm:`,
            ...state.said.slice(-10).map((s) => `- ${s}`),
          ]
        : []),
      '',
      "Kovan already ran each task's checks (the repository's own tests among them) before its work joined; the states above are their results, so do not try to run tests or commands yourself: you cannot here. Check the integrated code briefly (you cannot edit), then reply with two or three sentences for the team: what is done, what is not, and anything to look at. Do not call failed, blocked or unverified work done, and do not call verified work unverified.",
      state.said.length
        ? `If ${me?.name ?? 'they'} showed a lasting preference about how they like work done, add one last line starting with "Preference:". Only if it is clear.`
        : '',
    ]
      .filter(Boolean)
      .join('\n');
    await this.report(state, leadId, { status: 'working', task: 'Reviewing the results' });
    const end = await this.deps.run({
      root: state.root,
      model: lead?.model ?? 'openai/gpt-5.6-luna',
      effort: lead?.effort ?? null,
      mode: 'plan',
      task: prompt,
      tools: this.chatTools(state, leadId),
      approve: async () => false,
      onEvent: (() => {
        const stream = this.stream(state, leadId, state.root, 'Review the results');
        return (event: AgentEvent) => {
          if (event.type === 'tool_start') reply = '';
          if (event.type === 'text') reply += event.text;
          stream(event);
        };
      })(),
      onAgent: (agent) => (state.lead = agent),
      signal: state.abort.signal,
      ...this.coordination(state, state.root),
    });
    state.lead = undefined;
    if (end.reason !== 'done' || this.stopped(state)) return;
    const preference = /^\s*Preference:\s*(.+)$/im.exec(reply)?.[1]?.trim();
    const summary = reply.replace(/^\s*Preference:.*$/im, '').trim();
    if (summary)
      await this.call(state, 'POST', `/api/swarms/${state.swarm.id}/messages`, {
        fromId: leadId,
        toId: null,
        text: summary.slice(0, 4000),
      }).catch(() => undefined);
    // Private to the person, and only a suggestion until they accept it.
    if (preference)
      await this.call(state, 'POST', `/api/workspaces/${state.session.workspaceId}/learnings`, {
        kind: 'preference',
        text: preference.slice(0, 1000),
        swarmId: state.swarm.id,
      }).catch(() => undefined);
  }
}
