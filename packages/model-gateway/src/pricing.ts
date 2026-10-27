import type { ModelInfo, Usage } from './types.js';

/**
 * Prices that change past a prompt size, e.g. "above 272K input tokens the whole request is
 * billed at 2× input and 1.5× output". Matched by model id prefix.
 */
export interface LongContextRule {
  modelPrefix: string;
  aboveInputTokens: number;
  inputMultiplier: number;
  outputMultiplier: number;
}

export const LONG_CONTEXT_RULES: LongContextRule[] = [
  {
    modelPrefix: 'openai/gpt-5.6-',
    aboveInputTokens: 272_000,
    inputMultiplier: 2,
    outputMultiplier: 1.5,
  },
  {
    modelPrefix: 'google/gemini-',
    aboveInputTokens: 200_000,
    inputMultiplier: 2,
    outputMultiplier: 1.5,
  },
  {
    modelPrefix: 'anthropic/claude-sonnet-',
    aboveInputTokens: 200_000,
    inputMultiplier: 2,
    outputMultiplier: 1.5,
  },
];

/**
 * Cost of one call from a model's rate card, for providers that don't report a cost.
 * Cached prompt tokens use the cache-read price when the model has one.
 */
export function estimateCost(
  model: Pick<ModelInfo, 'id' | 'pricing'>,
  usage: Omit<Usage, 'cost'>,
  rules = LONG_CONTEXT_RULES,
): number {
  const rule = rules.find(
    (r) => model.id.startsWith(r.modelPrefix) && usage.promptTokens > r.aboveInputTokens,
  );
  const inMul = rule?.inputMultiplier ?? 1;
  const outMul = rule?.outputMultiplier ?? 1;
  const cached = Math.min(usage.cachedTokens, usage.promptTokens);
  const fresh = usage.promptTokens - cached;
  const cacheRate = model.pricing.cacheRead ?? model.pricing.input;
  const perToken = (perMillion: number) => perMillion / 1_000_000;
  return (
    fresh * perToken(model.pricing.input) * inMul +
    cached * perToken(cacheRate) * inMul +
    usage.completionTokens * perToken(model.pricing.output) * outMul
  );
}
