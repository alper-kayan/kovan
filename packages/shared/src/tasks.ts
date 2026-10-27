import { z } from 'zod';
import type { SubagentStatus } from './git.js';

// ---------- Phase 15: task graphs, lifecycle, verified completion ----------

/**
 * Where a subagent (an agent made for one task) may go from each status. Integrated, cancelled
 * and answered are final; failed and conflicting work can be checked again or reworked.
 */
const SUBAGENT_MOVES: Record<SubagentStatus, readonly SubagentStatus[]> = {
  running: ['checking', 'failed', 'cancelled', 'answered'],
  checking: ['passed', 'failed', 'conflict', 'cancelled'],
  passed: ['integrated', 'failed', 'conflict', 'cancelled'],
  failed: ['running', 'checking', 'cancelled'],
  conflict: ['running', 'checking', 'cancelled'],
  integrated: [],
  cancelled: [],
  answered: [],
};

/** Whether a subagent may move from one status to another (staying put is always allowed). */
export function canMoveSubagent(from: SubagentStatus, to: SubagentStatus): boolean {
  return from === to || SUBAGENT_MOVES[from].includes(to);
}

/**
 * The outcome of one check. `not_run`: an earlier check failed, so it was skipped; `blocked`:
 * it couldn't run at all (dependencies missing, the agent stopped first).
 */
export const CheckStatusSchema = z.enum(['passed', 'failed', 'not_run', 'blocked']);
export type CheckStatus = z.infer<typeof CheckStatusSchema>;

export const CheckResultSchema = z.object({
  name: z.string().max(200),
  /** The command run, or null for Kovan's own checks (applies cleanly, no conflict markers). */
  command: z.string().max(2000).nullable(),
  status: CheckStatusSchema,
  /** Why it failed or couldn't run: the last lines of its output. */
  detail: z.string().max(2000).nullable(),
  ms: z.number().int().min(0).max(86_400_000).nullable(),
});
export type CheckResult = z.infer<typeof CheckResultSchema>;

/**
 * What the checks say about a task. `verified`: every check passed and at least one of them was
 * the project's own (tests, typecheck, build…). `unverified`: nothing failed, but the project
 * has no checks Kovan could run, so only "it applies cleanly" is known. `failed`: a check failed
 * or couldn't run.
 */
export type Verification = 'verified' | 'unverified' | 'failed';

export function verificationOf(checks: readonly CheckResult[]): Verification {
  if (checks.length === 0 || checks.some((c) => c.status !== 'passed')) return 'failed';
  return checks.some((c) => c.command !== null) ? 'verified' : 'unverified';
}

/** One task of a plan, as the orchestrator sees it. */
export interface GraphTask {
  key: string;
  /** Keys of the tasks that must be done (and verified) before this one starts. */
  dependsOn: readonly string[];
}

/**
 * Checks a task graph: every dependency names a task of the graph, and nothing depends on itself,
 * directly or through others. Returns what is wrong, or null.
 */
export function graphProblem(tasks: readonly GraphTask[]): string | null {
  const keys = new Set<string>();
  for (const t of tasks) {
    if (keys.has(t.key)) return `Two tasks are called "${t.key}"`;
    keys.add(t.key);
  }
  for (const t of tasks)
    for (const d of t.dependsOn) {
      if (d === t.key) return `"${t.key}" depends on itself`;
      if (!keys.has(d)) return `"${t.key}" depends on "${d}", which is not a task`;
    }
  const byKey = new Map(tasks.map((t) => [t.key, t]));
  const state = new Map<string, 'visiting' | 'done'>();
  const visit = (key: string, path: string[]): string | null => {
    if (state.get(key) === 'done') return null;
    if (state.get(key) === 'visiting')
      return `The tasks depend on each other in a circle: ${[...path.slice(path.indexOf(key)), key].join(' → ')}`;
    state.set(key, 'visiting');
    for (const d of byKey.get(key)!.dependsOn) {
      const found = visit(d, [...path, key]);
      if (found) return found;
    }
    state.set(key, 'done');
    return null;
  };
  for (const t of tasks) {
    const found = visit(t.key, []);
    if (found) return found;
  }
  return null;
}

/**
 * Where a task of a swarm stands. `waiting`: for its dependencies or a free agent;
 * `waiting_for_approval`: a person must say yes before it starts; `blocked`: something it
 * depends on failed, so it can't run.
 */
export const TaskStateSchema = z.enum([
  'waiting',
  'waiting_for_approval',
  'running',
  'done',
  'failed',
  'blocked',
  'cancelled',
]);
export type TaskState = z.infer<typeof TaskStateSchema>;

/**
 * Where a task may go from each state. Done and cancelled are final. A running task goes back
 * to waiting when its swarm pauses (it runs again on resume); failed and blocked work can be
 * planned again.
 */
const TASK_MOVES: Record<TaskState, readonly TaskState[]> = {
  waiting: ['waiting_for_approval', 'running', 'blocked', 'cancelled'],
  waiting_for_approval: ['waiting', 'blocked', 'cancelled'],
  running: ['done', 'failed', 'waiting', 'cancelled'],
  failed: ['waiting', 'cancelled'],
  blocked: ['waiting', 'cancelled'],
  done: [],
  cancelled: [],
};

/** Whether a task may move between states; a step no swarm has run yet (null) may start anywhere. */
export function canMoveTask(from: TaskState | null, to: TaskState): boolean {
  return from === null || from === to || TASK_MOVES[from].includes(to);
}

/**
 * The tasks that can start now: waiting, with every dependency done. Tasks whose dependency
 * failed, was blocked or cancelled can never run; they are returned as `blocked`.
 */
export function nextTasks(
  tasks: readonly GraphTask[],
  stateOf: (key: string) => TaskState,
): { ready: string[]; blocked: { key: string; by: string }[] } {
  const ready: string[] = [];
  const blocked: { key: string; by: string }[] = [];
  for (const t of tasks) {
    if (stateOf(t.key) !== 'waiting') continue;
    const dead = t.dependsOn.find((d) => ['failed', 'blocked', 'cancelled'].includes(stateOf(d)));
    if (dead) blocked.push({ key: t.key, by: dead });
    else if (t.dependsOn.every((d) => stateOf(d) === 'done')) ready.push(t.key);
  }
  return { ready, blocked };
}

/** Whether two file lists touch the same file (a folder counts for everything under it). */
function sharedFiles(a: readonly string[], b: readonly string[]): string[] {
  const norm = (p: string) => p.trim().replace(/^\.\//, '').replace(/\/+$/, '');
  const inside = (x: string, y: string) =>
    x === y || x.startsWith(`${y}/`) || y.startsWith(`${x}/`);
  return a.map(norm).filter((x) => x && b.map(norm).some((y) => y && inside(x, y)));
}

/**
 * Tasks that would run side by side but touch the same files are put in order: the later one
 * waits for the earlier, so their changes can't collide when they join. Changes `dependsOn` in
 * place and returns what it ordered.
 */
export function serializeOverlaps(
  tasks: (GraphTask & { dependsOn: string[]; files: readonly string[] })[],
): { task: string; after: string; files: string[] }[] {
  const byKey = new Map(tasks.map((t) => [t.key, t]));
  const reaches = (from: string, to: string, seen = new Set<string>()): boolean => {
    if (from === to) return true;
    if (seen.has(from)) return false;
    seen.add(from);
    return (byKey.get(from)?.dependsOn ?? []).some((d) => reaches(d, to, seen));
  };
  const added: { task: string; after: string; files: string[] }[] = [];
  // Nearest earlier task first, so a chain on one file stays a chain.
  for (let j = 1; j < tasks.length; j++)
    for (let i = j - 1; i >= 0; i--) {
      const earlier = tasks[i]!;
      const later = tasks[j]!;
      const files = sharedFiles(earlier.files, later.files);
      if (files.length === 0) continue;
      if (reaches(later.key, earlier.key) || reaches(earlier.key, later.key)) continue;
      later.dependsOn.push(earlier.key);
      added.push({ task: later.key, after: earlier.key, files });
    }
  return added;
}

// ---------- the journal and replay ----------

/**
 * One line of a session's replay: something the Brain recorded (a plan change, a task's state,
 * a check, a cost, an approval) or something an agent did in its lane (a model call, a tool,
 * an answer). Read only: replaying runs nothing.
 */
export interface ReplayEvent {
  /** Where it came from: the Brain's journal, or a lane's transcript. */
  source: 'journal' | 'lane';
  /** The journal's order; lane events share their chunk's time (within about a second). */
  seq: number | null;
  at: string;
  kind: string;
  /** Who did it (a person or an AI teammate), when known. */
  actorName: string | null;
  /** Whose lane it happened in. */
  laneName: string | null;
  summary: string;
  detail: string | null;
  /** Ids that tie it to the rest: the task, its subagent, the swarm, the tool call. */
  refs: { stepId?: string; subagentId?: string; swarmId?: string; toolId?: string };
  /** Structured facts for the replay's state view (a task's new state, a cost). */
  data: Record<string, unknown> | null;
}

/**
 * Columns for drawing a task graph left to right: each task sits one column after the
 * latest of the tasks it depends on (its longest chain from a start). Dependencies outside the
 * list are ignored; the graph must have no circle (see graphProblem).
 */
export function graphColumns<T extends GraphTask>(tasks: readonly T[]): T[][] {
  const byKey = new Map(tasks.map((t) => [t.key, t]));
  const depth = new Map<string, number>();
  const depthOf = (t: T): number => {
    const known = depth.get(t.key);
    if (known !== undefined) return known;
    const deps = t.dependsOn.map((d) => byKey.get(d)).filter((d): d is T => Boolean(d));
    const d = deps.length ? Math.max(...deps.map(depthOf)) + 1 : 0;
    depth.set(t.key, d);
    return d;
  };
  const columns: T[][] = [];
  for (const t of tasks) (columns[depthOf(t)] ??= []).push(t);
  return columns.map((c) => c ?? []);
}

// ---------- change impact ----------

/**
 * How a file is tied to a change: it is the change (`changed`), imports a changed file
 * (`imports`), imports one that does (`imports_indirectly`), or only mentions a changed file's
 * name (`mentions`, the least sure).
 */
export type ImpactCertainty = 'changed' | 'imports' | 'imports_indirectly' | 'mentions';

export interface ImpactLink {
  path: string;
  kind: 'module' | 'test' | 'api';
  certainty: ImpactCertainty;
  /** From the changed file to this one. */
  via: string[];
}

/** What a change can reach. A map for checking, not proof that the change is safe. */
export interface ChangeImpact {
  changed: string[];
  links: ImpactLink[];
  /** What the map can't see (other languages, aliases, unresolved imports). */
  notes: string[];
}

const TEST_PATH = /(^|\/)(test|tests|__tests__|spec)\/|\.(test|spec)\.[a-z]+$|_test\.(go|py)$/;

/**
 * A task that only changes tests is checked in its own copy, where the code it tests isn't
 * there yet; on its own it fails. It waits for the tasks of the same plan that change code
 * (unless they are already in order). Changes `dependsOn` in place and returns what it ordered.
 */
export function orderTestOnlyTasks(
  tasks: (GraphTask & { dependsOn: string[]; files: readonly string[] })[],
): { task: string; after: string }[] {
  const byKey = new Map(tasks.map((t) => [t.key, t]));
  const reaches = (from: string, to: string, seen = new Set<string>()): boolean => {
    if (from === to) return true;
    if (seen.has(from)) return false;
    seen.add(from);
    return (byKey.get(from)?.dependsOn ?? []).some((d) => reaches(d, to, seen));
  };
  const testOnly = (t: { files: readonly string[] }) =>
    t.files.length > 0 && t.files.every((f) => TEST_PATH.test(f));
  const added: { task: string; after: string }[] = [];
  for (const t of tasks) {
    if (!testOnly(t)) continue;
    for (const code of tasks) {
      if (code === t || testOnly(code) || code.files.length === 0) continue;
      if (reaches(t.key, code.key) || reaches(code.key, t.key)) continue;
      t.dependsOn.push(code.key);
      added.push({ task: t.key, after: code.key });
    }
  }
  return added;
}
