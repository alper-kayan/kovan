# @kovan/cli: `kovan`, the coding agent in the terminal

The same agent loop as the desktop app and `agentd` (`@kovan/harness`: tools, permission modes, context compaction, runaway guard,
skills, `KOVAN.md` rules), with a prompt in front of it. No new agent, no third-party terminal agent underneath.

```
kovan                       a conversation with the agent, in this folder
kovan "fix the failing test"  one message: it does the work and exits
kovan -c                    pick up the last session in this folder
kovan sessions [--json]     sessions kept on this machine (~/.kovan/sessions, readable only by you)
kovan sessions export <id>  what a surrounding tool may remember of one: first ask, how it ended, files changed
kovan config                which server and model it talks to (never the key)
```

`--mode plan|request|allow|full` (default `allow`: edits freely, asks before commands), `-m <model>`, `--effort`, `--context-file <file>`
(extra instructions appended to the system prompt), `--reasoning`, `--cwd`. In the conversation: `/mode /model /models /clear /cost /context /help /exit`.
Ctrl+C stops a running turn; at the prompt it leaves.

## Which model server

Anything OpenAI-compatible. OpenRouter is the default (the same one Kovan's own agent uses):

```sh
export OPENROUTER_API_KEY=…                       # openrouter/auto unless you pass -m
# or a gateway of your own (OmniRoute, a local server):
export KOVAN_BASE_URL=http://localhost:20128/v1 KOVAN_MODEL=auto/best-coding-fast  # KOVAN_API_KEY if it wants one
```

The same fields can live in `~/.config/kovan/agent.json` (`baseUrl`, `apiKey`, `model`, `dialect`); the environment wins.

## Asking before it acts

`allow`/`request` ask before a command (and, in `request`, an edit): `e`vet, `h`ayır, or `t`ümüne (this tool, for the rest of the session). Without a terminal
there is nobody to ask, so it refuses and says to use `--mode full`.

## Build and test

```sh
pnpm --filter @kovan/cli build     # dist/index.js is the `kovan` bin
pnpm --filter @kovan/cli test      # scripted model, scripted terminal, and a real OpenAI-compatible server
```
