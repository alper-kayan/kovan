import { z } from 'zod';
import type { SwarmOutcome } from './sessions.js';

// ---------- Phase 10: AI teammates, Swarm, private learning ----------

export const PermissionModeSchema = z.enum(['plan', 'request', 'allow', 'full']);
export const EffortSchema = z.enum(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);

/**
 * An AI teammate: a workspace member like a person (it has a name, a role, a lane in sessions,
 * plan steps of its own), but no account to sign in with. It runs on the machine of whoever
 * puts it to work, on their provider key, and they pay for it.
 */
export interface AiAgent {
  /** Its member id (a user of kind "agent"). */
  id: string;
  workspaceId: string;
  name: string;
  model: string;
  effort: z.infer<typeof EffortSchema> | null;
  mode: z.infer<typeof PermissionModeSchema>;
  /** What it is good at and how it should work ("Writes tests first; keeps changes small"). */
  instructions: string;
  /** USD a month its work may cost, swarms and direct tasks together; null: no limit of its own. */
  monthlyLimit: number | null;
  /** What its work cost this calendar month (UTC). */
  monthSpent: number;
  createdBy: string | null;
  createdByName: string | null;
  archived: boolean;
  createdAt: string;
}

export const AgentNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(40)
  .regex(/^[\p{L}\p{N}][\p{L}\p{N} ._-]*$/u, 'Use letters, numbers, spaces, dots, dashes');

/** Model, vendor and tool names: a teammate is a colleague, so it never goes by one of these. */
const NOT_A_PERSON =
  /\b(claude|codex|gpt|o\d|gemini|llama|mistral|grok|deepseek|qwen|copilot|cursor|opus|sonnet|haiku|anthropic|openai|kovan|jev|jevrouter|agent|bot|assistant|ai|llm|model)\b/i;

/**
 * A name the swarm's lead gives a teammate it adds: a person's first name in English letters
 * ("Leo", "Nora Lee"), never a model's or a tool's.
 */
export const PersonNameSchema = z
  .string()
  .trim()
  .min(2)
  .max(24)
  .regex(/^[A-Z][a-z]+(?: [A-Z][a-z]+)?$/, "Use a person's first name, like Leo or Nora")
  .refine((n) => !NOT_A_PERSON.test(n), "Use a person's name, not a model's or a tool's");

/** The lead adds a teammate the team lacks, through the workspace's agent factory. */
export const HireTeammateSchema = z.object({
  name: PersonNameSchema,
  /** Its role: what it is good at and how it works. */
  instructions: z.string().trim().min(10).max(1000),
  /** Why the team needs it, for the people reading the session. */
  reason: z.string().trim().min(3).max(300),
});

const AI_AGENT_FIELDS = {
  name: AgentNameSchema,
  model: z.string().trim().min(1).max(200),
  effort: EffortSchema.nullable(),
  mode: PermissionModeSchema,
  instructions: z.string().max(4000),
  monthlyLimit: z.number().min(0.01).max(100_000).nullable(),
};

export const CreateAiAgentSchema = z.object({
  ...AI_AGENT_FIELDS,
  effort: AI_AGENT_FIELDS.effort.default(null),
  mode: AI_AGENT_FIELDS.mode.default('allow'),
  instructions: AI_AGENT_FIELDS.instructions.default(''),
  monthlyLimit: AI_AGENT_FIELDS.monthlyLimit.default(null),
});

/** Only what is sent changes (zod 4 would fill a partial's defaults in, resetting the rest). */
export const UpdateAiAgentSchema = z.object(AI_AGENT_FIELDS).partial();

/** What an AI teammate's direct task cost (the machine running it reports as it goes). */
export const AgentSpendSchema = z.object({
  sessionId: z.string().uuid(),
  /** 0 asks only whether it may work. */
  amount: z.number().min(0).max(1000),
});

export interface AgentSpendReply {
  monthSpent: number;
  /** Why it must stop (its own limit, or the workspace's), or null. */
  over: string | null;
}

/**
 * Where a teammate called in with @ answers: the caller's agent conversation (their lane), or
 * the comment thread it was called into (its first comment).
 */
export const MentionReplySchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('lane'), laneUserId: z.string().uuid() }),
  z.object({ kind: z.literal('comment'), commentId: z.string().uuid() }),
]);
export type MentionReply = z.infer<typeof MentionReplySchema>;

/** Calling an AI teammate into a conversation with @: the request and the conversation so far. */
export const MentionSchema = z.object({
  agentId: z.string().uuid(),
  text: z.string().trim().min(1).max(10_000),
  /** The conversation as the teammate should read it, cut to a readable size. */
  context: z.string().max(40_000).nullable().default(null),
  reply: MentionReplySchema,
});
export type Mention = z.infer<typeof MentionSchema>;

/**
 * How a called-in teammate's work on a request stands: working on it, answered (nothing
 * changed), changed (its change joined the session), failed, or stopped.
 */
export const MentionStatusSchema = z.enum(['working', 'answered', 'changed', 'failed', 'stopped']);
export type MentionStatus = z.infer<typeof MentionStatusSchema>;

/** The machine running a called-in teammate reports back to the conversation it was called into. */
export const MentionAnswerSchema = z.object({
  agentId: z.string().uuid(),
  /** The call it answers (the id `POST /api/sessions/:id/mention` gave). */
  requestId: z.string().min(1).max(100),
  /** Who called it in. */
  askerId: z.string().uuid(),
  reply: MentionReplySchema,
  status: MentionStatusSchema,
  /** Its answer (or why it failed); none while working. */
  text: z.string().max(20_000).nullable().default(null),
  /** What it was asked (sent when it starts), for a conversation that didn't see the call. */
  asked: z.string().max(10_000).nullable().default(null),
});
export type MentionAnswer = z.infer<typeof MentionAnswerSchema>;

export const SwarmStatusSchema = z.enum(['draft', 'running', 'paused', 'done', 'stopped']);
export type SwarmStatus = z.infer<typeof SwarmStatusSchema>;

export interface SwarmAgent {
  agentId: string;
  name: string;
  role: 'lead' | 'worker';
  status: 'idle' | 'working' | 'done' | 'stopped';
  /** What it is doing now. */
  task: string | null;
  spent: number;
}

/**
 * Several AI teammates on one shared goal in a session. The lead splits the goal into plan
 * steps for the others; they work in parallel, each in its own worktree, and their checked work
 * joins the session's checkout. It runs on the machine of whoever launched it, who pays; the
 * Brain keeps the budget and stops the swarm when it is reached.
 */
export interface Swarm {
  id: string;
  sessionId: string;
  workspaceId: string;
  goal: string;
  leadAgentId: string | null;
  status: SwarmStatus;
  /** Spending limit in USD; null means explicitly unlimited. */
  budget: number | null;
  /** Most one task may spend, in USD; past it the task is stopped. Null: no per-task limit. */
  taskBudget: number | null;
  /** Each task's change is reviewed by another agent before it joins. */
  review: boolean;
  spent: number;
  maxParallel: number;
  mode: z.infer<typeof PermissionModeSchema>;
  /** Who launched it (whose machine runs it, who pays). */
  launchedBy: string | null;
  launchedByName: string | null;
  /** Raised on every launch; the run's requests carry it (`x-kovan-fence`). */
  fence: number;
  pausedReason: string | null;
  /** How its tasks ended, once it is done (set by the run that finished it). */
  outcome: SwarmOutcome | null;
  agents: SwarmAgent[];
  createdAt: string;
  updatedAt: string;
}

/**
 * The swarm's state as a short badge: its status, except that a done swarm says how its tasks
 * went ("Done · 1 failed", or "Failed" when none worked). `tone` picks the color.
 */
export function swarmBadge(swarm: { status: string; outcome?: SwarmOutcome | null }): {
  label: string;
  tone: string;
} {
  const o = swarm.status === 'done' ? swarm.outcome : null;
  if (o && o.tasks > 0 && o.done === 0) return { label: 'Failed', tone: 'failed' };
  const bad = o ? o.failed + o.blocked : 0;
  if (o && bad > 0) return { label: `Done · ${bad} failed`, tone: 'partial' };
  return {
    label: swarm.status.charAt(0).toUpperCase() + swarm.status.slice(1),
    tone: swarm.status,
  };
}

/** A done swarm's result in a few words: "2 of 3 tasks done, 1 failed", or null when not done. */
export function swarmResult(swarm: { status: string; outcome?: SwarmOutcome | null }): {
  text: string;
  ok: boolean;
} | null {
  if (swarm.status !== 'done' || !swarm.outcome) return null;
  const o = swarm.outcome;
  if (o.tasks === 0) return { text: 'Finished with no tasks to do', ok: true };
  const rest = [
    o.failed ? `${o.failed} failed` : '',
    o.blocked ? `${o.blocked} blocked` : '',
    o.stopped ? `${o.stopped} stopped` : '',
  ].filter(Boolean);
  if (o.done === 0)
    return { text: `Ended without finishing a task (${rest.join(', ')})`, ok: false };
  return {
    text: `${o.done} of ${o.tasks} tasks done${rest.length ? `, ${rest.join(', ')}` : ''}`,
    ok: rest.length === 0,
  };
}

export const SwarmSettingsSchema = z.object({
  goal: z.string().trim().min(1).max(4000),
  leadAgentId: z.string().uuid().nullable(),
  agentIds: z.array(z.string().uuid()).min(1).max(12),
  budget: z.number().min(0.01).max(10_000).nullable(),
  taskBudget: z.number().min(0.01).max(1000).nullable().default(null),
  review: z.boolean().default(true),
  maxParallel: z.number().int().min(1).max(6).default(2),
  mode: PermissionModeSchema.default('allow'),
});

export const SwarmReportSchema = z.object({
  agentId: z.string().uuid(),
  status: z.enum(['idle', 'working', 'done', 'stopped']).optional(),
  task: z.string().max(500).nullable().optional(),
  /** Cost of a finished turn, added to the agent's and the swarm's spend. */
  cost: z.number().min(0).max(1000).optional(),
  /** The plan step (task) the cost belongs to, for its own budget. */
  stepId: z.string().uuid().optional(),
});

/** The Brain's answer to a report: the swarm, and the task's spend against its budget. */
export interface SwarmReportReply {
  swarm: Swarm;
  step?: { spent: number; over: boolean };
}

/**
 * What agents spent in a workspace, for limits and estimates. Estimates come only from tasks
 * that actually ran here; with none, there is no estimate.
 */
export interface AgentSpendStats {
  monthSpent: number;
  monthLimit: number | null;
  /** Finished swarm tasks (done or failed) with a known spend. */
  tasks: number;
  perTask: { average: number; p90: number } | null;
}

/**
 * What a swarm task reads and writes, measured on finished tasks (2026-10: 57 small changes
 * with their tests, on GPT-5.6 Luna and Claude Haiku 5.5): each task's cost divided back by its
 * model's prices, as fresh input and output tokens. A typical task (the median) and a larger
 * one (about the 90th percentile).
 */
export const TASK_TOKENS = {
  typical: { input: 12_000, output: 1_200 },
  large: { input: 36_000, output: 3_600 },
} as const;

/** A task's cost on a model, from its prices (USD per million tokens). */
export function taskCostAt(pricing: { input: number; output: number }): {
  typical: number;
  large: number;
} {
  const at = (t: { input: number; output: number }) =>
    (t.input * pricing.input + t.output * pricing.output) / 1_000_000;
  return { typical: at(TASK_TOKENS.typical), large: at(TASK_TOKENS.large) };
}

export const SwarmMessageKindSchema = z.enum(['note', 'question', 'answer', 'blocker']);
export type SwarmMessageKind = z.infer<typeof SwarmMessageKindSchema>;

/**
 * A line of the swarm's live chat: agents talking to each other, people to them, and agents
 * to the people of the session.
 */
export interface SwarmMessage {
  id: string;
  swarmId: string;
  fromId: string;
  fromName: string;
  /** null: to everyone in the swarm. An agent of the swarm, or a person of the session. */
  toId: string | null;
  toName: string | null;
  /** A note, a question (it waits for an answer), an answer, or a blocker (work can't go on). */
  kind: SwarmMessageKind;
  /** The message this one answers. */
  replyTo: string | null;
  text: string;
  /** The agents that have it in their model's context (until then it is queued). */
  deliveredTo: string[];
  /** The agents whose model answered after seeing it. */
  readBy: string[];
  createdAt: string;
}

/** The machine running a swarm says which messages one of its agents now has, or has read. */
export const SwarmDeliveredSchema = z.object({
  agentId: z.string().uuid(),
  ids: z.array(z.string().uuid()).min(1).max(100),
});

export const SwarmMessageSchema = z.object({
  /** An agent of the swarm (sent by the machine running it); omitted: the person themselves. */
  fromId: z.string().uuid().nullable().default(null),
  toId: z.string().uuid().nullable().default(null),
  text: z.string().trim().min(1).max(4000),
  kind: SwarmMessageKindSchema.default('note'),
  replyTo: z.string().uuid().nullable().default(null),
  /** Sending again with the same key gives back the first message instead of a second one. */
  key: z.string().min(8).max(100).optional(),
});

/**
 * What the swarm learned. Knowledge comes only from checked task results and is shared with
 * the workspace; preferences about how a person likes to work stay private to them and
 * unverified until they accept them, and can be corrected or forgotten.
 */
export interface Learning {
  id: string;
  workspaceId: string;
  kind: 'knowledge' | 'preference';
  /** Whose preference it is (only they see it); null for shared knowledge. */
  ownerId: string | null;
  text: string;
  status: 'suggested' | 'accepted' | 'forgotten';
  verified: boolean;
  /** For knowledge: the checked task it came from. */
  evidence: string | null;
  swarmId: string | null;
  createdAt: string;
  updatedAt: string;
}

export const CreateLearningSchema = z.object({
  kind: z.enum(['knowledge', 'preference']),
  text: z.string().trim().min(1).max(1000),
  swarmId: z.string().uuid().nullable().default(null),
  /** Knowledge must come from a task whose checks passed. */
  evidence: z.string().max(1000).nullable().default(null),
  verified: z.boolean().default(false),
});

export const UpdateLearningSchema = z
  .object({
    text: z.string().trim().min(1).max(1000),
    status: z.enum(['accepted', 'forgotten']),
  })
  .partial();

/**
 * An agent's questions and blockers to people (to everyone, or to a person) that no person has
 * answered yet, oldest first: what the swarm waits on people for.
 */
export function openQuestions(messages: SwarmMessage[], agentIds: string[]): SwarmMessage[] {
  const isAgent = (id: string) => agentIds.includes(id);
  return messages.filter(
    (m) =>
      isAgent(m.fromId) &&
      (m.kind === 'question' || m.kind === 'blocker') &&
      (m.toId === null || !isAgent(m.toId)) &&
      !messages.some((x) => x.replyTo === m.id && !isAgent(x.fromId)),
  );
}
