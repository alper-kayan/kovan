import {
  billedFor,
  monthProjection,
  monthStart,
  type BillingState,
  type Invoice,
  type OrgBillingState,
  type TeamPays,
  type UsageLine,
} from '@kovan/shared';
import { and, desc, eq, gte, isNotNull, isNull, lt, lte, sql } from 'drizzle-orm';
import type { Config } from '../config.js';
import type { Db } from '../db/client.js';
import {
  billingAccounts,
  invoices,
  managedUsage,
  orgBilling,
  orgMemberLimits,
  orgMembers,
  orgs,
  usageRecords,
  users,
  workspaces,
} from '../db/schema.js';
import { conflict, forbidden, HttpError, notFound } from '../errors.js';
import { actionMail, type Mailer } from '../mail.js';
import { StripeError, type StripeClient } from './stripe.js';

type Account = typeof billingAccounts.$inferSelect;
type OrgAccount = typeof orgBilling.$inferSelect;
type InvoiceRow = typeof invoices.$inferSelect;

const money = (n: number) => `$${n.toFixed(n < 1 ? 4 : 2)}`;
const monthKey = (d: Date) => d.toISOString().slice(0, 7);
/** What one call in flight is counted as before its real cost is known (USD). */
const CALL_ESTIMATE = 0.02;
const BILLING_PAGE = 'Settings → Billing & usage';
const usdText = (cents: number) => `$${(cents / 100).toFixed(2)}`;
const TEAM_PAGE = 'Settings → Organization → Team billing';

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

/** Who pays for a managed call: the person, or the organization that pays for its members. */
export type Payer =
  { kind: 'user'; userId: string } | { kind: 'org'; orgId: string; userId: string };

/** A managed request was refused, with the reason the person sees in their agent. */
export class PaymentRequired extends HttpError {
  constructor(message: string) {
    super(402, 'payment_required', message);
  }
}

/**
 * Managed usage billing, at provider cost × 1.05 applied once. Nothing goes out before someone
 * agreed to pay, set a limit and saved a card.
 *
 * - A person pays for their own runs, up to a monthly allowance (or explicitly unlimited); it is
 *   charged once a day, and balances under the payment minimum carry forward.
 * - An organization can pay for its members' runs in its workspaces instead: an owner agrees,
 *   sets a monthly cap for the organization and a default monthly limit per member (each member
 *   can have their own), and it is charged once a month with the company's details.
 *
 * Limits count calendar months (UTC) and start again on the 1st. A call in flight is counted
 * before its cost is known, so agents running side by side can't all slip past a limit.
 * A failed payment pauses new managed requests until it is retried or the card changes.
 */
export class BillingService {
  private timer: NodeJS.Timeout | null = null;
  /** Calls running now, per payer and per member of a paying organization. */
  private readonly inflight = new Map<string, number>();
  /** Members on an organization's default limit told this month that it ran out. */
  private readonly noticed = new Set<string>();

  constructor(
    private readonly db: Db,
    private readonly config: Config,
    private readonly stripe: StripeClient | null,
    private readonly mailer: Mailer | null = null,
  ) {}

  start(): void {
    if (this.config.NODE_ENV === 'test' || !this.stripe) return;
    // Hourly look; the charge itself runs once a day per person (monthly per organization), at
    // the configured hour.
    this.timer = setInterval(() => {
      if (new Date().getUTCHours() === this.config.BILLING_CHARGE_HOUR_UTC)
        void this.chargeDue().catch((error: unknown) => console.warn('Billing:', error));
    }, 3_600_000);
    this.timer.unref();
  }

  close(): void {
    if (this.timer) clearInterval(this.timer);
  }

  // ---------- accounts ----------

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

  private async orgAccount(orgId: string): Promise<OrgAccount | null> {
    const [row] = await this.db.select().from(orgBilling).where(eq(orgBilling.orgId, orgId));
    return row ?? null;
  }

  private async ensureOrgAccount(orgId: string): Promise<OrgAccount> {
    await this.db.insert(orgBilling).values({ orgId }).onConflictDoNothing();
    return (await this.orgAccount(orgId))!;
  }

  /** An organization pays only once an owner agreed, set its cap and saved a card. */
  private static paying(o: OrgAccount | null): o is OrgAccount {
    return Boolean(o?.consentAt && o.monthlyCap !== null && o.paymentMethodId);
  }

  private async requireOwner(orgId: string, userId: string): Promise<void> {
    const [m] = await this.db
      .select({ role: orgMembers.role })
      .from(orgMembers)
      .where(and(eq(orgMembers.orgId, orgId), eq(orgMembers.userId, userId)));
    if (!m) throw notFound('Organization not found');
    if (m.role !== 'owner')
      throw forbidden('Only an owner of the organization can change its billing');
  }

  // ---------- what was spent ----------

  /** Personal managed usage this month (since the allowance was set, if later). */
  private async personalSpent(userId: string, since: Date): Promise<number> {
    const [r] = await this.db
      .select({ s: sql<number>`coalesce(sum(${managedUsage.billed}), 0)`.mapWith(Number) })
      .from(managedUsage)
      .where(
        and(
          eq(managedUsage.userId, userId),
          isNull(managedUsage.orgId),
          gte(managedUsage.createdAt, since),
        ),
      );
    return r?.s ?? 0;
  }

  private async orgSpent(orgId: string, since: Date, userId?: string): Promise<number> {
    const [r] = await this.db
      .select({ s: sql<number>`coalesce(sum(${managedUsage.billed}), 0)`.mapWith(Number) })
      .from(managedUsage)
      .where(
        and(
          eq(managedUsage.orgId, orgId),
          gte(managedUsage.createdAt, since),
          ...(userId ? [eq(managedUsage.userId, userId)] : []),
        ),
      );
    return r?.s ?? 0;
  }

  private async unbilled(userId: string): Promise<number> {
    const [r] = await this.db
      .select({ s: sql<number>`coalesce(sum(${managedUsage.billed}), 0)`.mapWith(Number) })
      .from(managedUsage)
      .where(
        and(
          eq(managedUsage.userId, userId),
          isNull(managedUsage.orgId),
          isNull(managedUsage.invoiceId),
        ),
      );
    return r?.s ?? 0;
  }

  private allowanceSince(a: Account, now = new Date()): Date {
    const month = monthStart(now);
    return a.allowanceSince > month ? a.allowanceSince : month;
  }

  /** A member's own limit in an organization that pays, else its default; null: only the cap. */
  private async memberLimit(o: OrgAccount, userId: string): Promise<number | null> {
    const [own] = await this.db
      .select()
      .from(orgMemberLimits)
      .where(and(eq(orgMemberLimits.orgId, o.orgId), eq(orgMemberLimits.userId, userId)));
    return own ? own.monthlyLimit : o.memberLimit;
  }

  private inflightOf(key: string): number {
    return (this.inflight.get(key) ?? 0) * CALL_ESTIMATE;
  }

  // ---------- who pays, and whether they can ----------

  /** The organization pays in its own workspaces once it pays for members; else the person. */
  async payerFor(userId: string, workspaceId: string | null): Promise<Payer> {
    if (workspaceId) {
      const [ws] = await this.db
        .select({ orgId: workspaces.orgId })
        .from(workspaces)
        .where(eq(workspaces.id, workspaceId));
      if (ws && BillingService.paying(await this.orgAccount(ws.orgId)))
        return { kind: 'org', orgId: ws.orgId, userId };
    }
    return { kind: 'user', userId };
  }

  /** Why managed requests can't go out for this person right now, or null. */
  async blocker(userId: string): Promise<string | null> {
    if (!this.config.managedEnabled)
      return "This Kovan server doesn't sell model usage. Use your own model key instead: in the app, Settings → Model keys & spend; in the terminal, kovan setup.";
    const a = await this.account(userId);
    if (!a?.consentAt || (!a.uncapped && a.allowance === null))
      return `Set up Kovan billing in ${BILLING_PAGE}: choose a monthly allowance and accept the usage terms.`;
    if (!a.paymentMethodId) return `Add a card in ${BILLING_PAGE} to pay for models through Kovan.`;
    if (a.status === 'past_due')
      return `A payment failed, so Kovan billing is paused. Update your card or retry the payment in ${BILLING_PAGE}.`;
    if (!a.uncapped && a.allowance !== null) {
      const spent = await this.personalSpent(userId, this.allowanceSince(a));
      if (spent >= a.allowance)
        return `Your monthly allowance is used up (${money(spent)} of ${money(a.allowance)}). It starts again on the 1st; to go on now, raise it in ${BILLING_PAGE}.`;
      if (spent + this.inflightOf(`u:${userId}`) >= a.allowance)
        return `Your monthly allowance is nearly used up by the requests running now (${money(spent)} of ${money(a.allowance)}). Wait for them, or raise it in ${BILLING_PAGE}.`;
    }
    return null;
  }

  /** Why the organization can't pay for this member's request right now, or null. */
  async orgBlocker(orgId: string, userId: string): Promise<string | null> {
    if (!this.config.managedEnabled)
      return "This Kovan server doesn't sell model usage. Use your own model key instead: in the app, Settings → Model keys & spend; in the terminal, kovan setup.";
    const o = await this.orgAccount(orgId);
    const [org] = await this.db.select({ name: orgs.name }).from(orgs).where(eq(orgs.id, orgId));
    const name = org?.name ?? 'Your team';
    if (!BillingService.paying(o)) return `${name} doesn't pay for models through Kovan.`;
    if (o.status === 'past_due')
      return `A payment of ${name} failed, so its Kovan billing is paused. An owner can retry it in ${TEAM_PAGE}.`;
    const month = monthStart();
    const spent = await this.orgSpent(orgId, month);
    if (spent + this.inflightOf(`o:${orgId}`) >= o.monthlyCap!)
      return `${name}'s monthly limit for models (${money(o.monthlyCap!)}) is used up. It starts again on the 1st; an owner can raise it in ${TEAM_PAGE}.`;
    const limit = await this.memberLimit(o, userId);
    if (limit !== null) {
      const mine = await this.orgSpent(orgId, month, userId);
      if (mine + this.inflightOf(`m:${orgId}:${userId}`) >= limit)
        return `Your monthly limit in ${name} (${money(limit)}) is used up. It starts again on the 1st; an owner of ${name} can raise it.`;
    }
    return null;
  }

  /**
   * Before a managed request goes out: who pays, refused with the reason when they can't. The
   * request is counted as running until `done` is called.
   */
  async begin(userId: string, workspaceId: string | null): Promise<{ payer: Payer; done(): void }> {
    const payer = await this.payerFor(userId, workspaceId);
    const reason =
      payer.kind === 'org'
        ? await this.orgBlocker(payer.orgId, userId)
        : await this.blocker(userId);
    if (reason) throw new PaymentRequired(reason);
    const keys =
      payer.kind === 'org' ? [`o:${payer.orgId}`, `m:${payer.orgId}:${userId}`] : [`u:${userId}`];
    for (const k of keys) this.inflight.set(k, (this.inflight.get(k) ?? 0) + 1);
    let ended = false;
    return {
      payer,
      done: () => {
        if (ended) return;
        ended = true;
        for (const k of keys) {
          const n = (this.inflight.get(k) ?? 1) - 1;
          if (n > 0) this.inflight.set(k, n);
          else this.inflight.delete(k);
        }
      },
    };
  }

  /** Personal billing only (the CLI, say, and anything with no workspace). */
  async gate(userId: string): Promise<void> {
    const reason = await this.blocker(userId);
    if (reason) throw new PaymentRequired(reason);
  }

  // ---------- account deletion ----------

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
        ? `A payment for Kovan billing failed and is still owed. Retry it or update your card in ${BILLING_PAGE} on the desktop, then delete the account.`
        : null;
    return { blocker, unbilled: await this.unbilled(userId) };
  }

  /**
   * Right before an account is deleted: usage not charged yet is charged now, as it would have
   * been the next day (under the minimum charge it is waived). A charge that fails stops the
   * deletion, as an unpaid one does.
   */
  async settleBeforeDeletion(userId: string): Promise<void> {
    const a = await this.account(userId);
    if (!this.stripe || !a?.paymentMethodId || !a.stripeCustomerId) return;
    const owed = await this.unbilled(userId);
    if (Math.round(owed * 100) < this.config.BILLING_MINIMUM_CENTS) return;
    const invoice = await this.invoiceUsage(
      { userId },
      and(eq(managedUsage.userId, userId), isNull(managedUsage.orgId))!,
    );
    const done = await this.charge(this.stripe, invoice, a);
    if (done.status === 'failed')
      throw conflict(
        `The last charge for your Kovan billing (${usdText(done.amountCents)}) failed: ${done.failureReason ?? 'the card was declined'}. Update your card in ${BILLING_PAGE} on the desktop, then delete the account.`,
      );
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

  // ---------- what the person sees ----------

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
      period: r.period,
    };
  }

  /** Organizations of this person that pay for their usage, with their limit and spend there. */
  private async teamsOf(userId: string): Promise<TeamPays[]> {
    const rows = await this.db
      .select({ o: orgBilling, name: orgs.name })
      .from(orgMembers)
      .innerJoin(orgBilling, eq(orgBilling.orgId, orgMembers.orgId))
      .innerJoin(orgs, eq(orgs.id, orgMembers.orgId))
      .where(eq(orgMembers.userId, userId));
    const month = monthStart();
    const out: TeamPays[] = [];
    for (const { o, name } of rows) {
      if (!BillingService.paying(o)) continue;
      const reason = await this.orgBlocker(o.orgId, userId);
      out.push({
        orgId: o.orgId,
        orgName: name,
        ready: reason === null,
        reason,
        limit: await this.memberLimit(o, userId),
        spent: await this.orgSpent(o.orgId, month, userId),
      });
    }
    return out;
  }

  async state(userId: string): Promise<BillingState> {
    const a = await this.account(userId);
    const since = new Date(Date.now() - 30 * 86_400_000);
    // The usage page shows everything this person ran, whoever paid for it.
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
      spent: a ? await this.personalSpent(userId, this.allowanceSince(a)) : 0,
      unbilled: await this.unbilled(userId),
      minimum: this.config.BILLING_MINIMUM_CENTS / 100,
      invoices: list.map((r) => this.toInvoice(r)),
      usage: {
        byRun: byRun.map((r) => line(r.key, r.label ?? r.key, r.cost, r.calls)),
        byModel: byModel.map((r) => line(r.key, r.key, r.cost, r.calls)),
        byWorkspace: byWorkspace.map((r) => line(r.key, r.name, r.cost, r.calls)),
      },
      teams: await this.teamsOf(userId),
    };
  }

  /** An organization's billing as its owners see it: limits, card, who spent what this month. */
  async orgState(orgId: string, viewerId: string): Promise<OrgBillingState> {
    await this.requireOwner(orgId, viewerId);
    const o = await this.orgAccount(orgId);
    const month = monthStart();
    const spent = await this.orgSpent(orgId, month);
    const members = await this.db
      .select({ userId: users.id, name: users.name })
      .from(orgMembers)
      .innerJoin(users, eq(users.id, orgMembers.userId))
      .where(eq(orgMembers.orgId, orgId));
    const spentBy = await this.db
      .select({
        userId: managedUsage.userId,
        cost: sql<number>`sum(${managedUsage.billed})`.mapWith(Number),
      })
      .from(managedUsage)
      .where(and(eq(managedUsage.orgId, orgId), gte(managedUsage.createdAt, month)))
      .groupBy(managedUsage.userId);
    const own = await this.db
      .select()
      .from(orgMemberLimits)
      .where(eq(orgMemberLimits.orgId, orgId));
    const byWorkspace = await this.db
      .select({
        key: managedUsage.workspaceId,
        name: workspaces.name,
        cost: sql<number>`sum(${managedUsage.billed})`.mapWith(Number),
        calls: sql<number>`count(*)::int`,
      })
      .from(managedUsage)
      .leftJoin(workspaces, eq(workspaces.id, managedUsage.workspaceId))
      .where(and(eq(managedUsage.orgId, orgId), gte(managedUsage.createdAt, month)))
      .groupBy(managedUsage.workspaceId, workspaces.name)
      .orderBy(sql`sum(${managedUsage.billed}) desc`);
    const list = await this.db
      .select()
      .from(invoices)
      .where(eq(invoices.orgId, orgId))
      .orderBy(desc(invoices.createdAt))
      .limit(36);
    const enabled = Boolean(o?.consentAt && o.monthlyCap !== null);
    const reason = !this.config.managedEnabled
      ? "This Kovan server doesn't sell model usage. Use your own model key instead: in the app, Settings → Model keys & spend; in the terminal, kovan setup."
      : !enabled
        ? 'Not turned on yet.'
        : !o?.paymentMethodId
          ? 'Add a card for the organization.'
          : o.status === 'past_due'
            ? 'A payment failed: retry it or change the card.'
            : spent >= o.monthlyCap!
              ? `This month's limit (${money(o.monthlyCap!)}) is used up.`
              : null;
    return {
      orgId,
      available: this.config.managedEnabled,
      enabled,
      ready: reason === null,
      reason,
      monthlyCap: o?.monthlyCap ?? null,
      memberLimit: o?.memberLimit ?? null,
      card: o?.paymentMethodId
        ? { brand: o.cardBrand ?? 'card', last4: o.cardLast4 ?? '????' }
        : null,
      status: o?.status ?? 'ok',
      company: {
        name: o?.companyName ?? null,
        address: o?.companyAddress ?? null,
        taxId: o?.taxId ?? null,
        email: o?.billingEmail ?? null,
      },
      spent,
      projected: monthProjection(spent),
      byMember: members
        .map((m) => {
          const set = own.find((l) => l.userId === m.userId);
          return {
            userId: m.userId,
            name: m.name,
            spent: spentBy.find((s) => s.userId === m.userId)?.cost ?? 0,
            limit: set ? set.monthlyLimit : (o?.memberLimit ?? null),
            own: Boolean(set),
          };
        })
        .sort((x, y) => y.spent - x.spent || x.name.localeCompare(y.name)),
      byWorkspace: byWorkspace.map((r) => ({
        key: r.key ?? 'none',
        label: r.name ?? 'Removed workspace',
        cost: r.cost,
        calls: r.calls,
      })),
      invoices: list.map((r) => this.toInvoice(r)),
    };
  }

  // ---------- settings ----------

  /**
   * Chooses the monthly allowance (or unlimited) with explicit consent. Unpaid invoices and
   * usage not yet invoiced are kept and still charged.
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
        // A month counts whole: raising it mid-month keeps what was spent this month.
        allowanceSince: monthStart(),
        consentAt: new Date(),
        consentVersion: input.consentVersion,
        noticeMonth: null,
        updatedAt: new Date(),
      })
      .where(eq(billingAccounts.userId, userId));
    return this.state(userId);
  }

  /** An owner turns team billing on (or changes it): the limits and the company's details. */
  async configureOrg(
    orgId: string,
    userId: string,
    input: {
      monthlyCap: number;
      memberLimit: number | null;
      consentVersion: string;
      company: {
        name?: string | null | undefined;
        address?: string | null | undefined;
        taxId?: string | null | undefined;
        email?: string | null | undefined;
      };
    },
  ): Promise<OrgBillingState> {
    await this.requireOwner(orgId, userId);
    const before = await this.ensureOrgAccount(orgId);
    await this.db
      .update(orgBilling)
      .set({
        setupBy: before.setupBy ?? userId,
        consentAt: new Date(),
        consentVersion: input.consentVersion,
        monthlyCap: input.monthlyCap,
        memberLimit: input.memberLimit,
        ...(input.company.name !== undefined ? { companyName: input.company.name || null } : {}),
        ...(input.company.address !== undefined
          ? { companyAddress: input.company.address || null }
          : {}),
        ...(input.company.taxId !== undefined ? { taxId: input.company.taxId || null } : {}),
        ...(input.company.email !== undefined ? { billingEmail: input.company.email || null } : {}),
        noticeMonth: null,
        updatedAt: new Date(),
      })
      .where(eq(orgBilling.orgId, orgId));
    return this.orgState(orgId, userId);
  }

  /** An owner turns team billing off: members pay for themselves again from now on. */
  async disableOrg(orgId: string, userId: string): Promise<OrgBillingState> {
    await this.requireOwner(orgId, userId);
    await this.db
      .update(orgBilling)
      .set({ consentAt: null, updatedAt: new Date() })
      .where(eq(orgBilling.orgId, orgId));
    return this.orgState(orgId, userId);
  }

  /** An owner sets one member's own monthly limit (null: back to the default). */
  async setMemberLimit(
    orgId: string,
    ownerId: string,
    memberId: string,
    monthlyLimit: number | null | undefined,
  ): Promise<OrgBillingState> {
    await this.requireOwner(orgId, ownerId);
    if (monthlyLimit === undefined)
      await this.db
        .delete(orgMemberLimits)
        .where(and(eq(orgMemberLimits.orgId, orgId), eq(orgMemberLimits.userId, memberId)));
    else
      await this.db
        .insert(orgMemberLimits)
        .values({ orgId, userId: memberId, monthlyLimit })
        .onConflictDoUpdate({
          target: [orgMemberLimits.orgId, orgMemberLimits.userId],
          set: { monthlyLimit, noticeMonth: null },
        });
    return this.orgState(orgId, ownerId);
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
    return this.checkoutFor(stripe, customer, userId);
  }

  /** The same, for the organization's own card (an owner saves it). */
  async startOrgSetup(orgId: string, userId: string): Promise<{ url: string }> {
    await this.requireOwner(orgId, userId);
    const stripe = this.requireStripe();
    const o = await this.ensureOrgAccount(orgId);
    let customer = o.stripeCustomerId;
    if (!customer) {
      const [org] = await this.db.select().from(orgs).where(eq(orgs.id, orgId));
      const [u] = await this.db.select().from(users).where(eq(users.id, userId));
      customer = (
        await stripe.createCustomer({
          email: o.billingEmail ?? u?.email ?? null,
          name: o.companyName ?? org?.name ?? 'Kovan organization',
          userId,
          orgId,
          address: o.companyAddress,
          taxId: o.taxId,
        })
      ).id;
      await this.db
        .update(orgBilling)
        .set({ stripeCustomerId: customer })
        .where(eq(orgBilling.orgId, orgId));
    }
    return this.checkoutFor(stripe, customer, userId);
  }

  private async checkoutFor(
    stripe: StripeClient,
    customer: string,
    userId: string,
  ): Promise<{ url: string }> {
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

  /**
   * The card saved on a finished Checkout becomes the payment method of whoever it was for, a
   * person or an organization (idempotent). Says which.
   */
  async completeCheckout(sessionId: string): Promise<'user' | 'org'> {
    const stripe = this.requireStripe();
    const session = await stripe.getCheckout(sessionId);
    if (!session.customer) throw notFound('Checkout not found');
    const [a] = await this.db
      .select()
      .from(billingAccounts)
      .where(eq(billingAccounts.stripeCustomerId, session.customer));
    const [o] = a
      ? []
      : await this.db
          .select()
          .from(orgBilling)
          .where(eq(orgBilling.stripeCustomerId, session.customer));
    if (!a && !o) throw notFound('Checkout not found');
    const intentId =
      typeof session.setup_intent === 'string' ? session.setup_intent : session.setup_intent?.id;
    if (!intentId) throw conflict('No card was saved. Try adding it again.');
    const intent = await stripe.getSetupIntent(intentId);
    if (!intent.payment_method) throw conflict('No card was saved. Try adding it again.');
    const pm = await stripe.getPaymentMethod(intent.payment_method);
    await stripe.setDefaultPaymentMethod(session.customer, pm.id).catch(() => undefined);
    const card = {
      paymentMethodId: pm.id,
      cardBrand: pm.card?.brand ?? 'card',
      cardLast4: pm.card?.last4 ?? '????',
      updatedAt: new Date(),
    };
    if (a) {
      await this.db.update(billingAccounts).set(card).where(eq(billingAccounts.userId, a.userId));
      return 'user';
    }
    await this.db.update(orgBilling).set(card).where(eq(orgBilling.orgId, o!.orgId));
    return 'org';
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

  /** Files a managed call against whoever pays for it, and tells them when a limit runs out. */
  async record(payer: Payer | string, call: ManagedCall): Promise<number> {
    const who: Payer = typeof payer === 'string' ? { kind: 'user', userId: payer } : payer;
    const billed = billedFor(call.providerCost);
    const [row] = await this.db
      .insert(managedUsage)
      .values({
        ...call,
        userId: who.userId,
        orgId: who.kind === 'org' ? who.orgId : null,
        billed,
      })
      .onConflictDoNothing()
      .returning({ id: managedUsage.id });
    if (!row) return 0; // this generation is filed already
    await this.db.insert(usageRecords).values({
      userId: who.userId,
      workspaceId: call.workspaceId,
      conversationId: call.runId,
      model: call.model,
      kind: 'model',
      promptTokens: call.promptTokens,
      completionTokens: call.completionTokens,
      cost: billed,
      estimated: false,
    });
    await this.noticeLimits(who).catch((error: unknown) =>
      console.warn('Billing: limit notice failed:', error),
    );
    return billed;
  }

  // ---------- telling people ----------

  private async emailOf(userId: string): Promise<string | null> {
    const [u] = await this.db
      .select({ email: users.email })
      .from(users)
      .where(eq(users.id, userId));
    return u?.email ?? null;
  }

  private async ownersOf(orgId: string): Promise<string[]> {
    const rows = await this.db
      .select({ email: users.email })
      .from(orgMembers)
      .innerJoin(users, eq(users.id, orgMembers.userId))
      .where(
        and(eq(orgMembers.orgId, orgId), eq(orgMembers.role, 'owner'), isNotNull(users.email)),
      );
    return rows.map((r) => r.email!);
  }

  private async mail(to: string[], subject: string, text: string, action: string): Promise<void> {
    if (!this.mailer) return;
    const url = `${this.config.PUBLIC_URL.replace(/\/$/, '')}/account/billing/`;
    for (const address of [...new Set(to)])
      await this.mailer.send(actionMail(address, subject, text, action, url));
  }

  /** A limit that just ran out is said once a month, to the people it matters to. */
  private async noticeLimits(who: Payer): Promise<void> {
    if (!this.mailer) return;
    const now = new Date();
    const month = monthKey(now);
    const start = monthStart(now);
    if (who.kind === 'user') {
      const a = await this.account(who.userId);
      if (!a || a.uncapped || a.allowance === null || a.noticeMonth === month) return;
      const spent = await this.personalSpent(who.userId, this.allowanceSince(a, now));
      if (spent < a.allowance) return;
      await this.db
        .update(billingAccounts)
        .set({ noticeMonth: month })
        .where(eq(billingAccounts.userId, who.userId));
      const email = await this.emailOf(who.userId);
      if (email)
        await this.mail(
          [email],
          'Your Kovan allowance for this month is used up',
          `You used your monthly allowance for models through Kovan (${money(spent)} of ${money(a.allowance)}). Your agents can't use Kovan billing until it starts again on the 1st, unless you raise it.`,
          'Open billing',
        );
      return;
    }
    const o = await this.orgAccount(who.orgId);
    if (!o || o.monthlyCap === null) return;
    const [org] = await this.db
      .select({ name: orgs.name })
      .from(orgs)
      .where(eq(orgs.id, who.orgId));
    const name = org?.name ?? 'Your organization';
    const total = await this.orgSpent(who.orgId, start);
    if (total >= o.monthlyCap && o.noticeMonth !== month) {
      await this.db
        .update(orgBilling)
        .set({ noticeMonth: month })
        .where(eq(orgBilling.orgId, who.orgId));
      await this.mail(
        await this.ownersOf(who.orgId),
        `${name}'s Kovan limit for this month is used up`,
        `${name}'s members used its monthly limit for models (${money(total)} of ${money(o.monthlyCap)}). Their agents can't use team billing until it starts again on the 1st, unless an owner raises it.`,
        'Open billing',
      );
    }
    const limit = await this.memberLimit(o, who.userId);
    if (limit === null) return;
    const mine = await this.orgSpent(who.orgId, start, who.userId);
    if (mine < limit) return;
    const [own] = await this.db
      .select()
      .from(orgMemberLimits)
      .where(and(eq(orgMemberLimits.orgId, who.orgId), eq(orgMemberLimits.userId, who.userId)));
    // A member on the default limit has no row of their own to keep the notice in (making one
    // would fix their limit): this process remembers it instead.
    const key = `${who.orgId}:${who.userId}:${month}`;
    if (own ? own.noticeMonth === month : this.noticed.has(key)) return;
    if (own)
      await this.db
        .update(orgMemberLimits)
        .set({ noticeMonth: month })
        .where(and(eq(orgMemberLimits.orgId, who.orgId), eq(orgMemberLimits.userId, who.userId)));
    else this.noticed.add(key);
    const email = await this.emailOf(who.userId);
    if (email)
      await this.mail(
        [email],
        `Your Kovan limit in ${name} is used up`,
        `You used your monthly limit for models in ${name} (${money(mine)} of ${money(limit)}). Your agents can't use ${name}'s billing until it starts again on the 1st; an owner of ${name} can raise it.`,
        'Open billing',
      );
  }

  // ---------- charging ----------

  /**
   * The charges that are due: each person's usage not invoiced yet, once a day (unless it's under
   * the payment minimum: it carries forward); and on the 1st, each paying organization's usage of
   * the month before, as one invoice. Returns the invoices made.
   */
  async chargeDue(now = new Date(), force = false): Promise<Invoice[]> {
    const stripe = this.requireStripe();
    const made: Invoice[] = [];
    const due = await this.db
      .select({
        userId: managedUsage.userId,
        total: sql<number>`sum(${managedUsage.billed})`.mapWith(Number),
      })
      .from(managedUsage)
      .where(
        and(
          isNull(managedUsage.invoiceId),
          isNull(managedUsage.orgId),
          isNotNull(managedUsage.userId),
          lte(managedUsage.createdAt, now),
        ),
      )
      .groupBy(managedUsage.userId);
    const today = now.toISOString().slice(0, 10);
    for (const d of due) {
      const userId = d.userId!;
      const a = await this.account(userId);
      if (!a?.paymentMethodId || !a.stripeCustomerId) continue;
      if (!force && a.lastChargeAt?.toISOString().slice(0, 10) === today) continue;
      const cents = Math.round(d.total * 100);
      if (cents < this.config.BILLING_MINIMUM_CENTS) continue; // carries forward
      const invoice = await this.invoiceUsage(
        { userId },
        and(
          eq(managedUsage.userId, userId),
          isNull(managedUsage.orgId),
          lte(managedUsage.createdAt, now),
        )!,
      );
      await this.db
        .update(billingAccounts)
        .set({ lastChargeAt: now })
        .where(eq(billingAccounts.userId, userId));
      made.push(this.toInvoice(await this.charge(stripe, invoice, a)));
    }

    // Organizations: the month that ended, once (or whatever is owed, when forced).
    const month = monthStart(now);
    const first = now.getUTCDate() === 1;
    if (first || force) {
      const owed = await this.db
        .select({
          orgId: managedUsage.orgId,
          total: sql<number>`sum(${managedUsage.billed})`.mapWith(Number),
        })
        .from(managedUsage)
        .where(
          and(
            isNull(managedUsage.invoiceId),
            isNotNull(managedUsage.orgId),
            force ? lte(managedUsage.createdAt, now) : lt(managedUsage.createdAt, month),
          ),
        )
        .groupBy(managedUsage.orgId);
      for (const d of owed) {
        const orgId = d.orgId!;
        const o = await this.orgAccount(orgId);
        if (!o?.paymentMethodId || !o.stripeCustomerId) continue;
        if (!force && o.lastChargeAt && o.lastChargeAt >= month) continue;
        if (Math.round(d.total * 100) < this.config.BILLING_MINIMUM_CENTS) continue;
        const before = force ? now : month;
        const period = monthKey(new Date(before.getTime() - (force ? 0 : 1)));
        const invoice = await this.invoiceUsage(
          { orgId, period },
          and(
            eq(managedUsage.orgId, orgId),
            force ? lte(managedUsage.createdAt, now) : lt(managedUsage.createdAt, month),
          )!,
        );
        await this.db
          .update(orgBilling)
          .set({ lastChargeAt: now })
          .where(eq(orgBilling.orgId, orgId));
        made.push(this.toInvoice(await this.charge(stripe, invoice, o)));
      }
    }
    return made;
  }

  /** Puts the usage that matches into one new invoice; its amount is what that usage adds up to. */
  private async invoiceUsage(
    owner: { userId: string } | { orgId: string; period: string },
    which: ReturnType<typeof and>,
  ): Promise<InvoiceRow> {
    return this.db.transaction(async (tx) => {
      const [inv] = await tx
        .insert(invoices)
        .values({ ...owner, amountCents: 0, usage: 0 })
        .returning();
      const rows = await tx
        .update(managedUsage)
        .set({ invoiceId: inv!.id })
        .where(and(isNull(managedUsage.invoiceId), which))
        .returning({ billed: managedUsage.billed });
      const usage = Math.round(rows.reduce((s, r) => s + r.billed, 0) * 1_000_000) / 1_000_000;
      const [done] = await tx
        .update(invoices)
        .set({ usage, amountCents: Math.round(usage * 100) })
        .where(eq(invoices.id, inv!.id))
        .returning();
      return done!;
    });
  }

  private async charge(
    stripe: StripeClient,
    invoice: InvoiceRow,
    a: Pick<Account, 'stripeCustomerId' | 'paymentMethodId'>,
  ): Promise<InvoiceRow> {
    const attempt = invoice.attempts + 1;
    await this.db.update(invoices).set({ attempts: attempt }).where(eq(invoices.id, invoice.id));
    try {
      const intent = await stripe.chargeOffSession({
        customer: a.stripeCustomerId!,
        paymentMethod: a.paymentMethodId!,
        amountCents: invoice.amountCents,
        invoiceId: invoice.id,
        attempt,
        description: invoice.period
          ? `Kovan team billing, ${invoice.period} (${money(invoice.usage)} incl. 5%)`
          : `Kovan billing: models (${money(invoice.usage)} incl. 5%)`,
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

  /** Who hears about an invoice: the person, or the organization's billing email and owners. */
  private async invoiceRecipients(row: InvoiceRow): Promise<string[]> {
    if (row.orgId) {
      const o = await this.orgAccount(row.orgId);
      return o?.billingEmail ? [o.billingEmail] : this.ownersOf(row.orgId);
    }
    const email = row.userId ? await this.emailOf(row.userId) : null;
    return email ? [email] : [];
  }

  private async markPaid(invoiceId: string, receiptUrl: string | null): Promise<InvoiceRow> {
    const [before] = await this.db.select().from(invoices).where(eq(invoices.id, invoiceId));
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
    const owner = row.orgId ? eq(invoices.orgId, row.orgId) : eq(invoices.userId, row.userId!);
    const [stillFailed] = await this.db
      .select({ id: invoices.id })
      .from(invoices)
      .where(and(owner, eq(invoices.status, 'failed')))
      .limit(1);
    if (!stillFailed) {
      if (row.orgId)
        await this.db
          .update(orgBilling)
          .set({ status: 'ok' })
          .where(eq(orgBilling.orgId, row.orgId));
      else if (row.userId)
        await this.db
          .update(billingAccounts)
          .set({ status: 'ok' })
          .where(eq(billingAccounts.userId, row.userId));
    }
    // A receipt, once (a webhook may report the same payment again).
    if (before?.status !== 'paid')
      await this.mail(
        await this.invoiceRecipients(row),
        row.period
          ? `Kovan receipt for ${row.period}: ${money(row.amountCents / 100)}`
          : `Kovan receipt: ${money(row.amountCents / 100)}`,
        `${money(row.amountCents / 100)} was charged for models used through Kovan (${money(row.usage)} of usage, provider cost × 1.05${row.period ? `, ${row.period}` : ''}).${row.receiptUrl ? ` The card processor's receipt: ${row.receiptUrl}` : ''}`,
        'See invoices',
      ).catch((error: unknown) => console.warn('Billing: receipt mail failed:', error));
    return row;
  }

  private async markFailed(invoiceId: string, reason: string): Promise<InvoiceRow> {
    const [row] = await this.db
      .update(invoices)
      .set({ status: 'failed', failureReason: reason.slice(0, 500) })
      .where(eq(invoices.id, invoiceId))
      .returning();
    if (!row) throw notFound('Invoice not found');
    if (row.orgId)
      await this.db
        .update(orgBilling)
        .set({ status: 'past_due' })
        .where(eq(orgBilling.orgId, row.orgId));
    else if (row.userId)
      await this.db
        .update(billingAccounts)
        .set({ status: 'past_due' })
        .where(eq(billingAccounts.userId, row.userId));
    await this.mail(
      await this.invoiceRecipients(row),
      'A Kovan payment failed',
      `Charging ${money(row.amountCents / 100)} for models used through Kovan failed: ${reason.slice(0, 200)}. Until it is paid, agents can't use ${row.orgId ? 'team' : 'Kovan'} billing. Retry the payment or change the card.`,
      'Fix the payment',
    ).catch((error: unknown) => console.warn('Billing: failure mail failed:', error));
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

  /** The same, for an organization's invoice (an owner retries it). */
  async retryOrg(orgId: string, userId: string, invoiceId: string): Promise<Invoice> {
    await this.requireOwner(orgId, userId);
    const stripe = this.requireStripe();
    if (!/^[0-9a-f-]{36}$/i.test(invoiceId)) throw notFound('Invoice not found');
    const [inv] = await this.db
      .select()
      .from(invoices)
      .where(and(eq(invoices.id, invoiceId), eq(invoices.orgId, orgId)));
    if (!inv) throw notFound('Invoice not found');
    if (inv.status === 'paid') return this.toInvoice(inv);
    const o = await this.orgAccount(orgId);
    if (!o?.paymentMethodId) throw conflict('Add a card for the organization first');
    return this.toInvoice(await this.charge(stripe, inv, o));
  }
}
