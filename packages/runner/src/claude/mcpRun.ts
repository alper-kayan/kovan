#!/usr/bin/env node
// The MCP server Claude Code starts for one Kovan run: it lists that run's tools from the
// bridge (KOVAN_BRIDGE_FILE, KOVAN_RUN_ID) and passes every call through to it.
import { serveStdio } from '@kovan/mcp-coordination';
import { readFile } from 'node:fs/promises';

const file = process.env['KOVAN_BRIDGE_FILE'];
const run = process.env['KOVAN_RUN_ID'];
if (!file || !run) {
  process.stderr.write('KOVAN_BRIDGE_FILE and KOVAN_RUN_ID must be set\n');
  process.exit(1);
}
const info = JSON.parse(await readFile(file, 'utf8')) as { port: number; token: string };
const post = async (body: object): Promise<Record<string, unknown>> => {
  const res = await fetch(`http://127.0.0.1:${info.port}/`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${info.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ run, ...body }),
  });
  return (await res.json()) as Record<string, unknown>;
};
// Started as Claude Code's hook: the event comes on stdin, Kovan's answer goes to stdout.
if (process.argv.includes('--hook')) {
  let input = '';
  for await (const chunk of process.stdin) input += String(chunk);
  const out = await post({ op: 'hook', args: JSON.parse(input || '{}') as object }).catch(() => ({
    text: '',
  }));
  process.stdout.write(String(out['text'] ?? ''));
  process.exit(0);
}
const { tools } = (await post({ op: 'list' })) as {
  tools: { name: string; description: string; inputSchema: Record<string, unknown> }[];
};
await serveStdio({
  name: 'kovan',
  version: '0.1.0',
  instructions:
    'Tools of the Kovan swarm you are part of. Use the ones your task names (assign_tasks, review_verdict, message_agent and the like).',
  tools: tools.map((t) => ({
    ...t,
    handler: async (args) =>
      (await post({ op: 'call', tool: t.name, args })) as { text: string; isError?: boolean },
  })),
});
