import {
  git,
  mainCheckout,
  snapshotCommit,
  syncFromSnapshot,
  type SyncResult,
} from '@kovan/git-engine';
import type { AgentEvent, ApprovalRequest, Tool } from '@kovan/harness';
import {
  verificationOf,
  type ChangeImpact,
  type CheckResult,
  type Subagent,
  type Verification,
} from '@kovan/shared';
import type { DetachedRun, LiveAgent } from './run.js';
import type { SessionCheckouts } from './sessionCheckouts.js';
import { commandAllowed } from './commandPolicy.js';
import { changeImpact } from './impact.js';
import { detectChecks, linkDependencies, runChecks } from './verify.js';

/** Progress goes to the rail at most this often. */
const REPORT_MS = 1_500;
const CHECK_TIMEOUT_MS = 10 * 60_000;
const EDIT_TOOLS = new Set(['edit_file', 'write_file']);

export interface SubagentDeps {
  request<T>(method: 'GET' | 'POST' | 'PATCH', path: string, body?: unknown): Promise<T>;
  checkouts: SessionCheckouts;
  /** Runs Kovan's agent outside any conversation (the window's agent manager). */
  run(run: DetachedRun): Promise<Extract<AgentEvent, { type: 'turn_end' }>>;
  /** A subagent's work joined the session checkout at `root`. */
  changed?(sessionId: string, root: string): void;
}

export interface StartSubagent {
  sessionId: string;
  /** The parent lane's checkout. */
  parentRoot: string;
  task: string;
  model: string;
  effort: DetachedRun['effort'];
  /** The parent lane's permissions: a subagent may run commands only when the parent may freely. */
  parentMode: DetachedRun['mode'];
  /** An AI teammate doing this task for a swarm, instead of an anonymous subagent. */
  persona?: SubagentPersona;
  /** Makes starting idempotent: a repeat of the same key gets the subagent it started. */
  requestKey?: string;
  /** It ended (integrated, or failed / conflicted / cancelled): for an agent that delegated it. */
  onSettled?(outcome: SubagentOutcome): void;
  /**
   * An independent review of the work once its checks pass, before it joins: someone other
   * than its agent reads the diff (and the files in `root`) against the task.
   */
  review?: (input: ReviewInput) => Promise<ReviewVerdict>;
  /**
   * A command that proves the task's "done means" (a test of what it changes), run after the
   * project's own checks. Only a command an unattended agent may run (`commandAllowed`).
   */
  acceptanceCheck?: string | null;
  /**
   * Someone called this teammate in with @: it reads freely, but each edit and command waits for
   * their answer, and a reply alone (nothing changed) finishes it as answered.
   */
  askFirst?: (request: ApprovalRequest) => Promise<boolean>;
}

export interface ReviewInput {
  /** The subagent's worktree, to read files in. */
  root: string;
  /** The change against its starting point (cut to a readable size). */
  diff: string;
  results: CheckResult[];
  impact: ChangeImpact | null;
}

export interface ReviewVerdict {
  approved: boolean;
  /** Who reviewed it ("Wren"). */
  by: string;
  /** What is wrong, or what the reviewer noted. */
  detail: string | null;
}

export interface SubagentPersona {
  agentId: string;
  name: string;
  /** The whole prompt: who it is, what the team knows, the task. */
  prompt: string;
  tools?: Tool[];
  onEvent?(event: AgentEvent): void;
  /** The running agent, to steer it. */
  onAgent?(agent: LiveAgent): void;
  /** It ended: integrated, or failed / conflicted / cancelled (with why), and its last words. */
  onSettled?(outcome: SubagentOutcome): void;
  /** Its check before each write and its team note, for the copy it works in. */
  coordination?(root: string): Pick<DetachedRun, 'checkWrite' | 'turnContext'>;
}

export interface SubagentOutcome {
  status: 'integrated' | 'failed' | 'conflict' | 'cancelled' | 'answered';
  detail: string | null;
  reply: string | null;
  checks: { passed: number; total: number };
  /** Each check of the last run; empty when it never got to checking. */
  results: CheckResult[];
  verification: Verification;
  /** Source files it changed that no test mentions (from the checkout, not a guess). */
  untested: string[];
  /** What the change can reach (tests, modules, API routes), once its checks passed. */
  impact: ChangeImpact | null;
}

const TERMINAL = new Set(['failed', 'conflict', 'cancelled', 'answered']);

interface Local {
  sub: Subagent;
  parentRoot: string;
  mainRoot: string;
  root: string;
  base: string;
  abort: AbortController;
  integrating: boolean;
  persona: SubagentPersona | null;
  input: StartSubagent;
  reply: string | null;
  results: CheckResult[];
  untested: string[];
  impact: ChangeImpact | null;
  settled: boolean;
  /** Waiting for its next outcome (after a rework). */
  waiters: ((outcome: SubagentOutcome) => void)[];
}

type Patch = Partial<
  Pick<
    Subagent,
    'status' | 'added' | 'removed' | 'checksPassed' | 'checksTotal' | 'rev' | 'detail' | 'checks'
  >
>;

/** A diff longer than this is cut for the reviewer (it can still read the files). */
const MAX_REVIEW_DIFF = 40_000;
const TEST_FILE = /(^|\/)(test|tests|__tests__|spec)\/|\.(test|spec)\.[a-z]+$|_test\.(go|py)$/;
const SOURCE_FILE = /\.(ts|tsx|js|jsx|mjs|cjs|py|go|rs|rb|java|kt|swift|cs|php)$/;

/**
 * Source files a change touched that no test file mentions by name: what its passing tests
 * can't vouch for. Looked up in the work itself (new test files included), not guessed.
 */
export async function untestedFiles(root: string, base: string, work: string): Promise<string[]> {
  const changed = (await git(root, ['diff', '--name-only', '--diff-filter=AM', base, work]))
    .split('\n')
    .filter((f) => f && SOURCE_FILE.test(f) && !TEST_FILE.test(f));
  const untested: string[] = [];
  for (const file of changed.slice(0, 50)) {
    const stem = file
      .split('/')
      .pop()!
      .replace(/\.[^.]+$/, '');
    const hits = await git(root, [
      'grep',
      '-l',
      '-F',
      '--untracked',
      stem,
      '--',
      ':(glob)**/*.test.*',
      ':(glob)**/*.spec.*',
      ':(glob)**/test/**',
      ':(glob)**/tests/**',
      ':(glob)**/__tests__/**',
      ':(glob)**/*_test.*',
    ]).catch(() => '');
    if (!hits.trim()) untested.push(file);
  }
  return untested;
}

/** Lines added and removed in `root` since `base`, new files included. */
async function diffStat(root: string, base: string): Promise<{ added: number; removed: number }> {
  const { sha } = await snapshotCommit(root, 'stat');
  const out = await git(root, ['diff', '--numstat', base, sha]);
  let added = 0;
  let removed = 0;
  for (const line of out.split('\n')) {
    const [a, r] = line.split('\t');
    added += Number(a) || 0;
    removed += Number(r) || 0;
  }
  return { added, removed };
}

/**
 * Child tasks beside a lane. Each starts from a snapshot of the parent's checkout in its own
 * detached worktree, so the parent keeps working. Progress streams to the session rail. When the
 * child finishes, its required checks run (it applies to the parent, no conflict markers or
 * whitespace errors, and the repository's "Required Checks" from KOVAN.md); a clean candidate
 * is integrated into the parent exactly once (the Brain hands out the one claim). A conflict or
 * a failed check leaves the parent untouched and the child's worktree there to review.
 */
export class SubagentRunner {
  private readonly local = new Map<string, Local>();
  /** Starts under way, by request key: a repeat while one is starting waits for it. */
  private readonly starting = new Map<string, Promise<Subagent>>();

  constructor(private readonly deps: SubagentDeps) {}

  start(input: StartSubagent): Promise<Subagent> {
    const key = input.requestKey;
    if (!key) return this.begin(input);
    const pending = this.starting.get(key);
    if (pending) return pending;
    const started = this.begin(input).finally(() => this.starting.delete(key));
    this.starting.set(key, started);
    return started;
  }

  private async begin(input: StartSubagent): Promise<Subagent> {
    const mainRoot = await mainCheckout(input.parentRoot);
    const { sha: base } = await snapshotCommit(input.parentRoot, 'Kovan subagent: starting point');
    const body = {
      task: input.task,
      baseSha: base,
      ...(input.requestKey ? { requestKey: input.requestKey } : {}),
    };
    const post = () =>
      this.deps.request<{ subagent: Subagent; existing?: boolean }>(
        'POST',
        `/api/sessions/${input.sessionId}/subagents`,
        body,
      );
    // With a key, a request whose answer got lost is safe to send again.
    const { subagent, existing } = await post().catch((error: unknown) => {
      if (!input.requestKey) throw error;
      return post();
    });
    if (existing) {
      const here = this.local.get(subagent.id);
      if (here) return here.sub;
      // Started by a request whose answer never came back: nothing has worked on it yet.
      const untouched =
        subagent.status === 'running' && subagent.rev === 0 && subagent.checksTotal === 0;
      if (!untouched) throw new Error(`"${input.task}" was started already`);
    }
    // Keep the starting point reachable while the child works.
    await git(mainRoot, ['update-ref', `refs/kovan/subagents/${subagent.id}/base`, base]);
    let root: string;
    try {
      root = await this.deps.checkouts.forSubagent(mainRoot, subagent.id, base);
    } catch (error) {
      await this.report(subagent.id, { status: 'failed', detail: (error as Error).message });
      throw error;
    }
    const local: Local = {
      sub: subagent,
      parentRoot: input.parentRoot,
      mainRoot,
      root,
      base,
      abort: new AbortController(),
      integrating: false,
      persona: input.persona ?? null,
      input,
      reply: null,
      results: [],
      untested: [],
      impact: null,
      settled: false,
      waiters: [],
    };
    this.local.set(subagent.id, local);
    void this.work(local, input).catch((error: unknown) =>
      this.report(subagent.id, {
        status: 'failed',
        detail: (error as Error).message.slice(0, 500),
      }),
    );
    return subagent;
  }

  private async report(id: string, patch: Patch): Promise<void> {
    const r = await this.deps
      .request<{ subagent: Subagent }>('PATCH', `/api/subagents/${id}`, patch)
      .catch((error: unknown) => {
        console.warn('Subagent report failed:', error);
        return null;
      });
    const local = this.local.get(id);
    if (r && local) local.sub = r.subagent;
    if (local && patch.status && TERMINAL.has(patch.status))
      this.settle(local, patch.status as SubagentOutcome['status'], patch.detail ?? null);
  }

  private settle(local: Local, status: SubagentOutcome['status'], detail: string | null): void {
    if (local.settled) return;
    local.settled = true;
    const outcome: SubagentOutcome = {
      status,
      detail,
      reply: local.reply,
      checks: {
        passed: local.results.filter((c) => c.status === 'passed').length,
        total: local.results.length,
      },
      results: local.results,
      verification: status === 'integrated' ? verificationOf(local.results) : 'failed',
      untested: local.untested,
      impact: local.impact,
    };
    local.persona?.onSettled?.(outcome);
    local.input.onSettled?.(outcome);
    for (const resolve of local.waiters.splice(0)) resolve(outcome);
  }

  /**
   * Sends failed work back to its agent, in the same worktree, with what went wrong; then it is
   * checked again. Resolves with the new outcome.
   */
  async rework(id: string, feedback: string): Promise<SubagentOutcome> {
    const local = this.local.get(id);
    if (!local) throw new Error("This subagent's worktree is on another machine.");
    if (!local.settled) throw new Error('It is still working.');
    const next = new Promise<SubagentOutcome>((resolve) => local.waiters.push(resolve));
    local.settled = false;
    local.reply = null;
    local.results = [];
    await this.report(id, { status: 'running', checks: [], detail: 'Reworking after its checks' });
    void this.work(local, local.input, feedback).catch((error: unknown) =>
      this.report(id, { status: 'failed', detail: (error as Error).message.slice(0, 500) }),
    );
    return next;
  }

  private async work(local: Local, input: StartSubagent, feedback?: string): Promise<void> {
    const id = local.sub.id;
    let rev = 0;
    let lastReport = 0;
    let pending: NodeJS.Timeout | null = null;
    let doing: string | null = null;
    const tools = new Map<string, string>();
    const progress = () => {
      if (pending) return;
      pending = setTimeout(
        async () => {
          pending = null;
          lastReport = Date.now();
          const stat = await diffStat(local.root, local.base).catch(() => null);
          await this.report(id, { rev, ...(stat ?? {}), detail: doing });
        },
        Math.max(0, REPORT_MS - (Date.now() - lastReport)),
      );
    };

    const end = await this.deps.run({
      root: local.root,
      model: input.model,
      effort: input.effort,
      // Edits are free inside its own worktree; commands only when the parent runs on Full.
      // Called in with @, it asks before both.
      mode: input.askFirst ? 'request' : input.parentMode === 'full' ? 'full' : 'allow',
      task: [
        input.persona?.prompt ??
          [
            'You are a subagent: you work alone in your own copy of the repository, beside the lane that started you.',
            `Your task: ${input.task}`,
            '',
            'Make the change in the files here; do not commit, push or switch branches. Keep it focused on the task.',
            "When you're done, reply with one or two sentences on what you changed.",
          ].join('\n'),
        feedback
          ? `\nYour earlier attempt is in these files, but it didn't pass its checks:\n${feedback}\nFix what failed, keeping the rest of your change.`
          : '',
      ].join('\n'),
      ...(input.persona?.tools ? { tools: input.persona.tools } : {}),
      ...(input.persona?.onAgent ? { onAgent: input.persona.onAgent } : {}),
      ...(input.persona?.coordination?.(local.root) ?? {}),
      approve: input.askFirst ?? (async () => false),
      onEvent: (event) => {
        input.persona?.onEvent?.(event);
        // Its last words: the text after its last tool call (text arrives in pieces).
        if (event.type === 'text') local.reply = (local.reply ?? '') + event.text;
        if (event.type === 'tool_start') {
          local.reply = null;
          tools.set(event.id, event.name);
          doing = event.summary.slice(0, 200);
        }
        if (event.type === 'tool_end' && event.ok && EDIT_TOOLS.has(tools.get(event.id) ?? '')) {
          rev += 1;
          progress();
        }
      },
      signal: local.abort.signal,
    });
    if (pending) clearTimeout(pending);
    const stat = await diffStat(local.root, local.base).catch(() => ({ added: 0, removed: 0 }));
    if (end.reason === 'stopped') {
      await this.report(id, { status: 'cancelled', rev, ...stat, detail: 'Stopped' });
      return;
    }
    if (end.reason !== 'done') {
      await this.report(id, {
        status: 'failed',
        rev,
        ...stat,
        detail: end.error ?? 'The subagent stopped before finishing',
      });
      return;
    }
    if (stat.added === 0 && stat.removed === 0 && input.askFirst) {
      await this.report(id, { status: 'answered', rev, ...stat, detail: null });
      await this.cleanUp(local);
      return;
    }
    if (stat.added === 0 && stat.removed === 0) {
      await this.report(id, {
        status: 'failed',
        rev,
        ...stat,
        detail: 'It finished without changing anything',
      });
      return;
    }
    await this.report(id, { rev, ...stat });
    await this.check(local);
  }

  /**
   * Verifies the work: it applies to the parent, it has no conflict markers or whitespace
   * errors, and the project's own checks pass (KOVAN.md "Required Checks", else its scripts).
   * Every check gets a status; only a clean candidate is integrated.
   */
  async check(local: Local): Promise<void> {
    const id = local.sub.id;
    const found = await detectChecks(local.root);
    // The task's own proof comes last: the project's checks say nothing else broke first.
    const proof = local.input.acceptanceCheck?.trim();
    const project =
      proof && commandAllowed(proof)
        ? [
            ...found,
            {
              name: `Done means: ${proof}`,
              command: proof,
              source: 'the task',
              needsNodeModules: found.some((c) => c.needsNodeModules),
            },
          ]
        : found;
    const hasNodeModules = project.some((c) => c.needsNodeModules)
      ? await linkDependencies(local.mainRoot, local.root)
      : true;
    const own = (name: string, status: CheckResult['status'], detail: string | null) => ({
      name,
      command: null,
      status,
      detail,
      ms: null,
    });
    const skipped = (from: number) =>
      project.slice(from).map((c) => ({
        name: c.name,
        command: c.command,
        status: 'not_run' as const,
        detail: 'An earlier check failed',
        ms: null,
      }));
    const passedOf = (checks: CheckResult[]) => checks.filter((c) => c.status === 'passed').length;
    local.results = [];
    await this.report(id, {
      status: 'checking',
      checksPassed: 0,
      checksTotal: 2 + project.length + (local.input.review ? 1 : 0),
      checks: [],
      detail: 'Checking it applies to the parent',
    });
    const work = (
      await snapshotCommit(local.root, `Kovan subagent: ${local.sub.task.slice(0, 60)}`)
    ).sha;

    const dry = await syncFromSnapshot(local.parentRoot, work, local.base, {
      dryRun: true,
      followHead: false,
    });
    if (dry.conflicts.length > 0) {
      const detail = `The parent changed the same lines in ${dry.conflicts.map((c) => c.path).join(', ')}`;
      local.results = [
        own('Applies to the parent', 'failed', detail),
        own('No conflict markers or whitespace errors', 'not_run', 'An earlier check failed'),
        ...skipped(0),
      ];
      await this.report(id, { status: 'conflict', checksPassed: 0, checks: local.results, detail });
      return;
    }
    local.results = [own('Applies to the parent', 'passed', null)];
    await this.report(id, {
      checksPassed: 1,
      checks: local.results,
      detail: 'No conflict markers or whitespace errors',
    });
    const markers = await git(local.root, ['diff', '--check', local.base, work])
      .then(() => null)
      .catch((error: unknown) => (error as { stdout?: string }).stdout || (error as Error).message);
    if (markers) {
      const detail = `git diff --check: ${markers.split('\n')[0]}`;
      local.results.push(
        own('No conflict markers or whitespace errors', 'failed', detail),
        ...skipped(0),
      );
      await this.report(id, { status: 'failed', checksPassed: 1, checks: local.results, detail });
      return;
    }
    local.results.push(own('No conflict markers or whitespace errors', 'passed', null));
    const ownResults = [...local.results];

    const results = await runChecks(local.root, project, {
      hasNodeModules,
      timeoutMs: CHECK_TIMEOUT_MS,
      signal: local.abort.signal,
      onStart: (c, done) =>
        this.report(id, {
          checksPassed: passedOf([...ownResults, ...done]),
          detail: `Running ${c.command.split('\n')[0]}`,
        }),
      onResult: (done) => {
        local.results = [...ownResults, ...done];
        return this.report(id, { checksPassed: passedOf(local.results), checks: local.results });
      },
    });
    local.results = [...ownResults, ...results];
    const bad = results.find((c) => c.status !== 'passed');
    if (bad) {
      await this.report(id, {
        status: 'failed',
        checksPassed: passedOf(local.results),
        checks: local.results,
        detail:
          `${bad.name} ${bad.status === 'blocked' ? "couldn't run" : 'failed'}: ${bad.detail ?? ''}`
            .trim()
            .slice(0, 1000),
      });
      return;
    }
    local.untested = await untestedFiles(local.root, local.base, work).catch(() => []);
    local.impact = await git(local.root, ['diff', '--name-only', local.base, work])
      .then((out) => changeImpact(local.root, out.split('\n').filter(Boolean)))
      .catch(() => null);

    // Checks are not the whole story: someone else reads the change against the task.
    if (local.input.review) {
      await this.report(id, { checksPassed: passedOf(local.results), detail: 'Being reviewed' });
      const started = Date.now();
      const diff = await git(local.root, ['diff', '--stat', '--patch', local.base, work])
        .then((d) => (d.length > MAX_REVIEW_DIFF ? `${d.slice(0, MAX_REVIEW_DIFF)}\n… (cut)` : d))
        .catch(() => '');
      const verdict = await local.input
        .review({ root: local.root, diff, results: local.results, impact: local.impact })
        .catch((error: unknown): ReviewVerdict => ({
          approved: false,
          by: 'the reviewer',
          detail: `The review couldn't run: ${(error as Error).message}`,
        }));
      local.results = [
        ...local.results,
        {
          name: `Review by ${verdict.by}`,
          command: null,
          status: verdict.approved ? 'passed' : 'failed',
          detail: verdict.detail?.slice(0, 2000) ?? null,
          ms: Date.now() - started,
        },
      ];
      if (!verdict.approved) {
        await this.report(id, {
          status: 'failed',
          checksPassed: passedOf(local.results),
          checks: local.results,
          detail: `Review by ${verdict.by}: ${verdict.detail ?? 'not approved'}`.slice(0, 1000),
        });
        return;
      }
    }
    await this.report(id, {
      status: 'passed',
      checksPassed: passedOf(local.results),
      checks: local.results,
      detail: project.length ? null : 'This repository has no checks of its own to run',
    });
    await this.integrate(id);
  }

  /** Applies a passed child to its parent, once: the Brain's claim decides who does it. */
  async integrate(id: string): Promise<SyncResult | null> {
    const local = this.local.get(id);
    if (!local || local.integrating) return null;
    local.integrating = true;
    try {
      const work = (
        await snapshotCommit(local.root, `Kovan subagent: ${local.sub.task.slice(0, 60)}`)
      ).sha;
      // The parent may have moved on while the checks ran.
      const dry = await syncFromSnapshot(local.parentRoot, work, local.base, {
        dryRun: true,
        followHead: false,
      });
      if (dry.conflicts.length > 0) {
        await this.report(id, {
          status: 'conflict',
          detail: `The parent changed the same lines in ${dry.conflicts.map((c) => c.path).join(', ')}`,
        });
        return null;
      }
      const { subagent } = await this.deps.request<{ subagent: Subagent }>(
        'POST',
        `/api/subagents/${id}/integrate`,
      );
      local.sub = subagent;
      const result = await syncFromSnapshot(local.parentRoot, work, local.base, {
        atomic: true,
        followHead: false,
      });
      await this.cleanUp(local);
      this.settle(local, 'integrated', null);
      this.deps.changed?.(local.input.sessionId, local.parentRoot);
      return result;
    } finally {
      local.integrating = false;
    }
  }

  /** Runs the checks again (after fixing the parent, say), then integrates. */
  async retry(id: string): Promise<void> {
    const local = this.local.get(id);
    if (!local) throw new Error("This subagent's worktree is on another machine.");
    await this.check(local);
  }

  /** Stops a running child, or throws its work away. */
  async discard(id: string): Promise<void> {
    const local = this.local.get(id);
    if (!local) throw new Error("This subagent's worktree is on another machine.");
    local.abort.abort();
    if (['running', 'checking', 'passed', 'failed', 'conflict'].includes(local.sub.status))
      await this.report(id, { status: 'cancelled', detail: 'Discarded' });
    await this.cleanUp(local);
  }

  /** Where a child's work is, to review it. */
  pathOf(id: string): string | null {
    return this.local.get(id)?.root ?? null;
  }

  stopAll(): void {
    for (const local of this.local.values()) local.abort.abort();
  }

  private async cleanUp(local: Local): Promise<void> {
    this.local.delete(local.sub.id);
    await this.deps.checkouts.removeSubagent(local.mainRoot, local.root).catch(() => undefined);
    await git(local.mainRoot, [
      'update-ref',
      '-d',
      `refs/kovan/subagents/${local.sub.id}/base`,
    ]).catch(() => undefined);
  }
}
