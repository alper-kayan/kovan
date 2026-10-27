import { billedFor, type BillingState, type Invoice, type UsageLine } from '@kovan/shared';
import { and, desc, eq, gte, isNull, lte, sql } from 'drizzle-orm';
import type { Config } from '../config.js';
import type { Db } from '../db/client.js';
import {
  billingAccounts,
  invoices,
  managedUsage,
  usageRecords,
  users,
  workspaces,
} from '../db/schema.js';
import { conflict, HttpError, notFound } from '../errors.js';
import { StripeError, type StripeClient } from './stripe.js';

type Account = typeof billingAccounts.$inferSelect;
type InvoiceRow = typeof invoices.$inferSelect;

const money = (n: number) => `$${n.toFixed(n < 1 ? 4 : 2)}`;

export interface ManagedCall {
  workspaceId: string | null;
  runId: string;
  runLabel: string | null;
  model: string;
  generationId: string | null;
  promptTokens: number;
  completionTokens: number;
  /** USD the provider charged for the call. */
  providerCost: number;
}

/** A managed request was refused, with the reason the person sees in their agent. */
export class PaymentRequired extends HttpError {
  constructor(message: string) {
    super(402, 'payment_required', message);
  }
}

/**
 * Managed usage billing. The person who starts a run pays for every model call in it (delegated
 * agents and routing included) at provider cost × 1.05, applied once. Nothing goes out before
 * they choose an allowance (or explicitly unlimited), accept the usage terms and save a card.
 * Once a day, unbilled usage is charged off-session; balances under the payment minimum carry
 * forward. A failed payment pauses new managed requests until it is retried or the card changes.
 */
export class BillingService {
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly db: Db,
    private readonly config: Config,
    private readonly stripe: StripeClient | null,
  ) {}

  start(): void {
    if (this.config.NODE_ENV === 'test' || !this.stripe) return;
    // Hourly look; the charge itself runs once a day per person, at the configured hour.
    this.timer = setInterval(() => {
      if (new Date().getUTCHours() === this.config.BILLING_CHARGE_HOUR_UTC)
        void this.chargeDue().catch((error: unknown) => console.warn('Billing:', error));
    }, 3_600_000);
    this.timer.unref();
  }

  close(): void {
    if (this.timer) clearInterval(this.timer);
  }

  private async account(userId: string): Promise<Account | null> {
    const [row] = await this.db
      .select()
      .from(billingAccounts)
      .where(eq(billingAccounts.userId, userId));
    return row ?? null;
  }

  private async ensureAccount(userId: string): Promise<Account> {
    await this.db.insert(billingAccounts).values({ userId }).onConflictDoNothing();
    return (await this.account(userId))!;
  }

  private async spentSince(userId: string, since: Date): Promise<number> {
    const [r] = await this.db
      .select({ s: sql<number>`coalesce(sum(${managedUsage.billed}), 0)`.mapWith(Number) })
      .from(managedUsage)
      .where(and(eq(managedUsage.userId, userId), gte(managedUsage.createdAt, since)));
    return r?.s ?? 0;
  }

  private async unbilled(userId: string): Promise<number> {
    const [r] = await this.db
      .select({ s: sql<number>`coalesce(sum(${managedUsage.billed}), 0)`.mapWith(Number) })
      .from(managedUsage)
      .where(and(eq(managedUsage.userId, userId), isNull(managedUsage.invoiceId)));
    return r?.s ?? 0;
  }

  /** Why managed requests can't go out for this person right now, or null. */
  async blocker(userId: string): Promise<string | null> {
    if (!this.config.managedEnabled) return "This Kovan server doesn't offer managed usage.";
    const a = await this.account(userId);
    if (!a?.consentAt || (!a.uncapped && a.allowance === null))
      return 'Set up managed usage in Settings → Billing: choose an allowance and accept the usage terms.';
    if (!a.paymentMethodId)
      return 'Add a payment method in Settings → Billing to use managed usage.';
    if (a.status === 'past_due')
      return 'A payment failed, so managed requests are paused. Update your card or retry the payment in Settings → Billing.';
    if (!a.uncapped && a.allowance !== null) {
      const spent = await this.spentSince(userId, a.allowanceSince);
      if (spent >= a.allowance)
        return `Your managed usage allowance is used up (${money(spent)} of ${money(a.allowance)}). Raise or reset it in Settings → Billing.`;
    }
    return null;
  }

  /**
   * Before an account is deleted: why it can't be yet (a charge that failed and is still owed),
   * and what was used but not charged (it is not charged once the account is gone).
   */
  async beforeDeletion(userId: string): Promise<{ blocker: string | null; unbilled: number }> {
    const a = await this.account(userId);
    const [failed] = await this.db
      .select({ id: invoices.id })
      .from(invoices)
      .where(and(eq(invoices.userId, userId), eq(invoices.status, 'failed')));
    const blocker =
      a?.status === 'past_due' || failed
        ? 'A payment for managed usage failed and is still owed. Retry it or update your card in Settings → Billing on the desktop, then delete the account.'
        : null;
    return { blocker, unbilled: await this.unbilled(userId) };
  }

  /** The account is being deleted: its Stripe customer and saved cards go too. */
  async forget(userId: string): Promise<void> {
    const a = await this.account(userId);
    if (!a?.stripeCustomerId || !this.stripe) return;
    await this.stripe.deleteCustomer(a.stripeCustomerId).catch((error: unknown) => {
      // Already gone at Stripe is fine; anything else is logged, the deletion still goes on.
      if (!(error instanceof StripeError && error.status === 404))
        console.warn('Billing: could not delete the Stripe customer:', error);
    });
  }

  async gate(userId: string): Promise<void> {
    const reason = await this.blocker(userId);
    if (reason) throw new PaymentRequired(reason);
  }

  private toInvoice(r: InvoiceRow): Invoice {
    return {
      id: r.id,
      amount: r.amountCents / 100,
      usage: r.usage,
      status: r.status,
      receiptUrl: r.receiptUrl,
      failureReason: r.failureReason,
      createdAt: r.createdAt.toISOString(),
      paidAt: r.paidAt?.toISOString() ?? null,
    };
  }

  async state(userId: string): Promise<BillingState> {
    const a = await this.account(userId);
    const since = new Date(Date.now() - 30 * 86_400_000);
    const mine = and(eq(managedUsage.userId, userId), gte(managedUsage.createdAt, since));
    const line = (
      key: string | null,
      label: string | null,
      cost: number,
      calls: number,
    ): UsageLine => ({
      key: key ?? 'none',
      label: label ?? 'Personal',
      cost,
      calls,
    });
    const byRun = await this.db
      .select({
        key: managedUsage.runId,
        label: sql<string | null>`max(${managedUsage.runLabel})`,
        cost: sql<number>`sum(${managedUsage.billed})`.mapWith(Number),
        calls: sql<number>`count(*)::int`,
        last: sql<Date>`max(${managedUsage.createdAt})`,
      })
      .from(managedUsage)
      .where(mine)
      .groupBy(managedUsage.runId)
      .orderBy(sql`max(${managedUsage.createdAt}) desc`)
      .limit(20);
    const byModel = await this.db
      .select({
        key: managedUsage.model,
        cost: sql<number>`sum(${managedUsage.billed})`.mapWith(Number),
        calls: sql<number>`count(*)::int`,
      })
      .from(managedUsage)
      .where(mine)
      .groupBy(managedUsage.model)
      .orderBy(sql`sum(${managedUsage.billed}) desc`);
    const byWorkspace = await this.db
      .select({
        key: managedUsage.workspaceId,
        name: workspaces.name,
        cost: sql<number>`sum(${managedUsage.billed})`.mapWith(Number),
        calls: sql<number>`count(*)::int`,
      })
      .from(managedUsage)
      .leftJoin(workspaces, eq(workspaces.id, managedUsage.workspaceId))
      .where(mine)
      .groupBy(managedUsage.workspaceId, workspaces.name)
      .orderBy(sql`sum(${managedUsage.billed}) desc`);
    const list = await this.db
      .select()
      .from(invoices)
      .where(eq(invoices.userId, userId))
      .orderBy(desc(invoices.createdAt))
      .limit(50);
    const reason = await this.blocker(userId);
    return {
      available: this.config.managedEnabled,
      ready: reason === null,
      reason,
      allowance: a?.allowance ?? null,
      uncapped: a?.uncapped ?? false,
      consentAt: a?.consentAt?.toISOString() ?? null,
      card: a?.paymentMethodId
        ? { brand: a.cardBrand ?? 'card', last4: a.cardLast4 ?? '????' }
        : null,
      status: a?.status ?? 'ok',
      spent: a ? await this.spentSince(userId, a.allowanceSince) : 0,
      unbilled: await this.unbilled(userId),
      minimum: this.config.BILLING_MINIMUM_CENTS / 100,
      invoices: list.map((r) => this.toInvoice(r)),
      usage: {
        byRun: byRun.map((r) => line(r.key, r.label ?? r.key, r.cost, r.calls)),
        byModel: byModel.map((r) => line(r.key, r.key, r.cost, r.calls)),
        byWorkspace: byWorkspace.map((r) => line(r.key, r.name, r.cost, r.calls)),
      },
    };
  }

  /**
   * Chooses the allowance (or unlimited) with explicit consent. Setting it starts counting
   * afresh; unpaid invoices and usage not yet invoiced are kept and still charged.
   */
  async configure(
    userId: string,
    input: { allowance: number | null; uncapped: boolean; consentVersion: string },
  ): Promise<BillingState> {
    await this.ensureAccount(userId);
    await this.db
      .update(billingAccounts)
      .set({
        allowance: input.uncapped ? null : input.allowance,
        uncapped: input.uncapped,
        allowanceSince: new Date(),
        consentAt: new Date(),
        consentVersion: input.consentVersion,
        updatedAt: new Date(),
      })
      .where(eq(billingAccounts.userId, userId));
    return this.state(userId);
  }

  private requireStripe(): StripeClient {
    if (!this.stripe) throw conflict("Payments aren't set up on this Kovan server.");
    return this.stripe;
  }

  /** A Stripe-hosted page to save a card (Kovan never sees card details). */
  async startSetup(userId: string): Promise<{ url: string }> {
    const stripe = this.requireStripe();
    const a = await this.ensureAccount(userId);
    let customer = a.stripeCustomerId;
    if (!customer) {
      const [u] = await this.db.select().from(users).where(eq(users.id, userId));
      customer = (
        await stripe.createCustomer({
          email: u?.email ?? null,
          name: u?.name ?? 'Kovan user',
          userId,
        })
      ).id;
      await this.db
        .update(billingAccounts)
        .set({ stripeCustomerId: customer })
        .where(eq(billingAccounts.userId, userId));
    }
    const base = this.config.PUBLIC_URL.replace(/\/$/, '');
    const session = await stripe.createSetupCheckout({
      customer,
      userId,
      successUrl: `${base}/billing/done?session_id={CHECKOUT_SESSION_ID}`,
      cancelUrl: `${base}/billing/cancelled`,
    });
    if (!session.url) throw conflict('Stripe did not return a page to open');
    return { url: session.url };
  }

  /** The card saved on a finished Checkout becomes the person's payment method (idempotent). */
  async completeCheckout(sessionId: string): Promise<void> {
    const stripe = this.requireStripe();
    const session = await stripe.getCheckout(sessionId);
    if (!session.customer) throw notFound('Checkout not found');
    const [a] = await this.db
      .select()
      .from(billingAccounts)
      .where(eq(billingAccounts.stripeCustomerId, session.customer));
    if (!a) throw notFound('Checkout not found');
    const intentId =
      typeof session.setup_intent === 'string' ? session.setup_intent : session.setup_intent?.id;
    if (!intentId) throw conflict('That checkout saved no card');
    const intent = await stripe.getSetupIntent(intentId);
    if (!intent.payment_method) throw conflict('That checkout saved no card');
    const pm = await stripe.getPaymentMethod(intent.payment_method);
    await stripe.setDefaultPaymentMethod(session.customer, pm.id).catch(() => undefined);
    await this.db
      .update(billingAccounts)
      .set({
        paymentMethodId: pm.id,
        cardBrand: pm.card?.brand ?? 'card',
        cardLast4: pm.card?.last4 ?? '????',
        updatedAt: new Date(),
      })
      .where(eq(billingAccounts.userId, a.userId));
  }

  /** Stripe's events: a finished card setup, and payment results that arrive later. */
  async handleEvent(event: {
    type: string;
    data: { object: Record<string, unknown> };
  }): Promise<void> {
    const o = event.data.object;
    if (
      event.type === 'checkout.session.completed' &&
      o['mode'] === 'setup' &&
      typeof o['id'] === 'string'
    )
      await this.completeCheckout(o['id']);
    const invoiceId = (o['metadata'] as Record<string, string> | undefined)?.['kovan_invoice_id'];
    if (!invoiceId || !/^[0-9a-f-]{36}$/i.test(invoiceId)) return;
    if (event.type === 'payment_intent.succeeded') await this.markPaid(invoiceId, null);
    if (event.type === 'payment_intent.payment_failed') {
      const err = o['last_payment_error'] as { message?: string } | undefined;
      await this.markFailed(invoiceId, err?.message ?? 'The payment failed');
    }
  }

  // ---------- usage ----------

  /** Files a managed call: the ledger (what's billed) and the usage page's records. */
  async record(userId: string, call: ManagedCall): Promise<number> {
    const billed = billedFor(call.providerCost);
    const [row] = await this.db
      .insert(managedUsage)
      .values({ ...call, userId, billed })
      .onConflictDoNothing()
      .returning({ id: managedUsage.id });
    if (!row) return 0; // this generation is filed already
    await this.db.insert(usageRecords).values({
      userId,
      workspaceId: call.workspaceId,
      conversationId: call.runId,
      model: call.model,
      kind: 'model',
      promptTokens: call.promptTokens,
      completionTokens: call.completionTokens,
      cost: billed,
      estimated: false,
    });
    return billed;
  }

  // ---------- charging ----------

  /**
   * The daily off-session charge: every person's usage not invoiced yet becomes an invoice and
   * is charged, unless it's under the payment minimum (then it carries forward). Returns the
   * invoices made.
   */
  async chargeDue(now = new Date(), force = false): Promise<Invoice[]> {
    const stripe = this.requireStripe();
    const due = await this.db
      .select({
        userId: managedUsage.userId,
        total: sql<number>`sum(${managedUsage.billed})`.mapWith(Number),
      })
      .from(managedUsage)
      .where(and(isNull(managedUsage.invoiceId), lte(managedUsage.createdAt, now)))
      .groupBy(managedUsage.userId);
    const made: Invoice[] = [];
    const today = now.toISOString().slice(0, 10);
    for (const d of due) {
      const a = await this.account(d.userId);
      if (!a?.paymentMethodId || !a.stripeCustomerId) continue;
      if (!force && a.lastChargeAt?.toISOString().slice(0, 10) === today) continue;
      const cents = Math.round(d.total * 100);
      if (cents < this.config.BILLING_MINIMUM_CENTS) continue; // carries forward
      const invoice = await this.db.transaction(async (tx) => {
        const [inv] = await tx
          .insert(invoices)
          .values({ userId: d.userId, amountCents: 0, usage: 0 })
          .returning();
        const rows = await tx
          .update(managedUsage)
          .set({ invoiceId: inv!.id })
          .where(
            and(
              eq(managedUsage.userId, d.userId),
              isNull(managedUsage.invoiceId),
              lte(managedUsage.createdAt, now),
            ),
          )
          .returning({ billed: managedUsage.billed });
        const usage = Math.round(rows.reduce((s, r) => s + r.billed, 0) * 1_000_000) / 1_000_000;
        const [done] = await tx
          .update(invoices)
          .set({ usage, amountCents: Math.round(usage * 100) })
          .where(eq(invoices.id, inv!.id))
          .returning();
        await tx
          .update(billingAccounts)
          .set({ lastChargeAt: now })
          .where(eq(billingAccounts.userId, d.userId));
        return done!;
      });
      made.push(this.toInvoice(await this.charge(stripe, invoice, a)));
    }
    return made;
  }

  private async charge(stripe: StripeClient, invoice: InvoiceRow, a: Account): Promise<InvoiceRow> {
    const attempt = invoice.attempts + 1;
    await this.db.update(invoices).set({ attempts: attempt }).where(eq(invoices.id, invoice.id));
    try {
      const intent = await stripe.chargeOffSession({
        customer: a.stripeCustomerId!,
        paymentMethod: a.paymentMethodId!,
        amountCents: invoice.amountCents,
        invoiceId: invoice.id,
        attempt,
        description: `Kovan managed usage (${money(invoice.usage)} incl. 5%)`,
      });
      await this.db
        .update(invoices)
        .set({ paymentIntentId: intent.id })
        .where(eq(invoices.id, invoice.id));
      if (intent.status === 'succeeded') {
        const charge = intent.latest_charge;
        return this.markPaid(
          invoice.id,
          typeof charge === 'object' && charge ? (charge.receipt_url ?? null) : null,
        );
      }
      if (intent.status === 'processing') return invoice; // the webhook settles it
      return this.markFailed(
        invoice.id,
        intent.status === 'requires_action'
          ? 'Your bank wants you to confirm this payment. Update your card in Billing, then retry.'
          : (intent.last_payment_error?.message ?? `The payment is ${intent.status}`),
      );
    } catch (error) {
      if (!(error instanceof StripeError)) throw error;
      if (error.paymentIntentId)
        await this.db
          .update(invoices)
          .set({ paymentIntentId: error.paymentIntentId })
          .where(eq(invoices.id, invoice.id));
      return this.markFailed(invoice.id, error.message);
    }
  }

  private async markPaid(invoiceId: string, receiptUrl: string | null): Promise<InvoiceRow> {
    const [row] = await this.db
      .update(invoices)
      .set({
        status: 'paid',
        paidAt: new Date(),
        failureReason: null,
        ...(receiptUrl ? { receiptUrl } : {}),
      })
      .where(eq(invoices.id, invoiceId))
      .returning();
    if (!row) throw notFound('Invoice not found');
    // Nothing else failed: managed requests resume.
    const [stillFailed] = await this.db
      .select({ id: invoices.id })
      .from(invoices)
      .where(and(eq(invoices.userId, row.userId), eq(invoices.status, 'failed')))
      .limit(1);
    if (!stillFailed)
      await this.db
        .update(billingAccounts)
        .set({ status: 'ok' })
        .where(eq(billingAccounts.userId, row.userId));
    return row;
  }

  private async markFailed(invoiceId: string, reason: string): Promise<InvoiceRow> {
    const [row] = await this.db
      .update(invoices)
      .set({ status: 'failed', failureReason: reason.slice(0, 500) })
      .where(eq(invoices.id, invoiceId))
      .returning();
    if (!row) throw notFound('Invoice not found');
    await this.db
      .update(billingAccounts)
      .set({ status: 'past_due' })
      .where(eq(billingAccounts.userId, row.userId));
    return row;
  }

  /** Payment recovery: charge a failed invoice again (with the card saved now). */
  async retry(userId: string, invoiceId: string): Promise<Invoice> {
    const stripe = this.requireStripe();
    if (!/^[0-9a-f-]{36}$/i.test(invoiceId)) throw notFound('Invoice not found');
    const [inv] = await this.db
      .select()
      .from(invoices)
      .where(and(eq(invoices.id, invoiceId), eq(invoices.userId, userId)));
    if (!inv) throw notFound('Invoice not found');
    if (inv.status === 'paid') return this.toInvoice(inv);
    const a = await this.account(userId);
    if (!a?.paymentMethodId) throw conflict('Add a payment method first');
    return this.toInvoice(await this.charge(stripe, inv, a));
  }
}
