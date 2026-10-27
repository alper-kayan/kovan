import type { Effort, ModelInfo } from '@kovan/model-gateway';

export type Tier = 'economy' | 'balanced' | 'frontier';
export const TIER_ORDER: Tier[] = ['economy', 'balanced', 'frontier'];

export type TaskType =
  'question' | 'small_edit' | 'feature' | 'refactor' | 'debug' | 'plan' | 'review';

/** Preferred models per tier, best first; the first one present in the catalog wins. */
export const TIER_MODELS: Record<Tier, string[]> = {
  economy: [
    'openai/gpt-5.6-luna',
    'z-ai/glm-5.3-flash',
    'google/gemini-3.5-flash',
    'anthropic/claude-haiku-5.5',
  ],
  balanced: ['anthropic/claude-sonnet-5', 'openai/gpt-6-sol', 'openai/gpt-5.6-sol'],
  frontier: ['anthropic/claude-opus-5.5', 'openai/gpt-6-astra', 'anthropic/claude-fable-5.1'],
};

export const TIER_EFFORT: Record<Tier, Effort> = {
  economy: 'low',
  balanced: 'medium',
  frontier: 'high',
};

/** The rule table: task type and difficulty (1–5) decide the tier. */
export function tierFor(task: TaskType, difficulty: number): Tier {
  const d = Math.min(5, Math.max(1, Math.round(difficulty)));
  switch (task) {
    case 'question':
      return d <= 2 ? 'economy' : d <= 4 ? 'balanced' : 'frontier';
    case 'small_edit':
      return d <= 2 ? 'economy' : 'balanced';
    case 'review':
      return d <= 3 ? 'balanced' : 'frontier';
    case 'feature':
    case 'refactor':
      return d <= 3 ? 'balanced' : 'frontier';
    case 'debug':
      return d <= 1 ? 'economy' : d <= 3 ? 'balanced' : 'frontier';
    case 'plan':
      return d <= 2 ? 'balanced' : 'frontier';
  }
}

export function stepUp(tier: Tier): Tier {
  return TIER_ORDER[Math.min(TIER_ORDER.length - 1, TIER_ORDER.indexOf(tier) + 1)]!;
}

export function capTier(tier: Tier, cap: Tier | null): Tier {
  if (!cap) return tier;
  return TIER_ORDER.indexOf(tier) > TIER_ORDER.indexOf(cap) ? cap : tier;
}

/**
 * The model for a tier that fits the context. Falls back to any tool-capable model of that
 * tier's price band with a big enough window, then to the longest window available.
 */
export function pickModel(
  tier: Tier,
  catalog: ModelInfo[],
  contextTokens: number,
): ModelInfo | null {
  const fits = (m: ModelInfo) => m.tools && m.contextLength >= contextTokens;
  for (const id of TIER_MODELS[tier]) {
    const m = catalog.find((x) => x.id === id);
    if (m && fits(m)) return m;
  }
  // Same tier is full: try the next tiers up, then anything that fits.
  for (const t of TIER_ORDER.slice(TIER_ORDER.indexOf(tier) + 1)) {
    for (const id of TIER_MODELS[t]) {
      const m = catalog.find((x) => x.id === id);
      if (m && fits(m)) return m;
    }
  }
  const any = catalog.filter(fits).sort((a, b) => b.contextLength - a.contextLength);
  return any[0] ?? null;
}

/** Resolves "Opus", "sonnet 5", "gpt-6-sol"… to a catalog model, preferring the curated lists. */
export function findPinned(query: string, catalog: ModelInfo[]): ModelInfo | null {
  const q = query.toLowerCase().replace(/\s+/g, '-');
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const matches = (m: ModelInfo) => {
    const hay = `${m.id} ${m.name}`.toLowerCase();
    return hay.includes(q) || words.every((w) => hay.includes(w));
  };
  for (const tier of [...TIER_ORDER].reverse()) {
    for (const id of TIER_MODELS[tier]) {
      const m = catalog.find((x) => x.id === id);
      if (m && matches(m)) return m;
    }
  }
  return (
    catalog.filter((m) => m.tools && matches(m)).sort((a, b) => b.created - a.created)[0] ?? null
  );
}

export function tierOf(modelId: string): Tier | null {
  for (const tier of TIER_ORDER) if (TIER_MODELS[tier].includes(modelId)) return tier;
  return null;
}

export function effortFor(tier: Tier, model: ModelInfo): Effort | null {
  const wanted = TIER_EFFORT[tier];
  return model.reasoning?.efforts.includes(wanted) ? wanted : null;
}
