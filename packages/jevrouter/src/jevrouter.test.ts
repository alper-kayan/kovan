import type { ChatMessage, ChatRequest, ModelInfo, StreamEvent } from '@kovan/model-gateway';
import { describe, expect, it } from 'vitest';
import { classifyByRules } from './classifier.js';
import { turnSignals } from './digest.js';
import { parseDirectives } from './directives.js';
import { findPinned, pickModel, tierFor } from './policy.js';
import { JevRouter } from './router.js';

const model = (
  id: string,
  contextLength = 1_000_000,
  efforts: string[] = ['low', 'medium', 'high'],
): ModelInfo => ({
  id,
  name: id.split('/')[1]!,
  provider: id.split('/')[0]!,
  contextLength,
  maxOutput: null,
  pricing: { input: 1, output: 2, cacheRead: null, cacheWrite: null },
  tools: true,
  vision: false,
  reasoning: { mandatory: false, efforts: efforts as never, defaultEffort: null },
  created: 1,
});

const CATALOG = [
  model('openai/gpt-5.6-luna', 400_000),
  model('anthropic/claude-sonnet-5'),
  model('anthropic/claude-opus-5.5'),
  model('google/gemini-3.5-flash', 2_000_000),
];

const user = (content: string): ChatMessage => ({ role: 'user', content });
const toolCall = (id: string): ChatMessage => ({
  role: 'assistant',
  content: null,
  tool_calls: [{ id, type: 'function', function: { name: 'edit_file', arguments: '{}' } }],
});
const toolResult = (id: string, content: string): ChatMessage => ({
  role: 'tool',
  tool_call_id: id,
  content,
});

/** A client that answers "ok" and records which model each call went to. */
function fakeClient(classifierReply?: string) {
  const calls: ChatRequest[] = [];
  return {
    calls,
    async *stream(request: ChatRequest): AsyncGenerator<StreamEvent> {
      calls.push(request);
      const isClassifier =
        request.messages[0]?.role === 'system' &&
        String(request.messages[0].content).startsWith('You route');
      if (isClassifier && classifierReply) yield { type: 'text', text: classifierReply };
      else yield { type: 'text', text: 'ok' };
      yield {
        type: 'done',
        finishReason: 'stop',
        model: request.model,
        reasoningDetails: [],
        usage: {
          promptTokens: 10,
          completionTokens: 5,
          cachedTokens: 0,
          reasoningTokens: 0,
          cost: isClassifier ? 0.00001 : 0.001,
        },
      };
    },
  };
}

async function route(router: JevRouter, messages: ChatMessage[]) {
  const events: StreamEvent[] = [];
  for await (const e of router.stream({ model: 'kovan/jevrouter', messages })) events.push(e);
  const r = events.find((e) => e.type === 'route');
  return r?.type === 'route' ? r.decision : null;
}

describe('directives', () => {
  it('parses pins, tiers, caps and auto, and strips them', () => {
    expect(parseDirectives('Fix the race [jev: only use Opus] please')).toEqual({
      directive: { kind: 'pin', query: 'opus' },
      cleaned: 'Fix the race please',
    });
    expect(parseDirectives('[jev: tier economy] rename x').directive).toEqual({
      kind: 'tier',
      tier: 'economy',
    });
    expect(parseDirectives('[jev: no frontier]').directive).toEqual({
      kind: 'cap',
      tier: 'balanced',
    });
    expect(parseDirectives('[JEV: auto] go').directive).toEqual({ kind: 'auto' });
    expect(parseDirectives('[jev: gibberish words] x')).toEqual({ directive: null, cleaned: 'x' });
  });
});

describe('policy', () => {
  it('maps task and difficulty to tiers', () => {
    expect(tierFor('small_edit', 1)).toBe('economy');
    expect(tierFor('feature', 3)).toBe('balanced');
    expect(tierFor('plan', 4)).toBe('frontier');
    expect(tierFor('debug', 5)).toBe('frontier');
  });

  it('picks a model that fits the context, moving up when the tier is too small', () => {
    expect(pickModel('economy', CATALOG, 100_000)?.id).toBe('openai/gpt-5.6-luna');
    // A bigger window in the same tier comes first, then the next tier up.
    expect(pickModel('economy', CATALOG, 500_000)?.id).toBe('google/gemini-3.5-flash');
    const noGemini = CATALOG.filter((m) => !m.id.startsWith('google/'));
    expect(pickModel('economy', noGemini, 500_000)?.id).toBe('anthropic/claude-sonnet-5');
    expect(pickModel('frontier', CATALOG, 1_500_000)?.id).toBe('google/gemini-3.5-flash');
  });

  it('resolves pins by name', () => {
    expect(findPinned('Opus', CATALOG)?.id).toBe('anthropic/claude-opus-5.5');
    expect(findPinned('sonnet 5', CATALOG)?.id).toBe('anthropic/claude-sonnet-5');
  });
});

describe('classifyByRules', () => {
  it('recognises task types, difficulty and follow-ups', () => {
    expect(classifyByRules([user('Fix the typo in README.md')])).toMatchObject({
      task: 'debug',
      difficulty: 1,
      newTask: true,
    });
    expect(classifyByRules([user('What does src/a.ts do?')])).toMatchObject({ task: 'question' });
    expect(
      classifyByRules([user('Plan the migration of the entire codebase to ESM')]),
    ).toMatchObject({ task: 'plan', difficulty: 3 });
    expect(
      classifyByRules([
        user('add tests'),
        { role: 'assistant', content: 'done' },
        user('yes, go ahead'),
      ]).newTask,
    ).toBe(false);
  });
});

describe('turnSignals', () => {
  it('counts failures since the last user message', () => {
    const s = turnSignals([
      user('x'),
      toolCall('a'),
      toolResult('a', 'Error: boom'),
      toolCall('b'),
      toolResult('b', 'ok\n[exit code 0]'),
      toolCall('c'),
      toolResult('c', 'fail\n[exit code 1]'),
    ]);
    expect(s).toEqual({ failures: 2, consecutiveFailures: 1, toolCalls: 3 });
  });
});

describe('JevRouter', () => {
  it('routes by task, keeps the model for follow-ups and within a turn, and switches on new tasks', async () => {
    const client = fakeClient();
    const router = new JevRouter({ client, catalog: CATALOG });
    const history: ChatMessage[] = [
      { role: 'system', content: 's' },
      user('Rename the variable foo to bar in src/a.ts'),
    ];
    const first = await route(router, history);
    expect(first).toMatchObject({
      model: 'openai/gpt-5.6-luna',
      tier: 'economy',
      effort: 'low',
      switched: true,
    });

    history.push(toolCall('t1'), toolResult('t1', 'Edited'));
    expect(await route(router, history)).toMatchObject({
      model: 'openai/gpt-5.6-luna',
      switched: false,
      reason: expect.stringContaining('same task'),
    });

    history.push({ role: 'assistant', content: 'Done' }, user('ok thanks'));
    expect(await route(router, history)).toMatchObject({
      model: 'openai/gpt-5.6-luna',
      switched: false,
      reason: expect.stringContaining('continues'),
    });

    history.push(
      { role: 'assistant', content: 'You are welcome' },
      user(
        'Design the architecture for multi-region failover across all services, with a migration plan',
      ),
    );
    expect(await route(router, history)).toMatchObject({
      model: 'anthropic/claude-opus-5.5',
      tier: 'frontier',
      switched: true,
    });
    expect(client.calls.at(-1)?.model).toBe('anthropic/claude-opus-5.5');
  });

  it('escalates one tier when the agent keeps failing in a turn', async () => {
    const router = new JevRouter({ client: fakeClient(), catalog: CATALOG });
    const history: ChatMessage[] = [user('Rename foo to bar in src/a.ts')];
    await route(router, history);
    history.push(
      toolCall('a'),
      toolResult('a', 'old_string was not found in src/a.ts.'),
      toolCall('b'),
      toolResult('b', 'Error: nope'),
    );
    expect(await route(router, history)).toMatchObject({
      model: 'anthropic/claude-sonnet-5',
      tier: 'balanced',
      switched: true,
      reason: expect.stringContaining('escalated'),
    });
    // Only once per turn.
    history.push(
      toolCall('c'),
      toolResult('c', 'Error: still'),
      toolCall('d'),
      toolResult('d', 'Error: again'),
    );
    expect(await route(router, history)).toMatchObject({
      model: 'anthropic/claude-sonnet-5',
      switched: false,
    });
  });

  it('obeys pins and caps, and never sends directive text to the model', async () => {
    const client = fakeClient();
    const router = new JevRouter({ client, catalog: CATALOG });
    expect(await route(router, [user('Rename x [jev: only use Opus]')])).toMatchObject({
      model: 'anthropic/claude-opus-5.5',
      reason: expect.stringContaining('pinned'),
    });
    expect(JSON.stringify(client.calls.at(-1)?.messages)).not.toContain('jev');

    const capped = new JevRouter({ client: fakeClient(), catalog: CATALOG });
    expect(
      await route(capped, [
        user(
          '[jev: no frontier] Design the architecture for multi-region failover across all services',
        ),
      ]),
    ).toMatchObject({ tier: 'balanced', reason: expect.stringContaining('capped') });
  });

  it('uses the classifier model when configured and reports its cost', async () => {
    const client = fakeClient('{"task":"debug","difficulty":4,"same_task":false}');
    const router = new JevRouter({
      client,
      catalog: CATALOG,
      classifierModel: 'openai/gpt-5.6-luna',
    });
    const decision = await route(router, [user('it is broken')]);
    expect(decision).toMatchObject({
      tier: 'frontier',
      classifierModel: 'openai/gpt-5.6-luna',
      usage: { cost: 0.00001 },
    });
    expect(client.calls[0]).toMatchObject({ model: 'openai/gpt-5.6-luna', effort: 'none' });
  });

  it('falls back to the rules when the classifier answers nonsense', async () => {
    const router = new JevRouter({
      client: fakeClient('not json'),
      catalog: CATALOG,
      classifierModel: 'openai/gpt-5.6-luna',
    });
    expect(await route(router, [user('Fix the typo in README.md')])).toMatchObject({
      tier: 'economy',
      reason: expect.stringContaining('difficulty 1'),
    });
  });

  it('moves to a bigger window when the context outgrows the model', async () => {
    const router = new JevRouter({ client: fakeClient(), catalog: CATALOG });
    const history: ChatMessage[] = [user('Rename foo in src/a.ts')];
    expect((await route(router, history))?.model).toBe('openai/gpt-5.6-luna');
    history.push(toolCall('big'), toolResult('big', 'x'.repeat(1_500_000)));
    expect(await route(router, history)).toMatchObject({
      model: 'google/gemini-3.5-flash',
      tier: 'economy',
      reason: expect.stringContaining('context grew'),
    });
  });
});
