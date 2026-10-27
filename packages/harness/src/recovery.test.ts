import { describe, expect, it } from 'vitest';
import { isUsageLimit } from './recovery.js';

describe('isUsageLimit', () => {
  it('recognizes the ways agents say the account ran out', () => {
    for (const message of [
      "You've hit your session limit · resets 7pm",
      "You've hit your limit · resets 3pm",
      'Claude AI usage limit reached|1791841200',
      "You've hit your usage limit. Upgrade to Pro or try again in 3 hours.",
      'OpenRouter answered 402: insufficient credits',
      '429 Too Many Requests',
    ])
      expect(isUsageLimit(message), message).toBe(true);
  });

  it('leaves ordinary errors alone', () => {
    for (const message of ['ENOENT: no such file', 'The model returned no output', 'exit 1'])
      expect(isUsageLimit(message), message).toBe(false);
  });
});
