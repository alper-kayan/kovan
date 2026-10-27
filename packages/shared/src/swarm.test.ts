import { describe, expect, it } from 'vitest';
import { taskCostAt } from './swarm.js';

describe('a task priced from its model', () => {
  it('lands where the measured tasks did', () => {
    // GPT-5.6 Luna: $0.20 in, $1.20 out per million; its tasks cost $0.0044 (median), $0.012 (p90).
    const luna = taskCostAt({ input: 0.2, output: 1.2 });
    expect(luna.typical).toBeCloseTo(0.00384, 5);
    expect(luna.large).toBeCloseTo(0.01152, 5);
    // A pricier model costs more in proportion; a free one costs nothing.
    expect(taskCostAt({ input: 2, output: 10 }).typical).toBeCloseTo(0.036, 5);
    expect(taskCostAt({ input: 0, output: 0 })).toEqual({ typical: 0, large: 0 });
  });
});
