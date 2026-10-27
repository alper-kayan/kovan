#!/usr/bin/env node
// A stand-in for the `claude` CLI in tests: it starts the MCP server it is given, lists and
// calls Kovan's tools, asks two permission prompts, then answers like `claude -p` stream-json.
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';

const args = process.argv.slice(2);
const cfg = JSON.parse(readFileSync(args[args.indexOf('--mcp-config') + 1], 'utf8')).mcpServers
  .kovan;
const mcp = spawn(cfg.command, cfg.args, {
  env: { ...process.env, ...cfg.env },
  stdio: ['pipe', 'pipe', 'inherit'],
});
let buf = '';
const pending = new Map();
let n = 0;
mcp.stdout.setEncoding('utf8');
mcp.stdout.on('data', (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i);
    buf = buf.slice(i + 1);
    const m = JSON.parse(line);
    pending.get(m.id)?.(m);
  }
});
const rpc = (method, params) =>
  new Promise((r) => {
    const id = ++n;
    pending.set(id, r);
    mcp.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
await rpc('initialize', {
  protocolVersion: '2025-06-18',
  capabilities: {},
  clientInfo: { name: 'fake', version: '1' },
});
const tools = (await rpc('tools/list', {})).result.tools.map((t) => t.name);
const call = async (name, a) =>
  (await rpc('tools/call', { name, arguments: a })).result.content[0].text;
const assign = tools.includes('assign_tasks')
  ? await call('assign_tasks', { tasks: [{ id: 'a', title: 'A' }] })
  : null;
const test = JSON.parse(
  await call('approval_prompt', { tool_name: 'Bash', input: { command: 'pnpm test' } }),
).behavior;
const push = JSON.parse(
  await call('approval_prompt', { tool_name: 'Bash', input: { command: 'git push' } }),
).behavior;
const ask = JSON.parse(
  await call('approval_prompt', { tool_name: 'AskUserQuestion', input: { questions: [] } }),
);
const own = JSON.parse(
  await call('approval_prompt', { tool_name: 'mcp__kovan__assign_tasks', input: { tasks: [] } }),
).behavior;
// Kovan's hooks, when it gave settings: what they answer for a write and after a tool call.
let hooks = null;
if (args.includes('--settings')) {
  const { execSync } = await import('node:child_process');
  const settings = JSON.parse(readFileSync(args[args.indexOf('--settings') + 1], 'utf8'));
  const run = (event, input) =>
    execSync(settings.hooks[event][0].hooks[0].command, {
      input: JSON.stringify({ hook_event_name: event, ...input }),
      encoding: 'utf8',
      shell: '/bin/sh',
    });
  hooks = {
    pre: run('PreToolUse', {
      tool_name: 'Write',
      tool_input: { file_path: `${process.cwd()}/src/cart.js` },
    }),
    preOther: run('PreToolUse', {
      tool_name: 'Write',
      tool_input: { file_path: `${process.cwd()}/src/free.js` },
    }),
    post: run('PostToolUse', { tool_name: 'Read', tool_input: {} }),
    again: run('PostToolUse', { tool_name: 'Read', tool_input: {} }),
  };
}
const emit = (o) => process.stdout.write(JSON.stringify(o) + '\n');
emit({ type: 'system', subtype: 'init', session_id: 's1', model: 'claude-sonnet-5-5' });
emit({
  type: 'assistant',
  message: {
    content: [
      { type: 'text', text: JSON.stringify({ args, tools, assign, test, push, ask, own, hooks }) },
    ],
  },
});
emit({
  type: 'result',
  subtype: 'success',
  is_error: false,
  result: 'ok',
  total_cost_usd: 0.42,
  usage: { input_tokens: 10, output_tokens: 5 },
});
mcp.kill();
