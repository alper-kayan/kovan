import { createServer } from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { handleMessage, serveStdio, type ServerInfo } from './server.js';
import { bridgeCaller, coordinationTools, INSTRUCTIONS } from './tools.js';

const info = (
  tools = coordinationTools(async (tool) => ({ text: `called ${tool}` })),
): ServerInfo => ({ name: 'kovan', version: '0', instructions: INSTRUCTIONS, tools });

describe('MCP protocol', () => {
  it('initializes, lists tools and calls them', async () => {
    const init = await handleMessage(info(), {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-06-18' },
    });
    expect(init).toMatchObject({
      result: {
        protocolVersion: '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'kovan' },
      },
    });

    const list = (await handleMessage(info(), { jsonrpc: '2.0', id: 2, method: 'tools/list' })) as {
      result: { tools: { name: string; description: string }[] };
    };
    const names = list.result.tools.map((t) => t.name);
    expect(names).toEqual([
      'get_team_context',
      'propose_split',
      'claim_plan_step',
      'update_plan_step',
      'assign_work',
      'message_agent',
      'record_memory',
      'create_issue',
      'approval_prompt',
    ]);
    // Every tool says when not to use it.
    for (const t of list.result.tools) expect(t.description).toMatch(/Don't|Only when|only for/);

    const call = await handleMessage(info(), {
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name: 'get_team_context', arguments: {} },
    });
    expect(call).toMatchObject({
      result: { content: [{ type: 'text', text: 'called get_team_context' }], isError: false },
    });
  });

  it('ignores notifications and rejects unknown methods and tools', async () => {
    expect(
      await handleMessage(info(), { jsonrpc: '2.0', method: 'notifications/initialized' }),
    ).toBeNull();
    expect(
      await handleMessage(info(), { jsonrpc: '2.0', id: 4, method: 'resources/list' }),
    ).toMatchObject({ error: { code: -32601 } });
    expect(
      await handleMessage(info(), {
        jsonrpc: '2.0',
        id: 5,
        method: 'tools/call',
        params: { name: 'nope' },
      }),
    ).toMatchObject({ error: { code: -32602 } });
  });

  it('speaks newline-delimited JSON over stdio', async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const lines: unknown[] = [];
    output.on('data', (d: Buffer) =>
      d
        .toString()
        .split('\n')
        .filter(Boolean)
        .forEach((l) => lines.push(JSON.parse(l))),
    );
    const done = serveStdio(info(), input, output);
    input.write('{"jsonrpc":"2.0","id":1,"method":"ping"}\n{"jsonrpc":"2.0","id":2,"meth');
    input.end('od":"tools/list"}\nnot json\n');
    await done;
    // JSON-RPC responses aren't ordered; look each one up.
    expect(lines).toContainEqual({ jsonrpc: '2.0', id: 1, result: {} });
    expect(lines).toContainEqual(expect.objectContaining({ id: 2, result: expect.any(Object) }));
    expect(lines).toContainEqual(
      expect.objectContaining({ error: { code: -32700, message: 'Parse error' } }),
    );
  });
});

describe('bridge', () => {
  let dir: string;
  let server: ReturnType<typeof createServer>;
  let seen: { auth?: string | undefined; body?: unknown } = {};

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'kovan-bridge-'));
    server = createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        seen = { auth: req.headers.authorization, body: JSON.parse(body) };
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ text: 'team: alice online' }));
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as { port: number }).port;
    await writeFile(join(dir, 'bridge.json'), JSON.stringify({ port, token: 'secret' }));
  });
  afterAll(async () => {
    server.close();
    await rm(dir, { recursive: true, force: true });
  });

  it('forwards tool calls with the token, the repo and the conversation', async () => {
    const call = bridgeCaller({
      bridgeFile: join(dir, 'bridge.json'),
      root: '/repo',
      conversationId: 'c1',
    });
    expect(await call('get_team_context', {})).toEqual({ text: 'team: alice online' });
    expect(seen).toEqual({
      auth: 'Bearer secret',
      body: { tool: 'get_team_context', args: {}, root: '/repo', conversationId: 'c1' },
    });
  });

  it('fails soft when Kovan is not running', async () => {
    const call = bridgeCaller({
      bridgeFile: join(dir, 'missing.json'),
      root: '/repo',
      conversationId: null,
    });
    expect(await call('get_team_context', {})).toMatchObject({
      isError: true,
      text: expect.stringContaining('not running'),
    });
  });
});
