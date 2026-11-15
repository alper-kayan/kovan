import { describe, expect, it } from 'vitest';
import { laneRoute } from './laneRoute.js';

describe('laneRoute', () => {
  it('says a Claude Code or Codex lane runs on your subscription', () => {
    expect(
      laneRoute({ harness: 'claude-code', model: 'claude-code · claude-haiku-5-5' }),
    ).toMatchObject({
      kind: 'subscription',
      key: 'Claude Code · your subscription',
    });
    expect(laneRoute({ harness: 'codex', model: 'default' }).kind).toBe('subscription');
  });

  it('says a Kovan agent lane is paid per use, and by which route', () => {
    expect(laneRoute({ harness: 'kovan', model: 'anthropic/claude-sonnet-5' })).toMatchObject({
      kind: 'paid',
      key: 'OpenRouter · {model}',
      values: { model: 'claude-sonnet-5' },
    });
    expect(laneRoute({ harness: 'kovan', model: 'kovan/jevrouter' }).key).toBe(
      'JevRouter · paid models',
    );
    expect(
      laneRoute({ harness: 'kovan', model: '@deepinfra/deepseek-ai/DeepSeek-V3.2' }),
    ).toMatchObject({
      kind: 'paid',
      key: '{provider} · your key',
      values: { provider: 'deepinfra' },
    });
  });

  it('says nothing when it does not know', () => {
    expect(laneRoute({ harness: null, model: null }).kind).toBe('unknown');
  });
});
