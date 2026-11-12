# Paying for AI: Kovan billing

With Kovan billing you run models without a provider key of your own. Kovan's server calls the model and bills you what the provider charged × 1.05.

## What it costs

Kovan billing charges the provider's actual token cost for each call, multiplied by 1.05 once. The cost shown under each turn in the app is the amount you pay.

If you use your own provider key instead, you pay the provider directly and Kovan adds nothing.

## Who pays

The person who starts a run pays for all of it. That includes the subagents it starts, the agents of a Swarm, the work of an AI teammate you added, and JevRouter's routing calls.

An organization can pay instead: with **team billing** on, it pays for its members' runs in its own workspaces, so nobody there needs a key or a card of their own. Outside its workspaces, each person still pays for themselves.

## Setting it up

Managed requests start only when all three of these are in place:

1. **A saved card.** You enter it on the payment processor's hosted page. Card details never reach Kovan.
2. **A monthly allowance.** A dollar amount, or explicitly unlimited.
3. **Your authorization** of the daily charges, by accepting the consent text.

You can do this in the app under **Settings → Billing & usage**, or on the [billing page](/account/billing/) of this site.

## The allowance

The allowance is the most you can spend on models through Kovan in a calendar month before requests stop.

- It is one amount shared by all your workspaces and every run going at the same time.
- It includes the × 1.05 and excludes tax.
- It starts again on the 1st of each month (UTC). Raising it mid-month keeps what you spent that month.
- It is checked before every model call, and calls already running count towards it, so agents running side by side can't all slip past it.
- When it runs out you get one email that month. Unpaid invoices and usage not yet charged are kept.

## Team billing

An owner turns it on under **Settings → Organization → Team billing** and chooses:

- **a monthly limit for the organization**, all members together;
- **a monthly limit per member**, which an owner can change for one person (or leave empty for no limit of their own);
- the **company's details** (name, address, tax ID, billing email) for its receipts and invoices; and
- the organization's own **card**, saved on the payment processor's page.

Members see their limit and what they used under **Settings → Billing & usage**. The owner sees what each member and each workspace spent this month, and where the month is headed at its pace so far. The organization is charged once a month, for the month before, as one invoice; its receipt goes to the billing email (or to its owners). When the organization's limit or a member's limit runs out, the people it matters to get one email that month.

## Charges

Personal usage is charged to your card once a day; each charge sends a receipt. A balance below the payment minimum is not charged; it carries forward to the next day. Invoices are kept for tax records even after an account is deleted.

A run you cancel still pays for the usage the provider confirms it did.

## When a payment fails

Your account (or the organization) becomes past due, an email says so, and new managed requests stop with a message that says why. Retry the invoice or replace the card from the billing page. Once the invoice is paid, requests work again without any other step.

## Seeing your usage

The billing page shows:

- your status, allowance and saved card,
- usage that has not been charged yet,
- invoices, each with a receipt link, and
- the last 30 days of models paid through Kovan, by run, by model and by workspace.

## Servers without Kovan billing

A Kovan server only offers Kovan billing when it has been configured for it. Where it has not, the billing page says so, and you can still run models with your own key.
