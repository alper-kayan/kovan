import { BILLING_CONSENT_VERSION } from '@kovan/shared';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { signWebhook } from './billing/stripe.js';
import { auth, oauthLogin, startHarness, type Harness } from './test/harness.js';

let h: Harness;
let provider: Server;
let stripe: Server;
let alice: { token: string; id: string };
let workspaceId: string;

/** What the fake Stripe saw, and whether the next card charge declines. */
const charges: { amount: number; offSession: string; idempotency: string }[] = [];
let decline = false;
const deletedCustomers: string[] = [];

const body = (req: IncomingMessage) =>
  new Promise<string>((resolve) => {
    let b = '';
    req.on('data', (c: Buffer) => (b += c.toString()));
    req.on('end', () => resolve(b));
  });

async function listen(server: Server): Promise<string> {
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

beforeAll(async () => {
  // A provider that streams a reply and reports its cost, like OpenRouter.
  provider = createServer((req, res) => {
    void body(req).then((raw) => {
      if (req.url === '/models') {
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ data: [{ id: 'openai/gpt-5.6-luna', name: 'Luna' }] }));
        return;
      }
      if (req.url?.startsWith('/generation')) {
        res.setHeader('content-type', 'application/json');
        res.end(
          JSON.stringify({
            data: {
              total_cost: 0.001,
              tokens_prompt: 50,
              tokens_completion: 5,
              model: 'slow/model',
            },
          }),
        );
        return;
      }
      const { model } = JSON.parse(raw) as { model: string };
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(
        `data: ${JSON.stringify({ id: `gen-${model}-${Date.now()}`, model, choices: [{ delta: { content: 'Hi' } }] })}\n\n`,
      );
      if (model === 'slow/model') return; // never finishes: the person stops it
      res.write(
        `data: ${JSON.stringify({ id: 'x', model, choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 20, cost: 0.2 } })}\n\n`,
      );
      res.end('data: [DONE]\n\n');
    });
  });
  // A Stripe that saves one card and charges it (or declines).
  stripe = createServer((req, res) => {
    void body(req).then((raw) => {
      res.setHeader('content-type', 'application/json');
      const params = new URLSearchParams(raw);
      const url = req.url ?? '';
      if (url === '/v1/customers') return res.end(JSON.stringify({ id: 'cus_1' }));
      if (url === '/v1/checkout/sessions')
        return res.end(
          JSON.stringify({
            id: 'cs_1',
            url: 'https://checkout.stripe.test/cs_1',
            customer: 'cus_1',
          }),
        );
      if (url.startsWith('/v1/checkout/sessions/cs_1'))
        return res.end(
          JSON.stringify({
            id: 'cs_1',
            customer: 'cus_1',
            mode: 'setup',
            setup_intent: { id: 'seti_1', payment_method: 'pm_1' },
          }),
        );
      if (url.startsWith('/v1/setup_intents/'))
        return res.end(JSON.stringify({ id: 'seti_1', payment_method: 'pm_1' }));
      if (url.startsWith('/v1/payment_methods/'))
        return res.end(JSON.stringify({ id: 'pm_1', card: { brand: 'visa', last4: '4242' } }));
      if (url.startsWith('/v1/customers/') && req.method === 'DELETE') {
        deletedCustomers.push(url.slice('/v1/customers/'.length));
        return res.end(JSON.stringify({ id: 'cus_1', deleted: true }));
      }
      if (url.startsWith('/v1/customers/')) return res.end('{}');
      if (url === '/v1/payment_intents') {
        charges.push({
          amount: Number(params.get('amount')),
          offSession: params.get('off_session') ?? '',
          idempotency: String(req.headers['idempotency-key'] ?? ''),
        });
        if (decline) {
          res.statusCode = 402;
          return res.end(
            JSON.stringify({
              error: {
                message: 'Your card was declined.',
                code: 'card_declined',
                payment_intent: { id: 'pi_bad' },
              },
            }),
          );
        }
        return res.end(
          JSON.stringify({
            id: `pi_${charges.length}`,
            status: 'succeeded',
            amount: Number(params.get('amount')),
            latest_charge: { receipt_url: `https://pay.stripe.test/r/${charges.length}` },
          }),
        );
      }
      res.statusCode = 404;
      res.end('{}');
    });
  });
  h = await startHarness({
    MANAGED_OPENROUTER_API_KEY: 'sk-managed',
    MANAGED_OPENROUTER_BASE_URL: await listen(provider),
    STRIPE_SECRET_KEY: 'sk_test_1',
    STRIPE_API_BASE: await listen(stripe),
    STRIPE_WEBHOOK_SECRET: 'whsec_1',
  });
  const r = await oauthLogin(h, 'github', 'alice', {
    providerUserId: '1',
    login: 'alice',
    name: 'alice',
  });
  alice = { token: r.token, id: r.user.id };
  const orgId = (await api('GET', '/api/me')).body.orgs[0].id;
  workspaceId = (await api('POST', '/api/workspaces', { orgId, name: 'lobby', repoUrl: null })).body
    .workspace.id;
});
afterAll(async () => {
  await settle();
  await h.close();
  provider.close();
  stripe.close();
});

async function api(method: string, url: string, payload?: object) {
  const res = await h.app.inject({
    method: method as 'GET',
    url,
    headers: auth(alice.token),
    ...(payload ? { payload } : {}),
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- loose JSON in tests
  return { status: res.statusCode, body: res.json() as Record<string, any> };
}

/** One managed model call from the desktop app, as its agent makes them. */
async function call(model = 'openai/gpt-5.6-luna', signal?: AbortSignal) {
  return fetch(`${h.baseUrl}/api/inference/v1/chat/completions`, {
    method: 'POST',
    headers: {
      ...auth(alice.token),
      'content-type': 'application/json',
      'x-kovan-run': 'conv-1',
      'x-kovan-run-label': encodeURIComponent('Fix the lobby race'),
      'x-kovan-workspace': workspaceId,
    },
    body: JSON.stringify({ model, stream: true, messages: [{ role: 'user', content: 'hi' }] }),
    ...(signal ? { signal } : {}),
  });
}

const state = async () => (await api('GET', '/api/billing')).body.billing;
const settle = () => new Promise((r) => setTimeout(r, 150));

describe('managed usage', () => {
  it('needs an allowance, consent and a card before anything goes out', async () => {
    let r = await call();
    expect(r.status).toBe(402);
    expect(((await r.json()) as { error: { message: string } }).error.message).toMatch(
      /choose an allowance and accept/,
    );

    // Neither a silent allowance nor a missing consent is accepted.
    expect(
      (
        await api('PUT', '/api/billing', {
          allowance: null,
          uncapped: false,
          consent: true,
          consentVersion: BILLING_CONSENT_VERSION,
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await api('PUT', '/api/billing', {
          allowance: 1,
          uncapped: false,
          consent: false,
          consentVersion: BILLING_CONSENT_VERSION,
        })
      ).status,
    ).toBe(400);
    await api('PUT', '/api/billing', {
      allowance: 1,
      uncapped: false,
      consent: true,
      consentVersion: BILLING_CONSENT_VERSION,
    });
    r = await call();
    expect(((await r.json()) as { error: { message: string } }).error.message).toMatch(
      /Add a payment method/,
    );

    // The card is entered on Stripe's page; coming back saves it.
    const { url } = (await api('POST', '/api/billing/setup')).body;
    expect(url).toBe('https://checkout.stripe.test/cs_1');
    const done = await h.app.inject({ method: 'GET', url: '/billing/done?session_id=cs_1' });
    expect(done.body).toContain('Card saved');
    expect(await state()).toMatchObject({
      ready: true,
      card: { brand: 'visa', last4: '4242' },
      allowance: 1,
    });
  });

  it('streams the reply through and bills provider cost × 1.05 once', async () => {
    const r = await call();
    expect(r.status).toBe(200);
    const text = await r.text();
    expect(text).toContain('"Hi"');
    // The app is shown what the person pays, not the provider's price.
    expect(text).toContain('"cost":0.21');
    await settle();
    const s = await state();
    expect(s.spent).toBeCloseTo(0.21, 10);
    expect(s.unbilled).toBeCloseTo(0.21, 10);
    expect(s.usage.byRun[0]).toMatchObject({
      key: 'conv-1',
      label: 'Fix the lobby race',
      calls: 1,
    });
    expect(s.usage.byWorkspace[0]).toMatchObject({ label: 'lobby' });
    // The usage page shows what the person pays.
    const usage = (await api('GET', '/api/usage')).body;
    expect(usage.total).toBeCloseTo(0.21, 10);
  });

  it('still bills the verified usage of a call that was stopped', async () => {
    const abort = new AbortController();
    const r = await call('slow/model', abort.signal);
    const reader = r.body!.getReader();
    await reader.read(); // the first chunk arrived; then the person stops the run
    abort.abort();
    await new Promise((r) => setTimeout(r, 1_400));
    const s = await state();
    expect(s.usage.byModel.find((m: { key: string }) => m.key === 'slow/model')?.cost).toBeCloseTo(
      0.00105,
      10,
    );
  });

  it('charges the day off-session, carrying small balances forward', async () => {
    // $0.21105 is under the $0.50 payment minimum: it carries forward, nothing is charged.
    expect((await state()).unbilled).toBeCloseTo(0.21105, 8);
    expect((await api('POST', '/api/billing/run-charges', { force: true })).body.invoices).toEqual(
      [],
    );
    expect(charges).toHaveLength(0);

    await call();
    await call();
    await settle();
    const made = (await api('POST', '/api/billing/run-charges', { force: true })).body.invoices;
    // 0.21 + 0.00105 + 0.21 + 0.21 of usage, charged as 63 cents.
    expect(made).toEqual([
      expect.objectContaining({ amount: 0.63, usage: 0.63105, status: 'paid' }),
    ]);
    expect(charges.at(-1)).toMatchObject({ amount: 63, offSession: 'true' });
    expect(charges.at(-1)!.idempotency).toMatch(/^kovan-invoice-.+-1$/);
    const s = await state();
    expect(s.unbilled).toBe(0);
    expect(s.invoices[0]).toMatchObject({
      status: 'paid',
      receiptUrl: 'https://pay.stripe.test/r/1',
    });
    // Today's charge ran: on schedule (no force), the next one waits for tomorrow.
    await call();
    await call();
    await call();
    await settle();
    expect((await api('POST', '/api/billing/run-charges', { force: false })).body.invoices).toEqual(
      [],
    );
  });

  it('stops at the allowance, and a reset keeps unpaid usage', async () => {
    // $1 allowance: $1.05105 spent so far (six calls and the stopped one).
    const r = await call();
    expect(r.status).toBe(402);
    expect(((await r.json()) as { error: { message: string } }).error.message).toMatch(
      /allowance is used up \(\$1\.\d+ of \$1\.00\)/,
    );
    const unbilled = (await state()).unbilled;
    // Raising (or resetting) it starts counting afresh; usage not yet charged stays.
    const s = (
      await api('PUT', '/api/billing', {
        allowance: 2,
        uncapped: false,
        consent: true,
        consentVersion: BILLING_CONSENT_VERSION,
      })
    ).body.billing;
    expect(s).toMatchObject({ ready: true, spent: 0 });
    expect(s.unbilled).toBeCloseTo(unbilled, 10);
  });

  it('pauses managed requests when a payment fails, until it is retried', async () => {
    await call(); // enough unbilled usage to pass the payment minimum
    await settle();
    decline = true;
    const [inv] = (await api('POST', '/api/billing/run-charges', { force: true })).body.invoices;
    expect(inv).toMatchObject({ status: 'failed', failureReason: 'Your card was declined.' });
    const r = await call();
    expect(r.status).toBe(402);
    expect(((await r.json()) as { error: { message: string } }).error.message).toMatch(
      /payment failed/,
    );
    expect((await state()).status).toBe('past_due');

    decline = false;
    const retried = (await api('POST', `/api/billing/invoices/${inv.id}/retry`)).body.invoice;
    expect(retried.status).toBe('paid');
    // A second attempt has its own idempotency key.
    expect(charges.at(-1)!.idempotency).toMatch(/-2$/);
    expect(await state()).toMatchObject({ status: 'ok', ready: true });
    expect((await call()).status).toBe(200);
  });

  it('accepts only signed webhooks', async () => {
    const event = JSON.stringify({
      type: 'payment_intent.succeeded',
      data: { object: { metadata: {} } },
    });
    const bad = await h.app.inject({
      method: 'POST',
      url: '/webhooks/stripe',
      headers: { 'content-type': 'application/json', 'stripe-signature': 't=1,v1=00' },
      payload: event,
    });
    expect(bad.statusCode).toBe(400);
    const good = await h.app.inject({
      method: 'POST',
      url: '/webhooks/stripe',
      headers: {
        'content-type': 'application/json',
        'stripe-signature': signWebhook(event, 'whsec_1'),
      },
      payload: event,
    });
    expect(good.statusCode).toBe(200);
  });

  it('removes the saved card at Stripe when the account is deleted', async () => {
    await call(); // used, not charged yet
    await settle();
    const plan = (await api('GET', '/api/me/deletion')).body.plan;
    expect(plan.blocker).toBeNull();
    expect(plan.unbilled).toBeGreaterThan(0);
    expect((await api('POST', '/api/me/delete', { confirm: true })).status).toBe(200);
    expect(deletedCustomers).toEqual(['cus_1']);
  });
});
