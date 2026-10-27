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

export const BILLING_CONSENT_VERSION = '2026-10-13';
export const BILLING_CONSENT =
  "I authorize Kovan to charge my saved payment method once a day, off-session, for managed model usage at the provider's token cost × 1.05, up to the allowance I choose (or without a limit if I choose unlimited). Balances under the payment minimum carry forward. Tax, where it applies, is shown separately.";

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
  allowance: number | null;
  uncapped: boolean;
  consentAt: string | null;
  card: { brand: string; last4: string } | null;
  status: 'ok' | 'past_due';
  /** Billed managed usage (markup included) since the allowance was last set or reset. */
  spent: number;
  /** Usage not invoiced yet (it carries forward until the payment minimum). */
  unbilled: number;
  /** The payment minimum, USD. */
  minimum: number;
  invoices: Invoice[];
  /** The last 30 days of managed usage, by run, model and workspace. */
  usage: { byRun: UsageLine[]; byModel: UsageLine[]; byWorkspace: UsageLine[] };
}

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
