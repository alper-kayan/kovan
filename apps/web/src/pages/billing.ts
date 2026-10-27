import type { BillingState, Invoice, UsageLine } from '@kovan/shared';
import '../site';
import '../styles/pages.css';
import { api } from '../lib/api';
import { h, safeUrl } from '../lib/dom';
import { errorText, mountSession, type SessionView } from '../lib/session';

const root = document.querySelector<HTMLElement>('[data-app]')!;

/** Dollars to the cent; `exact` keeps up to four decimals for amounts that are not rounded yet. */
const usd = (value: number, exact = false) =>
  `$${value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: exact ? 4 : 2 })}`;

const day = (iso: string) => {
  const date = new Date(iso);
  return Number.isNaN(date.getTime())
    ? '—'
    : date.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
};

const CARD_BRANDS: Record<string, string> = {
  visa: 'Visa',
  mastercard: 'Mastercard',
  amex: 'American Express',
  discover: 'Discover',
};

function statusPanel(billing: BillingState): HTMLElement {
  const limit = billing.uncapped ? null : billing.allowance;
  const figures = h(
    'div',
    { class: 'figures' },
    h(
      'div',
      { class: 'figure' },
      h('b', {}, usd(billing.spent)),
      h(
        'span',
        {},
        limit === null
          ? billing.uncapped
            ? 'spent, no limit set'
            : 'spent'
          : `spent of ${usd(limit)}`,
      ),
    ),
    h(
      'div',
      { class: 'figure' },
      h('b', {}, usd(billing.unbilled, true)),
      h('span', {}, 'not charged yet'),
    ),
    h(
      'div',
      { class: 'figure' },
      h('b', {}, usd(billing.minimum)),
      h('span', {}, 'payment minimum; smaller balances carry forward'),
    ),
  );
  const panel = h(
    'section',
    { class: 'panel' },
    h(
      'div',
      { class: 'panel-head' },
      h('h2', {}, 'Managed usage'),
      billing.status === 'past_due'
        ? h('span', { class: 'tag-bad' }, 'payment failed')
        : h(
            'span',
            { class: billing.ready ? 'tag-ok' : 'tag-dim' },
            billing.ready ? 'ready' : 'not set up',
          ),
    ),
  );
  if (billing.status === 'past_due')
    panel.append(
      h(
        'p',
        { class: 'message bad' },
        'A payment failed, so new managed requests are paused. Retry the invoice below or replace the card.',
      ),
    );
  else if (!billing.ready && billing.reason)
    panel.append(h('p', { class: 'message warn' }, billing.reason));
  panel.append(figures);
  if (limit !== null && limit > 0) {
    const used = Math.min(100, Math.round((billing.spent / limit) * 100));
    const fill = h('i', {});
    fill.style.width = `${used}%`;
    panel.append(
      h(
        'div',
        { class: 'meter', role: 'img', 'aria-label': `${used}% of the allowance used` },
        fill,
      ),
    );
  }
  return panel;
}

function cardPanel(billing: BillingState, view: SessionView): HTMLElement {
  const notice = h('p', { class: 'message', hidden: true });
  const button = h(
    'button',
    { class: 'btn btn-secondary', type: 'button' },
    billing.card ? 'Replace card' : 'Add a card',
  );
  const refresh = h(
    'button',
    { class: 'btn btn-secondary', type: 'button', hidden: true },
    'I saved my card',
  );
  refresh.addEventListener('click', view.reload);
  button.addEventListener('click', () => {
    // Opened with the click; the checkout page is loaded into it once the server returns it.
    const tab = window.open('', '_blank');
    button.disabled = true;
    api
      .post<{ url: string }>('/api/billing/setup')
      .then(({ url }) => {
        const checkout = safeUrl(url);
        if (!checkout) throw new Error('The server sent a card page that cannot be opened.');
        if (tab && !tab.closed) {
          tab.opener = null;
          tab.location.replace(checkout);
          notice.textContent = 'Save your card in the tab that opened, then come back here.';
        } else {
          notice.replaceChildren(
            'Your browser blocked the new tab. ',
            h(
              'a',
              { class: 'link', href: checkout, target: '_blank', rel: 'noopener' },
              'Open the card page',
            ),
            ', then come back here.',
          );
        }
        notice.className = 'message';
        notice.hidden = false;
        refresh.hidden = false;
      })
      .catch((error: unknown) => {
        tab?.close();
        if (isSignedOut(error)) return view.fail(error);
        notice.textContent = errorText(error);
        notice.className = 'message bad';
        notice.hidden = false;
      })
      .finally(() => (button.disabled = false));
  });

  return h(
    'section',
    { class: 'panel' },
    h('div', { class: 'panel-head' }, h('h2', {}, 'Payment method')),
    notice,
    h(
      'p',
      { class: 'panel-text' },
      billing.card
        ? `${CARD_BRANDS[billing.card.brand] ?? billing.card.brand} ending in ${billing.card.last4}.`
        : 'No card saved. Card details are entered on the payment processor’s page and never reach Kovan.',
    ),
    h('div', { class: 'actions' }, button, refresh),
  );
}

const isSignedOut = (error: unknown) =>
  typeof error === 'object' && error !== null && (error as { status?: number }).status === 401;

function allowancePanel(billing: BillingState, view: SessionView): HTMLElement {
  const capped = h('input', { type: 'radio', name: 'limit', value: 'capped', id: 'limit-capped' });
  const open = h('input', { type: 'radio', name: 'limit', value: 'uncapped', id: 'limit-open' });
  const amount = h('input', {
    class: 'input',
    type: 'number',
    min: '0.01',
    max: '100000',
    step: '0.01',
    inputmode: 'decimal',
    'aria-label': 'Allowance in US dollars',
    value: billing.allowance ?? 25,
  });
  (billing.uncapped ? open : capped).checked = true;
  amount.addEventListener('focus', () => (capped.checked = true));

  const consent = h('input', { type: 'checkbox', id: 'consent', required: true });
  const notice = h('p', { class: 'message', hidden: true });
  const save = h('button', { class: 'btn btn-primary', type: 'submit' }, 'Save allowance');

  const form = h(
    'form',
    { class: 'allowance', novalidate: true },
    h(
      'p',
      { class: 'panel-text' },
      'The allowance is the most managed usage you can run before requests stop. It is shared by all your workspaces and runs, includes the × ',
      String(__MANAGED_MARKUP__),
      ' and excludes tax. Saving it starts the count again.',
    ),
    h(
      'label',
      { class: 'choice', for: 'limit-capped' },
      capped,
      'Up to',
      h('span', { class: 'mono' }, '$'),
      amount,
    ),
    h('label', { class: 'choice', for: 'limit-open' }, open, 'Unlimited: no cap on managed usage'),
    h('label', { class: 'consent', for: 'consent' }, consent, h('span', {}, __BILLING_CONSENT__)),
    notice,
    h('div', {}, save),
  );

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    const fail = (text: string) => {
      notice.textContent = text;
      notice.className = 'message bad';
      notice.hidden = false;
    };
    const uncapped = open.checked;
    const value = Math.round(Number(amount.value) * 100) / 100;
    if (!uncapped && !(value >= 0.01 && value <= 100_000))
      return fail('Enter an allowance between $0.01 and $100,000, or choose unlimited.');
    if (!consent.checked) return fail('Tick the box to authorize the charges before saving.');
    save.disabled = true;
    api
      .put<{ billing: BillingState }>('/api/billing', {
        allowance: uncapped ? null : value,
        uncapped,
        consent: true,
        consentVersion: __BILLING_CONSENT_VERSION__,
      })
      .then(({ billing: next }) => renderBilling(next, view, 'Allowance saved.'))
      .catch((error: unknown) => {
        save.disabled = false;
        if (isSignedOut(error)) return view.fail(error);
        fail(errorText(error));
      });
  });

  return h(
    'section',
    { class: 'panel' },
    h(
      'div',
      { class: 'panel-head' },
      h('h2', {}, 'Allowance'),
      billing.consentAt
        ? h('span', { class: 'tag-dim' }, `authorized ${day(billing.consentAt)}`)
        : null,
    ),
    form,
  );
}

function invoiceRow(invoice: Invoice, view: SessionView): HTMLElement {
  const receipt = safeUrl(invoice.receiptUrl);
  const actions = h('td', {});
  if (receipt)
    actions.append(
      h(
        'a',
        { class: 'link', href: receipt, target: '_blank', rel: 'noopener noreferrer' },
        'Receipt',
      ),
    );
  if (invoice.status === 'failed') {
    const retry = h(
      'button',
      { class: 'btn btn-secondary btn-sm', type: 'button' },
      'Retry payment',
    );
    retry.addEventListener('click', () => {
      retry.disabled = true;
      retry.textContent = 'Retrying…';
      api
        .post(`/api/billing/invoices/${encodeURIComponent(invoice.id)}/retry`)
        .then(() => loadBilling(view, 'Payment retried.'))
        .catch((error: unknown) => {
          if (isSignedOut(error)) return view.fail(error);
          retry.disabled = false;
          retry.textContent = 'Retry payment';
          actions.append(h('p', { class: 'message bad' }, errorText(error)));
        });
    });
    actions.append(retry);
  }
  const tag =
    { paid: 'tag-ok', pending: 'tag-warn', failed: 'tag-bad' }[invoice.status] ?? 'tag-dim';
  return h(
    'tr',
    {},
    h('td', {}, day(invoice.createdAt)),
    h('td', { class: 'num' }, usd(invoice.amount)),
    h('td', { class: 'num' }, usd(invoice.usage, true)),
    h(
      'td',
      { class: 'left' },
      h('span', { class: tag }, invoice.status),
      invoice.status === 'failed' && invoice.failureReason ? ` ${invoice.failureReason}` : null,
    ),
    actions,
  );
}

function invoicesPanel(billing: BillingState, view: SessionView): HTMLElement {
  const panel = h(
    'section',
    { class: 'panel' },
    h('div', { class: 'panel-head' }, h('h2', {}, 'Invoices')),
  );
  if (!billing.invoices.length) {
    panel.append(
      h(
        'p',
        { class: 'panel-text' },
        'No invoices yet. Usage is charged once a day when it passes the minimum.',
      ),
    );
    return panel;
  }
  const body = h('tbody', {});
  for (const invoice of billing.invoices) body.append(invoiceRow(invoice, view));
  const heading = (label: string, left = false) =>
    h('th', { scope: 'col', class: left ? 'left' : null }, h('span', {}, label));
  panel.append(
    h(
      'div',
      { class: 'table-wrap' },
      h(
        'table',
        { class: 'data-table' },
        h(
          'thead',
          {},
          h(
            'tr',
            {},
            heading('Date'),
            heading('Charged'),
            heading('Usage'),
            heading('Status', true),
            heading(''),
          ),
        ),
        body,
      ),
    ),
  );
  return panel;
}

function usageList(title: string, lines: UsageLine[]): HTMLElement {
  const list = h('ul', { class: 'usage-list' });
  for (const line of lines.slice(0, 12))
    list.append(
      h(
        'li',
        {},
        h('span', { title: line.label }, line.label),
        h('span', { class: 'num' }, `${usd(line.cost)} · ${line.calls}`),
      ),
    );
  if (!lines.length) list.append(h('li', {}, h('span', {}, 'Nothing yet')));
  return h('div', {}, h('p', { class: 'subhead' }, title), list);
}

function usagePanel(billing: BillingState): HTMLElement {
  return h(
    'section',
    { class: 'panel' },
    h('div', { class: 'panel-head' }, h('h2', {}, 'Usage, last 30 days')),
    h(
      'p',
      { class: 'panel-text' },
      'What you paid for managed usage, with the number of model calls.',
    ),
    h(
      'div',
      { class: 'usage-grid' },
      usageList('By run', billing.usage.byRun),
      usageList('By model', billing.usage.byModel),
      usageList('By workspace', billing.usage.byWorkspace),
    ),
  );
}

function renderBilling(billing: BillingState, view: SessionView, notice?: string): void {
  const head = h(
    'header',
    { class: 'page-head' },
    h('p', { class: 'crumbs' }, h('a', { href: '/account/' }, 'Account'), ' / Billing'),
    h('h1', {}, 'Billing and usage'),
    h(
      'p',
      {},
      `Managed usage costs the provider's token price × ${__MANAGED_MARKUP__}, charged to your card once a day.`,
    ),
  );
  if (!billing.available) {
    root.replaceChildren(
      head,
      h(
        'p',
        { class: 'message warn' },
        "This server doesn't offer managed usage. You can still run models with your own provider key in the app.",
      ),
    );
    return;
  }
  root.replaceChildren(
    head,
    ...(notice ? [h('p', { class: 'message ok spaced', role: 'status' }, notice)] : []),
    statusPanel(billing),
    cardPanel(billing, view),
    allowancePanel(billing, view),
    invoicesPanel(billing, view),
    usagePanel(billing),
  );
}

function loadBilling(view: SessionView, notice?: string): Promise<void> {
  return api
    .get<{ billing: BillingState }>('/api/billing')
    .then(({ billing }) => renderBilling(billing, view, notice))
    .catch(view.fail);
}

mountSession(root, 'Billing', (_me, view) => loadBilling(view));
