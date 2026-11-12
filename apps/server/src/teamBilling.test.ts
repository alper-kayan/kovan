import { TEAM_BILLING_CONSENT_VERSION } from '@kovan/shared';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { auth, oauthLogin, startHarness, type Harness } from './test/harness.js';

let h: Harness;
let provider: Server;
let stripe: Server;
let selin: { token: string; id: string };
let ece: { token: string; id: string };
let orgId: string;
let shop: string;
const charges: { amount: number; customer: string }[] = [];

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
  // Every call costs the provider $0.20: $0.21 billed.
  provider = createServer((req, res) => {
    void body(req).then((raw) => {
      const { model } = JSON.parse(raw || '{}') as { model?: string };
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(
        `data: ${JSON.stringify({ id: `gen-${Math.random()}`, model, choices: [{ delta: { content: 'Hi' } }] })}\n\n`,
      );
      res.write(
        `data: ${JSON.stringify({ id: 'x', model, choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 20, cost: 0.2 } })}\n\n`,
      );
      res.end('data: [DONE]\n\n');
    });
  });
  let customers = 0;
  stripe = createServer((req, res) => {
    void body(req).then((raw) => {
      res.setHeader('content-type', 'application/json');
      const params = new URLSearchParams(raw);
      const url = req.url ?? '';
      if (url === '/v1/customers') return res.end(JSON.stringify({ id: `cus_${++customers}` }));
      if (url === '/v1/checkout/sessions') {
        const customer = params.get('customer')!;
        return res.end(
          JSON.stringify({
            id: `cs_${customer}`,
            url: `https://checkout.stripe.test/${customer}`,
            customer,
          }),
        );
      }
      if (url.startsWith('/v1/checkout/sessions/cs_')) {
        const customer = url.slice('/v1/checkout/sessions/cs_'.length).split('?')[0];
        return res.end(
          JSON.stringify({
            id: `cs_${customer}`,
            customer,
            mode: 'setup',
            setup_intent: { id: 'seti_1', payment_method: 'pm_1' },
          }),
        );
      }
      if (url.startsWith('/v1/setup_intents/'))
        return res.end(JSON.stringify({ id: 'seti_1', payment_method: 'pm_1' }));
      if (url.startsWith('/v1/payment_methods/'))
        return res.end(JSON.stringify({ id: 'pm_1', card: { brand: 'visa', last4: '4242' } }));
      if (url.startsWith('/v1/customers/')) return res.end('{}');
      if (url === '/v1/payment_intents') {
        charges.push({ amount: Number(params.get('amount')), customer: params.get('customer')! });
        return res.end(
          JSON.stringify({
            id: `pi_${charges.length}`,
            status: 'succeeded',
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
  const s = await oauthLogin(h, 'github', 'selin', {
    providerUserId: '1',
    login: 'selin',
    name: 'Selin',
    email: 'selin@example.com',
  });
  selin = { token: s.token, id: s.user.id };
  const e = await oauthLogin(h, 'github', 'ece', {
    providerUserId: '2',
    login: 'ece',
    name: 'Ece',
    email: 'ece@example.com',
  });
  ece = { token: e.token, id: e.user.id };
  orgId = (await api(selin, 'GET', '/api/me')).body.orgs[0].id;
  shop = (await api(selin, 'POST', '/api/workspaces', { orgId, name: 'shop', repoUrl: null })).body
    .workspace.id;
  await api(selin, 'PATCH', `/api/workspaces/${shop}`, { mode: 'team' });
  await api(selin, 'POST', `/api/workspaces/${shop}/invites`, {
    githubLogin: 'ece',
    role: 'editor',
  });
});
afterAll(async () => {
  await new Promise((r) => setTimeout(r, 150));
  await h.close();
  provider.close();
  stripe.close();
});

async function api(who: { token: string }, method: string, url: string, payload?: object) {
  const res = await h.app.inject({
    method: method as 'GET',
    url,
    headers: auth(who.token),
    ...(payload ? { payload } : {}),
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- loose JSON in tests
  return { status: res.statusCode, body: res.json() as Record<string, any> };
}

/** One managed model call, as the desktop's agent makes them, in a workspace (or none). */
async function call(who: { token: string }, workspaceId: string | null) {
  const res = await fetch(`${h.baseUrl}/api/inference/v1/chat/completions`, {
    method: 'POST',
    headers: {
      ...auth(who.token),
      'content-type': 'application/json',
      'x-kovan-run': 'conv-1',
      ...(workspaceId ? { 'x-kovan-workspace': workspaceId } : {}),
    },
    body: JSON.stringify({ model: 'openai/luna', stream: true, messages: [] }),
  });
  const text = await res.text();
  await new Promise((r) => setTimeout(r, 60)); // the usage is filed once the stream ends
  return { status: res.status, text };
}

const mailTo = (to: string) => h.mailer.sent.filter((m) => m.to === to);

describe('an organization that pays for its members', () => {
  it('is turned on by an owner only, with limits and a card of its own', async () => {
    // Before: Ece has nothing of her own set up, so nothing goes out for her.
    const before = await call(ece, shop);
    expect(before.status).toBe(402);
    expect(before.text).toMatch(/Set up Kovan billing/);

    const settings = {
      monthlyCap: 1,
      memberLimit: 0.3,
      consent: true,
      consentVersion: TEAM_BILLING_CONSENT_VERSION,
      company: {
        name: 'Shop Ltd',
        address: 'Main St 1',
        taxId: 'TR123',
        email: 'billing@shop.example',
      },
    };
    // A member who isn't an owner can't turn it on, or see it.
    expect((await api(ece, 'PUT', `/api/orgs/${orgId}/billing`, settings)).status).toBe(403);
    const on = await api(selin, 'PUT', `/api/orgs/${orgId}/billing`, settings);
    expect(on.body.billing).toMatchObject({
      enabled: true,
      ready: false,
      reason: 'Add a card for the organization.',
      company: { name: 'Shop Ltd', taxId: 'TR123' },
    });
    const { url } = (await api(selin, 'POST', `/api/orgs/${orgId}/billing/setup`)).body;
    const customer = new URL(url).pathname.slice(1);
    const done = await h.app.inject({
      method: 'GET',
      url: `/billing/done?session_id=cs_${customer}`,
    });
    expect(done.body).toContain('the organization can pay for its members now');
    expect((await api(selin, 'GET', `/api/orgs/${orgId}/billing`)).body.billing).toMatchObject({
      ready: true,
      card: { last4: '4242' },
    });
  });

  it('pays for Ece in its workspace, up to her monthly limit, and tells her once', async () => {
    expect((await call(ece, shop)).status).toBe(200);
    const mine = (await api(ece, 'GET', '/api/billing')).body.billing;
    expect(mine.teams).toEqual([
      expect.objectContaining({ orgName: expect.any(String), ready: true, limit: 0.3 }),
    ]);
    expect(mine.teams[0].spent).toBeCloseTo(0.21, 10);
    // Her own billing is untouched: the organization paid.
    expect(mine.spent).toBe(0);

    expect((await call(ece, shop)).status).toBe(200); // $0.21 < $0.30: one more goes
    const stopped = await call(ece, shop);
    expect(stopped.status).toBe(402);
    expect(stopped.text).toMatch(/Your monthly limit in .+ \(\$0\.3000\) is used up/);
    expect(mailTo('ece@example.com').filter((m) => /limit in/.test(m.subject))).toHaveLength(1);
    await call(ece, shop);
    expect(mailTo('ece@example.com').filter((m) => /limit in/.test(m.subject))).toHaveLength(1);

    // Outside its workspaces, it doesn't pay.
    expect((await call(ece, null)).text).toMatch(/Set up Kovan billing/);
  });

  it('shows the owner who spent what this month, and lets them change one member’s limit', async () => {
    const team = (await api(selin, 'GET', `/api/orgs/${orgId}/billing`)).body.billing;
    const row = team.byMember.find((m: { userId: string }) => m.userId === ece.id);
    expect(row).toMatchObject({ limit: 0.3, own: false });
    expect(row.spent).toBeCloseTo(0.42, 10);
    expect(team.spent).toBeCloseTo(0.42, 10);
    expect(team.projected).toBeGreaterThanOrEqual(team.spent);
    expect(team.byWorkspace[0]).toMatchObject({ label: 'shop', calls: 2 });
    expect((await api(ece, 'GET', `/api/orgs/${orgId}/billing`)).status).toBe(403);

    const raised = await api(selin, 'PUT', `/api/orgs/${orgId}/billing/members/${ece.id}`, {
      monthlyLimit: 5,
    });
    expect(
      raised.body.billing.byMember.find((m: { userId: string }) => m.userId === ece.id),
    ).toMatchObject({
      limit: 5,
      own: true,
    });
    expect((await call(ece, shop)).status).toBe(200);
  });

  it('stops everyone at the organization’s cap, and tells its owners', async () => {
    // $1 cap: $0.63 spent; two more calls reach it.
    await call(ece, shop);
    await call(ece, shop);
    const stopped = await call(selin, shop);
    expect(stopped.status).toBe(402);
    expect(stopped.text).toMatch(/monthly limit for models \(\$1\.00\) is used up/);
    expect(
      mailTo('selin@example.com').filter((m) => /limit for this month is used up/.test(m.subject)),
    ).toHaveLength(1);
  });

  it('charges the organization once, as one invoice with its receipt to the billing email', async () => {
    const made = (await api(selin, 'POST', '/api/billing/run-charges', { force: true })).body
      .invoices;
    expect(made).toHaveLength(1);
    expect(made[0]).toMatchObject({
      status: 'paid',
      period: expect.stringMatching(/^\d{4}-\d{2}$/),
    });
    expect(made[0].usage).toBeCloseTo(1.05, 6);
    expect(charges).toHaveLength(1);
    const team = (await api(selin, 'GET', `/api/orgs/${orgId}/billing`)).body.billing;
    expect(team.invoices).toHaveLength(1);
    // Ece's own invoices stay empty: the organization paid.
    expect((await api(ece, 'GET', '/api/billing')).body.billing.invoices).toEqual([]);
    expect(mailTo('billing@shop.example').filter((m) => /receipt/i.test(m.subject))).toHaveLength(
      1,
    );
  });
});
