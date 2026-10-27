# Managed usage and billing

With managed usage you run models without a provider key of your own. Kovan's server calls the model and bills you what the provider charged × 1.05.

## What it costs

Managed usage is the provider's actual token cost for each call, multiplied by 1.05 once. The cost shown under each turn in the app is the amount you pay.

If you use your own provider key instead, you pay the provider directly and Kovan adds nothing.

## Who pays

The person who starts a run pays for all of it. That includes the subagents it starts, the agents of a Swarm, the work of an AI teammate you added, and JevRouter's routing calls.

## Setting it up

Managed requests start only when all three of these are in place:

1. **A saved card.** You enter it on the payment processor's hosted page. Card details never reach Kovan.
2. **An allowance.** A dollar amount, or explicitly unlimited.
3. **Your authorization** of the daily charges, by accepting the consent text.

You can do this in the app under **Settings → Billing & usage**, or on the [billing page](/account/billing/) of this site.

## The allowance

The allowance is the most managed usage you can run before requests stop.

- It is one amount shared by all your workspaces and every run going at the same time.
- It includes the × 1.05 and excludes tax.
- It is checked before every model call, so a run can go over by at most one call.
- Changing or resetting it starts the count again. Unpaid invoices and usage not yet charged are kept.

## Charges

Usage is charged to your card once a day. A balance below the payment minimum is not charged; it carries forward to the next day.

A run you cancel still pays for the usage the provider confirms it did.

## When a payment fails

Your account becomes past due and new managed requests stop with a message that says why. Retry the invoice or replace the card from the billing page. Once the invoice is paid, requests work again without any other step.

## Seeing your usage

The billing page shows:

- your status, allowance and saved card,
- usage that has not been charged yet,
- invoices, each with a receipt link, and
- the last 30 days of managed usage by run, by model and by workspace.

## Servers without managed usage

A Kovan server only offers managed usage when it has been configured for it. Where it has not, the billing page says so, and you can still run models with your own key.
