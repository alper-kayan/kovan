import type { ChatRequest, StreamEvent } from '@kovan/model-gateway';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  Agent,
  needsApproval,
  type AgentEvent,
  type ApprovalRequest,
  type ModelStreamer,
  type PermissionMode,
} from './agent.js';

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'kovan-agent-'));
  await writeFile(join(root, 'a.txt'), 'old\n');
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

type Step = StreamEvent[];
const call = (id: string, name: string, args: object): StreamEvent => ({
  type: 'tool_call',
  call: { id, type: 'function', function: { name, arguments: JSON.stringify(args) } },
});
const done = (cost = 0.001): StreamEvent => ({
  type: 'done',
  finishReason: 'stop',
  model: 'test/model',
  reasoningDetails: [],
  usage: { promptTokens: 10, completionTokens: 5, cachedTokens: 0, reasoningTokens: 0, cost },
});

/** A model that plays back scripted turns and records what it was asked. */
function scripted(steps: Step[]): ModelStreamer & { requests: ChatRequest[] } {
  const requests: ChatRequest[] = [];
  return {
    requests,
    async *stream(request) {
      requests.push(structuredClone(request));
      const step = steps.shift();
      if (!step) throw new Error('No more scripted steps');
      for (const event of step) yield event;
    },
  };
}

function makeAgent(
  model: ModelStreamer,
  mode: PermissionMode,
  approve: (r: ApprovalRequest) => Promise<boolean> = async () => true,
) {
  const events: AgentEvent[] = [];
  const agent = new Agent({
    model,
    modelId: 'test/model',
    effort: null,
    mode,
    root,
    isRepo: false,
    systemPrompt: 'system',
    approve,
    onEvent: (e) => events.push(e),
  });
  return { agent, events };
}

describe('needsApproval', () => {
  it('matches the four permission modes', () => {
    expect(needsApproval('request', 'edit')).toBe(true);
    expect(needsApproval('allow', 'edit')).toBe(false);
    expect(needsApproval('allow', 'command')).toBe(true);
    expect(needsApproval('full', 'command')).toBe(false);
    expect(needsApproval('request', 'read')).toBe(false);
  });
});

describe('Agent', () => {
  it('runs a tool loop and returns the answer with its cost', async () => {
    const model = scripted([
      [
        { type: 'reasoning', text: 'Let me look.' },
        call('c1', 'read_file', { path: 'a.txt' }),
        done(0.002),
      ],
      [{ type: 'text', text: 'It says old.' }, done(0.001)],
    ]);
    const { agent, events } = makeAgent(model, 'request');
    await agent.send('What is in a.txt?');

    expect(events.map((e) => e.type)).toEqual([
      'turn_start',
      'reasoning',
      'usage',
      'tool_start',
      'tool_end',
      'text',
      'usage',
      'turn_end',
    ]);
    const end = events.at(-1) as Extract<AgentEvent, { type: 'turn_end' }>;
    expect(end.reason).toBe('done');
    expect(end.cost).toBeCloseTo(0.003);
    // The second request carries the tool result back to the model.
    const toolMsg = model.requests[1]!.messages.find((m) => m.role === 'tool');
    expect(toolMsg).toMatchObject({ tool_call_id: 'c1' });
    expect((toolMsg as { content: string }).content).toContain('old');
  });

  it('asks before edits in request mode and skips denied actions', async () => {
    const asked: ApprovalRequest[] = [];
    const model = scripted([
      [call('c1', 'edit_file', { path: 'a.txt', old_string: 'old', new_string: 'new' }), done()],
      [{ type: 'text', text: 'Okay, I will not.' }, done()],
    ]);
    const { agent } = makeAgent(model, 'request', async (r) => {
      asked.push(r);
      return false;
    });
    await agent.send('Change it');
    expect(asked).toEqual([
      expect.objectContaining({ tool: 'edit_file', title: 'Make this edit?', path: 'a.txt' }),
    ]);
    expect(await readFile(join(root, 'a.txt'), 'utf8')).toBe('old\n');
    const toolMsg = model.requests[1]!.messages.find((m) => m.role === 'tool') as {
      content: string;
    };
    expect(toolMsg.content).toContain('denied');
  });

  it("holds a write that collides with a teammate's work, then makes it when asked again", async () => {
    const asked: string[] = [];
    const model = scripted([
      [call('c1', 'edit_file', { path: 'a.txt', old_string: 'old', new_string: 'new' }), done()],
      [call('c2', 'edit_file', { path: 'a.txt', old_string: 'old', new_string: 'new' }), done()],
      [{ type: 'text', text: 'Done.' }, done()],
    ]);
    const events: AgentEvent[] = [];
    let told = false;
    const agent = new Agent({
      model,
      modelId: 'test/model',
      effort: null,
      mode: 'request',
      root,
      isRepo: false,
      systemPrompt: 'system',
      approve: async (r) => {
        asked.push(r.tool);
        return true;
      },
      onEvent: (e) => events.push(e),
      checkWrite: async (path) => {
        if (told) return null;
        told = true;
        return `Held this write to ${path}: Owen is changing it.`;
      },
    });
    await agent.send('Change it');
    // Held before anyone was asked; the second try was asked about and made.
    const first = model.requests[1]!.messages.find((m) => m.role === 'tool') as { content: string };
    expect(first.content).toContain('Owen is changing it');
    expect(asked).toEqual(['edit_file']);
    expect(await readFile(join(root, 'a.txt'), 'utf8')).toBe('new\n');
  });

  it("reads a folder's own rules when the agent reaches it, before its first edit there", async () => {
    await mkdir(join(root, 'pay'));
    await writeFile(join(root, 'pay', 'KOVAN.md'), 'Amounts are integers in cents.\n');
    await writeFile(join(root, 'pay', 'total.ts'), 'export const total = 1;\n');
    const model = scripted([
      [
        call('c1', 'edit_file', {
          path: 'pay/total.ts',
          old_string: 'total = 1',
          new_string: 'total = 100',
        }),
        done(),
      ],
      [
        call('c2', 'edit_file', {
          path: 'pay/total.ts',
          old_string: 'total = 1',
          new_string: 'total = 100',
        }),
        done(),
      ],
      [{ type: 'text', text: 'Done.' }, done()],
    ]);
    const { agent } = makeAgent(model, 'allow');
    await agent.send('Make the total a hundred');
    const tool = model.requests[1]!.messages.find((m) => m.role === 'tool') as { content: string };
    expect(tool.content).toContain('pay/KOVAN.md has rules for this folder');
    // From then on the model sees them, and the edit goes through.
    expect(JSON.stringify(model.requests[1]!.messages)).toContain('Amounts are integers in cents.');
    expect(await readFile(join(root, 'pay', 'total.ts'), 'utf8')).toBe(
      'export const total = 100;\n',
    );
  });

  it("reads the team's state again between steps of a long turn", async () => {
    const model = scripted([
      [call('c1', 'read_file', { path: 'a.txt' }), done()],
      [call('c2', 'read_file', { path: 'a.txt' }), done()],
      [{ type: 'text', text: 'Done.' }, done()],
    ]);
    const notes = ['Owen is changing cart.ts.', 'Owen locked a.txt.'];
    let read = 0;
    const agent = new Agent({
      model,
      modelId: 'test/model',
      effort: null,
      mode: 'allow',
      root,
      isRepo: false,
      systemPrompt: 'system',
      approve: async () => true,
      onEvent: () => undefined,
      turnContext: async () => notes[Math.min(read++, notes.length - 1)]!,
      contextRefreshMs: 0,
    });
    await agent.send('Look at a.txt');
    const noteOf = (i: number) =>
      model.requests[i]!.messages.filter((m) => m.role === 'system')
        .map((m) => m.content)
        .join('|');
    expect(noteOf(0)).toContain('Owen is changing cart.ts.');
    expect(noteOf(1)).toContain('Owen locked a.txt.');
    expect(noteOf(1)).not.toContain('Owen is changing cart.ts.');
  });

  it('summarizes the older part near the window and keeps going', async () => {
    const huge = 'y'.repeat(40_000 * 4);
    const model = scripted([
      // Near the window before the first request: the summary comes first.
      [{ type: 'text', text: 'Goal: change a.txt. Read it; it says old.' }, done()],
      [call('c1', 'read_file', { path: 'a.txt' }), done()],
      [{ type: 'text', text: 'Done.' }, done()],
    ]);
    const events: AgentEvent[] = [];
    const agent = new Agent(
      {
        model,
        modelId: 'test/model',
        effort: null,
        mode: 'allow',
        root,
        isRepo: false,
        systemPrompt: 'system',
        approve: async () => true,
        onEvent: (e) => events.push(e),
        contextWindow: () => 50_000,
      },
      [
        { role: 'system', content: 'system' },
        { role: 'user', content: huge },
        { role: 'assistant', content: 'Noted.' },
        { role: 'user', content: 'Thanks' },
        { role: 'assistant', content: 'Sure.' },
      ],
    );
    await agent.send('Now change a.txt');
    // The first request was the summary, with the older part as text and no tools.
    expect(String(model.requests[0]!.messages[0]!.content)).toContain('compress');
    expect(model.requests[0]!.tools).toEqual([]);
    // The history now starts with the summary; the newest exchange is kept as it was.
    const next = model.requests[1]!.messages;
    expect(String(next[1]!.content)).toContain('Goal: change a.txt');
    expect(next.some((m) => m.role === 'user' && m.content === 'Now change a.txt')).toBe(true);
    expect(JSON.stringify(next)).not.toContain(huge);
    expect(events.find((e) => e.type === 'compacted')).toBeTruthy();
    expect(events.at(-1)).toMatchObject({ type: 'turn_end', reason: 'done' });
  });

  it('summarizes and retries once when the model says the request is too long', async () => {
    let first = true;
    const requests: ChatRequest[] = [];
    const replies: Step[] = [
      [{ type: 'text', text: 'Summary: the task is to change a.txt.' }, done()],
      [{ type: 'text', text: 'Done.' }, done()],
    ];
    const model: ModelStreamer = {
      async *stream(request) {
        requests.push(structuredClone(request));
        if (first) {
          first = false;
          throw new Error("This model's maximum context length is 8192 tokens");
        }
        for (const event of replies.shift()!) yield event;
      },
    };
    const events: AgentEvent[] = [];
    const agent = new Agent(
      {
        model,
        modelId: 'test/model',
        effort: null,
        mode: 'allow',
        root,
        isRepo: false,
        systemPrompt: 'system',
        approve: async () => true,
        onEvent: (e) => events.push(e),
      },
      [
        { role: 'system', content: 'system' },
        { role: 'user', content: 'first task' },
        { role: 'assistant', content: 'ok' },
        { role: 'user', content: 'second task' },
        { role: 'assistant', content: 'ok' },
      ],
    );
    await agent.send('Change a.txt');
    expect(requests).toHaveLength(3);
    expect(events.find((e) => e.type === 'compacted')).toBeTruthy();
    expect(events.at(-1)).toMatchObject({ type: 'turn_end', reason: 'done' });
  });

  it('edits without asking in allow mode but still asks for commands', async () => {
    const asked: string[] = [];
    const model = scripted([
      [
        call('c1', 'edit_file', { path: 'a.txt', old_string: 'old', new_string: 'new' }),
        call('c2', 'run_shell', { command: 'echo hi' }),
        done(),
      ],
      [{ type: 'text', text: 'Done.' }, done()],
    ]);
    const { agent } = makeAgent(model, 'allow', async (r) => {
      asked.push(r.tool);
      return true;
    });
    await agent.send('Change it and run echo');
    expect(asked).toEqual(['run_shell']);
    expect(await readFile(join(root, 'a.txt'), 'utf8')).toBe('new\n');
  });

  it('offers only read-only tools in plan mode', async () => {
    const model = scripted([[{ type: 'text', text: 'Plan: 1. …' }, done()]]);
    const { agent } = makeAgent(model, 'plan');
    await agent.send('Plan it');
    expect(model.requests[0]!.tools!.map((t) => t.name).sort()).toEqual([
      'grep',
      'list_dir',
      'read_file',
    ]);
    expect(model.requests[0]!.messages.at(-1)).toMatchObject({
      role: 'system',
      content: expect.stringContaining('PLAN'),
    });
  });

  it('turns unknown tools and bad JSON into recoverable errors', async () => {
    const model = scripted([
      [
        call('c1', 'delete_everything', {}),
        {
          type: 'tool_call',
          call: { id: 'c2', type: 'function', function: { name: 'read_file', arguments: '{bad' } },
        },
        done(),
      ],
      [{ type: 'text', text: 'Sorry.' }, done()],
    ]);
    const { agent } = makeAgent(model, 'full');
    await agent.send('Go');
    const tools = model.requests[1]!.messages.filter((m) => m.role === 'tool') as {
      content: string;
    }[];
    expect(tools[0]!.content).toContain('unknown tool "delete_everything"');
    expect(tools[1]!.content).toContain('not valid JSON');
  });

  it('stops a running command and ends the turn as stopped', async () => {
    const model = scripted([[call('c1', 'run_shell', { command: 'sleep 30' }), done()]]);
    const { agent, events } = makeAgent(model, 'full');
    const running = agent.send('Wait');
    setTimeout(() => agent.stop(), 300);
    await running;
    expect(events.at(-1)).toMatchObject({ type: 'turn_end', reason: 'stopped' });
    expect(agent.running).toBe(false);
  });

  it('forwards router decisions and adds routing and rate-card costs to the turn', async () => {
    const model = scripted([
      [
        {
          type: 'route',
          decision: {
            model: 'a/cheap',
            effort: 'low',
            tier: 'economy',
            reason: 'small edit',
            switched: true,
            classifierModel: 'a/tiny',
            usage: {
              promptTokens: 5,
              completionTokens: 2,
              cachedTokens: 0,
              reasoningTokens: 0,
              cost: 0.0001,
            },
          },
        },
        { type: 'text', text: 'Hi' },
        {
          type: 'done',
          finishReason: 'stop',
          model: 'a/cheap',
          reasoningDetails: [],
          usage: {
            promptTokens: 1000,
            completionTokens: 10,
            cachedTokens: 0,
            reasoningTokens: 0,
            cost: null,
          },
        },
      ],
    ]);
    const events: AgentEvent[] = [];
    const agent = new Agent({
      model,
      modelId: 'kovan/jevrouter',
      effort: null,
      mode: 'request',
      root,
      isRepo: false,
      systemPrompt: 's',
      approve: async () => true,
      onEvent: (e) => events.push(e),
      price: () => 0.002,
    });
    await agent.send('hello');
    expect(events.find((e) => e.type === 'route')).toMatchObject({
      decision: { model: 'a/cheap' },
    });
    const usages = events.filter((e) => e.type === 'usage');
    expect(usages).toEqual([
      expect.objectContaining({ kind: 'routing', model: 'a/tiny', estimated: false }),
      expect.objectContaining({
        kind: 'model',
        model: 'a/cheap',
        estimated: true,
        usage: expect.objectContaining({ cost: 0.002 }),
      }),
    ]);
    expect((events.at(-1) as Extract<AgentEvent, { type: 'turn_end' }>).cost).toBeCloseTo(0.0021);
  });

  it('reports model failures and keeps the history consistent', async () => {
    const model: ModelStreamer = {
      // eslint-disable-next-line require-yield
      async *stream() {
        throw new Error('Insufficient credits');
      },
    };
    const { agent, events } = makeAgent(model, 'request');
    await agent.send('Hi');
    expect(events.at(-1)).toMatchObject({
      type: 'turn_end',
      reason: 'error',
      error: 'Insufficient credits',
    });
    expect(agent.running).toBe(false);
  });
});

describe('team tools and context', () => {
  it('runs team tools in plan mode without asking, and gives the model the turn context', async () => {
    const recorded: Record<string, unknown>[] = [];
    const model = scripted([
      [
        call('c1', 'record_memory', { path: 'a.txt', kind: 'gotcha', text: 'Keep it old.' }),
        done(),
      ],
      [{ type: 'text', text: 'Saved.' }, done()],
    ]);
    const asked: ApprovalRequest[] = [];
    const agent = new Agent({
      model,
      modelId: 'test/model',
      effort: null,
      mode: 'plan',
      root,
      isRepo: false,
      systemPrompt: 'system',
      approve: async (r) => (asked.push(r), true),
      onEvent: () => {},
      extraTools: [
        {
          spec: { name: 'record_memory', description: 'note', parameters: { type: 'object' } },
          kind: 'team',
          describe: () => 'Recorded a note',
          run: async (args) => (recorded.push(args), { ok: true, output: 'saved' }),
        },
      ],
      turnContext: async () => 'Team notes:\n- a.txt: Keep it old.',
    });
    await agent.send('remember the gotcha');
    expect(asked).toEqual([]);
    expect(recorded).toEqual([{ path: 'a.txt', kind: 'gotcha', text: 'Keep it old.' }]);
    expect(model.requests[0]!.tools?.map((t) => t.name)).toContain('record_memory');
    const system = model.requests[0]!.messages.filter((m) => m.role === 'system');
    expect(system.some((m) => String(m.content).includes('Keep it old.'))).toBe(true);
    // The note isn't kept in the history; each turn reads it fresh.
    expect(agent.messages.some((m) => String(m.content).includes('Team notes'))).toBe(false);
  });
});

describe('edits being written', () => {
  it('passes on the new text as the model writes it, before the edit runs', async () => {
    const progress: AgentEvent[] = [];
    const args = '{"path":"a.txt","old_string":"old","new_string":"new line\\nmore"}';
    const model = scripted([
      [
        { type: 'tool_progress', id: 'c1', name: 'edit_file', arguments: args.slice(0, 50) },
        { type: 'tool_progress', id: 'c1', name: 'edit_file', arguments: args },
        call('c1', 'edit_file', JSON.parse(args)),
        done(),
      ],
      [{ type: 'text', text: 'Done.' }, done()],
    ]);
    const agent = new Agent({
      model,
      modelId: 'test/model',
      effort: null,
      mode: 'full',
      root,
      isRepo: false,
      systemPrompt: 'system',
      approve: async () => true,
      onEvent: (e) => e.type === 'tool_progress' && progress.push(e),
    });
    await agent.send('edit it');
    // Throttled: the first update goes out; the full text arrives with the tool call anyway.
    expect(progress[0]).toMatchObject({
      type: 'tool_progress',
      id: 'c1',
      path: 'a.txt',
      anchor: 'old',
      text: 'n',
    });
    expect(await readFile(join(root, 'a.txt'), 'utf8')).toBe('new line\nmore\n');
  });
});

describe('steering and stopping safely', () => {
  const agentWith = (model: ModelStreamer, events: AgentEvent[]) =>
    new Agent({
      model,
      modelId: 'test/model',
      effort: null,
      mode: 'full',
      root,
      isRepo: false,
      systemPrompt: 'system',
      approve: async () => true,
      onEvent: (e) => events.push(e),
    });

  it('gives guidance to the model before its next step, and returns it if the turn ends first', async () => {
    const events: AgentEvent[] = [];
    const model = scripted([
      [call('c1', 'run_shell', { command: 'sleep 0.3' }), done()],
      [{ type: 'text', text: 'Done.' }, done()],
    ]);
    const agent = agentWith(model, events);
    const turn = agent.send('work');
    await new Promise((r) => setTimeout(r, 100));
    expect(agent.steer({ id: 's1', text: 'Keep the retry bounded', fromName: 'alice' })).toBe(true);
    await turn;
    expect(events.find((e) => e.type === 'steer')).toMatchObject({ id: 's1', status: 'delivered' });
    const second = model.requests[1]!.messages.map((m) => String(m.content));
    expect(second).toContain('Guidance from alice while you work: Keep the retry bounded');

    // Nothing left to deliver it to: it comes back.
    const late: AgentEvent[] = [];
    const slow: ModelStreamer = {
      async *stream() {
        await new Promise((r) => setTimeout(r, 150));
        yield { type: 'text', text: 'ok' };
        yield done();
      },
    };
    const quick = agentWith(slow, late);
    const t = quick.send('hi');
    await new Promise((r) => setTimeout(r, 50));
    quick.steer({ id: 's2', text: 'too late' });
    await t;
    expect(late.find((e) => e.type === 'steer')).toMatchObject({ id: 's2', status: 'returned' });
    expect(agent.steer({ id: 's3', text: 'idle' })).toBe(false);
  });

  it('holds an edit while a new message waits, so the model reads it first', async () => {
    const events: AgentEvent[] = [];
    const model = scripted([
      [
        call('c1', 'run_shell', { command: 'sleep 0.2' }),
        call('c2', 'write_file', { path: 'held.txt', content: 'x' }),
        done(),
      ],
      [call('c3', 'write_file', { path: 'held.txt', content: 'y' }), done()],
      [{ type: 'text', text: 'Done.' }, done()],
    ]);
    const agent = agentWith(model, events);
    const turn = agent.send('work');
    await new Promise((r) => setTimeout(r, 80));
    agent.steer({ id: 's1', text: 'Use y, not x', fromName: 'Maya' });
    await turn;
    const held = events.find((e) => e.type === 'tool_end' && e.id === 'c2');
    expect(held).toMatchObject({ ok: false });
    expect((held as { output: string }).output).toContain('a new message from Maya came in');
    // Read with the next step, then the edit goes through.
    expect(events.find((e) => e.type === 'steer')).toMatchObject({ status: 'delivered' });
    expect(await readFile(join(root, 'held.txt'), 'utf8')).toBe('y');
  });

  it('stops at a checkpoint after the action in flight, not in the middle of it', async () => {
    const events: AgentEvent[] = [];
    const model = scripted([
      [
        call('c1', 'run_shell', { command: 'sleep 0.3 && echo first' }),
        call('c2', 'run_shell', { command: 'echo second' }),
        done(),
      ],
    ]);
    const agent = agentWith(model, events);
    const turn = agent.send('work');
    await new Promise((r) => setTimeout(r, 100));
    agent.stopAtCheckpoint();
    await turn;
    const first = events.find((e) => e.type === 'tool_end' && e.id === 'c1');
    expect(first).toMatchObject({ ok: true, output: expect.stringContaining('first') });
    expect(events.some((e) => e.type === 'tool_start' && e.id === 'c2')).toBe(false);
    expect(events.at(-1)).toMatchObject({ type: 'turn_end', reason: 'stopped', checkpoint: true });
  });

  it('marks a risky command cut off mid-flight as an unknown outcome', async () => {
    const events: AgentEvent[] = [];
    const agent = agentWith(
      scripted([
        [
          call('c1', 'run_shell', { command: 'echo pushing; sleep 2; git push origin main' }),
          done(),
        ],
      ]),
      events,
    );
    const turn = agent.send('ship it');
    await new Promise((r) => setTimeout(r, 300));
    agent.stop();
    await turn;
    expect(events.find((e) => e.type === 'outcome_unknown')).toMatchObject({
      toolId: 'c1',
      command: 'echo pushing; sleep 2; git push origin main',
      evidence: expect.stringContaining('pushing'),
    });
  });
});
