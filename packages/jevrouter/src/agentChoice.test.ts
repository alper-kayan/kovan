import { describe, expect, it } from 'vitest';
import {
  chooseAgent,
  parseAgentDirective,
  rulesUnsure,
  type AgentCandidate,
  type AgentId,
} from './agentChoice.js';
import type { Classification } from './classifier.js';

const MODELS: Record<AgentId, string> = {
  'claude-code': 'default',
  codex: 'default',
  kovan: 'kovan/jevrouter',
};

const all = (
  over: Partial<Record<AgentId, Partial<AgentCandidate>>> = {},
  ids: AgentId[] = ['claude-code', 'codex', 'kovan'],
): AgentCandidate[] =>
  ids.map((agent) => ({
    agent,
    model: MODELS[agent],
    account: agent,
    usable: true,
    nearLimit: false,
    ...over[agent],
  }));

const task = (t: Classification['task'], difficulty: number): Classification => ({
  task: t,
  difficulty,
  newTask: true,
  source: 'rules',
});

const choose = (over: Partial<Parameters<typeof chooseAgent>[0]> = {}) =>
  chooseAgent({
    order: all(),
    classification: task('feature', 3),
    takesImages: ['kovan'],
    hasImages: false,
    asked: null,
    ...over,
  });

describe('parseAgentDirective', () => {
  it('reads the agent named in a prompt and removes it', () => {
    expect(parseAgentDirective('fix the test [jev: codex]')).toEqual({
      agent: 'codex',
      cleaned: 'fix the test',
    });
    expect(parseAgentDirective('[JEV: Claude Code] add a route').agent).toBe('claude-code');
    expect(parseAgentDirective('[jev: kovan] hi').agent).toBe('kovan');
  });

  it('leaves model directives for the router', () => {
    const text = 'do it [jev: only use Opus]';
    expect(parseAgentDirective(text)).toEqual({ agent: null, cleaned: text });
  });
});

describe('chooseAgent', () => {
  it('takes the first ready agent in the person’s order', () => {
    expect(choose()).toMatchObject({ agent: 'claude-code', model: 'default', tier: 'balanced' });
    expect(choose({ order: all({}, ['codex', 'claude-code', 'kovan']) })?.agent).toBe('codex');
    expect(choose({ order: all({ 'claude-code': { usable: false } }) })?.agent).toBe('codex');
    expect(
      choose({ order: all({ 'claude-code': { usable: false }, codex: { usable: false } }) }),
    ).toMatchObject({ agent: 'kovan', model: 'kovan/jevrouter' });
  });

  it('starts Claude Code on a model that fits the work', () => {
    expect(choose({ classification: task('question', 1) })?.model).toBe('haiku');
    expect(choose({ classification: task('refactor', 5) })).toMatchObject({
      model: 'opus',
      tier: 'frontier',
    });
  });

  it('uses the model the person ranked, and can rank one agent twice', () => {
    const order: AgentCandidate[] = [
      {
        agent: 'claude-code',
        model: 'opus',
        account: 'claude-code',
        usable: true,
        nearLimit: false,
      },
      {
        agent: 'kovan',
        model: '@deepinfra/deepseek-ai/DeepSeek-V3',
        account: '@deepinfra',
        usable: true,
        nearLimit: false,
      },
      {
        agent: 'kovan',
        model: 'kovan/jevrouter',
        account: 'kovan',
        usable: true,
        nearLimit: false,
      },
    ];
    // A ranked model holds even for easy work.
    expect(choose({ order, classification: task('question', 1) })).toMatchObject({
      agent: 'claude-code',
      model: 'opus',
    });
    const withoutClaude = order.map((o, i) => (i === 0 ? { ...o, usable: false } : o));
    expect(choose({ order: withoutClaude })).toMatchObject({
      agent: 'kovan',
      model: '@deepinfra/deepseek-ai/DeepSeek-V3',
    });
    expect(
      choose({ order: withoutClaude.map((o, i) => (i === 1 ? { ...o, usable: false } : o)) }),
    ).toMatchObject({ agent: 'kovan', model: 'kovan/jevrouter' });
  });

  it('keeps an agent near its limit for hard work when another subscription is free', () => {
    const near = all({ 'claude-code': { nearLimit: true } });
    const light = choose({ order: near });
    expect(light?.agent).toBe('codex');
    expect(light?.reason).toContain('close to its limit');
    expect(choose({ order: near, classification: task('plan', 4) })?.agent).toBe('claude-code');
    // Not moved to pay-per-use just to save quota.
    expect(
      choose({ order: all({ 'claude-code': { nearLimit: true }, codex: { usable: false } }) })
        ?.agent,
    ).toBe('claude-code');
  });

  it('sends a prompt with images to an agent that takes them', () => {
    expect(choose({ hasImages: true })).toMatchObject({ agent: 'kovan' });
    expect(choose({ hasImages: true, order: all({ kovan: { usable: false } }) })?.agent).toBe(
      'claude-code',
    );
  });

  it('obeys an agent named in the prompt, and says so when it can’t', () => {
    expect(choose({ asked: 'codex' })).toMatchObject({
      agent: 'codex',
      reason: 'you asked for it',
    });
    const fallback = choose({ asked: 'codex', order: all({ codex: { usable: false } }) });
    expect(fallback?.agent).toBe('claude-code');
    expect(fallback?.reason).toContain("Codex can't take a turn now");
  });

  it('gives up when nobody can run', () => {
    expect(
      choose({
        order: all({
          'claude-code': { usable: false },
          codex: { usable: false },
          kovan: { usable: false },
        }),
      }),
    ).toBeNull();
  });
});

describe('rulesUnsure', () => {
  it('is unsure only when nothing matched on a long prompt', () => {
    expect(rulesUnsure('x'.repeat(300), task('small_edit', 2))).toBe(true);
    expect(rulesUnsure('rename foo', task('small_edit', 1))).toBe(false);
    expect(rulesUnsure('x'.repeat(300), task('debug', 3))).toBe(false);
  });
});
