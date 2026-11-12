import { z } from 'zod';

// ---------- Phase 11: managed usage and billing ----------

/** Managed usage costs the provider's token cost times this, applied once. */
export const MANAGED_MARKUP = 1.05;

/**
 * Billed amount for a provider cost: × 1.05 once. Kept exact (to 1e-10, past float noise);
 * only an invoice rounds, to cents.
 */
export function billedFor(providerCost: number): number {
  return Math.round(providerCost * MANAGED_MARKUP * 1e10) / 1e10;
}

export const BILLING_CONSENT_VERSION = '2026-11-12';
export const BILLING_CONSENT =
  "I authorize Kovan to charge my saved payment method once a day, without asking me each time, for the AI models I use through Kovan at the provider's token cost × 1.05, up to the monthly allowance I choose (or without a limit if I choose unlimited). Balances under the payment minimum carry forward. Tax, where it applies, is shown separately.";

/** What an owner agrees to when the organization pays for its members' models. */
export const TEAM_BILLING_CONSENT_VERSION = '2026-11-12';
export const TEAM_BILLING_CONSENT =
  "I authorize Kovan to charge the organization's saved payment method once a month, without asking each time, for the AI models its members use through Kovan in its workspaces at the provider's token cost × 1.05, up to the monthly limit I set for the organization and for each member. Tax, where it applies, is shown separately.";

/** The first moment of this calendar month, UTC: monthly limits count from here. */
export function monthStart(now: Date = new Date()): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

/** Where a month's spend is headed if it goes on as it has: spent ÷ days so far × days in it. */
export function monthProjection(spent: number, now: Date = new Date()): number {
  const start = monthStart(now);
  const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  const elapsed = Math.max(1 / 24, (now.getTime() - start.getTime()) / 86_400_000);
  const days = (next.getTime() - start.getTime()) / 86_400_000;
  return (spent / elapsed) * days;
}

export interface Invoice {
  id: string;
  /** What was charged, USD (cents rounded). */
  amount: number;
  /** The usage it covers, USD, exactly. */
  usage: number;
  status: 'pending' | 'paid' | 'failed';
  receiptUrl: string | null;
  failureReason: string | null;
  createdAt: string;
  paidAt: string | null;
  /** For an organization's monthly invoice: the month it covers ("2026-11"). */
  period?: string | null;
}

/** An organization that pays for this person's managed usage in its workspaces. */
export interface TeamPays {
  orgId: string;
  orgName: string;
  /** Requests in its workspaces may go out now; otherwise why not, in words. */
  ready: boolean;
  reason: string | null;
  /** This person's limit there per month, USD; null when only the organization's cap applies. */
  limit: number | null;
  /** What this person used there this month, USD. */
  spent: number;
}

export interface UsageLine {
  key: string;
  label: string;
  cost: number;
  calls: number;
}

export interface BillingState {
  /** This server offers managed usage (it has a provider key and payments). */
  available: boolean;
  /** Managed requests may go out now; otherwise why not, in words. */
  ready: boolean;
  reason: string | null;
  /** USD per calendar month (it starts again on the 1st, UTC); null with uncapped. */
  allowance: number | null;
  uncapped: boolean;
  consentAt: string | null;
  card: { brand: string; last4: string } | null;
  status: 'ok' | 'past_due';
  /** Billed managed usage (markup included) this month, paid personally. */
  spent: number;
  /** Usage not invoiced yet (it carries forward until the payment minimum). */
  unbilled: number;
  /** The payment minimum, USD. */
  minimum: number;
  invoices: Invoice[];
  /** The last 30 days of managed usage, by run, model and workspace. */
  usage: { byRun: UsageLine[]; byModel: UsageLine[]; byWorkspace: UsageLine[] };
  /** Organizations that pay for this person's usage in their workspaces. */
  teams: TeamPays[];
}

/** An organization's own billing, as its owners see it. */
export interface OrgBillingState {
  orgId: string;
  available: boolean;
  /** Team billing is turned on (an owner agreed and set the limits). */
  enabled: boolean;
  ready: boolean;
  reason: string | null;
  /** USD per month for the whole organization. */
  monthlyCap: number | null;
  /** USD per month each member may use unless set for them; null: only the cap. */
  memberLimit: number | null;
  card: { brand: string; last4: string } | null;
  status: 'ok' | 'past_due';
  company: {
    name: string | null;
    address: string | null;
    taxId: string | null;
    email: string | null;
  };
  /** This month so far, and where it is headed. */
  spent: number;
  projected: number;
  byMember: { userId: string; name: string; spent: number; limit: number | null; own: boolean }[];
  byWorkspace: UsageLine[];
  invoices: Invoice[];
}

export const OrgBillingSettingsSchema = z.object({
  monthlyCap: z.number().min(1).max(100_000),
  memberLimit: z.number().min(0.01).max(100_000).nullable(),
  consent: z.literal(true),
  consentVersion: z.literal(TEAM_BILLING_CONSENT_VERSION),
  company: z
    .object({
      name: z.string().trim().max(200).nullable(),
      address: z.string().trim().max(500).nullable(),
      taxId: z.string().trim().max(60).nullable(),
      email: z.string().trim().email().max(200).nullable(),
    })
    .partial()
    .default({}),
});

/** One member's own monthly limit in an organization that pays; null: the default applies. */
export const OrgMemberLimitSchema = z.object({
  monthlyLimit: z.number().min(0).max(100_000).nullable(),
});

export const BillingSettingsSchema = z
  .object({
    /** USD, markup included, tax excluded; null with uncapped. */
    allowance: z.number().min(0.01).max(100_000).nullable(),
    uncapped: z.boolean(),
    consent: z.literal(true),
    consentVersion: z.literal(BILLING_CONSENT_VERSION),
  })
  .refine((s) => s.uncapped === (s.allowance === null), {
    message: 'Choose an allowance, or explicitly choose unlimited',
  });
