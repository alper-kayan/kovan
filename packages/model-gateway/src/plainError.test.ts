import { describe, expect, it } from 'vitest';
import { hostLabel, plainModelError, unreachable } from './plainError.js';

describe('a provider error in words', () => {
  it('says what happened and what to do, and keeps the provider’s own line', () => {
    const key = plainModelError({ status: 401, said: 'User not found.', host: 'OpenRouter' });
    expect(key).toMatch(/^OpenRouter refused the key/);
    expect(key).toContain('(OpenRouter said: User not found.)');
    expect(plainModelError({ status: 502, said: null, host: 'Kovan' })).toBe(
      'Kovan had a problem on its side (HTTP 502). Try again in a moment.',
    );
    expect(unreachable('localhost:11434')).toMatch(/server at localhost:11434 is running/);
    expect(hostLabel('https://openrouter.ai/api/v1')).toBe('OpenRouter');
    expect(hostLabel('https://kovan.example/api/inference/v1')).toBe('Kovan');
  });
});
