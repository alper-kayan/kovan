import { describe, expect, it } from 'vitest';
import { chooseClaudeModel as choose, isJev } from './jevClaude.js';

/** Jev's choice from its rules alone. */
const alias = async (prompt: string) => (await choose(prompt)).alias;

describe('JevRouter choosing Claude Code models', () => {
  it('gives easy work Haiku, ordinary work Sonnet and hard work Opus', async () => {
    expect(await alias('Your task: Fix the typo in the README title')).toBe('haiku');
    expect(
      await alias('Your task: Add a discounted(items, percent) helper to src/cart.js with a test'),
    ).toBe('sonnet');
    expect(
      await alias(
        'Your task: Fix the race condition across the entire codebase where concurrent checkouts deadlock, in src/a.ts, src/b.ts and src/c.ts',
      ),
    ).toBe('opus');
  });

  it('plans and reviews by role, and follows [jev: …] in the goal', async () => {
    const plan = (goal: string) =>
      `You are Wren, the lead.\nThe goal: ${goal}\n\nRead the code, then call assign_tasks once.`;
    expect(await alias(plan('Add a total helper'))).toBe('sonnet');
    expect(await alias(plan('Design the plugin architecture and migrate all the modules'))).toBe(
      'opus',
    );
    expect(
      (await choose('The task: Add totals\nCall review_verdict with your verdict.')).tier,
    ).toBe('balanced');
    expect(await choose(plan('Add a total helper [jev: only use opus]'))).toMatchObject({
      alias: 'opus',
      reason: 'pinned to opus by a [jev: …] directive',
    });
    expect(await alias(plan('Migrate the whole codebase [jev: no frontier]'))).toBe('sonnet');
    expect(await alias('Your task: big thing [jev: economy]')).toBe('haiku');
  });

  it('knows a teammate that leaves the choice to Jev', () => {
    expect(isJev('kovan/jevrouter')).toBe(true);
    expect(isJev('JevRouter')).toBe(true);
    expect(isJev('anthropic/claude-sonnet-5.5')).toBe(false);
  });

  it("asks Jev's classifier when there is one, and falls back to its rules when it fails", async () => {
    const asked: string[] = [];
    const classifier = (answer: string | Error) => ({
      model: 'openai/gpt-5.6-luna',
      client: {
        async *stream(request: { model: string }) {
          asked.push(request.model);
          if (answer instanceof Error) throw answer;
          yield { type: 'text' as const, text: answer };
          yield {
            type: 'done' as const,
            finishReason: 'stop',
            model: request.model,
            reasoningDetails: [],
            usage: {
              promptTokens: 200,
              completionTokens: 20,
              cachedTokens: 0,
              reasoningTokens: 0,
              cost: 0.00003,
            },
          };
        },
      },
    });
    // The rules would call this small; the classifier knows better.
    const hard = await choose(
      'Your task: Fix the checkout bug',
      classifier('{"task":"debug","difficulty":5,"same_task":false}'),
    );
    expect(hard).toMatchObject({ alias: 'opus', classifierModel: 'openai/gpt-5.6-luna' });
    expect(hard.reason).toContain('(model)');
    expect(hard.usage?.cost).toBe(0.00003);
    expect(asked).toEqual(['openai/gpt-5.6-luna']);
    const fallback = await choose('Your task: Fix the typo', classifier(new Error('offline')));
    expect(fallback).toMatchObject({ classifierModel: null, usage: null });
    expect(fallback.reason).toContain('(rules)');
  });
});
