import { describe, expect, it } from 'vitest';
import { mentionedPaths, similarity } from './overlap.js';

describe('overlap helpers', () => {
  it('finds file paths a prompt mentions', () => {
    expect(mentionedPaths('Fix the race in src/lobby/join.ts and update README.md')).toEqual([
      'src/lobby/join.ts',
      'README.md',
    ]);
  });

  it('scores related task descriptions above unrelated ones', () => {
    const lobby = 'Fix the lobby join race. Compare-and-set the seat write';
    expect(similarity('Seat write in the lobby join drops players', lobby)).toBeGreaterThan(0.34);
    expect(similarity('Update the billing page copy', lobby)).toBeLessThan(0.34);
  });
});
