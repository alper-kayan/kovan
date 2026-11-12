# AI models and JevRouter

Kovan's own agent can use hundreds of models through OpenRouter ([the current list](/models/)). You can pick one yourself or let JevRouter pick one for each task.

## The catalog

The [models page](/models/) lists every model with its context size and price per million tokens. The same catalog is in the app, where it also shows which models support tools, images and reasoning.

## Choosing a model

The composer has a single model pill. Click it for a searchable picker with prices and context sizes. Models that support reasoning also show their effort levels.

The composer always shows the exact model the next turn will use and who pays for it.

## Your key or Kovan billing

There are two ways to pay for models:

- **Your own OpenRouter key.** Kovan stores it in your operating system's keychain. You pay OpenRouter directly and Kovan adds nothing.
- **Kovan billing.** Kovan's server calls the model for you and bills you the provider's cost × 1.05. See [Paying for AI](/docs/managed-usage-and-billing/).

You can also add any OpenAI-compatible endpoint as a custom provider in **Settings → Model keys & spend**.

## JevRouter

JevRouter chooses a model per task instead of using one model for everything. Choose **JevRouter** in the model picker to turn it on.

### How it decides

- **It reads the whole conversation.** The decision uses the conversation so far, the open plan step and recent tool results, not only your last message.
- **It works in tiers.** Models are grouped as economy, balanced and frontier. Small questions and edits go to cheaper models; multi-file changes and hard debugging go to stronger ones. If the context does not fit, it moves to a model with a longer context.
- **It keeps your cache warm.** The model changes only when the task changes. Within a task the model stays the same, so prompt caching keeps working.
- **It escalates.** Repeated failed edits, tool errors or failing tests move the task up a tier.

### Steering it

Write a directive anywhere in a prompt. It is removed from the text before the model sees it.

| Directive                                              | Effect                        |
| ------------------------------------------------------ | ----------------------------- |
| `[jev: only use Opus]`                                 | Pin a model by name.          |
| `[jev: economy]`, `[jev: balanced]`, `[jev: frontier]` | Use that tier.                |
| `[jev: max balanced]`                                  | Never go above that tier.     |
| `[jev: auto]`                                          | Go back to automatic routing. |

### What it costs

Routing decisions use a small model, and those calls are part of the run's cost. The cost of each turn is shown under it once the provider reports it.

> The animations on the home page show how routing and the Arena work. Their numbers are not benchmark results. What JevRouter saves depends on your work.

## Spend

**Settings → Model keys & spend** shows what each workspace has spent. A session's side panel shows usage per turn.
