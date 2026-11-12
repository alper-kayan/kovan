import { BILLING_CONSENT_VERSION, type BillingState } from '@kovan/shared';
import { reportError, setState, toast } from '../store';
import { api } from './api';

const request = <T>(method: 'GET' | 'POST' | 'PUT', path: string, body?: unknown) =>
  (body === undefined
    ? api.invoke('brain:request', method, path)
    : api.invoke('brain:request', method, path, body)) as Promise<T>;

/** Whether Kovan billing can pay for models changed: the chat's "ready" check reads it again. */
const refreshProviders = () =>
  void api
    .invoke('providers:status')
    .then((providers) => setState({ providers }))
    .catch(() => undefined);

export async function loadBilling(): Promise<BillingState | null> {
  return request<{ billing: BillingState }>('GET', '/api/billing')
    .then((r) => {
      refreshProviders();
      return r.billing;
    })
    .catch(() => null);
}

/** Saves the allowance (or explicitly unlimited) with the person's consent. */
export async function saveAllowance(allowance: number | null): Promise<BillingState | null> {
  try {
    const { billing } = await request<{ billing: BillingState }>('PUT', '/api/billing', {
      allowance,
      uncapped: allowance === null,
      consent: true,
      consentVersion: BILLING_CONSENT_VERSION,
    });
    toast(
      allowance === null
        ? 'Kovan billing has no monthly limit now.'
        : `Allowance set to $${allowance.toFixed(2)}.`,
    );
    refreshProviders();
    return billing;
  } catch (error) {
    reportError(error);
    return null;
  }
}

/** Opens Stripe's page to save a card; Kovan never sees the card details. */
export async function addCard(): Promise<void> {
  try {
    const { url } = await request<{ url: string }>('POST', '/api/billing/setup');
    window.open(url, '_blank');
    toast('Add your card on the Stripe page in your browser, then come back here.');
  } catch (error) {
    reportError(error);
  }
}

export async function retryInvoice(id: string): Promise<BillingState | null> {
  try {
    const { invoice } = await request<{ invoice: { status: string } }>(
      'POST',
      `/api/billing/invoices/${id}/retry`,
    );
    toast(
      invoice.status === 'paid' ? 'Paid. Kovan billing is back on.' : 'The payment failed again.',
    );
    return loadBilling();
  } catch (error) {
    reportError(error);
    return null;
  }
}
