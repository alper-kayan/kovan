import type { Tool } from '@kovan/harness';
import { canMoveTask, type Swarm, type SwarmMessage, type TaskState } from '@kovan/shared';
import { describe, expect, it } from 'vitest';
import type { DetachedRun } from './run.js';
import type { StartSubagent, SubagentOutcome } from './subagents.js';
import { SwarmRunner } from './swarm.js';

const ME = { id: 'aaaaaaaa-0000-4000-8000-000000000001', name: 'alice' };
const WREN = 'bbbbbbbb-0000-4000-8000-000000000001';
const MOSS = 'bbbbbbbb-0000-4000-8000-000000000002';
const TERN = 'bbbbbbbb-0000-4000-8000-000000000003';

/** A Brain that keeps one swarm, its plan and its budget, like the server does. */
function fakeBrain(
  budget: number | null,
  limits: {
    taskBudget?: number;
    perTask?: { average: number; p90: number; from: number };
    review?: boolean;
    /** An AI teammate's monthly limit for its direct tasks (null: none). */
    agentLimit?: number | null;
  } = {},
) {
  /** What AI teammates' direct tasks reported spending (POST /api/agents/:id/spend). */
  const agentSpend = { total: 0, reports: [] as number[] };
  const answers: Record<string, unknown>[] = [];
  const swarm: Swarm = {
    id: 'swarm-1',
    sessionId: 'session-1',
    workspaceId: 'ws-1',
    goal: 'Add total and product helpers',
    leadAgentId: WREN,
    status: 'draft',
    budget,
    taskBudget: limits.taskBudget ?? null,
    review: limits.review ?? false,
    spent: 0,
    maxParallel: 2,
    mode: 'allow',
    launchedBy: null,
    launchedByName: null,
    fence: 0,
    pausedReason: null,
    agents: [
      { agentId: WREN, name: 'Wren', role: 'lead', status: 'idle', task: null, spent: 0 },
      { agentId: MOSS, name: 'Moss', role: 'worker', status: 'idle', task: null, spent: 0 },
      { agentId: TERN, name: 'Tern', role: 'worker', status: 'idle', task: null, spent: 0 },
    ],
    createdAt: '',
    updatedAt: '',
  };
  const steps: {
    id: string;
    title: string;
    ownerId: string;
    status: string;
    detail: null;
    acceptance: string | null;
    dependsOn: string[];
    files?: string[];
    runState?: TaskState | null;
    runDetail?: string | null;
    approval?: 'pending' | 'approved' | 'rejected' | null;
    approvalReason?: string | null;
    approvedBy?: string | null;
  }[] = [];
  /** Every run state a step went through, checked like the server does. */
  const runs: Record<string, TaskState[]> = {};
  const stepSpent: Record<string, number> = {};
  const messages: {
    fromId: string;
    toId: string | null;
    text: string;
    kind?: string;
    replyTo?: string | null;
    key?: string;
  }[] = [];
  /** Chat messages already on the Brain when the swarm starts here, and their deliveries. */
  const pending: SwarmMessage[] = [];
  const delivered: { agentId: string; ids: string[] }[] = [];
  const read: { agentId: string; ids: string[] }[] = [];
  /** Every message the chat has, as the server sends them out (set to hear them live). */
  const chat: SwarmMessage[] = [];
  const live: { send?: (m: SwarmMessage) => void } = {};
  const locks: { path: string; userId: string; userName: string }[] = [];
  const hires: Record<string, unknown>[] = [];
  const learnings: Record<string, unknown>[] = [];
  /** The fences requests carried, and whether the swarm was launched again elsewhere. */
  const fences: (string | undefined)[] = [];
  const moved = { now: false };
  const request = async <T>(
    method: string,
    path: string,
    body?: unknown,
    options?: { fence?: string },
  ): Promise<T> => {
    const b = body as Record<string, unknown>;
    fences.push(options?.fence);
    if (moved.now && options?.fence)
      throw Object.assign(new Error('This swarm was started again elsewhere'), {
        code: 'stale_run',
      });
    if (method === 'POST' && path === `/api/swarms/${swarm.id}/agents`) {
      const agent = {
        id: 'bbbbbbbb-0000-4000-8000-0000000000aa',
        workspaceId: 'ws-1',
        name: b['name'] as string,
        model: 'kovan/jevrouter',
        effort: null,
        mode: 'allow',
        instructions: b['instructions'] as string,
        createdBy: WREN,
        createdByName: 'Wren',
        archived: false,
        createdAt: '2026-10-17T10:00:00.000Z',
      };
      swarm.agents.push({
        agentId: agent.id,
        name: agent.name,
        role: 'worker',
        status: 'idle',
        task: null,
        spent: 0,
      });
      hires.push(b);
      return { agent, swarm: { ...swarm, agents: [...swarm.agents] } } as T;
    }
    if (path.endsWith('/launch')) {
      const resumed = swarm.status === 'paused';
      swarm.status = 'running';
      swarm.launchedBy = ME.id;
      swarm.fence += 1;
      return { swarm, resumed } as T;
    }
    if (path.startsWith('/api/sessions/') && method === 'GET' && path.endsWith('/plan'))
      return { plan: { sessionId: 'session-1', steps, offers: [] } } as T;
    if (path.startsWith('/api/sessions/') && method === 'GET')
      return {
        session: {
          id: 'session-1',
          workspaceId: 'ws-1',
          title: 'Totals',
          participants: [
            { userId: ME.id, name: 'alice', kind: 'human' },
            // An AI teammate this machine runs, for direct tasks.
            { userId: TERN, name: 'Tern', kind: 'agent', hostId: ME.id },
          ],
        },
      } as T;
    if (path.endsWith('/agents'))
      return {
        agents: [
          { id: WREN, name: 'Wren', model: 'm', effort: null, instructions: 'Leads.' },
          { id: MOSS, name: 'Moss', model: 'm', effort: null, instructions: 'Writes code.' },
          { id: TERN, name: 'Tern', model: 'm', effort: null, instructions: 'Writes tests.' },
        ],
      } as T;
    if (method === 'POST' && path.endsWith('/mention/answer')) {
      answers.push(b);
      return { ok: true } as T;
    }
    if (method === 'POST' && /^\/api\/agents\/[^/]+\/spend$/.test(path)) {
      const amount = b['amount'] as number;
      agentSpend.reports.push(amount);
      agentSpend.total += amount;
      const limit = limits.agentLimit ?? null;
      return {
        monthSpent: agentSpend.total,
        over:
          limit !== null && agentSpend.total >= limit
            ? `Tern's monthly limit is reached ($${agentSpend.total.toFixed(4)} of $${limit.toFixed(4)})`
            : null,
      } as T;
    }
    if (path.endsWith('/learnings') && method === 'GET') return { learnings: [] } as T;
    if (path.endsWith('/learnings')) {
      learnings.push(b);
      return {} as T;
    }
    if (path.endsWith('/plan/steps')) {
      const first = steps.length;
      for (const s of b['steps'] as {
        title: string;
        ownerId: string;
        acceptance: string | null;
        after: number[];
        approvalReason: string | null;
        files?: string[];
      }[])
        steps.push({
          id: `step-${steps.length}`,
          title: s.title,
          ownerId: s.ownerId,
          status: 'todo',
          detail: null,
          acceptance: s.acceptance,
          files: s.files ?? [],
          approval: s.approvalReason ? 'pending' : null,
          approvalReason: s.approvalReason,
          approvedBy: null,
          dependsOn: s.after.map((i) => `step-${first + i}`),
        });
      return { plan: { steps } } as T;
    }
    if (path.startsWith('/api/plan-steps/')) {
      const step = steps.find((s) => s.id === path.split('/')[3])!;
      if (b['status']) step.status = String(b['status']);
      if (b['runState']) {
        const to = b['runState'] as TaskState;
        if (!canMoveTask(step.runState ?? null, to))
          throw new Error(`409 ${step.title}: ${step.runState} → ${to}`);
        step.runState = to;
        step.runDetail = b['runDetail'] as string | null;
        (runs[step.title] ??= []).push(to);
      }
      return {} as T;
    }
    if (path.endsWith('/agent-spend'))
      return {
        stats: {
          monthSpent: 0.01,
          monthLimit: null,
          tasks: limits.perTask?.from ?? 0,
          perTask: limits.perTask
            ? { average: limits.perTask.average, p90: limits.perTask.p90 }
            : null,
        },
      } as T;
    if (path.endsWith('/report')) {
      const cost = Number(b['cost'] ?? 0);
      swarm.spent += cost;
      if (swarm.status === 'running' && swarm.budget !== null && swarm.spent >= swarm.budget)
        swarm.status = 'paused';
      const stepId = b['stepId'] as string | undefined;
      if (!stepId) return { swarm: { ...swarm } } as T;
      stepSpent[stepId] = (stepSpent[stepId] ?? 0) + cost;
      return {
        swarm: { ...swarm },
        step: {
          spent: stepSpent[stepId],
          over: swarm.taskBudget !== null && stepSpent[stepId] >= swarm.taskBudget,
        },
      } as T;
    }
    if (path.endsWith('/messages/delivered')) {
      delivered.push(b as (typeof delivered)[number]);
      return { ok: true } as T;
    }
    if (path.endsWith('/messages/read')) {
      read.push(b as (typeof read)[number]);
      return { ok: true } as T;
    }
    if (path.endsWith('/messages')) {
      if (method === 'GET') return { messages: pending } as T;
      const same = b['key'] ? chat.find((m) => (m as { key?: string }).key === b['key']) : null;
      if (same) return { message: same } as T;
      messages.push(b as (typeof messages)[number]);
      const name = (id: string | null) =>
        swarm.agents.find((a) => a.agentId === id)?.name ?? (id === ME.id ? 'alice' : null);
      const fromId = (b['fromId'] as string | null) ?? ME.id;
      const message = {
        id: `msg-${String(chat.length + 1).padStart(4, '0')}`,
        swarmId: swarm.id,
        fromId,
        fromName: name(fromId) ?? 'someone',
        toId: (b['toId'] as string | null) ?? null,
        toName: name((b['toId'] as string | null) ?? null),
        kind: (b['kind'] as SwarmMessage['kind']) ?? 'note',
        replyTo: (b['replyTo'] as string | null) ?? null,
        text: b['text'] as string,
        deliveredTo: [],
        readBy: [],
        createdAt: new Date().toISOString(),
        key: b['key'],
      } as SwarmMessage;
      chat.push(message);
      // Like the server: everyone in the session hears it, the machine running it too.
      setTimeout(() => live.send?.(message), 1);
      return { message } as T;
    }
    if (path.endsWith('/locks')) return { locks } as T;
    if (path.endsWith('/sessions') && method === 'GET')
      return {
        sessions: [
          {
            id: 'session-2',
            title: 'Checkout page',
            status: 'active',
            participants: [{ userId: 'person-2', name: 'Bea', mode: 'join' }],
            touchedFiles: ['src/cart.js'],
            locks: [],
          },
        ],
      } as T;
    if (path.endsWith('/status')) {
      swarm.status = b['status'] as Swarm['status'];
      return { swarm } as T;
    }
    throw new Error(`unexpected ${method} ${path}`);
  };
  return {
    swarm,
    steps,
    messages,
    pending,
    delivered,
    read,
    chat,
    live,
    locks,
    hires,
    fences,
    moved,
    learnings,
    runs,
    agentSpend,
    answers,
    request,
  };
}

/** A chat message as the Brain sends it. */
function chat(
  m: Partial<SwarmMessage> & Pick<SwarmMessage, 'id' | 'fromId' | 'text'>,
): SwarmMessage {
  return {
    swarmId: 'swarm-1',
    fromName: 'someone',
    toId: null,
    toName: null,
    kind: 'note',
    replyTo: null,
    deliveredTo: [],
    readBy: [],
    createdAt: '2026-10-17T10:00:00.000Z',
    ...m,
  };
}

async function until(fn: () => boolean, ms = 5_000): Promise<void> {
  const start = Date.now();
  while (!fn()) {
    if (Date.now() - start > ms) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 10));
  }
}

const passed = (name: string, command: string | null = 'pnpm run test') => ({
  name,
  command,
  status: 'passed' as const,
  detail: null,
  ms: command ? 10 : null,
});

type Assignment = {
  id: string;
  agent: string;
  title: string;
  depends_on?: string[];
  acceptance?: string;
  needs_approval?: string;
  files?: string[];
};

const THREE: Assignment[] = [
  { id: 't1', agent: 'Moss', title: 'Write total()' },
  { id: 't2', agent: 'Tern', title: 'Write product()' },
  { id: 't3', agent: 'Moss', title: 'Write mean()' },
];

/**
 * A swarm on fake parts. Subagents settle after a short while with what `result` says for the
 * task and attempt (integrated and verified by default); the lead assigns `split` (each entry
 * one call of assign_tasks) and reviews.
 */
function setup(
  budget: number | null,
  options: {
    costPerTask?: number;
    split?: Assignment[][];
    /** What the lead assigns when it plans the rest after failures (nothing if unset). */
    replan?: Assignment[];
    assumptions?: string[];
    /** The lead's open questions, and whether nothing starts until they are answered. */
    questions?: string[];
    waitForAnswers?: boolean;
    taskBudget?: number;
    perTask?: { average: number; p90: number; from: number };
    /** Costs a task's agent reports as soon as it starts (null: a call with no price). */
    spendOnStart?: (number | null)[];
    review?: boolean;
    /** The reviewer's verdict for a task's nth review (approve by default). */
    verdict?(title: string, n: number): Record<string, unknown>;
    result?(title: string, attempt: number): Partial<SubagentOutcome> | 'hang';
    taskTimeoutMs?: number;
    /** The lead's first turn only looks around and ends without splitting. */
    lazyLead?: boolean;
    /** The lead adds this teammate before it splits the goal. */
    hire?: { name: string; role: string; reason: string };
    /** A turn an idle agent was woken for: what it does with its tools. */
    answer?(
      run: DetachedRun,
      call: (tool: string, args: Record<string, unknown>) => Promise<string>,
    ): Promise<void>;
    /** What a task's agent does as soon as it runs (with its tools), before it settles. */
    work?(
      title: string,
      call: (tool: string, args: Record<string, unknown>) => Promise<string>,
    ): Promise<void>;
    /** Task agents take messages while they run (and say when their model has them). */
    steerable?: boolean;
    replyWaitMs?: number;
    agentLimit?: number;
  } = {},
) {
  const brain = fakeBrain(budget, {
    ...(options.agentLimit !== undefined ? { agentLimit: options.agentLimit } : {}),
    ...(options.taskBudget ? { taskBudget: options.taskBudget } : {}),
    ...(options.perTask ? { perTask: options.perTask } : {}),
    ...(options.review ? { review: true } : {}),
  });
  const reviews: { title: string; prompt: string; root: string }[] = [];
  const started: StartSubagent[] = [];
  const reworked: { id: string; feedback: string }[] = [];
  const events: string[] = [];
  const assignReplies: string[] = [];
  const notices: string[] = [];
  let leadSplits = 0;
  let parallel = 0;
  let maxSeen = 0;
  const lanes: { agentId: string; type: string; askerId?: unknown }[] = [];
  const answers: { agent: string; prompt: string; tools: string[] }[] = [];
  const steers: { agent: string; text: string }[] = [];
  const runs: DetachedRun[] = [];
  const live = new Map<string, () => void>();
  const subs = new Map<string, { input: StartSubagent; attempt: number }>();
  const settleLater = (id: string, resolve: (o: SubagentOutcome) => void) => {
    const sub = subs.get(id)!;
    const p = sub.input.persona!;
    const title = sub.input.task.split(': ').slice(1).join(': ');
    const result = options.result?.(title, sub.attempt) ?? {};
    // Its running agent, when the test wants one: a message counts once "its model" has it.
    if (options.steerable && sub.attempt === 1)
      p.onAgent?.({
        get running() {
          return live.has(id);
        },
        steer: (m: { id: string; text: string; fromName?: string }) => {
          if (!live.has(id)) return false;
          steers.push({ agent: p.name, text: m.text });
          setTimeout(() => p.onEvent?.({ type: 'steer', ...m, status: 'delivered' }), 2);
          setTimeout(() => p.onEvent?.({ type: 'text', text: 'Noted.' }), 4);
          return true;
        },
        stop: () => undefined,
      } as never);
    if (options.work && sub.attempt === 1)
      void options.work(title, async (name, args) => {
        const tool = p.tools!.find((t) => t.spec.name === name)!;
        return (await tool.run(args, { signal: new AbortController().signal } as never)).output;
      });
    parallel += 1;
    maxSeen = Math.max(maxSeen, parallel);
    events.push(`start ${title}#${sub.attempt}`);
    (options.spendOnStart ?? []).forEach((cost, i) =>
      setTimeout(
        () =>
          p.onEvent?.({
            type: 'usage',
            usage: {
              promptTokens: 1,
              completionTokens: 1,
              cachedTokens: 0,
              reasoningTokens: 0,
              cost,
            },
            model: 'm',
            kind: 'model',
            estimated: false,
          }),
        5 + i * 15,
      ),
    );
    const settle = (outcome: SubagentOutcome) => {
      parallel -= 1;
      live.delete(id);
      events.push(`end ${title}#${sub.attempt} ${outcome.status}`);
      resolve(outcome);
    };
    live.set(id, () => {
      clearTimeout(timer);
      settle({
        status: 'cancelled',
        detail: 'Discarded',
        reply: null,
        checks: { passed: 0, total: 0 },
        results: [],
        verification: 'failed',
        untested: [],
        impact: null,
      });
    });
    const timer =
      result === 'hang'
        ? undefined
        : setTimeout(() => {
            p.onEvent?.({
              type: 'tool_start',
              id: `w-${id}`,
              name: 'write_file',
              summary: 'Write',
              args: { path: `/repo/src/${title.split(' ')[1] ?? 'x'}.js` },
            });
            p.onEvent?.({
              type: 'usage',
              usage: {
                promptTokens: 1,
                completionTokens: 1,
                cachedTokens: 0,
                reasoningTokens: 0,
                cost: options.costPerTask ?? 0.001,
              },
              model: 'm',
              kind: 'model',
              estimated: false,
            });
            const results = [passed('Applies to the parent', null), passed('pnpm run test')];
            const outcome: SubagentOutcome = {
              status: 'integrated',
              detail: null,
              reply: `Done.\nLearned: ${p.name} found totals live in src/totals.ts.`,
              checks: { passed: results.length, total: results.length },
              results,
              verification: 'verified',
              untested: [],
              impact: null,
              ...result,
            };
            // Like the real runner: a passed candidate is reviewed before it joins.
            const review = sub.input.review;
            if (outcome.status !== 'integrated' || !review) return settle(outcome);
            void review({
              root: '/work',
              diff: `+function ${title}`,
              results: outcome.results,
              impact: outcome.impact,
            }).then((v) => {
              const checked = [
                ...outcome.results,
                {
                  name: `Review by ${v.by}`,
                  command: null,
                  status: v.approved ? ('passed' as const) : ('failed' as const),
                  detail: v.detail,
                  ms: 1,
                },
              ];
              settle(
                v.approved
                  ? { ...outcome, results: checked }
                  : {
                      ...outcome,
                      status: 'failed',
                      detail: `Review by ${v.by}: ${v.detail}`,
                      results: checked,
                      verification: 'failed',
                    },
              );
            });
          }, 30);
  };
  const runner: SwarmRunner = new SwarmRunner({
    request: brain.request,
    me: () => ME,
    laneEvent: (_s, event, _t, agentId) =>
      lanes.push({
        agentId,
        type: event.type,
        ...('askerId' in event ? { askerId: event.askerId } : {}),
      }),
    subagents: {
      start: async (input) => {
        started.push(input);
        const id = `sub-${started.length}`;
        subs.set(id, { input, attempt: 1 });
        settleLater(id, (o) => input.persona!.onSettled?.(o));
        return { id } as never;
      },
      rework: (id: string, feedback: string) => {
        reworked.push({ id, feedback });
        subs.get(id)!.attempt += 1;
        return new Promise<SubagentOutcome>((resolve) => settleLater(id, resolve));
      },
      discard: async (id: string) => {
        live.get(id)?.();
      },
    },
    checkoutOf: async () => '/repo',
    notify: (title, body) => notices.push(`${title}: ${body}`),
    approvalPollMs: 20,
    ...(options.taskTimeoutMs ? { taskTimeoutMs: options.taskTimeoutMs } : {}),
    ...(options.replyWaitMs ? { replyWaitMs: options.replyWaitMs } : {}),
    // The lead: splits the goal with its tool the first time, reviews the second.
    run: async (run: DetachedRun) => {
      runs.push(run);
      run.onEvent({ type: 'turn_start', turnId: 't', model: 'm' });
      const assign = run.tools?.find((t: Tool) => t.spec.name === 'assign_tasks');
      const call = async (name: string, args: Record<string, unknown>) => {
        const tool = run.tools!.find((t) => t.spec.name === name)!;
        return (await tool.run(args, { signal: run.signal } as never)).output;
      };
      if (run.task.includes('you were woken for these messages')) {
        const agent = /^You are (\w+)/.exec(run.task)![1]!;
        answers.push({ agent, prompt: run.task, tools: (run.tools ?? []).map((t) => t.spec.name) });
        run.onEvent({ type: 'text', text: 'Looking.' });
        await options.answer?.(run, call);
        run.onEvent({ type: 'turn_end', turnId: 't', reason: 'done', cost: 0 });
        return { type: 'turn_end', turnId: 't', reason: 'done', cost: 0 };
      }
      const verdictTool = run.tools?.find((t: Tool) => t.spec.name === 'review_verdict');
      if (verdictTool) {
        const title = /The task: (.+)/.exec(run.task)![1]!;
        reviews.push({ title, prompt: run.task, root: run.root });
        const n = reviews.filter((r) => r.title === title).length;
        await verdictTool.run(options.verdict?.(title, n) ?? { approve: true }, {} as never);
      } else if (
        assign &&
        options.lazyLead &&
        leadSplits === 0 &&
        !run.task.includes('ended without')
      ) {
        // Looks around, then stops without calling assign_tasks.
      } else if (assign) {
        const hireTool = run.tools?.find((t: Tool) => t.spec.name === 'add_teammate');
        if (options.hire && leadSplits === 0) {
          const r = await hireTool!.run(options.hire, {} as never);
          assignReplies.push(r.output);
        }
        leadSplits += 1;
        const turns =
          leadSplits === 1 ? (options.split ?? [THREE]) : options.replan ? [options.replan] : [];
        for (const tasks of turns) {
          const r = await assign.run(
            {
              tasks,
              ...(options.assumptions ? { assumptions: options.assumptions } : {}),
              ...(options.questions ? { questions: options.questions } : {}),
              ...(options.waitForAnswers ? { wait_for_answers: true } : {}),
            },
            {} as never,
          );
          assignReplies.push(r.output);
          if (r.ok) break;
        }
      } else
        run.onEvent({
          type: 'text',
          text: 'All three helpers are in.\nPreference: alice wants small diffs.',
        });
      run.onEvent({ type: 'turn_end', turnId: 't', reason: 'done', cost: 0 });
      return { type: 'turn_end', turnId: 't', reason: 'done', cost: 0 };
    },
  });
  brain.live.send = (message) =>
    runner.onMessage({
      type: 'swarm.message',
      workspaceId: 'ws-1',
      sessionId: 'session-1',
      message,
    });
  return {
    runner,
    brain,
    started,
    reworked,
    events,
    assignReplies,
    notices,
    reviews,
    leadSplits: () => leadSplits,
    lanes,
    answers,
    steers,
    runs,
    maxSeen: () => maxSeen,
  };
}

describe('SwarmRunner', () => {
  it('splits the goal, runs the tasks in parallel, and finishes with a review', async () => {
    const { runner, brain, started, lanes, maxSeen } = setup(1);
    await runner.launch('swarm-1', '/repo');
    await until(() => brain.swarm.status === 'done');

    // The split became plan steps owned by the agents, all done.
    expect(brain.steps.map((s) => [s.title, s.ownerId, s.status])).toEqual([
      ['Write total()', MOSS, 'done'],
      ['Write product()', TERN, 'done'],
      ['Write mean()', MOSS, 'done'],
    ]);
    expect(started.map((s) => s.task)).toEqual([
      'Moss: Write total()',
      'Tern: Write product()',
      'Moss: Write mean()',
    ]);
    // At most two at once, and one task per agent at a time.
    expect(maxSeen()).toBe(2);
    expect(started[0]!.persona!.prompt).toContain('Tern: Write product()');
    // Each agent's work streams as its own lane.
    expect(lanes.some((l) => l.agentId === WREN && l.type === 'turn_start')).toBe(true);
    // Knowledge from checked work is shared; the preference is only suggested, privately.
    expect(brain.learnings.filter((l) => l['kind'] === 'knowledge')).toHaveLength(3);
    expect(brain.learnings.find((l) => l['kind'] === 'knowledge')).toMatchObject({
      verified: true,
      evidence: 'Moss: "Write total()" passed 2/2 checks',
    });
    expect(brain.messages.at(-2)).toMatchObject({
      fromId: WREN,
      toId: null,
      text: 'All three helpers are in.',
    });
    // The closing report comes from the checks.
    const report = brain.messages.at(-1)!.text;
    expect(report).toContain('Swarm report: 3 of 3 tasks verified');
    expect(report).toContain('- Write total() (Moss): verified · $0.0010');
    expect(report).toContain('checks: ✓ Applies to the parent, ✓ pnpm run test (0.0s)');
    expect(brain.swarm.spent).toBeCloseTo(0.003);
  });

  it('splits a new swarm again, even when earlier swarms left plan steps', async () => {
    const { runner, brain, started } = setup(1);
    brain.steps.push({
      id: 'old',
      title: 'Old work',
      ownerId: MOSS,
      status: 'done',
      detail: null,
      acceptance: null,
      dependsOn: [],
      files: [],
    });
    await runner.launch('swarm-1', '/repo');
    await until(() => brain.swarm.status === 'done');
    expect(started).toHaveLength(3);
  });

  it('stops at the budget the Brain keeps', async () => {
    const { runner, brain } = setup(0.0015);
    await runner.launch('swarm-1', '/repo');
    await until(() => brain.swarm.status === 'paused');
    await new Promise((r) => setTimeout(r, 150));
    // Whatever was still running is stopped: nothing past the budget is marked done.
    expect(brain.steps.filter((x) => x.status === 'done').length).toBeLessThanOrEqual(2);
    expect(brain.swarm.status).toBe('paused');
    expect(runner.isRunning('swarm-1')).toBe(false);
  });

  it('runs dependent tasks in order and independent ones together', async () => {
    const { runner, brain, events } = setup(1, {
      split: [
        [
          { id: 'model', agent: 'Moss', title: 'Add the model', acceptance: 'its tests pass' },
          { id: 'docs', agent: 'Tern', title: 'Write the docs' },
          { id: 'api', agent: 'Tern', title: 'Expose the API', depends_on: ['model'] },
        ],
      ],
    });
    await runner.launch('swarm-1', '/repo');
    await until(() => brain.swarm.status === 'done');
    // The model and the docs start together; the API only once the model is done.
    expect(events.slice(0, 2).sort()).toEqual(['start Add the model#1', 'start Write the docs#1']);
    expect(events.indexOf('start Expose the API#1')).toBeGreaterThan(
      events.indexOf('end Add the model#1 integrated'),
    );
    // Each step's run went through its states in order; the Brain checked every move.
    expect(brain.runs).toEqual({
      'Add the model': ['waiting', 'running', 'done'],
      'Write the docs': ['waiting', 'running', 'done'],
      'Expose the API': ['waiting', 'running', 'done'],
    });
    expect(brain.steps.map((s) => [s.title, s.acceptance, s.dependsOn])).toEqual([
      ['Add the model', 'its tests pass', []],
      ['Write the docs', null, []],
      ['Expose the API', null, ['step-0']],
    ]);
  });

  it('sends failed checks back once, and blocks what depends on a task that still fails', async () => {
    const failing = {
      status: 'failed' as const,
      detail: 'pnpm run test failed: expected 6, got 5',
      results: [
        passed('Applies to the parent', null),
        {
          name: 'pnpm run test',
          command: 'pnpm run test',
          status: 'failed' as const,
          detail: 'expected 6, got 5',
          ms: 10,
        },
      ],
      verification: 'failed' as const,
    };
    const { runner, brain, started, reworked } = setup(1, {
      split: [
        [
          { id: 'sum', agent: 'Moss', title: 'Write sum()' },
          { id: 'avg', agent: 'Tern', title: 'Write average()', depends_on: ['sum'] },
          { id: 'max', agent: 'Tern', title: 'Write max()' },
        ],
      ],
      result: (title, attempt) =>
        title === 'Write sum()' ? failing : title === 'Write max()' && attempt === 1 ? failing : {},
    });
    await runner.launch('swarm-1', '/repo');
    await until(() => brain.swarm.status === 'done');
    // sum() failed twice (one rework); average() never started; max() passed on its rework.
    expect(started.map((s) => s.task)).toEqual(['Moss: Write sum()', 'Tern: Write max()']);
    expect(reworked).toHaveLength(2);
    expect(reworked[0]!.feedback).toBe('- pnpm run test: expected 6, got 5');
    expect(brain.steps.map((s) => s.status)).toEqual(['doing', 'todo', 'done']);
    expect(brain.runs).toEqual({
      'Write sum()': ['waiting', 'running', 'failed'],
      'Write average()': ['waiting', 'blocked'],
      'Write max()': ['waiting', 'running', 'done'],
    });
    expect(brain.steps[0]!.runDetail).toBe('pnpm run test failed: expected 6, got 5');
    const report = brain.messages.at(-1)!.text;
    expect(report).toContain('1 of 3 tasks verified · 1 failed · 1 blocked');
    expect(report).toContain('- Write sum() (Moss): failed after 2 attempts');
    expect(report).toContain('checks: ✓ Applies to the parent, ✗ pnpm run test (0.0s)');
    expect(report).toContain(
      '- Write average() (Tern): blocked · $0.0000\n  It depends on "Write sum()", which failed',
    );
    expect(report).toContain('- Write max() (Tern): verified after 2 attempts');
  });

  it('says when work is done but the repository has no checks to verify it', async () => {
    const { runner, brain } = setup(1, {
      split: [[{ id: 't1', agent: 'Moss', title: 'Fix the typo' }]],
      result: () => ({
        results: [passed('Applies to the parent', null)],
        verification: 'unverified',
      }),
    });
    await runner.launch('swarm-1', '/repo');
    await until(() => brain.swarm.status === 'done');
    const report = brain.messages.at(-1)!.text;
    expect(report).toContain('0 of 1 tasks verified · 1 done without checks of their own');
    expect(report).toContain('- Fix the typo (Moss): done, not verified');
  });

  it('hands an agent the messages written before it started, and says it has them', async () => {
    const { runner, brain, started } = setup(1, {
      split: [[{ id: 'a', agent: 'Moss', title: 'A' }]],
    });
    brain.pending.push(
      chat({
        id: 'note-1',
        fromId: 'person-1',
        fromName: 'Alper',
        toId: MOSS,
        text: 'Reuse the Table component',
      }),
    );
    await runner.launch('swarm-1', '/repo');
    // The same message comes over the live channel too, and again once it is delivered.
    const note = brain.pending[0]!;
    runner.onMessage({
      type: 'swarm.message',
      workspaceId: 'ws-1',
      sessionId: 'session-1',
      message: note,
    });
    runner.onMessage({
      type: 'swarm.message',
      workspaceId: 'ws-1',
      sessionId: 'session-1',
      message: { ...note, deliveredTo: [MOSS] },
    });
    await until(() => brain.swarm.status === 'done');
    const prompt = started[0]!.persona!.prompt;
    expect(prompt).toContain('From Alper [message note-1]: Reuse the Table component');
    expect(prompt.split('Reuse the Table component')).toHaveLength(2);
    expect(brain.delivered.filter((d) => d.ids.includes('note-1'))).toEqual([
      { agentId: MOSS, ids: ['note-1'] },
    ]);
  });

  it('lets the lead add a teammate the team lacks, and gives them work', async () => {
    const { runner, brain, started, assignReplies } = setup(1, {
      hire: {
        name: 'Leo',
        role: 'Database migrations and queries.',
        reason: 'Nobody knows the DB',
      },
      split: [
        [
          { id: 'a', agent: 'Moss', title: 'A' },
          { id: 'db', agent: 'Leo', title: 'Add the index' },
        ],
      ],
    });
    await runner.launch('swarm-1', '/repo');
    await until(() => brain.swarm.status === 'done');
    expect(brain.hires).toEqual([
      {
        name: 'Leo',
        instructions: 'Database migrations and queries.',
        reason: 'Nobody knows the DB',
      },
    ]);
    expect(assignReplies[0]).toContain('Leo joined the team');
    expect(started.map((s) => s.task).sort()).toEqual(['Leo: Add the index', 'Moss: A']);
  });

  it("sends its run's fence, and stops when its writes are refused as stale", async () => {
    const { runner, brain, started } = setup(1, {
      split: [[{ id: 'a', agent: 'Moss', title: 'A' }]],
    });
    // It was launched again elsewhere right after this machine took it.
    brain.moved.now = true;
    await runner.launch('swarm-1', '/repo');
    await until(() => !runner.isRunning('swarm-1'));
    expect(brain.fences).toContain('swarm-1:1');
    expect(started).toEqual([]);
  });

  it('stops a waiting run as soon as it hears the swarm was launched again', async () => {
    const { runner, brain, started } = setup(1, {
      split: [[{ id: 'a', agent: 'Moss', title: 'A' }]],
      result: () => 'hang',
    });
    await runner.launch('swarm-1', '/repo');
    await until(() => started.length === 1);
    runner.onMessage({ type: 'swarm', workspaceId: 'ws-1', swarm: { ...brain.swarm, fence: 2 } });
    await until(() => !runner.isRunning('swarm-1'));
  });

  it('asks the lead once more when it stops without splitting the goal', async () => {
    const { runner, brain, started, leadSplits } = setup(1, {
      lazyLead: true,
      split: [[{ id: 'a', agent: 'Moss', title: 'A' }]],
    });
    await runner.launch('swarm-1', '/repo');
    await until(() => brain.swarm.status === 'done');
    expect(leadSplits()).toBe(1);
    expect(started.map((s) => s.task)).toEqual(['Moss: A']);
  });

  it('asks the lead again when its split is a circle', async () => {
    const { runner, brain, assignReplies, started } = setup(1, {
      split: [
        [
          { id: 'a', agent: 'Moss', title: 'A', depends_on: ['b'] },
          { id: 'b', agent: 'Tern', title: 'B', depends_on: ['a'] },
        ],
        [{ id: 'a', agent: 'Moss', title: 'A' }],
      ],
    });
    await runner.launch('swarm-1', '/repo');
    await until(() => brain.swarm.status === 'done');
    expect(assignReplies[0]).toContain('in a circle: a → b → a');
    expect(started.map((s) => s.task)).toEqual(['Moss: A']);
  });

  it('stops a task that takes too long and blocks what waits for it', async () => {
    const { runner, brain } = setup(1, {
      split: [
        [
          { id: 'slow', agent: 'Moss', title: 'Slow task' },
          { id: 'next', agent: 'Tern', title: 'After it', depends_on: ['slow'] },
        ],
      ],
      result: (title) => (title === 'Slow task' ? 'hang' : {}),
      taskTimeoutMs: 80,
    });
    await runner.launch('swarm-1', '/repo');
    await until(() => brain.swarm.status === 'done');
    const report = brain.messages.at(-1)!.text;
    expect(report).toContain('- Slow task (Moss): failed');
    expect(report).toContain('took longer than 0 minutes and was stopped');
    expect(report).toContain('- After it (Tern): blocked');
  });

  it('gives every task run its own request key, so a repeated start makes no second agent', async () => {
    const { runner, brain, started } = setup(1);
    await runner.launch('swarm-1', '/repo');
    await until(() => brain.swarm.status === 'done');
    const keys = started.map((s) => s.requestKey!);
    expect(new Set(keys).size).toBe(3);
    for (const key of keys) expect(key).toMatch(/^swarm-1:[0-9a-f]{8}:step-\d:0$/);
  });

  it('puts running work back to waiting when the swarm pauses, and runs it on resume', async () => {
    const { runner, brain, started } = setup(1, {
      split: [[{ id: 'slow', agent: 'Moss', title: 'Slow task' }]],
      result: (_title, attempt) => (started.length === 1 && attempt === 1 ? 'hang' : {}),
    });
    await runner.launch('swarm-1', '/repo');
    await until(() => brain.runs['Slow task']?.at(-1) === 'running');
    runner.onMessage({
      type: 'swarm',
      workspaceId: 'ws-1',
      swarm: { ...brain.swarm, status: 'paused' },
    });
    brain.swarm.status = 'paused';
    await until(() => !runner.isRunning('swarm-1'));
    expect(brain.runs['Slow task']).toEqual(['waiting', 'running', 'waiting']);

    await runner.launch('swarm-1', '/repo');
    await until(() => brain.swarm.status === 'done');
    expect(brain.runs['Slow task']).toEqual(['waiting', 'running', 'waiting', 'running', 'done']);
    expect(started).toHaveLength(2);
    // The resumed run is another launch: another key, not the halted subagent.
    expect(started[0]!.requestKey).not.toBe(started[1]!.requestKey);
  });

  it('cancels what was left when the swarm is stopped, and leaves nothing running', async () => {
    const { runner, brain, events } = setup(1, {
      split: [
        [
          { id: 'a', agent: 'Moss', title: 'Long task' },
          { id: 'b', agent: 'Tern', title: 'After it', depends_on: ['a'] },
        ],
      ],
      result: () => 'hang',
    });
    await runner.launch('swarm-1', '/repo');
    await until(() => brain.runs['Long task']?.at(-1) === 'running');
    brain.swarm.status = 'stopped';
    runner.onMessage({ type: 'swarm', workspaceId: 'ws-1', swarm: { ...brain.swarm } });
    await until(() => !runner.isRunning('swarm-1'));
    expect(brain.runs).toEqual({
      'Long task': ['waiting', 'running', 'waiting', 'cancelled'],
      'After it': ['waiting', 'cancelled'],
    });
    // Its subagent was discarded: started and ended, nothing left live.
    expect(events).toEqual(['start Long task#1', 'end Long task#1 cancelled']);
  });

  it('holds a risky task until a person says yes, then runs it and what waits for it', async () => {
    const { runner, brain, notices } = setup(1, {
      split: [
        [
          {
            id: 'mig',
            agent: 'Moss',
            title: 'Add a users migration',
            needs_approval: 'Changes the database schema',
          },
          { id: 'use', agent: 'Tern', title: 'Use the users table', depends_on: ['mig'] },
          { id: 'docs', agent: 'Tern', title: 'Write the docs' },
        ],
      ],
    });
    await runner.launch('swarm-1', '/repo');
    await until(() => brain.runs['Add a users migration']?.at(-1) === 'waiting_for_approval');
    expect(notices[0]).toBe(
      'Moss needs your approval: "Add a users migration": Changes the database schema. Approve it in the session plan.',
    );
    // Independent work goes on meanwhile; nothing that needs the yes has started.
    await until(() => brain.runs['Write the docs']?.at(-1) === 'done');
    expect(brain.runs['Use the users table']).toEqual(['waiting']);
    const step = brain.steps[0]!;
    step.approval = 'approved';
    step.approvedBy = ME.id;
    await until(() => brain.swarm.status === 'done');
    expect(brain.runs['Add a users migration']).toEqual([
      'waiting',
      'waiting_for_approval',
      'waiting',
      'running',
      'done',
    ]);
    expect(brain.runs['Use the users table']).toEqual(['waiting', 'running', 'done']);
    expect(step.runDetail).toBe('Verified: 2/2 checks passed');
  });

  it('stops a risky task a person says no to, and blocks what depends on it', async () => {
    const { runner, brain, started } = setup(1, {
      split: [
        [
          { id: 'del', agent: 'Moss', title: 'Delete old files', needs_approval: 'Deletes files' },
          { id: 'after', agent: 'Tern', title: 'Tidy up', depends_on: ['del'] },
        ],
      ],
    });
    await runner.launch('swarm-1', '/repo');
    await until(() => brain.runs['Delete old files']?.at(-1) === 'waiting_for_approval');
    // The answer arrives live, as a plan update.
    const plan = {
      sessionId: 'session-1',
      steps: brain.steps.map((s, i) =>
        i === 0 ? { ...s, approval: 'rejected' as const, approvedBy: ME.id } : s,
      ),
      offers: [],
    };
    runner.onMessage({ type: 'plan', workspaceId: 'ws-1', plan: plan as never });
    await until(() => brain.swarm.status === 'done');
    expect(started).toHaveLength(0);
    expect(brain.runs['Delete old files']).toEqual([
      'waiting',
      'waiting_for_approval',
      'cancelled',
    ]);
    expect(brain.steps[0]!.runDetail).toBe('Rejected by alice');
    expect(brain.runs['Tidy up']).toEqual(['waiting', 'blocked']);
  });

  it('plans the rest once after failures, on top of what got done', async () => {
    const failing = {
      status: 'failed' as const,
      detail: 'pnpm run build failed',
      results: [
        passed('Applies to the parent', null),
        {
          name: 'pnpm run build',
          command: 'pnpm run build',
          status: 'failed' as const,
          detail: 'type error',
          ms: 10,
        },
      ],
      verification: 'failed' as const,
    };
    const { runner, brain, leadSplits } = setup(1, {
      split: [
        [
          { id: 'api', agent: 'Moss', title: 'Change the API' },
          { id: 'ui', agent: 'Tern', title: 'Update the UI', depends_on: ['api'] },
        ],
      ],
      replan: [
        { id: 'api', agent: 'Tern', title: 'Change the API, keeping the old route' },
        { id: 'ui', agent: 'Moss', title: 'Update the UI after the fix', depends_on: ['api'] },
      ],
      result: (title) => (title === 'Change the API' ? failing : {}),
    });
    await runner.launch('swarm-1', '/repo');
    await until(() => brain.swarm.status === 'done');
    expect(leadSplits()).toBe(2);
    expect(brain.runs).toEqual({
      'Change the API': ['waiting', 'running', 'failed'],
      'Update the UI': ['waiting', 'blocked', 'cancelled'],
      'Change the API, keeping the old route': ['waiting', 'running', 'done'],
      'Update the UI after the fix': ['waiting', 'running', 'done'],
    });
    expect(brain.steps[1]!.runDetail).toBe('Replanned: the new plan takes it over');
    // Its dependency points at the new step, not the failed one.
    expect(brain.steps[3]!.dependsOn).toEqual(['step-2']);
    const report = brain.messages.at(-1)!.text;
    expect(report).toContain('2 of 4 tasks verified · 1 failed · 1 stopped');
    expect(report).toContain('Replanned once after failures.');
  });

  it('plans again only once', async () => {
    const { runner, brain, leadSplits } = setup(1, {
      split: [[{ id: 'a', agent: 'Moss', title: 'Task A' }]],
      replan: [{ id: 'a', agent: 'Moss', title: 'Task A again' }],
      result: () => ({ status: 'failed', detail: 'no', results: [], verification: 'failed' }),
    });
    await runner.launch('swarm-1', '/repo');
    await until(() => brain.swarm.status === 'done');
    expect(leadSplits()).toBe(2);
    expect(brain.messages.at(-1)!.text).toContain('0 of 2 tasks verified · 2 failed');
  });

  it('says out loud what the lead assumed', async () => {
    const { runner, brain } = setup(1, {
      split: [[{ id: 'a', agent: 'Moss', title: 'Add median()' }]],
      assumptions: ['Median of an even list is the mean of the middle two'],
    });
    await runner.launch('swarm-1', '/repo');
    await until(() => brain.swarm.status === 'done');
    expect(brain.messages[0]).toMatchObject({
      fromId: WREN,
      text: 'Assumptions:\n- Median of an even list is the mean of the middle two',
    });
    expect(brain.messages.at(-1)!.text).toContain(
      'Assumed:\n- Median of an even list is the mean of the middle two',
    );
  });

  it("asks the plan's open questions as questions, and lists the unanswered ones as still open", async () => {
    const t = setup(1, {
      split: [[{ id: 'a', agent: 'Moss', title: 'Add median()' }]],
      questions: ['Should median() accept strings?'],
    });
    await t.runner.launch('swarm-1', '/repo');
    await until(() => t.brain.swarm.status === 'done');
    const asked = t.brain.chat.find((m) => m.kind === 'question')!;
    expect(asked).toMatchObject({
      fromId: WREN,
      toId: ME.id,
      text: 'Open question: Should median() accept strings?',
    });
    // Nothing waited for it.
    expect(t.brain.runs['Add median()']).toEqual(['waiting', 'running', 'done']);
    expect(t.brain.messages.at(-1)!.text).toContain(
      'Still open:\n- Should median() accept strings?',
    );
  });

  it('holds every task until a person answers, when the lead says the work needs it', async () => {
    const t = setup(1, {
      split: [
        [
          { id: 'a', agent: 'Moss', title: 'Add median()' },
          { id: 'b', agent: 'Tern', title: 'Add mode()' },
        ],
      ],
      questions: ['Which file do the helpers go in?'],
      waitForAnswers: true,
    });
    await t.runner.launch('swarm-1', '/repo');
    await until(() => (t.brain.runs['Add mode()'] ?? []).includes('waiting_for_approval'));
    const asked = t.brain.chat.find((m) => m.kind === 'question')!;
    expect(asked.text).toBe('Before the work starts: Which file do the helpers go in?');
    expect(t.notices.some((n) => n.includes('has questions before the swarm starts'))).toBe(true);
    await new Promise((r) => setTimeout(r, 100));
    expect(t.started).toEqual([]);
    await t.brain.request('POST', '/api/swarms/swarm-1/messages', {
      fromId: null,
      toId: WREN,
      replyTo: asked.id,
      text: 'src/stats.js',
    });
    await until(() => t.brain.swarm.status === 'done');
    const median = t.started.find((x) => x.task === 'Moss: Add median()')!;
    expect(median.persona!.prompt).toContain(
      'alice answered the open question "Which file do the helpers go in?": src/stats.js',
    );
    expect(t.brain.runs['Add median()']).toEqual([
      'waiting',
      'waiting_for_approval',
      'waiting',
      'running',
      'done',
    ]);
    expect(t.brain.messages.at(-1)!.text).not.toContain('Still open');
  });

  it("refuses a proof it couldn't run unattended, and hands a safe one to the task's checks", async () => {
    const t = setup(1, {
      split: [
        [{ id: 'a', agent: 'Moss', title: 'Add median()', check: 'npm publish' } as Assignment],
        [
          {
            id: 'a',
            agent: 'Moss',
            title: 'Add median()',
            acceptance: 'median() of [1, 3, 2] is 2',
            check: 'node --test test/stats.test.js',
          } as Assignment,
        ],
      ],
    });
    await t.runner.launch('swarm-1', '/repo');
    await until(() => t.brain.swarm.status === 'done');
    expect(t.assignReplies[0]).toContain(`isn't one Kovan runs on its own`);
    expect(t.started[0]!.acceptanceCheck).toBe('node --test test/stats.test.js');
    // Kept with the plan step, so a resumed swarm runs it too.
    expect(t.brain.steps[0]!.acceptance).toBe(
      'median() of [1, 3, 2] is 2 (proof: `node --test test/stats.test.js`)',
    );
  });

  it('puts side-by-side tasks on the same file in order, and says so', async () => {
    const { runner, brain, events, assignReplies } = setup(1, {
      split: [
        [
          { id: 'a', agent: 'Moss', title: 'Add median()', files: ['src/stats.js'] },
          { id: 'b', agent: 'Tern', title: 'Add mode()', files: ['src/stats.js'] },
          { id: 'c', agent: 'Tern', title: 'Write docs', files: ['docs/stats.md'] },
        ],
      ],
    });
    await runner.launch('swarm-1', '/repo');
    await until(() => brain.swarm.status === 'done');
    expect(assignReplies[0]).toContain(
      '"Add mode()" now waits for "Add median()": both change src/stats.js.',
    );
    expect(brain.messages[0]!.text).toBe(
      'Plan:\n- "Add mode()" now waits for "Add median()": both change src/stats.js',
    );
    expect(brain.steps.map((s) => s.dependsOn)).toEqual([[], ['step-0'], []]);
    expect(events.indexOf('start Add mode()#1')).toBeGreaterThan(
      events.indexOf('end Add median()#1 integrated'),
    );
  });

  it('starts work over once on the updated checkout when it no longer applies', async () => {
    const conflict = {
      status: 'conflict' as const,
      detail: 'The parent changed the same lines in src/stats.js',
      results: [],
      verification: 'failed' as const,
    };
    let tries = 0;
    const { runner, brain, started } = setup(1, {
      split: [[{ id: 'a', agent: 'Moss', title: 'Add median()' }]],
      result: () => (++tries === 1 ? conflict : {}),
    });
    await runner.launch('swarm-1', '/repo');
    await until(() => brain.swarm.status === 'done');
    expect(started).toHaveLength(2);
    expect(started[1]!.requestKey).toBe(`${started[0]!.requestKey}:rerun1`);
    const prompt = started[1]!.persona!.prompt;
    expect(prompt).toContain('Handed over to you:');
    expect(prompt).toContain(
      'Moss worked on this before and stopped: its work no longer applied: The parent changed the same lines in src/stats.js.',
    );
    expect(prompt).toContain('It changed: src/median().js.');
    expect(brain.runs['Add median()']).toEqual(['waiting', 'running', 'running', 'done']);
  });

  it('fails work that conflicts again after its fresh start', async () => {
    const conflict = {
      status: 'conflict' as const,
      detail: 'The parent changed the same lines in src/stats.js',
      results: [],
      verification: 'failed' as const,
    };
    const { runner, brain, started } = setup(1, {
      split: [[{ id: 'a', agent: 'Moss', title: 'Add median()' }]],
      result: () => conflict,
    });
    await runner.launch('swarm-1', '/repo');
    await until(() => brain.swarm.status === 'done');
    expect(started).toHaveLength(2);
    expect(brain.runs['Add median()']).toEqual(['waiting', 'running', 'running', 'failed']);
  });

  it('hands a moved task over with what the first agent did', async () => {
    const { runner, brain, started } = setup(1, {
      split: [[{ id: 'a', agent: 'Moss', title: 'Add median()' }]],
      result: () => (started.length === 1 ? 'hang' : {}),
    });
    await runner.launch('swarm-1', '/repo');
    await until(() => brain.runs['Add median()']?.at(-1) === 'running');
    runner.onMessage({
      type: 'swarm.control',
      workspaceId: 'ws-1',
      swarmId: 'swarm-1',
      agentId: MOSS,
      action: 'reassign',
      toId: TERN,
    } as never);
    await until(() => brain.swarm.status === 'done');
    expect(started.map((s) => s.persona!.name)).toEqual(['Moss', 'Tern']);
    expect(started[1]!.persona!.prompt).toContain(
      'Moss worked on this before and stopped: it was moved to another agent.',
    );
    expect(brain.runs['Add median()']).toEqual([
      'waiting',
      'running',
      'waiting',
      'running',
      'done',
    ]);
  });

  it('stops a task past its own budget, as the Brain says, and blocks what waits for it', async () => {
    const { runner, brain, events } = setup(1, {
      split: [
        [
          { id: 'big', agent: 'Moss', title: 'Big task' },
          { id: 'next', agent: 'Tern', title: 'After it', depends_on: ['big'] },
        ],
      ],
      taskBudget: 0.0015,
      spendOnStart: [0.001, 0.001],
      result: () => 'hang',
    });
    await runner.launch('swarm-1', '/repo');
    await until(() => brain.swarm.status === 'done');
    expect(events).toEqual(['start Big task#1', 'end Big task#1 cancelled']);
    expect(brain.runs).toEqual({
      'Big task': ['waiting', 'running', 'failed'],
      'After it': ['waiting', 'blocked'],
    });
    expect(brain.steps[0]!.runDetail).toBe('It went over its budget: $0.0020 of $0.0015');
    expect(brain.swarm.status).toBe('done');
  });

  it('estimates from what earlier tasks here cost, and compares in the report', async () => {
    const { runner, brain } = setup(1, { perTask: { average: 0.002, p90: 0.004, from: 5 } });
    await runner.launch('swarm-1', '/repo');
    await until(() => brain.swarm.status === 'done');
    expect(brain.messages[0]!.text).toBe(
      "Estimate: 3 tasks × ~$0.0020 ≈ $0.0060 (up to ~$0.0120), from 5 finished tasks in this workspace; the lead's own turns come on top.",
    );
    expect(brain.messages.at(-1)!.text).toContain(
      'Estimated ~$0.0060 for the first plan (from 5 earlier tasks); the tasks spent $0.0030.',
    );
  });

  it("doesn't make up an estimate without earlier tasks, and says when prices are unknown", async () => {
    const { runner, brain } = setup(1, {
      split: [[{ id: 'a', agent: 'Moss', title: 'Add median()' }]],
      spendOnStart: [null],
    });
    await runner.launch('swarm-1', '/repo');
    await until(() => brain.swarm.status === 'done');
    expect(brain.messages[0]!.text).toBe(
      'No estimate yet: no swarm task has finished in this workspace to learn its cost from. The budget ($1.00) still holds.',
    );
    expect(brain.messages.at(-1)!.text).toContain(
      '1 model call has no known price (own provider or missing from the catalog): the real spend is higher than shown.',
    );
  });

  it('has each change reviewed by the lead before it joins', async () => {
    const { runner, brain, reviews } = setup(1, {
      review: true,
      split: [[{ id: 'a', agent: 'Moss', title: 'Add median()', acceptance: 'its tests pass' }]],
    });
    await runner.launch('swarm-1', '/repo');
    await until(() => brain.swarm.status === 'done');
    expect(reviews).toHaveLength(1);
    expect(reviews[0]!.root).toBe('/work');
    expect(reviews[0]!.prompt).toContain("You are Wren, reviewing Moss's change");
    expect(reviews[0]!.prompt).toContain('Done means: its tests pass');
    expect(reviews[0]!.prompt).toContain('+function Add median()');
    expect(brain.messages.at(-1)!.text).toContain(
      'checks: ✓ Applies to the parent, ✓ pnpm run test (0.0s), ✓ Review by Wren (0.0s)',
    );
  });

  it('sends a change the reviewer turns down back once, with what to fix', async () => {
    const { runner, brain, reworked } = setup(1, {
      review: true,
      split: [
        [{ id: 'a', agent: 'Moss', title: 'Add median()', acceptance: 'handles an empty list' }],
      ],
      verdict: (_title, n) =>
        n === 1
          ? { approve: true, acceptance_met: false, issues: ['median([]) throws'] }
          : { approve: true, acceptance_met: true, notes: 'No test for very large lists' },
    });
    await runner.launch('swarm-1', '/repo');
    await until(() => brain.swarm.status === 'done');
    // "Approve" with "done means" not met is a no.
    expect(reworked[0]!.feedback).toBe(
      '- Review by Wren: It doesn\'t meet "handles an empty list"; median([]) throws',
    );
    const report = brain.messages.at(-1)!.text;
    expect(report).toContain('- Add median() (Moss): verified after 2 attempts');
    expect(report).toContain('noted by Wren: No test for very large lists');
  });

  it('says which changed files no test covers', async () => {
    const { runner, brain } = setup(1, {
      split: [[{ id: 'a', agent: 'Moss', title: 'Add median()' }]],
      result: () => ({
        untested: ['src/median.js'],
        impact: {
          changed: ['src/median.js'],
          links: [
            {
              path: 'src/summary.js',
              kind: 'module' as const,
              certainty: 'imports' as const,
              via: ['src/median.js', 'src/summary.js'],
            },
          ],
          notes: [],
        },
      }),
    });
    await runner.launch('swarm-1', '/repo');
    await until(() => brain.swarm.status === 'done');
    expect(brain.messages.at(-1)!.text).toContain('  not covered by any test: src/median.js');
    expect(brain.messages.at(-1)!.text).toContain('  reaches: 1 module depends on it');
  });

  it('makes a task of tests alone wait for the code it tests', async () => {
    const { runner, brain, events, assignReplies } = setup(1, {
      split: [
        [
          { id: 'code', agent: 'Moss', title: 'Implement mode()', files: ['src/mode.js'] },
          { id: 'tests', agent: 'Tern', title: 'Add mode tests', files: ['test/mode.test.js'] },
        ],
      ],
    });
    await runner.launch('swarm-1', '/repo');
    await until(() => brain.swarm.status === 'done');
    expect(assignReplies[0]).toContain(
      '"Add mode tests" now waits for "Implement mode()": it only changes tests, which need that code.',
    );
    expect(brain.steps[1]!.dependsOn).toEqual(['step-0']);
    expect(events.indexOf('start Add mode tests#1')).toBeGreaterThan(
      events.indexOf('end Implement mode()#1 integrated'),
    );
  });
});

/** The id of the newest message to an agent, as its prompt shows it. */
const lastId = (prompt: string) => [...prompt.matchAll(/\[message (\S+?)[\],]/g)].at(-1)![1]!;

describe('Swarm chat', () => {
  it("wakes the idle lead for a person's message while the work runs; it answers and adds work", async () => {
    const t = setup(1, {
      split: [[{ id: 'a', agent: 'Moss', title: 'A' }]],
      answer: async (run, call) => {
        await call('message_agent', {
          to: 'alice',
          text: 'Adding it now.',
          reply_to: lastId(run.task),
        });
        await call('assign_tasks', {
          tasks: [{ id: 'r', agent: 'Tern', title: 'Add the README' }],
        });
      },
    });
    await t.runner.launch('swarm-1', '/repo');
    await until(() => t.started.length === 1);
    const { message } = await t.brain.request<{ message: SwarmMessage }>(
      'POST',
      '/api/swarms/swarm-1/messages',
      { fromId: null, toId: WREN, text: 'Also add a README' },
    );
    await until(() => t.brain.swarm.status === 'done');
    expect(t.answers.map((a) => a.agent)).toEqual(['Wren']);
    expect(t.answers[0]!.prompt).toContain('Also add a README');
    expect(t.answers[0]!.tools).toContain('assign_tasks');
    expect(t.started.map((x) => x.task)).toEqual(['Moss: A', 'Tern: Add the README']);
    expect(t.brain.messages).toContainEqual(
      expect.objectContaining({ fromId: WREN, toId: ME.id, kind: 'answer', replyTo: message.id }),
    );
    // Its model had it, then said something: delivered, then read.
    expect(t.brain.delivered).toContainEqual({ agentId: WREN, ids: [message.id] });
    expect(t.brain.read.some((r) => r.agentId === WREN && r.ids.includes(message.id))).toBe(true);
  });

  it('lets a worker ask the lead and wait for the answer', async () => {
    let got = '';
    const t = setup(1, {
      split: [[{ id: 'a', agent: 'Moss', title: 'A' }]],
      work: async (title, call) => {
        got = await call('message_agent', {
          to: 'lead',
          text: 'Where do totals live?',
          kind: 'question',
          wait: true,
        });
      },
      answer: async (run, call) => {
        await call('message_agent', {
          to: 'Moss',
          text: 'In src/totals.ts',
          reply_to: lastId(run.task),
        });
      },
    });
    await t.runner.launch('swarm-1', '/repo');
    await until(() => got !== '');
    expect(got).toBe('Wren answered: In src/totals.ts');
    await until(() => t.brain.swarm.status === 'done');
    const answer = t.brain.chat.find((m) => m.text === 'In src/totals.ts')!;
    expect(t.brain.delivered).toContainEqual({ agentId: MOSS, ids: [answer.id] });
  });

  it('gives up waiting after a while and says so', async () => {
    let got = '';
    const t = setup(1, {
      split: [[{ id: 'a', agent: 'Moss', title: 'A' }]],
      replyWaitMs: 50,
      work: async (title, call) => {
        got = await call('message_agent', {
          to: 'alice',
          text: 'Blue or green?',
          kind: 'question',
          wait: true,
        });
      },
    });
    await t.runner.launch('swarm-1', '/repo');
    await until(() => got !== '');
    expect(got).toContain('no answer came');
    // Written to a person: the chat has it to them.
    expect(t.brain.messages).toContainEqual(
      expect.objectContaining({ fromId: MOSS, toId: ME.id, kind: 'question' }),
    );
  });

  it('counts a message delivered once the model has it, and read once it answers after', async () => {
    const t = setup(1, {
      split: [[{ id: 'a', agent: 'Moss', title: 'A' }]],
      steerable: true,
      result: () => 'hang',
      taskTimeoutMs: 200,
    });
    await t.runner.launch('swarm-1', '/repo');
    await until(() => t.started.length === 1);
    const { message } = await t.brain.request<{ message: SwarmMessage }>(
      'POST',
      '/api/swarms/swarm-1/messages',
      { fromId: null, toId: MOSS, text: 'Keep it small' },
    );
    await until(() => t.brain.read.some((r) => r.ids.includes(message.id)));
    expect(t.steers).toEqual([{ agent: 'Moss', text: expect.stringContaining('Keep it small') }]);
    expect(t.brain.delivered).toContainEqual({ agentId: MOSS, ids: [message.id] });
    await until(() => t.brain.swarm.status === 'done');
  });

  it("wakes nobody for agents' announcements, and an idle agent at most three times for theirs", async () => {
    const t = setup(1, {
      split: [[{ id: 'a', agent: 'Moss', title: 'A' }]],
      result: () => 'hang',
      taskTimeoutMs: 600,
      work: async (title, call) => {
        await call('message_agent', { to: 'everyone', text: 'I am on A' });
        for (let i = 0; i < 5; i++) {
          await call('message_agent', { to: 'Tern', text: `Ping ${i}` });
          await until(() => false, 40).catch(() => undefined);
        }
      },
    });
    await t.runner.launch('swarm-1', '/repo');
    await until(() => t.brain.swarm.status === 'done');
    expect(t.answers.filter((a) => a.agent === 'Tern')).toHaveLength(3);
    expect(t.answers.filter((a) => a.agent === 'Wren')).toHaveLength(0);
  });

  it('holds a task that needs an answer until a person gives it, and hands it the answer', async () => {
    const t = setup(1, {
      split: [
        [
          {
            id: 'c',
            agent: 'Moss',
            title: 'Paint the button',
            needs_answer: 'Which colour?',
          } as Assignment,
          { id: 'b', agent: 'Tern', title: 'B' },
        ],
      ],
    });
    await t.runner.launch('swarm-1', '/repo');
    await until(() => (t.brain.runs['Paint the button'] ?? []).includes('waiting_for_approval'));
    const question = t.brain.chat.find((m) => m.kind === 'question')!;
    expect(question).toMatchObject({ fromId: WREN, toId: ME.id });
    expect(question.text).toContain('Which colour?');
    expect(t.notices.some((n) => n.includes('needs an answer'))).toBe(true);
    await until(() => t.started.length === 1);
    expect(t.started.map((x) => x.task)).toEqual(['Tern: B']);
    await t.brain.request('POST', '/api/swarms/swarm-1/messages', {
      fromId: null,
      toId: WREN,
      replyTo: question.id,
      text: 'Blue',
    });
    await until(() => t.brain.swarm.status === 'done');
    const paint = t.started.find((x) => x.task === 'Moss: Paint the button')!;
    expect(paint.persona!.prompt).toContain('alice answered "Which colour?": Blue');
    expect(t.brain.runs['Paint the button']).toEqual([
      'waiting',
      'waiting_for_approval',
      'waiting',
      'running',
      'done',
    ]);
  });

  it("counts an AI teammate's direct task against its limit, and stops it there", async () => {
    const t = setup(1, { agentLimit: 0.01, spendOnStart: [0.004, 0.008], steerable: true });
    const direct = t.runner.direct({
      sessionId: 'session-1',
      agentId: TERN,
      text: 'Add a test for total()',
      id: 'lane-1',
      fromUserId: ME.id,
      fromName: 'alice',
    });
    await until(() => t.notices.some((n) => n.startsWith('Tern stopped')));
    expect(t.brain.agentSpend.reports).toEqual([0, 0.004, 0.008]);
    expect(t.notices.find((n) => n.startsWith('Tern stopped'))).toContain(
      "Tern's monthly limit is reached",
    );
    expect(t.lanes.filter((l) => l.agentId === TERN).map((l) => l.type)).toContain('notice');
    await direct;
  });

  it('asks whoever called a teammate in with @ before it edits or runs anything', async () => {
    const t = setup(1);
    const direct = t.runner.direct({
      sessionId: 'session-1',
      agentId: TERN,
      text: 'Is this total() right?',
      id: 'lane-3',
      fromUserId: ME.id,
      fromName: 'alice',
      mention: { context: 'alice: add a total() helper\nagent: Added src/total.ts' },
    });
    await until(() => t.started.length === 1);
    const call = t.started[0]!;
    expect(call.persona!.prompt).toContain('alice called you into a conversation');
    expect(call.persona!.prompt).toContain('agent: Added src/total.ts');
    expect(call.persona!.prompt).toContain('alice asked you: Is this total() right?');
    const request = (id: string) => ({
      id,
      tool: 'run_shell',
      kind: 'command' as const,
      title: 'Run this?',
      detail: 'pnpm test',
    });
    // Its approval card says who called it in, so their phone hears about it.
    call.persona!.onEvent!({ type: 'approval', request: request('r1') });
    expect(t.lanes.at(-1)).toMatchObject({ agentId: TERN, type: 'approval', askerId: ME.id });
    const answer = (requestId: string, status: 'approved' | 'denied' | 'pending') =>
      t.runner.onMessage({
        type: 'approval',
        approval: {
          sessionId: 'session-1',
          laneUserId: TERN,
          requestId,
          tool: 'run_shell',
          kind: 'command',
          title: 'Run this?',
          detail: 'pnpm test',
          status,
          answeredBy: ME.id,
          createdAt: '',
        },
      });
    const first = call.askFirst!(request('r1'));
    const second = call.askFirst!(request('r2'));
    answer('r1', 'pending');
    answer('r1', 'approved');
    answer('r2', 'denied');
    expect(await first).toBe(true);
    expect(await second).toBe(false);
    await direct;
  });

  it('tells the conversation it was called into that it is on it, then what it answered', async () => {
    const t = setup(1, { result: () => ({ reply: 'total() skips refunds.' }) });
    await t.runner.direct({
      sessionId: 'session-1',
      agentId: TERN,
      text: '@Tern why are refunds off?',
      id: 'call-1',
      fromUserId: ME.id,
      fromName: 'alice',
      mention: { context: null, reply: { kind: 'comment', commentId: 'c-1' } },
    });
    expect(t.brain.answers.map((a) => [a['status'], a['text']])).toEqual([
      ['working', null],
      ['changed', 'total() skips refunds.'],
    ]);
    expect(t.brain.answers[0]).toMatchObject({
      agentId: TERN,
      requestId: 'call-1',
      askerId: ME.id,
      reply: { kind: 'comment', commentId: 'c-1' },
    });
    // A lane message (no @ call) reports nothing.
    await t.runner.direct({
      sessionId: 'session-1',
      agentId: TERN,
      text: 'Add a test',
      id: 'lane-9',
      fromUserId: ME.id,
      fromName: 'alice',
    });
    expect(t.brain.answers).toHaveLength(2);
  });

  it("lets a teammate's own tasks run without asking", async () => {
    const t = setup(1);
    await t.runner.direct({
      sessionId: 'session-1',
      agentId: TERN,
      text: 'Add a test for total()',
      id: 'lane-4',
      fromUserId: ME.id,
      fromName: 'alice',
    });
    expect(t.started[0]!.askFirst).toBeUndefined();
    expect(t.started[0]!.persona!.prompt).toContain('Make the change in the files here');
  });

  it('does not start a direct task once the limit is reached', async () => {
    const t = setup(1, { agentLimit: 0 });
    await t.runner.direct({
      sessionId: 'session-1',
      agentId: TERN,
      text: 'Add a test for total()',
      id: 'lane-2',
      fromUserId: ME.id,
      fromName: 'alice',
    });
    expect(t.started).toEqual([]);
    expect(t.notices).toEqual([
      "Tern didn't start: Tern's monthly limit is reached ($0.0000 of $0.0000).",
    ]);
    expect(t.lanes.map((l) => l.type)).toEqual(['user', 'notice']);
  });

  it('wakes an idle swarm agent for a message in its lane, inside its swarm', async () => {
    const t = setup(1, {
      split: [[{ id: 'a', agent: 'Moss', title: 'A' }]],
      result: () => 'hang',
      taskTimeoutMs: 200,
    });
    await t.runner.launch('swarm-1', '/repo');
    await until(() => t.started.length === 1);
    await t.runner.direct({
      sessionId: 'session-1',
      agentId: TERN,
      text: 'Why is the build slow?',
      id: 'lane-1',
      fromUserId: ME.id,
      fromName: 'alice',
    });
    await until(() => t.answers.length === 1);
    expect(t.answers[0]).toMatchObject({ agent: 'Tern' });
    expect(t.answers[0]!.prompt).toContain('From alice (in your lane): Why is the build slow?');
    await until(() => t.brain.swarm.status === 'done');
    // No solo job beside the swarm.
    expect(t.started.map((x) => x.task)).toEqual(['Moss: A']);
  });

  it('refuses more tasks than it takes at once, instead of cutting the plan', async () => {
    const nine = Array.from({ length: 9 }, (_, i) => ({
      id: `t${i}`,
      agent: 'Moss',
      title: `T${i}`,
    }));
    const t = setup(1, { split: [nine, [{ id: 'a', agent: 'Moss', title: 'A' }]] });
    await t.runner.launch('swarm-1', '/repo');
    await until(() => t.brain.swarm.status === 'done');
    expect(t.assignReplies[0]).toContain('At most 8 tasks at once');
    expect(t.started.map((x) => x.task)).toEqual(['Moss: A']);
  });

  it("checks every run's writes against others' work, and gives it a note of the team", async () => {
    const t = setup(1, { split: [[{ id: 'a', agent: 'Moss', title: 'A' }]] });
    t.brain.locks.push({ path: 'src/pay.js', userId: 'person-2', userName: 'Bea' });
    await t.runner.launch('swarm-1', '/repo');
    await until(() => t.started.length === 1);
    const run = t.started[0]!.persona!.coordination!('/work');
    const note = (await run.turnContext!())!;
    expect(note).toContain('Your swarm now:');
    expect(note).toContain('- Moss: A → running');
    expect(note).toContain('src/pay.js (locked by Bea)');
    expect(note).toContain('"Checkout page" (Bea): src/cart.js');
    expect(await run.checkWrite!('/work/src/cart.js')).toContain('Checkout page');
    // The lead's own turns get the note too.
    expect(t.runs.every((r) => typeof r.turnContext === 'function')).toBe(true);
    await until(() => t.brain.swarm.status === 'done');
  });
});
