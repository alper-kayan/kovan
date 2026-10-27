import type { ChatRequest, StreamEvent } from '@kovan/model-gateway';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  Agent,
  needsApproval,
  toolsForMode,
  type AgentEvent,
  type ApprovalRequest,
  type ModelStreamer,
  type PermissionMode,
} from './agent.js';
import type { Tool } from './tools.js';

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'kovan-external-'));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const done: StreamEvent = {
  type: 'done',
  finishReason: 'stop',
  model: 'test/model',
  reasoningDetails: [],
  usage: { promptTokens: 1, completionTokens: 1, cachedTokens: 0, reasoningTokens: 0, cost: 0 },
};
const call = (id: string, name: string, args: object): StreamEvent => ({
  type: 'tool_call',
  call: { id, type: 'function', function: { name, arguments: JSON.stringify(args) } },
});
function scripted(steps: StreamEvent[][]): ModelStreamer & { requests: ChatRequest[] } {
  const requests: ChatRequest[] = [];
  return {
    requests,
    async *stream(request) {
      requests.push(structuredClone(request));
      for (const e of steps.shift() ?? [{ type: 'text', text: 'ok' } as StreamEvent, done]) yield e;
    },
  };
}

function mcpTool(name: string, opts: { readOnly?: boolean; allowed?: () => boolean } = {}) {
  const runs: Record<string, unknown>[] = [];
  const tool: Tool = {
    kind: 'external',
    spec: { name, description: name, parameters: { type: 'object', properties: {} } },
    origin: `github · ${name}`,
    ...(opts.readOnly ? { readOnly: true } : {}),
    ...(opts.allowed ? { allowed: opts.allowed } : {}),
    describe: (a) => `Used ${name} ${JSON.stringify(a)}`,
    display: (a) => ({ ...a, token: a['token'] ? '••••••' : undefined }),
    async run(args) {
      runs.push(args);
      return { ok: true, output: `ran ${name}` };
    },
  };
  return { tool, runs };
}

function run(mode: PermissionMode, tools: Tool[], steps: StreamEvent[][], approve = true) {
  const events: AgentEvent[] = [];
  const asked: ApprovalRequest[] = [];
  const model = scripted(steps);
  const agent = new Agent({
    model,
    modelId: 'test/model',
    effort: null,
    mode,
    root,
    isRepo: false,
    systemPrompt: 'system',
    approve: async (r) => {
      asked.push(r);
      return approve;
    },
    onEvent: (e) => events.push(e),
    turnTools: async () => tools,
  });
  return { agent, events, asked, model };
}

describe('external (MCP) tools', () => {
  it('ask in Request and Allow modes, not in Full', () => {
    expect(needsApproval('request', 'external')).toBe(true);
    expect(needsApproval('allow', 'external')).toBe(true);
    expect(needsApproval('full', 'external')).toBe(false);
  });

  it('are offered in Plan mode only when their server says they only read', () => {
    const reader = mcpTool('mcp__gh__list', { readOnly: true }).tool;
    const writer = mcpTool('mcp__gh__create').tool;
    const names = toolsForMode('plan', [reader, writer]).map((t) => t.spec.name);
    expect(names).toContain('mcp__gh__list');
    expect(names).not.toContain('mcp__gh__create');
  });

  it('show their server, tool and masked arguments on the card, then run with the real ones', async () => {
    const { tool, runs } = mcpTool('mcp__gh__create');
    const { agent, events, asked, model } = run(
      'allow',
      [tool],
      [[call('1', 'mcp__gh__create', { title: 'Bug', token: 'real-secret' }), done]],
    );
    await agent.send('file it');
    expect(model.requests[0]!.tools?.map((t) => t.name)).toContain('mcp__gh__create');
    expect(asked[0]).toMatchObject({ kind: 'external', title: 'Use this tool?' });
    expect(asked[0]!.detail).toContain('github · mcp__gh__create');
    expect(asked[0]!.detail).not.toContain('real-secret');
    const start = events.find((e) => e.type === 'tool_start');
    expect(JSON.stringify(start)).not.toContain('real-secret');
    expect(runs).toEqual([{ title: 'Bug', token: 'real-secret' }]);
  });

  it('run without asking in Full mode or once "always allow" was chosen', async () => {
    const full = run(
      'full',
      [mcpTool('mcp__gh__create').tool],
      [[call('1', 'mcp__gh__create', {}), done]],
    );
    await full.agent.send('go');
    expect(full.asked).toEqual([]);
    const always = run(
      'request',
      [mcpTool('mcp__gh__create', { allowed: () => true }).tool],
      [[call('1', 'mcp__gh__create', {}), done]],
    );
    await always.agent.send('go');
    expect(always.asked).toEqual([]);
    expect(always.events.find((e) => e.type === 'tool_end')).toMatchObject({ ok: true });
  });

  it("don't run when the person says no", async () => {
    const { tool, runs } = mcpTool('mcp__gh__create');
    const r = run('request', [tool], [[call('1', 'mcp__gh__create', {}), done]], false);
    await r.agent.send('go');
    expect(runs).toEqual([]);
  });
});
