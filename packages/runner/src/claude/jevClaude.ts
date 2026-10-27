import type { Usage } from '@kovan/model-gateway';
import {
  capTier,
  classifyByModel,
  classifyByRules,
  type ClassifierModel,
  JEV_MODEL_ID,
  parseDirectives,
  tierFor,
  type TaskType,
  type Tier,
} from '@kovan/jevrouter';

/** JevRouter's tiers in Claude Code's terms. */
export const CLAUDE_TIER: Record<Tier, 'haiku' | 'sonnet' | 'opus'> = {
  economy: 'haiku',
  balanced: 'sonnet',
  frontier: 'opus',
};

export interface ClaudeChoice {
  alias: 'haiku' | 'sonnet' | 'opus';
  tier: Tier;
  reason: string;
  /** What asking the classifier cost, when it was asked. */
  usage: Usage | null;
  classifierModel: string | null;
}

/** JevRouter's own classifier: a small model on OpenRouter (only Jev uses it, never the agents). */
export interface JevClassifier {
  client: ClassifierModel;
  model: string;
}

/** Whether a teammate's model leaves the choice to JevRouter. */
export const isJev = (model: string) =>
  model === JEV_MODEL_ID || /^(kovan\/)?jev(router)?$/i.test(model.trim());

/** The part of a swarm prompt that says what the work is, for judging how hard it is. */
function workOf(prompt: string): string {
  const line = /^(?:The goal|Your task|The task|Task):\s*(.+)$/im.exec(prompt);
  return line?.[1] ?? prompt;
}

/**
 * Lets JevRouter choose Claude Code's model for one task, the way it chooses everywhere in
 * Kovan: its rules first, then its classifier model when there is one (a fraction of a cent
 * on OpenRouter; the agents themselves stay on the person's Claude subscription). Easy work
 * gets Haiku, ordinary work Sonnet, hard work and planning hard goals Opus. `[jev: …]` in
 * the goal steers it.
 */
export async function chooseClaudeModel(
  prompt: string,
  classifier?: JevClassifier,
): Promise<ClaudeChoice> {
  const { directive, cleaned } = parseDirectives(prompt);
  if (directive?.kind === 'pin') {
    const q = directive.query.toLowerCase();
    const alias = q.includes('opus')
      ? 'opus'
      : q.includes('haiku')
        ? 'haiku'
        : q.includes('sonnet')
          ? 'sonnet'
          : null;
    if (alias) {
      const tier = (Object.keys(CLAUDE_TIER) as Tier[]).find((t) => CLAUDE_TIER[t] === alias)!;
      return {
        alias,
        tier,
        reason: `pinned to ${alias} by a [jev: …] directive`,
        usage: null,
        classifierModel: null,
      };
    }
  }
  if (directive?.kind === 'tier')
    return {
      alias: CLAUDE_TIER[directive.tier],
      tier: directive.tier,
      reason: `[jev: ${directive.tier}]`,
      usage: null,
      classifierModel: null,
    };
  const messages = [{ role: 'user' as const, content: workOf(cleaned) }];
  let c = classifyByRules(messages);
  let usage: Usage | null = null;
  if (classifier) {
    const byModel = await classifyByModel(classifier.client, classifier.model, messages).catch(
      () => null,
    );
    if (byModel) {
      c = byModel.classification;
      usage = byModel.usage;
    }
  }
  // A swarm's lead plans and its reviewers review, whatever the goal's own wording.
  const task: TaskType = /\bcall assign_tasks\b/i.test(cleaned)
    ? 'plan'
    : /\breview_verdict\b/.test(cleaned)
      ? 'review'
      : c.task;
  let tier = tierFor(task, c.difficulty);
  let reason = `${task}, difficulty ${c.difficulty} (${c.source})`;
  if (directive?.kind === 'cap') {
    tier = capTier(tier, directive.tier);
    reason += `, at most ${directive.tier}`;
  }
  return {
    alias: CLAUDE_TIER[tier],
    tier,
    reason,
    usage,
    classifierModel: c.source === 'model' ? classifier!.model : null,
  };
}
