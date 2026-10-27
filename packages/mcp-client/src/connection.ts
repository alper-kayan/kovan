import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { ToolListChangedNotificationSchema } from '@modelcontextprotocol/sdk/types.js';
import { configKey, type McpServerConfig } from './config.js';
import { resultText } from './content.js';
import { isUnauthorized, offersSignIn, storedAuth, type OAuthStore } from './oauth.js';

export interface McpTool {
  /** The server's own name for it. */
  name: string;
  title: string | null;
  description: string;
  inputSchema: Record<string, unknown>;
  /** The server says it only reads (`readOnlyHint`): the one kind Plan mode may use. */
  readOnly: boolean;
}

export interface McpCallResult {
  text: string;
  isError: boolean;
}

export interface ConnectionOptions {
  /** Where a command-started server runs when its config doesn't say. */
  cwd: string;
  /** Added under the config's own env (e.g. the person's PATH, which apps don't inherit). */
  env?: Record<string, string>;
  client?: { name: string; version: string };
  startTimeoutMs?: number;
  callTimeoutMs?: number;
  /** Where remote servers' sign-ins are kept (tokens are sent and refreshed from here). */
  oauth?: OAuthStore;
}

/** `needs-auth`: a remote server that wants the person to sign in first. */
export type McpStatus = 'idle' | 'starting' | 'ready' | 'needs-auth' | 'failed' | 'closed';

const START_TIMEOUT = 30_000;
const CALL_TIMEOUT = 120_000;
const MAX_CALL_TIME = 10 * 60_000;
const STDERR_LINES = 20;

/**
 * One MCP server: started the first time it is needed, listed once (again when it says its
 * tools changed), and closed with the app. A server that dies is started again once; a second
 * death leaves it failed, with the end of its error output as the reason.
 */
export class McpConnection {
  status: McpStatus = 'idle';
  error: string | null = null;
  readonly key: string;
  private client: Client | null = null;
  private starting: Promise<Client> | null = null;
  private tools: McpTool[] | null = null;
  private restarts = 0;
  private closing = false;
  private stderr: string[] = [];

  constructor(
    readonly name: string,
    readonly config: McpServerConfig,
    private readonly options: ConnectionOptions,
  ) {
    this.key = `${name}:${configKey(config)}`;
  }

  /** The server's tools, starting it if needed. */
  async listTools(): Promise<McpTool[]> {
    const client = await this.ready();
    if (this.tools) return this.tools;
    const tools: McpTool[] = [];
    let cursor: string | undefined;
    do {
      const page = await client.listTools(cursor ? { cursor } : {}, {
        timeout: this.options.startTimeoutMs ?? START_TIMEOUT,
      });
      for (const t of page.tools)
        tools.push({
          name: t.name,
          title: t.title ?? t.annotations?.title ?? null,
          description: t.description ?? '',
          inputSchema: t.inputSchema as Record<string, unknown>,
          readOnly: t.annotations?.readOnlyHint === true,
        });
      cursor = page.nextCursor;
    } while (cursor);
    this.tools = tools;
    return tools;
  }

  async callTool(
    name: string,
    args: Record<string, unknown>,
    options: { signal?: AbortSignal; timeoutMs?: number } = {},
  ): Promise<McpCallResult> {
    const client = await this.ready();
    try {
      const result = await client.callTool({ name, arguments: args }, undefined, {
        timeout: options.timeoutMs ?? this.options.callTimeoutMs ?? CALL_TIMEOUT,
        resetTimeoutOnProgress: true,
        maxTotalTimeout: MAX_CALL_TIME,
        ...(options.signal ? { signal: options.signal } : {}),
      });
      return { text: resultText(result), isError: result.isError === true };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // Gone mid-call: nobody knows whether the action happened. It is not tried again.
      if (this.status !== 'ready' || /closed/i.test(message))
        return {
          isError: true,
          text: `The ${this.name} server stopped while this ran, so it isn't known whether it happened.${this.tail()}`,
        };
      return { isError: true, text: `Error from ${this.name}: ${message}` };
    }
  }

  async close(): Promise<void> {
    this.closing = true;
    this.status = 'closed';
    const client = this.client;
    this.client = null;
    this.tools = null;
    await client?.close().catch(() => undefined);
  }

  private tail(): string {
    return this.stderr.length ? `\nIts last output:\n${this.stderr.join('\n')}` : '';
  }

  private async ready(): Promise<Client> {
    if (this.status === 'closed') throw new Error(`${this.name} is closed`);
    if (this.client && this.status === 'ready') return this.client;
    if (this.status === 'failed' || this.status === 'needs-auth')
      throw new Error(this.error ?? `${this.name} failed to start`);
    this.starting ??= this.start().finally(() => {
      this.starting = null;
    });
    return this.starting;
  }

  private async transport(): Promise<Transport> {
    const { config } = this;
    if (config.type === 'http') {
      // Tokens go along only once the person has signed in; without them a server that wants
      // sign-in says 401, and nothing registers or opens a browser behind their back.
      const saved = await this.options.oauth?.get(config.url);
      const authProvider =
        saved?.tokens && this.options.oauth
          ? storedAuth(config.url, this.options.oauth, saved, this.options.client?.name)
          : undefined;
      // The SDK's own optional fields don't fit exactOptionalPropertyTypes.
      return new StreamableHTTPClientTransport(new URL(config.url), {
        requestInit: { headers: config.headers },
        ...(authProvider ? { authProvider } : {}),
      }) as unknown as Transport;
    }
    const transport = new StdioClientTransport({
      command: config.command,
      args: config.args,
      env: { ...this.options.env, ...config.env },
      cwd: config.cwd ?? this.options.cwd,
      stderr: 'pipe',
    });
    transport.stderr?.on('data', (chunk: Buffer) => {
      const lines = chunk.toString('utf8').split('\n').filter(Boolean);
      this.stderr = [...this.stderr, ...lines].slice(-STDERR_LINES).map((l) => l.slice(0, 500));
    });
    return transport;
  }

  private async start(): Promise<Client> {
    this.status = 'starting';
    const client = new Client(this.options.client ?? { name: 'kovan', version: '0.1.0' });
    client.setNotificationHandler(ToolListChangedNotificationSchema, () => {
      this.tools = null;
    });
    client.onclose = () => {
      if (this.closing || this.client !== client) return;
      this.client = null;
      this.tools = null;
      // Died on its own: once it may start again, the next time it's needed.
      if (this.restarts === 0) {
        this.restarts++;
        this.status = 'idle';
      } else {
        this.status = 'failed';
        this.error = `${this.name} stopped again after a restart.${this.tail()}`;
      }
    };
    const timeout = this.options.startTimeoutMs ?? START_TIMEOUT;
    const { config } = this;
    try {
      await client.connect(await this.transport(), { timeout });
    } catch (error) {
      await client.close().catch(() => undefined);
      if (isUnauthorized(error) && config.type === 'http' && (await offersSignIn(config.url))) {
        this.status = 'needs-auth';
        this.error = `${this.name} needs you to sign in (Settings → Agents → MCP servers).`;
        throw new Error(this.error, { cause: error });
      }
      this.status = 'failed';
      const reason = isUnauthorized(error)
        ? 'it turned Kovan away (401): check the headers it needs'
        : error instanceof Error
          ? error.message
          : String(error);
      this.error = `${this.name} didn't start: ${reason}${this.tail()}`;
      throw new Error(this.error, { cause: error });
    }
    this.client = client;
    this.status = 'ready';
    return client;
  }
}

/**
 * Every MCP server this app has started, by name and config: the same server is reused across
 * turns and agents, a changed config starts a new one, and all of them stop with the app.
 */
export class McpHub {
  private readonly connections = new Map<string, McpConnection>();

  constructor(private readonly options: Omit<ConnectionOptions, 'cwd'>) {}

  connection(name: string, config: McpServerConfig, cwd: string): McpConnection {
    const key = `${name}:${configKey(config)}`;
    let c = this.connections.get(key);
    // A closed one (or one that failed for good) is replaced only when the config changes.
    if (!c || c.status === 'closed') {
      c = new McpConnection(name, config, { ...this.options, cwd });
      this.connections.set(key, c);
    }
    return c;
  }

  /** Forgets a server's connections (after a sign-in, or to try a failed one again). */
  async reset(name: string): Promise<void> {
    for (const [key, c] of this.connections)
      if (c.name === name) {
        this.connections.delete(key);
        await c.close();
      }
  }

  /** Stops servers that are no longer configured anywhere. */
  async keepOnly(keys: Iterable<string>): Promise<void> {
    const keep = new Set(keys);
    for (const [key, c] of this.connections)
      if (!keep.has(key)) {
        this.connections.delete(key);
        await c.close();
      }
  }

  list(): McpConnection[] {
    return [...this.connections.values()];
  }

  async closeAll(): Promise<void> {
    const all = [...this.connections.values()];
    this.connections.clear();
    await Promise.all(all.map((c) => c.close()));
  }
}
