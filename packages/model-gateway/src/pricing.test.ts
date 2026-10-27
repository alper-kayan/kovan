import { describe, expect, it } from 'vitest';
import { estimateCost } from './pricing.js';

const luna = {
  id: 'openai/gpt-5.6-luna',
  pricing: { input: 0.2, output: 1.2, cacheRead: 0.02, cacheWrite: null },
};
const usage = (prompt: number, completion: number, cached = 0) => ({
  promptTokens: prompt,
  completionTokens: completion,
  cachedTokens: cached,
  reasoningTokens: 0,
});

describe('estimateCost', () => {
  it('prices fresh, cached and output tokens per million', () => {
    // 900k fresh × $0.2/M + 100k cached × $0.02/M + 10k out × $1.2/M
    expect(estimateCost({ ...luna, id: 'x/y' }, usage(1_000_000, 10_000, 100_000))).toBeCloseTo(
      0.18 + 0.002 + 0.012,
    );
  });

  it('applies long-context multipliers to the whole request above the threshold', () => {
    const small = estimateCost(luna, usage(100_000, 1000));
    expect(small).toBeCloseTo(0.02 + 0.0012);
    const big = estimateCost(luna, usage(300_000, 1000));
    expect(big).toBeCloseTo(300_000 * 0.2e-6 * 2 + 1000 * 1.2e-6 * 1.5);
  });

  it('is zero for free models', () => {
    expect(
      estimateCost(
        { id: 'f/free', pricing: { input: 0, output: 0, cacheRead: null, cacheWrite: null } },
        usage(5000, 500),
      ),
    ).toBe(0);
  });
});
