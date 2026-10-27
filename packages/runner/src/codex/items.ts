type Json = Record<string, unknown>;

/** app-server's camelCase statuses in `codex exec --json`'s terms (what the parser reads). */
const STATUS: Record<string, string> = {
  inProgress: 'in_progress',
  completed: 'completed',
  failed: 'failed',
  declined: 'declined',
};

/**
 * One app-server thread item as the `codex exec --json` item the stream parser knows; null for
 * items the lane doesn't show (the person's own messages, hooks, plans).
 */
export function execItem(item: Json): Json | null {
  const id = String(item['id'] ?? '');
  const status = STATUS[String(item['status'] ?? '')] ?? item['status'];
  switch (item['type']) {
    case 'agentMessage':
      return { id, type: 'agent_message', text: item['text'] ?? '' };
    case 'reasoning': {
      const summary = (item['summary'] as unknown[] | undefined) ?? [];
      const text = summary.map((s) => (typeof s === 'string' ? s : '')).join('\n');
      return { id, type: 'reasoning', text };
    }
    case 'commandExecution':
      return {
        id,
        type: 'command_execution',
        command: item['command'] ?? '',
        aggregated_output: item['aggregatedOutput'] ?? '',
        exit_code: item['exitCode'] ?? null,
        status,
      };
    case 'fileChange':
      return {
        id,
        type: 'file_change',
        changes: ((item['changes'] as Json[] | undefined) ?? []).map((c) => ({
          path: c['path'],
          kind: (c['kind'] as Json | undefined)?.['type'] ?? 'update',
        })),
        status,
      };
    case 'mcpToolCall':
      return {
        id,
        type: 'mcp_tool_call',
        server: item['server'],
        tool: item['tool'],
        arguments: item['arguments'] ?? {},
        result: item['result'] ?? null,
        error: item['error'] ?? null,
        status,
      };
    case 'webSearch':
      return { id, type: 'web_search', query: item['query'] ?? '' };
    default:
      return null;
  }
}
