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

## What it reads of Claude Code's

What he already wrote for Claude works here, in the same formats (`KOVAN_NO_CLAUDE=1` leaves everything of Claude's alone):

- **Skills**: `SKILL.md` folders in the repository's `.kovan/skills` and `.claude/skills`, the desktop app's own skill folder, and `~/.claude/skills`. The model is
  told which exist and loads one with `use_skill`; typing `/skill-name args` loads it for that turn. `/skills` lists them (and names any that could not be read).
- **Notes**: the repository's `KOVAN.md`, `AGENTS.md`, `CLAUDE.md` (and the rules in subfolders, read as the agent reaches them), plus his own `~/.kovan/KOVAN.md` and `~/.claude/CLAUDE.md`.
- **Custom commands**: `.kovan/commands/<name>.md`, `.claude/commands/<name>.md` and `~/.claude/commands/`; the file is the prompt, `$ARGUMENTS` / `$1`…`$9` are what he typed after the name.

Not yet: hooks, MCP servers from `.mcp.json`, Claude plugins (a folder with `.claude-plugin/` is not a skill), and `@file` / `!command` inside a command.

## In Coucou's notch

[Coucou](https://github.com/Louis-CFM/coucou) (MIT) is a notch companion for AI coding agents. It documents how any tool can show up next to Claude Code
(`docs/AGENTS.md`): newline-terminated hook JSON to its Unix socket, tagged `coucou_agent`. `kovan` speaks that, with no change to Coucou:

- a **kovan** pill with the session live: `SessionStart`, `UserPromptSubmit`, `PreToolUse` / `PostToolUse` per tool call ("Edit Invoice.swift", "Bash npm test", in Claude Code's tool names),
  `Stop` with the last words, `SessionEnd`; the terminal's identity is sent too so the notch can jump back to it.
- **approvals from the notch** (and Coucou's lock-screen and phone cards): when the agent asks permission, the terminal and the notch ask at once; the first real answer wins and the other question
  is withdrawn. `allow`, `always` (that tool, for the session) and `deny` come from the notch; `ask` or silence leaves it to the terminal. With nobody at the terminal, the notch alone can answer.
- Nothing changes when Coucou is not running (a missing, refused or silent socket is "no notch", never a wait). `KOVAN_NO_NOTCH=1` turns it off, `KOVAN_NOTCH_SOCKET=<path>` points at another socket.
  Looks for the GitHub build's `~/Library/Application Support/NotchBuddy/nb.sock`, then the App Store build's.

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
