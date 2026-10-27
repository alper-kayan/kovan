#!/usr/bin/env node
// Kovan's hook for agent CLIs started outside Kovan (e.g. `claude` in a terminal): before a
// prompt it adds the team context, before an edit it checks teammates' locks. It always fails
// open: if Kovan isn't running or doesn't answer, the agent carries on as if it weren't here.
//
//   KOVAN_BRIDGE_FILE=… KOVAN_WORKSPACE_ROOT=… node hook.js <UserPromptSubmit|PreToolUse|PostToolUse|Stop>
import { bridgeCaller } from './tools.js';

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

async function main(): Promise<void> {
  const event = process.argv[2] ?? '';
  const bridgeFile = process.env['KOVAN_BRIDGE_FILE'];
  const root = process.env['KOVAN_WORKSPACE_ROOT'] ?? process.cwd();
  if (!bridgeFile) return;
  let input: Record<string, unknown> = {};
  try {
    input = JSON.parse((await readStdin()) || '{}') as Record<string, unknown>;
  } catch {
    // Not JSON: nothing to act on.
  }
  const call = bridgeCaller({ bridgeFile, root, conversationId: null });
  const result = await call('hook', { event, input });
  if (result.isError || !result.text) return;
  // The desktop answers with the exact JSON the CLI expects (or nothing).
  process.stdout.write(result.text);
}

main().then(
  () => process.exit(0),
  () => process.exit(0),
);
