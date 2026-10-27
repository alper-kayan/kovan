import type { ChatRequest, StreamEvent } from '@kovan/model-gateway';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Agent, type AgentEvent, type ModelStreamer } from './agent.js';
import { execFileSync } from 'node:child_process';
import {
  isRepeating,
  MAX_REPLY_CHARS,
  NO_PROGRESS_NOTE,
  RUNAWAY_MESSAGES,
  StepWatch,
} from './runaway.js';

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'kovan-runaway-'));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const done: StreamEvent = {
  type: 'done',
  finishReason: 'stop',
  model: 'test/model',
  reasoningDetails: [],
  usage: {
    promptTokens: 10,
    completionTokens: 5,
    cachedTokens: 0,
    reasoningTokens: 0,
    cost: 0.001,
  },
};
const call = (id: string, name: string, args: string): StreamEvent => ({
  type: 'tool_call',
  call: { id, type: 'function', function: { name, arguments: args } },
});

/** A model that answers every step with `step(n)` and counts how much it was read. */
function model(step: (n: number) => Iterable<StreamEvent>) {
  const state = { steps: 0, read: 0, aborted: false };
  const streamer: ModelStreamer = {
    async *stream(_request: ChatRequest, signal) {
      signal?.addEventListener('abort', () => (state.aborted = true));
      for (const event of step(state.steps++)) {
        state.read++;
        yield event;
      }
    },
  };
  return { streamer, state };
}

function run(streamer: ModelStreamer, isRepo = false) {
  const events: AgentEvent[] = [];
  const agent = new Agent({
    model: streamer,
    modelId: 'test/model',
    effort: null,
    mode: 'full',
    root,
    isRepo,
    systemPrompt: 'system',
    approve: async () => true,
    onEvent: (e) => events.push(e),
  });
  return { agent, events, end: () => events.find((e) => e.type === 'turn_end') };
}

describe('isRepeating', () => {
  it('spots a short piece repeated to the end, not ordinary prose or code', () => {
    expect(isRepeating('I will now check the file. '.repeat(200))).toBe(true);
    expect(isRepeating('x'.repeat(5000))).toBe(true);
    const code = Array.from({ length: 300 }, (_, i) => `const value${i} = compute(${i * 7});`).join(
      '\n',
    );
    expect(isRepeating(code)).toBe(false);
    expect(isRepeating('short')).toBe(false);
  });
});

describe('runaway models', () => {
  it('counts what a cut-off reply cost from what it streamed, since the provider never says', async () => {
    const { streamer } = model(function* () {
      for (let i = 0; i < 100_000; i++) yield { type: 'text', text: 'Let me think again. ' };
    });
    const events: AgentEvent[] = [];
    const agent = new Agent({
      model: streamer,
      modelId: 'test/model',
      effort: null,
      mode: 'full',
      root,
      isRepo: false,
      systemPrompt: 'system',
      approve: async () => true,
      onEvent: (e) => events.push(e),
      // $1 per million output tokens, nothing for input.
      price: (_m, u) => u.completionTokens / 1_000_000,
    });
    await agent.send('go');
    const usage = events.find((e) => e.type === 'usage');
    expect(usage).toMatchObject({ estimated: true, kind: 'model', model: 'test/model' });
    const end = events.find((e) => e.type === 'turn_end') as { cost: number };
    expect(end.cost).toBeGreaterThan(0);
    expect(end.cost).toBe((usage as { usage: { cost: number } }).usage.cost);
  });

  it('cuts off a reply that repeats itself and ends the turn with an error', async () => {
    const { streamer, state } = model(function* () {
      for (let i = 0; i < 100_000; i++) yield { type: 'text', text: 'Let me think again. ' };
      yield done;
    });
    const { agent, end } = run(streamer);
    await agent.send('go');
    expect(end()).toMatchObject({ reason: 'error', error: RUNAWAY_MESSAGES.repeating });
    expect(state.read).toBeLessThan(500);
    expect(state.aborted).toBe(true);
    expect(agent.running).toBe(false);
  });

  it('cuts off repeating reasoning and a reply that never ends', async () => {
    const thinking = model(function* () {
      for (let i = 0; i < 100_000; i++) yield { type: 'reasoning', text: 'wait, ' };
    });
    const a = run(thinking.streamer);
    await a.agent.send('go');
    expect(a.end()).toMatchObject({ reason: 'error', error: RUNAWAY_MESSAGES.repeating });

    let n = 0;
    const endless = model(function* () {
      // Never periodic: every chunk is different.
      for (;;) yield { type: 'text', text: `line ${n++} ${Math.sqrt(n).toFixed(6)}\n` };
    });
    const b = run(endless.streamer);
    await b.agent.send('go');
    expect(b.end()).toMatchObject({ reason: 'error', error: RUNAWAY_MESSAGES.tooLong });
    expect(endless.state.read).toBeLessThan(MAX_REPLY_CHARS / 5);
  });

  it('stops after three steps of only broken tool calls, but lets the model recover from one', async () => {
    const broken = model((n) => [
      call(`c${n}`, n % 2 ? 'no_such_tool' : 'read_file', '{oops'),
      done,
    ]);
    const a = run(broken.streamer);
    await a.agent.send('go');
    expect(a.end()).toMatchObject({ reason: 'error', error: RUNAWAY_MESSAGES.invalid });
    expect(broken.state.steps).toBe(3);

    const recovers = model((n) =>
      n === 0
        ? [call('c0', 'no_such_tool', '{}'), done]
        : n === 1
          ? [call('c1', 'list_dir', '{}'), done]
          : [{ type: 'text', text: 'Done.' }, done],
    );
    const b = run(recovers.streamer);
    await b.agent.send('go');
    expect(b.end()).toMatchObject({ reason: 'done' });
  });

  it('stops when the same call keeps giving the same result', async () => {
    const loop = model((n) => [call(`c${n}`, 'list_dir', '{}'), done]);
    const { agent, end } = run(loop.streamer);
    await agent.send('go');
    expect(end()).toMatchObject({ reason: 'error', error: RUNAWAY_MESSAGES.same });
    expect(loop.state.steps).toBe(5);
  });

  it('warns, then pauses, when a call repeats while the files stay the same', async () => {
    execFileSync('git', ['init', '-q'], { cwd: root });
    const requests: ChatRequest[] = [];
    let n = 0;
    const streamer: ModelStreamer = {
      async *stream(request) {
        requests.push(structuredClone(request));
        yield call(`c${n++}`, 'list_dir', '{}');
        yield done;
      },
    };
    const { agent, end } = run(streamer, true);
    await agent.send('go');
    expect(end()).toMatchObject({ reason: 'error', error: RUNAWAY_MESSAGES.stuck });
    expect(requests).toHaveLength(3);
    // After the second identical call the model was told it isn't getting anywhere.
    expect(JSON.stringify(requests[2]!.messages)).toContain(NO_PROGRESS_NOTE);
    expect(JSON.stringify(requests[1]!.messages)).not.toContain(NO_PROGRESS_NOTE);
  });
});

describe('StepWatch', () => {
  const same = [
    { name: 'run_shell', args: '{"command":"pnpm test"}', output: 'FAIL', invalid: false },
  ];
  it('counts a repeat as no progress only while the files stay the same', () => {
    const watch = new StepWatch();
    expect(watch.step(same, 'tree-a')).toEqual({ stop: null, warn: false });
    expect(watch.step(same, 'tree-a')).toEqual({ stop: null, warn: true });
    // The files changed in between: the same failing test is a new attempt.
    expect(watch.step(same, 'tree-b')).toEqual({ stop: null, warn: false });
    expect(watch.step(same, 'tree-b')).toEqual({ stop: null, warn: true });
    expect(watch.step(same, 'tree-b')).toEqual({ stop: 'stuck', warn: false });
  });
});
