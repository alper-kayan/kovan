import { z } from 'zod';
import { CheckResultSchema, type CheckResult } from './tasks.js';

// ---------- Phase 9: subagents, pull requests ----------

/**
 * running → checking → passed → integrated, or failed (a check failed, the agent errored) or
 * conflict (it no longer applies to the parent). Failed and conflicting work stays reviewable.
 * answered: a teammate called in with @ replied without changing anything.
 */
export const SubagentStatusSchema = z.enum([
  'running',
  'checking',
  'passed',
  'integrated',
  'failed',
  'conflict',
  'cancelled',
  'answered',
]);
export type SubagentStatus = z.infer<typeof SubagentStatusSchema>;

/** A child task running beside its parent lane, in its own worktree from a session snapshot. */
export interface Subagent {
  id: string;
  sessionId: string;
  /** Whose lane started it (and whose account it runs on). */
  parentUserId: string;
  parentName: string;
  task: string;
  status: SubagentStatus;
  /** Lines added and removed against the snapshot it started from. */
  added: number;
  removed: number;
  checksPassed: number;
  checksTotal: number;
  /** How many times its work changed (each edit is a revision). */
  rev: number;
  /** The snapshot it started from. */
  baseSha: string | null;
  /** Why it failed or conflicts, or which check is running. */
  detail: string | null;
  /** Each check of its last run, with what happened (passed, failed, not run, blocked). */
  checks: CheckResult[];
  createdAt: string;
  updatedAt: string;
  integratedAt: string | null;
}

export const StartSubagentSchema = z.object({
  task: z.string().trim().min(1).max(2000),
  /**
   * Makes starting idempotent: the same key from the same lane returns the subagent it already
   * started instead of a second one (a swarm task uses its swarm, task and run).
   */
  requestKey: z.string().trim().min(1).max(200).optional(),
  baseSha: z
    .string()
    .regex(/^[0-9a-f]{7,64}$/)
    .nullable()
    .default(null),
});

export const UpdateSubagentSchema = z
  .object({
    status: SubagentStatusSchema.exclude(['integrated']),
    added: z.number().int().min(0).max(10_000_000),
    removed: z.number().int().min(0).max(10_000_000),
    checksPassed: z.number().int().min(0).max(100),
    checksTotal: z.number().int().min(0).max(100),
    rev: z.number().int().min(0).max(1_000_000),
    detail: z.string().max(2000).nullable(),
    checks: z.array(CheckResultSchema).max(30),
  })
  .partial();

/** A session's pull request; merging it completes the session. */
export interface SessionPr {
  url: string;
  number: number;
  state: 'open' | 'merged' | 'closed';
}

export const SessionPrSchema = z.object({
  url: z
    .string()
    .url()
    .max(500)
    .refine((u) => /^https:\/\//.test(u) || /^http:\/\/(localhost|127\.0\.0\.1)[:/]/.test(u)),
  number: z.number().int().min(1),
  state: z.enum(['open', 'merged', 'closed']),
});
