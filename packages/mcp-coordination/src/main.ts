#!/usr/bin/env node
// Entry point Claude Code and Codex launch: `node main.js`, configured by environment.
import { serveStdio } from './server.js';
import { bridgeCaller, coordinationTools, INSTRUCTIONS } from './tools.js';

const bridgeFile = process.env['KOVAN_BRIDGE_FILE'];
if (!bridgeFile) {
  process.stderr.write('KOVAN_BRIDGE_FILE is not set\n');
  process.exit(1);
}

await serveStdio({
  name: 'kovan',
  version: '0.1.0',
  instructions: INSTRUCTIONS,
  tools: coordinationTools(
    bridgeCaller({
      bridgeFile,
      root: process.env['KOVAN_WORKSPACE_ROOT'] ?? process.cwd(),
      conversationId: process.env['KOVAN_CONVERSATION_ID'] ?? null,
    }),
  ),
});
