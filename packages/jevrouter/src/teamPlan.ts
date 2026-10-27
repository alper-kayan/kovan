import { classifyByRules } from './classifier.js';
import type { TaskType } from './policy.js';

/** An AI teammate that could join a swarm. */
export interface TeamCandidate {
  id: string;
  name: string;
  /** What it is good at ("Writes tests first"). */
  instructions: string;
}

export interface TeamSuggestion {
  /** One agent is enough: a swarm would only add cost; the person's own agent can do it. */
  small: boolean;
  leadId: string;
  /** Teammates who take tasks; empty when the lead does the work itself. */
  workerIds: string[];
  maxParallel: number;
  reason: string;
}

const TASK_WORDS: Record<TaskType, string> = {
  question: 'a question',
  small_edit: 'a small change',
  feature: 'a feature',
  refactor: 'a refactor',
  debug: 'debugging',
  plan: 'planning',
  review: 'a review',
};

const LEAD_WORDS = /\b(lead|leads|plan|plans|planning|review|reviews|architect|coordinat)/i;
const STOP = new Set(
  'a an and the to of in on for with by from into each both all its it is be are this that these those then also add make write'.split(
    ' ',
  ),
);

/**
 * The separate pieces a goal asks for: "median(), range() and a summary()" is three. Counted from
 * the goal's lists (commas, "and", lines); a goal without a list is one piece.
 */
export function goalParts(goal: string): number {
  const pieces = goal
    .split(/\n\s*(?:[-*•]|\d+[.)])\s+|,|;|\band\b|\bve\b|\bplus\b/i)
    .map((p) => p.trim())
    .filter((p) => p.split(/\s+/).filter(Boolean).length >= 1 && /\w/.test(p));
  return Math.max(1, Math.min(6, pieces.length));
}

function words(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/[^\p{L}\p{N}]+/u)
      .filter((w) => w.length > 2 && !STOP.has(w))
      .map((w) => w.replace(/(ing|es|s)$/, '')),
  );
}

/**
 * Who should work on a goal, before anyone spends on it: how big it is (JevRouter's free rules:
 * task type, difficulty, how many pieces), then the teammates whose instructions fit it best.
 * A small, single-piece goal gets one agent; two or three pieces get two workers, four or more
 * pieces (or a hard goal) three, never more than are free. Null when there is nobody to pick.
 */
export function suggestTeam(
  goal: string,
  agents: TeamCandidate[],
  /** A Solo workspace keeps swarms small (two workers at most). */
  options: { maxWorkers?: number } = {},
): TeamSuggestion | null {
  if (agents.length === 0 || !goal.trim()) return null;
  const c = classifyByRules([{ role: 'user', content: goal }]);
  const parts = goalParts(goal);
  const wanted =
    parts <= 1 && c.difficulty <= 2
      ? 0
      : Math.min(parts, c.difficulty >= 4 || parts >= 4 ? 3 : 2, options.maxWorkers ?? 3);

  const lead = agents.find((a) => LEAD_WORDS.test(a.instructions)) ?? agents[0]!;
  const goalWords = words(goal);
  const fit = (a: TeamCandidate) =>
    [...words(a.instructions)].filter((w) => goalWords.has(w)).length;
  const workers = agents
    .filter((a) => a.id !== lead.id)
    .map((a, i) => ({ a, score: fit(a), i }))
    .sort((x, y) => y.score - x.score || x.i - y.i)
    .slice(0, wanted)
    .map((x) => x.a);

  const size = `${TASK_WORDS[c.task]}, difficulty ${c.difficulty}/5, ${parts} part${parts === 1 ? '' : 's'}`;
  const team = workers.length
    ? `${lead.name} leads, ${workers.map((w) => w.name).join(' and ')} take the tasks`
    : `${lead.name} alone: more agents wouldn't pay off`;
  const short =
    wanted > workers.length
      ? ` (only ${workers.length} other teammate${workers.length === 1 ? '' : 's'} free)`
      : '';
  return {
    small: wanted === 0,
    leadId: lead.id,
    workerIds: workers.map((w) => w.id),
    maxParallel: Math.max(1, workers.length),
    reason: `${size}: ${team}${short}`,
  };
}
