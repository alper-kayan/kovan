import { BillingSettingsSchema, billedFor } from '@kovan/shared';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { requireUser } from '../auth/guard.js';
import { getRole } from '../authz.js';
import type { AppContext } from '../context.js';
import { forbidden } from '../errors.js';
import type { BillingService, ManagedCall } from './service.js';
import { verifyWebhook } from './stripe.js';

const page = (title: string, text: string) =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title} · Kovan</title><style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#101010;color:#d8d8d8;font:15px/1.5 system-ui,sans-serif}main{max-width:420px;padding:24px;text-align:center}h1{font-size:20px;font-weight:600;color:#fff}</style></head><body><main><h1>${title}</h1><p>${text}</p></main></body></html>`;

/**
 * Reads a provider SSE stream as it passes: the generation id, the model and the usage. Lines
 * with usage go on with the billed cost (× 1.05) in place of the provider's, so the app shows
 * what the person actually pays.
 */
class UsageTap {
  private buffer = '';
  generationId: string | null = null;
  model: string | null = null;
  usage: { cost: number | null; prompt: number; completion: number } | null = null;

  /** Complete lines out (rewritten where needed); a partial line waits for the rest. */
  push(chunk: string): string {
    this.buffer += chunk;
    let out = '';
    let at: number;
    while ((at = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.slice(0, at + 1);
      this.buffer = this.buffer.slice(at + 1);
      out += this.line(line);
    }
    return out;
  }

  /** Whatever was left without a final newline. */
  flush(): string {
    const rest = this.buffer;
    this.buffer = '';
    return rest ? this.line(rest) : '';
  }

  private line(line: string): string {
    const trimmed = line.trim();
    if (!trimmed.startsWith('data:')) return line;
    const data = trimmed.slice(5).trim();
    if (data === '[DONE]') return line;
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(data) as Record<string, unknown>;
    } catch {
      return line; // comments and keep-alives aren't JSON
    }
    this.read(event);
    const usage = event['usage'] as Record<string, unknown> | undefined;
    if (!usage || typeof usage['cost'] !== 'number') return line;
    return `data: ${JSON.stringify({ ...event, usage: { ...usage, cost: billedFor(usage['cost']) } })}\n`;
  }

  read(event: Record<string, unknown>): void {
    if (typeof event['id'] === 'string') this.generationId ??= event['id'];
    if (typeof event['model'] === 'string') this.model = event['model'];
    const u = event['usage'] as Record<string, unknown> | undefined;
    if (u)
      this.usage = {
        cost: typeof u['cost'] === 'number' ? u['cost'] : null,
        prompt: Number(u['prompt_tokens'] ?? 0),
        completion: Number(u['completion_tokens'] ?? 0),
      };
  }
}

export function registerBillingRoutes(app: FastifyInstance, ctx: AppContext): void {
  const { billing, config } = ctx;
  const upstream = config.MANAGED_OPENROUTER_BASE_URL.replace(/\/$/, '');
  const providerHeaders = () => ({
    authorization: `Bearer ${config.MANAGED_OPENROUTER_API_KEY}`,
    'content-type': 'application/json',
    'x-title': 'Kovan',
    'http-referer': config.PUBLIC_URL,
  });

  // ---------- the account ----------

  app.get('/api/billing', async (req) => {
    const user = await requireUser(ctx, req);
    return { billing: await billing.state(user.id) };
  });

  app.put('/api/billing', async (req) => {
    const user = await requireUser(ctx, req);
    const input = BillingSettingsSchema.parse(req.body);
    const state = await billing.configure(user.id, input);
    await ctx.audit.record({ actor: user, action: 'billing.settings_changed', req });
    return { billing: state };
  });

  app.post('/api/billing/setup', async (req) => {
    const user = await requireUser(ctx, req);
    await ctx.audit.record({ actor: user, action: 'billing.card_setup_started', req });
    return billing.startSetup(user.id);
  });

  app.post('/api/billing/invoices/:id/retry', async (req) => {
    const user = await requireUser(ctx, req);
    const { id } = z.object({ id: z.string() }).parse(req.params);
    await ctx.audit.record({ actor: user, action: 'billing.payment_retried', req });
    return { invoice: await billing.retry(user.id, id) };
  });

  // The daily charge on demand, for development and test mode only.
  app.post('/api/billing/run-charges', async (req) => {
    await requireUser(ctx, req);
    if (config.NODE_ENV === 'production') throw forbidden('Charges run on their own schedule');
    const { force } = z.object({ force: z.boolean().default(true) }).parse(req.body ?? {});
    return { invoices: await billing.chargeDue(new Date(), force) };
  });

  app.get('/billing/done', async (req, reply) => {
    const { session_id: id } = z.object({ session_id: z.string().max(200) }).parse(req.query);
    try {
      await billing.completeCheckout(id);
      return reply
        .type('text/html')
        .send(
          page(
            'Card saved',
            'You can close this tab and go back to Kovan. Managed usage is ready once your allowance is set.',
          ),
        );
    } catch {
      return reply
        .code(400)
        .type('text/html')
        .send(
          page('Something went wrong', 'The card was not saved. Go back to Kovan and try again.'),
        );
    }
  });

  app.get('/billing/cancelled', async (_req, reply) =>
    reply.type('text/html').send(page('No card saved', 'Nothing changed. You can close this tab.')),
  );

  // Stripe signs webhooks over the raw body, so this route keeps it as text.
  void app.register(async (scope) => {
    scope.addContentTypeParser('application/json', { parseAs: 'string' }, (_req, body, done) =>
      done(null, body),
    );
    scope.post('/webhooks/stripe', async (req, reply) => {
      const raw = String(req.body ?? '');
      const signature = String(req.headers['stripe-signature'] ?? '');
      if (
        !config.STRIPE_WEBHOOK_SECRET ||
        !verifyWebhook(raw, signature, config.STRIPE_WEBHOOK_SECRET)
      )
        return reply.code(400).send({ error: 'bad signature' });
      await billing.handleEvent(JSON.parse(raw) as Parameters<BillingService['handleEvent']>[0]);
      return { received: true };
    });
  });

  // ---------- the managed model endpoint (OpenAI-compatible) ----------

  let catalog: { at: number; body: unknown } | null = null;
  app.get('/api/inference/v1/models', async (req, reply) => {
    await requireUser(ctx, req);
    if (!config.managedEnabled)
      return reply
        .code(503)
        .send({ error: { message: "This server doesn't offer managed usage." } });
    if (!catalog || Date.now() - catalog.at > 3_600_000) {
      const res = await fetch(`${upstream}/models`, { headers: providerHeaders() });
      if (!res.ok)
        return reply.code(502).send({ error: { message: `The provider answered ${res.status}` } });
      catalog = { at: Date.now(), body: await res.json() };
    }
    return catalog.body;
  });

  app.post('/api/inference/v1/chat/completions', async (req, reply) => {
    const user = await requireUser(ctx, req);
    await billing.gate(user.id);
    const body = (req.body ?? {}) as Record<string, unknown>;
    if (typeof body['model'] !== 'string')
      return reply.code(400).send({ error: { message: 'model is required' } });
    // Usage is always asked for: it is what gets billed.
    body['usage'] = { include: true };
    const runId = String(req.headers['x-kovan-run'] ?? 'unknown').slice(0, 200);
    let runLabel: string | null = null;
    try {
      runLabel =
        decodeURIComponent(String(req.headers['x-kovan-run-label'] ?? '')).slice(0, 200) || null;
    } catch {
      runLabel = null;
    }
    const wanted = String(req.headers['x-kovan-workspace'] ?? '');
    // Usage is only filed under a workspace the person belongs to.
    const workspaceId =
      /^[0-9a-f-]{36}$/i.test(wanted) && (await getRole(ctx.db, wanted, user.id)) ? wanted : null;

    const abort = new AbortController();
    // The app went away mid-answer (the person stopped the run): stop the provider too.
    reply.raw.on('close', () => {
      if (!reply.raw.writableFinished) abort.abort();
    });
    let res: Response;
    try {
      res = await fetch(`${upstream}/chat/completions`, {
        method: 'POST',
        headers: providerHeaders(),
        body: JSON.stringify(body),
        signal: abort.signal,
      });
    } catch {
      return reply.code(502).send({ error: { message: "The model provider can't be reached" } });
    }
    const tap = new UsageTap();
    const file = (aborted: boolean) =>
      void settle(
        billing,
        user.id,
        tap,
        { workspaceId, runId, runLabel, model: body['model'] as string },
        aborted,
        (id) =>
          fetch(`${upstream}/generation?id=${encodeURIComponent(id)}`, {
            headers: providerHeaders(),
          }),
      );

    if (!res.ok || !res.body) {
      const text = await res.text().catch(() => '');
      return reply
        .code(res.status)
        .type('application/json')
        .send(text || '{}');
    }
    if (body['stream'] !== true) {
      const json = (await res.json()) as Record<string, unknown>;
      tap.read(json);
      file(false);
      const usage = json['usage'] as Record<string, unknown> | undefined;
      if (usage && typeof usage['cost'] === 'number')
        json['usage'] = { ...usage, cost: billedFor(usage['cost']) };
      return json;
    }
    return pipe(reply, res, tap, abort, file);
  });
}

async function pipe(
  reply: FastifyReply,
  res: Response,
  tap: UsageTap,
  abort: AbortController,
  file: (aborted: boolean) => void,
): Promise<void> {
  reply.hijack();
  reply.raw.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  });
  const decoder = new TextDecoder();
  try {
    for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
      const out = tap.push(decoder.decode(chunk, { stream: true }));
      if (out) reply.raw.write(out);
    }
    reply.raw.end(tap.flush());
    file(false);
  } catch {
    // The person stopped the run: what the provider already did is still billed.
    file(abort.signal.aborted);
    if (!reply.raw.writableEnded) reply.raw.end();
  }
}

/**
 * Bills a call from the usage the provider reported. A call cut off before its usage arrived is
 * looked up afterwards by its generation id, so a cancelled run still pays its verified usage.
 */
async function settle(
  billing: BillingService,
  userId: string,
  tap: UsageTap,
  call: Pick<ManagedCall, 'workspaceId' | 'runId' | 'runLabel' | 'model'>,
  aborted: boolean,
  lookup: (generationId: string) => Promise<Response>,
): Promise<void> {
  try {
    if (tap.usage?.cost !== null && tap.usage?.cost !== undefined && !aborted) {
      await billing.record(userId, {
        ...call,
        model: tap.model ?? call.model,
        generationId: tap.generationId,
        promptTokens: tap.usage.prompt,
        completionTokens: tap.usage.completion,
        providerCost: tap.usage.cost,
      });
      return;
    }
    if (!tap.generationId) return;
    for (const wait of [1_000, 4_000, 15_000]) {
      await new Promise((r) => setTimeout(r, wait));
      const res = await lookup(tap.generationId).catch(() => null);
      if (!res?.ok) continue;
      const { data } = (await res.json()) as {
        data?: {
          total_cost?: number;
          tokens_prompt?: number;
          tokens_completion?: number;
          model?: string;
        };
      };
      if (typeof data?.total_cost !== 'number') continue;
      await billing.record(userId, {
        ...call,
        model: data.model ?? tap.model ?? call.model,
        generationId: tap.generationId,
        promptTokens: data.tokens_prompt ?? 0,
        completionTokens: data.tokens_completion ?? 0,
        providerCost: data.total_cost,
      });
      return;
    }
    console.warn(`Managed call ${tap.generationId} could not be priced; not billed.`);
  } catch (error) {
    console.warn('Could not file managed usage:', error);
  }
}
