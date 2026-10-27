import { randomBytes, timingSafeEqual } from 'node:crypto';
import { rm, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { join } from 'node:path';

export interface BridgeRequest {
  tool: string;
  args: Record<string, unknown>;
  root: string;
  conversationId: string | null;
}

export type BridgeHandler = (
  request: BridgeRequest,
) => Promise<{ text: string; isError?: boolean }>;

/**
 * The loopback endpoint Kovan's MCP server calls from inside Claude Code or Codex. It listens on
 * 127.0.0.1 only, on a random port, and requires a random token kept in a file only this user
 * can read.
 */
export class Bridge {
  private server: Server | null = null;
  private readonly token = randomBytes(24).toString('base64url');
  readonly file: string;

  constructor(
    dataDir: string,
    private readonly handle: BridgeHandler,
  ) {
    this.file = join(dataDir, 'bridge.json');
  }

  async start(): Promise<void> {
    const expected = Buffer.from(`Bearer ${this.token}`);
    this.server = createServer((req, res) => {
      const auth = Buffer.from(req.headers.authorization ?? '');
      if (
        req.method !== 'POST' ||
        req.url !== '/tool' ||
        auth.length !== expected.length ||
        !timingSafeEqual(auth, expected)
      ) {
        res.writeHead(404).end();
        return;
      }
      let body = '';
      req.setEncoding('utf8');
      req.on('data', (chunk: string) => {
        body += chunk;
        if (body.length > 1_000_000) req.destroy();
      });
      req.on('end', () => {
        void (async () => {
          let result: { text: string; isError?: boolean };
          try {
            const request = JSON.parse(body) as BridgeRequest;
            result = await this.handle(request);
          } catch (error) {
            result = { text: `Error: ${(error as Error).message}`, isError: true };
          }
          res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(result));
        })();
      });
    });
    // Approvals can wait on a person for a long time.
    this.server.requestTimeout = 0;
    this.server.headersTimeout = 60_000;
    await new Promise<void>((resolve) => this.server!.listen(0, '127.0.0.1', resolve));
    const port = (this.server.address() as { port: number }).port;
    await writeFile(this.file, JSON.stringify({ port, token: this.token }), { mode: 0o600 });
  }

  async stop(): Promise<void> {
    this.server?.close();
    await rm(this.file, { force: true });
  }
}
