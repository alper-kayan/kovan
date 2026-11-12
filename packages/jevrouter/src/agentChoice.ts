import type { Classification } from './classifier.js';
import { tierFor, type Tier } from './policy.js';

/** Who can run a conversation: Kovan's own agent, or the person's Claude Code or Codex. */
export type AgentId = 'kovan' | 'claude-code' | 'codex';

export const AGENT_NAMES: Record<AgentId, string> = {
  kovan: 'Kovan',
  'claude-code': 'Claude Code',
  codex: 'Codex',
};

/** One step of the person's order, with what is known about it right now. */
export interface AgentCandidate {
  agent: AgentId;
  /** The model the person ranked: "default" leaves the choice to Auto (Claude Code) or the CLI. */
  model: string;
  /** Whose usage it spends; steps that share an account run out together. */
  account: string;
  /** Installed (or keyed) and not out of usage. */
  usable: boolean;
  /** Close to its account limit. */
  nearLimit: boolean;
}

export interface AgentChoice {
  agent: AgentId;
  /** The model to start it with: the ranked one, or an alias picked for the task's tier. */
  model: string;
  tier: Tier;
  reason: string;
  /** The picked step's account: which of several sign-ins of the same agent runs it. */
  account: string;
}

const AGENT_DIRECTIVE = /\[\s*jev\s*:\s*(claude(?:[ -]code)?|codex|kovan)\s*\]/gi;

/** "[jev: codex]" in a prompt names the agent; returns it and the prompt without it. */
export function parseAgentDirective(text: string): { agent: AgentId | null; cleaned: string } {
  let agent: AgentId | null = null;
  const cleaned = text.replace(AGENT_DIRECTIVE, (_match, name: string) => {
    const n = name.toLowerCase();
    agent = n.startsWith('claude') ? 'claude-code' : (n as AgentId);
    return '';
  });
  return { agent, cleaned: agent ? cleaned.replace(/[ \t]{2,}/g, ' ').trim() : text };
}

/** A ranked model is used as is; Claude Code's "default" becomes the alias for the tier. */
function modelFor(step: AgentCandidate, tier: Tier): string {
  if (step.agent !== 'claude-code' || step.model !== 'default') return step.model;
  return tier === 'frontier' ? 'opus' : tier === 'economy' ? 'haiku' : 'default';
}

const TASK_WORDS: Record<Classification['task'], string> = {
  question: 'a question',
  small_edit: 'a small edit',
  feature: 'a feature',
  refactor: 'a refactor',
  debug: 'debugging',
  plan: 'planning',
  review: 'a review',
};

/**
 * Picks the agent and model for a new task: the person's order, minus steps that can't take a
 * turn now. A step close to its limit is kept for hard work when another subscription can do
 * the rest; a prompt with images goes to an agent that takes them. Null when nobody can run it.
 */
export function chooseAgent(input: {
  /** The person's order of preference, first to last. */
  order: AgentCandidate[];
  classification: Classification;
  /** Agents that take image attachments. */
  takesImages: AgentId[];
  hasImages: boolean;
  /** An agent named in the prompt ("[jev: codex]"). */
  asked: AgentId | null;
}): AgentChoice | null {
  const { classification: c } = input;
  const tier = tierFor(c.task, c.difficulty);
  const pick = (step: AgentCandidate, reason: string): AgentChoice => ({
    agent: step.agent,
    model: modelFor(step, tier),
    tier,
    reason,
    account: step.account,
  });
  const work = `${TASK_WORDS[c.task]}, difficulty ${c.difficulty}/5`;
  const ready = input.order.filter((step) => step.usable);

  let unavailable = '';
  if (input.asked) {
    const named = ready.find((step) => step.agent === input.asked);
    if (named) return pick(named, 'you asked for it');
    unavailable = `${AGENT_NAMES[input.asked]} can't take a turn now; `;
  }
  if (ready.length === 0) return null;

  if (input.hasImages) {
    const withImages = ready.find((step) => input.takesImages.includes(step.agent));
    if (withImages) return pick(withImages, `${unavailable}the prompt has an image`);
  }

  const first = ready[0]!;
  if (first.nearLimit && tier !== 'frontier') {
    const spare = ready.find(
      (step) => step.agent !== 'kovan' && step.account !== first.account && !step.nearLimit,
    );
    if (spare)
      return pick(
        spare,
        `${unavailable}${work}; ${AGENT_NAMES[first.agent]} is close to its limit and kept for harder work`,
      );
  }
  return pick(first, `${unavailable}${work}; first ready in your order`);
}

/** Whether the free rules are too unsure to route on, so the small model is worth a call. */
export function rulesUnsure(text: string, classification: Classification): boolean {
  if (classification.task !== 'small_edit') return false;
  const t = text.trim();
  // Nothing matched (the fallback type) on a prompt long enough to hide a bigger task; or on
  // one in a language the rules hardly know (letters outside English's), whatever its length.
  return t.length > 240 || (t.length > 30 && /[\u0080-\uFFFF]/.test(t) && /\p{L}{3}/u.test(t));
}
