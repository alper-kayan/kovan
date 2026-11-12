import { createHmac, timingSafeEqual } from 'node:crypto';

export class StripeError extends Error {
  constructor(
    message: string,
    readonly status: number,
    /** Stripe's error code ("card_declined", "authentication_required"…). */
    readonly code: string | null,
    /** The payment intent a failed charge left behind, when there is one. */
    readonly paymentIntentId: string | null = null,
  ) {
    super(message);
    this.name = 'StripeError';
  }
}

interface Params {
  [key: string]: string | number | boolean | undefined | Params | string[];
}

/** Stripe's form encoding: nested keys as a[b][c], arrays as a[]. */
function encode(params: Params, prefix = ''): string[] {
  const out: string[] = [];
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined) continue;
    const name = prefix ? `${prefix}[${key}]` : key;
    if (Array.isArray(value))
      for (const v of value)
        out.push(`${encodeURIComponent(`${name}[]`)}=${encodeURIComponent(v)}`);
    else if (typeof value === 'object') out.push(...encode(value, name));
    else out.push(`${encodeURIComponent(name)}=${encodeURIComponent(String(value))}`);
  }
  return out;
}

export interface CheckoutSession {
  id: string;
  url: string | null;
  customer: string | null;
  setup_intent: string | { id: string; payment_method: string | null } | null;
  metadata?: Record<string, string>;
}

export interface PaymentIntent {
  id: string;
  status: string;
  amount: number;
  latest_charge?: string | { receipt_url?: string | null } | null;
  last_payment_error?: { message?: string; code?: string } | null;
  metadata?: Record<string, string>;
}

/**
 * The few Stripe calls managed usage needs, over plain HTTPS: customers, Checkout in setup mode
 * (the card is entered on Stripe's page; Kovan never sees it), off-session payment intents and
 * webhook signatures.
 */
export class StripeClient {
  constructor(
    private readonly secretKey: string,
    private readonly base = 'https://api.stripe.com',
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  private async call<T>(
    method: 'GET' | 'POST' | 'DELETE',
    path: string,
    params: Params = {},
    idempotencyKey?: string,
  ): Promise<T> {
    const body = encode(params).join('&');
    const url = method === 'GET' && body ? `${this.base}${path}?${body}` : `${this.base}${path}`;
    const res = await this.fetchImpl(url, {
      method,
      headers: {
        authorization: `Bearer ${this.secretKey}`,
        ...(method === 'POST' ? { 'content-type': 'application/x-www-form-urlencoded' } : {}),
        ...(idempotencyKey ? { 'idempotency-key': idempotencyKey } : {}),
        'stripe-version': '2024-06-20',
      },
      ...(method === 'POST' ? { body } : {}),
      signal: AbortSignal.timeout(30_000),
    });
    const data = (await res.json().catch(() => ({}))) as {
      error?: { message?: string; code?: string; payment_intent?: { id?: string } };
    } & T;
    if (!res.ok)
      throw new StripeError(
        data.error?.message ?? `Stripe answered ${res.status}`,
        res.status,
        data.error?.code ?? null,
        data.error?.payment_intent?.id ?? null,
      );
    return data;
  }

  /** Removes the customer and its saved cards (a deleted Kovan account). */
  deleteCustomer(id: string) {
    return this.call<{ id: string; deleted: boolean }>(
      'DELETE',
      `/v1/customers/${encodeURIComponent(id)}`,
    );
  }

  /**
   * A customer for a person, or for an organization (the company's name, address and tax id
   * then go on its receipts and invoices).
   */
  createCustomer(input: {
    email: string | null;
    name: string;
    userId: string;
    orgId?: string;
    address?: string | null;
    taxId?: string | null;
  }) {
    return this.call<{ id: string }>('POST', '/v1/customers', {
      ...(input.email ? { email: input.email } : {}),
      name: input.name,
      ...(input.address ? { address: { line1: input.address.split('\n')[0]!.slice(0, 200) } } : {}),
      metadata: {
        kovan_user_id: input.userId,
        ...(input.orgId ? { kovan_org_id: input.orgId } : {}),
        ...(input.taxId ? { tax_id: input.taxId } : {}),
      },
    });
  }

  /** A Stripe-hosted page where the person saves a card for later off-session charges. */
  createSetupCheckout(input: {
    customer: string;
    successUrl: string;
    cancelUrl: string;
    userId: string;
  }) {
    return this.call<CheckoutSession>('POST', '/v1/checkout/sessions', {
      mode: 'setup',
      customer: input.customer,
      currency: 'usd',
      payment_method_types: ['card'],
      success_url: input.successUrl,
      cancel_url: input.cancelUrl,
      metadata: { kovan_user_id: input.userId },
      setup_intent_data: { metadata: { kovan_user_id: input.userId } },
    });
  }

  getCheckout(id: string) {
    return this.call<CheckoutSession>('GET', `/v1/checkout/sessions/${encodeURIComponent(id)}`, {
      expand: ['setup_intent'],
    });
  }

  getSetupIntent(id: string) {
    return this.call<{ id: string; payment_method: string | null; customer: string | null }>(
      'GET',
      `/v1/setup_intents/${encodeURIComponent(id)}`,
    );
  }

  getPaymentMethod(id: string) {
    return this.call<{ id: string; card?: { brand?: string; last4?: string } }>(
      'GET',
      `/v1/payment_methods/${encodeURIComponent(id)}`,
    );
  }

  setDefaultPaymentMethod(customer: string, paymentMethod: string) {
    return this.call('POST', `/v1/customers/${encodeURIComponent(customer)}`, {
      invoice_settings: { default_payment_method: paymentMethod },
    });
  }

  /** Charges a saved card while the person is away. Declines throw a StripeError. */
  chargeOffSession(input: {
    customer: string;
    paymentMethod: string;
    amountCents: number;
    invoiceId: string;
    attempt: number;
    description: string;
  }) {
    return this.call<PaymentIntent>(
      'POST',
      '/v1/payment_intents',
      {
        amount: input.amountCents,
        currency: 'usd',
        customer: input.customer,
        payment_method: input.paymentMethod,
        off_session: true,
        confirm: true,
        description: input.description,
        metadata: { kovan_invoice_id: input.invoiceId },
        expand: ['latest_charge'],
      },
      // A retried request never charges twice.
      `kovan-invoice-${input.invoiceId}-${input.attempt}`,
    );
  }
}

/**
 * Checks a webhook's Stripe-Signature header ("t=…,v1=…") against the raw body. Rejects
 * signatures older than five minutes.
 */
export function verifyWebhook(
  payload: string,
  header: string,
  secret: string,
  now = Date.now(),
): boolean {
  const parts = Object.fromEntries(
    header.split(',').map((p) => {
      const at = p.indexOf('=');
      return [p.slice(0, at).trim(), p.slice(at + 1).trim()];
    }),
  ) as Record<string, string>;
  const t = Number(parts['t']);
  const v1 = parts['v1'];
  if (!t || !v1 || Math.abs(now / 1000 - t) > 300) return false;
  const expected = createHmac('sha256', secret).update(`${t}.${payload}`).digest('hex');
  const a = Buffer.from(expected);
  const b = Buffer.from(v1);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Signs a payload the way Stripe does (for tests and local tools). */
export function signWebhook(payload: string, secret: string, now = Date.now()): string {
  const t = Math.floor(now / 1000);
  return `t=${t},v1=${createHmac('sha256', secret).update(`${t}.${payload}`).digest('hex')}`;
}
