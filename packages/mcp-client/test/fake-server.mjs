#!/usr/bin/env node
// A small MCP server for tests, on stdio, or on HTTP with `--http <port>` (prints "listening").
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { appendFileSync } from 'node:fs';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

if (process.env.FAKE_FAIL_START) {
  process.stderr.write('fake: cannot start, FAKE_FAIL_START is set\n');
  process.exit(3);
}
// Each start is written down, for the restart tests.
if (process.env.FAKE_STARTS) appendFileSync(process.env.FAKE_STARTS, 'start\n');

const TOOLS = [
  {
    name: 'echo',
    description: 'Says the text back',
    inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'save_note',
    description: 'Saves a note',
    inputSchema: { type: 'object', properties: { note: { type: 'string' } } },
  },
  { name: 'picture', description: 'An image', inputSchema: { type: 'object' } },
  { name: 'big', description: 'Lots of text', inputSchema: { type: 'object' } },
  { name: 'env', description: 'Reads FAKE_TOKEN', inputSchema: { type: 'object' } },
  { name: 'fail', description: 'Reports an error', inputSchema: { type: 'object' } },
  { name: 'crash', description: 'Exits', inputSchema: { type: 'object' } },
  {
    name: 'slow',
    description: 'Waits',
    inputSchema: { type: 'object', properties: { ms: { type: 'number' } } },
  },
];

function server() {
  const s = new Server({ name: 'fake', version: '1.0.0' }, { capabilities: { tools: {} } });
  s.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));
  s.setRequestHandler(CallToolRequestSchema, async (req) => {
    const args = req.params.arguments ?? {};
    switch (req.params.name) {
      case 'echo':
        return { content: [{ type: 'text', text: `echo: ${args.text}` }] };
      case 'save_note':
        return { content: [{ type: 'text', text: `saved ${args.note}` }] };
      case 'picture':
        return {
          content: [
            { type: 'text', text: 'Here it is' },
            { type: 'image', data: Buffer.alloc(300).toString('base64'), mimeType: 'image/png' },
          ],
        };
      case 'big':
        return { content: [{ type: 'text', text: 'x'.repeat(100_000) }] };
      case 'env':
        return { content: [{ type: 'text', text: `token is ${process.env.FAKE_TOKEN}` }] };
      case 'fail':
        return { isError: true, content: [{ type: 'text', text: 'it went wrong' }] };
      case 'crash':
        process.stderr.write('fake: crashing now\n');
        process.exit(1);
        break;
      case 'slow':
        await new Promise((r) => setTimeout(r, Number(args.ms ?? 1000)));
        return { content: [{ type: 'text', text: 'done waiting' }] };
      default:
        throw new Error(`no tool ${req.params.name}`);
    }
  });
  return s;
}

const httpAt = process.argv.indexOf('--http');
if (httpAt === -1) {
  await server().connect(new StdioServerTransport());
} else {
  // FAKE_OAUTH: also an OAuth authorization server that signs anyone in at once (PKCE checked).
  const oauth = { codes: new Map(), tokens: new Set(), refresh: new Map(), issued: 0 };
  const json = (res, status, body) =>
    res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
  const http = createServer(async (req, res) => {
    const base = `http://127.0.0.1:${http.address().port}`;
    const url = new URL(req.url, base);
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const text = Buffer.concat(chunks).toString('utf8');
    if (process.env.FAKE_OAUTH) {
      if (url.pathname.startsWith('/.well-known/oauth-protected-resource'))
        return json(res, 200, { resource: `${base}/mcp`, authorization_servers: [base] });
      if (url.pathname === '/.well-known/oauth-authorization-server')
        return json(res, 200, {
          issuer: base,
          authorization_endpoint: `${base}/authorize`,
          token_endpoint: `${base}/token`,
          registration_endpoint: `${base}/register`,
          response_types_supported: ['code'],
          code_challenge_methods_supported: ['S256'],
        });
      // Signs everyone out, as a server that revoked its tokens would.
      if (url.pathname === '/forget') {
        oauth.tokens.clear();
        oauth.refresh.clear();
        return json(res, 200, {});
      }
      if (url.pathname === '/register')
        return json(res, 201, { ...JSON.parse(text), client_id: `client-${Date.now()}` });
      if (url.pathname === '/authorize') {
        const code = `code-${Math.random().toString(36).slice(2)}`;
        oauth.codes.set(code, url.searchParams.get('code_challenge'));
        const back = new URL(url.searchParams.get('redirect_uri'));
        back.searchParams.set('code', code);
        back.searchParams.set('state', url.searchParams.get('state') ?? '');
        res.writeHead(302, { location: back.href }).end();
        return;
      }
      if (url.pathname === '/token') {
        const form = new URLSearchParams(text);
        const issue = () => {
          const access = `at-${++oauth.issued}`;
          const refresh = `rt-${oauth.issued}`;
          oauth.tokens.add(access);
          oauth.refresh.set(refresh, true);
          return json(res, 200, {
            access_token: access,
            token_type: 'Bearer',
            expires_in: 3600,
            refresh_token: refresh,
          });
        };
        if (form.get('grant_type') === 'authorization_code') {
          const challenge = oauth.codes.get(form.get('code'));
          const sent = createHash('sha256')
            .update(form.get('code_verifier') ?? '')
            .digest('base64url');
          if (!challenge || challenge !== sent) return json(res, 400, { error: 'invalid_grant' });
          oauth.codes.delete(form.get('code'));
          return issue();
        }
        if (
          form.get('grant_type') === 'refresh_token' &&
          oauth.refresh.has(form.get('refresh_token'))
        )
          return issue();
        return json(res, 400, { error: 'invalid_grant' });
      }
      const bearer = /^Bearer (.+)$/.exec(req.headers.authorization ?? '')?.[1];
      if (!bearer || !oauth.tokens.has(bearer)) {
        res
          .writeHead(401, {
            'www-authenticate': `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource/mcp"`,
          })
          .end('sign in');
        return;
      }
    }
    if (process.env.FAKE_AUTH && req.headers.authorization !== `Bearer ${process.env.FAKE_AUTH}`) {
      res.writeHead(401).end('no');
      return;
    }
    const body = text ? JSON.parse(text) : undefined;
    // Stateless: a server and transport per request.
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    await server().connect(transport);
    await transport.handleRequest(req, res, body);
  });
  http.listen(Number(process.argv[httpAt + 1] ?? 0), '127.0.0.1', () => {
    process.stdout.write(`listening ${http.address().port}\n`);
  });
}
