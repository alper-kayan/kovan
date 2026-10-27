import { describe, expect, it } from 'vitest';
import { codexMcpArgs } from './args.js';

describe('codexMcpArgs', () => {
  it('adds the Kovan MCP server as -c overrides (format checked with `codex mcp list --json`)', () => {
    const args = codexMcpArgs({
      command: '/Applications/Kovan.app/Contents/MacOS/Kovan',
      args: ['/a b/main.js'],
      env: { ELECTRON_RUN_AS_NODE: '1', KOVAN_BRIDGE_FILE: '/x/"q"/bridge.json' },
    });
    expect(args).toEqual([
      '-c',
      'mcp_servers.kovan.command="/Applications/Kovan.app/Contents/MacOS/Kovan"',
      '-c',
      'mcp_servers.kovan.args=["/a b/main.js"]',
      '-c',
      'mcp_servers.kovan.env={ELECTRON_RUN_AS_NODE="1",KOVAN_BRIDGE_FILE="/x/\\"q\\"/bridge.json"}',
      '-c',
      'mcp_servers.kovan.default_tools_approval_mode="approve"',
    ]);
  });
});
