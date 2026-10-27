#!/usr/bin/env node
// A stand-in for `codex app-server`: JSON-RPC on stdio. It starts a thread and a turn, runs one
// command, takes a steered message (shown in the thread as a user message with its client id),
// then answers with everything it heard and ends the turn.
import { createInterface } from 'node:readline';

const send = (o) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...o }) + '\n');
const note = (method, params) => send({ method, params });
const heard = [];
let done = false;
const finish = () => {
  if (done) return;
  done = true;
  note('item/completed', {
    item: {
      id: 'cmd1',
      type: 'commandExecution',
      command: "/bin/zsh -lc 'pnpm test'",
      aggregatedOutput: 'ok',
      exitCode: 0,
      status: 'completed',
    },
  });
  note('item/completed', {
    item: { id: 'msg1', type: 'agentMessage', text: `heard: ${heard.join(' | ')}` },
  });
  note('thread/tokenUsage/updated', {
    tokenUsage: {
      total: {
        inputTokens: 100,
        cachedInputTokens: 40,
        outputTokens: 10,
        reasoningOutputTokens: 0,
        totalTokens: 110,
      },
    },
  });
  note('turn/completed', { turn: { id: 'u1', status: 'completed', items: [] } });
};
createInterface({ input: process.stdin }).on('line', (line) => {
  const m = JSON.parse(line);
  if (m.method === 'initialize') send({ id: m.id, result: { userAgent: 'fake' } });
  else if (m.method === 'thread/start' || m.method === 'thread/resume')
    send({ id: m.id, result: { thread: { id: m.params.threadId ?? 'thread-1' } } });
  else if (m.method === 'turn/start') {
    heard.push(m.params.input[0].text.split('\n\n').at(-1));
    send({ id: m.id, result: { turn: { id: 'u1', status: 'inProgress', items: [] } } });
    note('turn/started', { turn: { id: 'u1' } });
    note('item/started', {
      item: {
        id: 'cmd1',
        type: 'commandExecution',
        command: "/bin/zsh -lc 'pnpm test'",
        status: 'inProgress',
      },
    });
    setTimeout(finish, 400);
  } else if (m.method === 'turn/steer') {
    heard.push(m.params.input[0].text);
    send({ id: m.id, result: { turnId: 'u1' } });
    note('item/completed', {
      item: { id: 'um2', type: 'userMessage', clientId: m.params.clientUserMessageId, content: [] },
    });
  } else if (m.method === 'turn/interrupt') {
    send({ id: m.id, result: {} });
    done = true;
    note('turn/completed', { turn: { id: 'u1', status: 'interrupted', items: [] } });
  }
});
