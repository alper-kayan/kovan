// A minimal Model Context Protocol server over stdio: newline-delimited JSON-RPC 2.0 with the
// three methods agents need (initialize, tools/list, tools/call). No dependencies, so it ships
// as one small file next to the app.

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  handler: (args: Record<string, unknown>) => Promise<{ text: string; isError?: boolean }>;
}

export interface ServerInfo {
  name: string;
  version: string;
  /** Shown to the agent at the start of every session. */
  instructions: string;
  tools: ToolDefinition[];
}

type Json = Record<string, unknown>;

const SUPPORTED_PROTOCOL = '2025-06-18';

/** Handles one JSON-RPC message and returns the response (or null for notifications). */
export async function handleMessage(info: ServerInfo, message: Json): Promise<Json | null> {
  const id = message['id'];
  const method = message['method'];
  const params = (message['params'] ?? {}) as Json;
  const reply = (result: unknown) => ({ jsonrpc: '2.0', id, result });
  const fail = (code: number, text: string) => ({
    jsonrpc: '2.0',
    id,
    error: { code, message: text },
  });

  // Notifications (no id) get no response.
  if (id === undefined || id === null) return null;

  switch (method) {
    case 'initialize':
      return reply({
        protocolVersion:
          typeof params['protocolVersion'] === 'string'
            ? params['protocolVersion']
            : SUPPORTED_PROTOCOL,
        capabilities: { tools: {} },
        serverInfo: { name: info.name, version: info.version },
        instructions: info.instructions,
      });
    case 'ping':
      return reply({});
    case 'tools/list':
      return reply({
        tools: info.tools.map(({ name, description, inputSchema }) => ({
          name,
          description,
          inputSchema,
        })),
      });
    case 'tools/call': {
      const tool = info.tools.find((t) => t.name === params['name']);
      if (!tool) return fail(-32602, `Unknown tool: ${String(params['name'])}`);
      try {
        const result = await tool.handler((params['arguments'] ?? {}) as Json);
        return reply({
          content: [{ type: 'text', text: result.text }],
          isError: result.isError ?? false,
        });
      } catch (error) {
        return reply({
          content: [{ type: 'text', text: `Error: ${(error as Error).message}` }],
          isError: true,
        });
      }
    }
    default:
      return fail(-32601, `Method not found: ${String(method)}`);
  }
}

/** Serves MCP over stdin/stdout until stdin closes. */
export function serveStdio(
  info: ServerInfo,
  input: NodeJS.ReadableStream = process.stdin,
  output: NodeJS.WritableStream = process.stdout,
): Promise<void> {
  return new Promise((resolve) => {
    let buffer = '';
    const queue: Promise<void>[] = [];
    input.setEncoding?.('utf8');
    input.on('data', (chunk: string) => {
      buffer += chunk;
      let newline: number;
      while ((newline = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (!line) continue;
        queue.push(
          (async () => {
            let message: Json;
            try {
              message = JSON.parse(line) as Json;
            } catch {
              output.write(
                JSON.stringify({
                  jsonrpc: '2.0',
                  id: null,
                  error: { code: -32700, message: 'Parse error' },
                }) + '\n',
              );
              return;
            }
            const response = await handleMessage(info, message);
            if (response) output.write(JSON.stringify(response) + '\n');
          })(),
        );
      }
    });
    input.on('end', () => void Promise.all(queue).then(() => resolve()));
  });
}
