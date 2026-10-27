#!/usr/bin/env node
// A stand-in for `claude -p --input-format stream-json`: it reads the task and any later
// messages from stdin, works a moment, then answers with every message it got so far (as
// Claude Code folds messages that arrive mid-turn into that turn). It exits when stdin ends.
import { createInterface } from 'node:readline';

const emit = (o) => process.stdout.write(JSON.stringify(o) + '\n');
const got = [];
let busy = false;
const turn = async () => {
  busy = true;
  await new Promise((r) => setTimeout(r, 300));
  const heard = got.splice(0);
  emit({
    type: 'assistant',
    message: { content: [{ type: 'text', text: `heard: ${heard.join(' | ')}` }] },
  });
  emit({
    type: 'result',
    subtype: 'success',
    is_error: false,
    result: 'ok',
    total_cost_usd: 0.1,
    usage: { input_tokens: 1, output_tokens: 1 },
  });
  busy = false;
  if (got.length) void turn();
};
emit({ type: 'system', subtype: 'init', session_id: 'live', model: 'claude-haiku-5-5' });
createInterface({ input: process.stdin }).on('line', (line) => {
  const m = JSON.parse(line);
  got.push(m.message.content[0].text);
  if (!busy) void turn();
});
