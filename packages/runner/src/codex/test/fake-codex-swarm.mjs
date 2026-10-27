#!/usr/bin/env node
// A stand-in for `codex app-server` on a swarm task: it asks to run two commands and to apply
// one change, calls a Kovan tool through the bridge its MCP settings name, takes steered
// messages, then answers with all it saw and ends the turn.
import { readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

const argv = process.argv.slice(2).join(' ');
const bridgeFile = /KOVAN_BRIDGE_FILE="([^"]*)"/.exec(argv)?.[1];
const runId = /KOVAN_RUN_ID="([^"]*)"/.exec(argv)?.[1];
const send = (o) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...o }) + '\n');
const note = (method, params) => send({ method, params });
const seen = {
  prompt: '',
  decisions: {},
  steered: [],
  tool: null,
  policy: /approval_policy="([\w-]+)"/.exec(argv)?.[1],
};
const waiting = new Map();
let n = 1000;
const ask = (method, params) =>
  new Promise((resolve) => {
    const id = ++n;
    waiting.set(id, resolve);
    send({ id, method, params });
  });

async function work(root) {
  seen.decisions.test = (
    await ask('item/commandExecution/requestApproval', {
      itemId: 'c1',
      command: "/bin/zsh -lc 'pnpm test'",
    })
  ).decision;
  seen.decisions.push = (
    await ask('item/commandExecution/requestApproval', { itemId: 'c2', command: 'git push' })
  ).decision;
  note('item/started', {
    item: {
      id: 'f1',
      type: 'fileChange',
      changes: [{ path: `${root}/src/cart.js`, kind: { type: 'update' } }],
      status: 'inProgress',
    },
  });
  seen.decisions.change = (await ask('item/fileChange/requestApproval', { itemId: 'f1' })).decision;
  const info = JSON.parse(readFileSync(bridgeFile, 'utf8'));
  const res = await fetch(`http://127.0.0.1:${info.port}/`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${info.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      run: runId,
      op: 'call',
      tool: 'message_agent',
      args: { to: 'lead', text: 'hi' },
    }),
  });
  seen.tool = (await res.json()).text;
  note('item/completed', {
    item: {
      id: 'c1',
      type: 'commandExecution',
      command: 'pnpm test',
      aggregatedOutput: 'ok',
      exitCode: 0,
      status: 'completed',
    },
  });
  await new Promise((r) => setTimeout(r, 300));
  note('item/completed', {
    item: { id: 'msg1', type: 'agentMessage', text: JSON.stringify(seen) },
  });
  note('turn/completed', { turn: { id: 'u1', status: 'completed', items: [] } });
}

createInterface({ input: process.stdin }).on('line', (line) => {
  const m = JSON.parse(line);
  if (typeof m.id === 'number' && !m.method) {
    waiting.get(m.id)?.(m.result ?? m.error);
    return;
  }
  if (m.method === 'initialize') send({ id: m.id, result: { userAgent: 'fake' } });
  else if (m.method === 'thread/start') {
    seen.sandbox = m.params.sandbox;
    send({ id: m.id, result: { thread: { id: 'thread-1' } } });
    seen.root = m.params.cwd;
  } else if (m.method === 'turn/start') {
    seen.prompt = m.params.input[0].text;
    send({ id: m.id, result: { turn: { id: 'u1', status: 'inProgress', items: [] } } });
    note('turn/started', { turn: { id: 'u1' } });
    void work(seen.root);
  } else if (m.method === 'turn/steer') {
    seen.steered.push(m.params.input[0].text);
    send({ id: m.id, result: { turnId: 'u1' } });
    note('item/completed', {
      item: {
        id: `um${seen.steered.length}`,
        type: 'userMessage',
        clientId: m.params.clientUserMessageId,
        content: [],
      },
    });
  } else if (m.method === 'turn/interrupt') {
    send({ id: m.id, result: {} });
    note('turn/completed', { turn: { id: 'u1', status: 'interrupted', items: [] } });
  }
});
