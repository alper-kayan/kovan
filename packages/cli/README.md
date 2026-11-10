# @kovan/cli: `kovan`, the coding agent in the terminal

The same agent loop as the desktop app and `agentd` (`@kovan/harness`: tools, permission modes, context compaction, runaway guard,
skills, `KOVAN.md` rules), with a prompt in front of it. No new agent, no third-party terminal agent underneath.

```
kovan                       a conversation with the agent, in this folder
kovan "fix the failing test"  one message: it does the work and exits
kovan -c                    pick up the last session in this folder
kovan -r <name|id>          pick up a session by its name or id, in the folder it was held in
kovan sessions [--json]     sessions kept on this machine (~/.kovan/sessions, readable only by you)
kovan sessions export <id>  what a surrounding tool may remember of one: first ask, how it ended, files changed
kovan config                which server and model it talks to (never the key)
```

`--mode plan|request|allow|full` (default `allow`: edits freely, asks before commands), `-m <model>`, `--effort`, `--context-file <file>`
(extra instructions appended to the system prompt), `--reasoning`, `--cwd`. In the conversation: `/mode /model /models /resume /rename /clear /cost /context /help /exit` (`/rename <name>` names it; `/resume` lists every session, this folder's first).
Ctrl+C stops a running turn; at the prompt it leaves.

## Install

```sh
curl -fsSL https://kovan.alperkayan.dev/install.sh | sh      # macOS and Linux
irm https://kovan.alperkayan.dev/install.ps1 | iex           # Windows, in PowerShell
```

Node.js 22 or newer. On Windows the `kovan` command goes to `%USERPROFILE%\.kovan\bin`, added to the user PATH. It goes to `~/.kovan/cli/kovan.mjs` with a `kovan` command in `~/.local/bin`, checked against
the release key before it is installed, and keeps itself up to date (see Updates below). Remove it with
`rm -rf ~/.kovan/cli ~/.local/bin/kovan`.

## What it reads of Claude Code's

What you already wrote for Claude works here, in the same formats (`KOVAN_NO_CLAUDE=1` leaves everything of Claude's alone):

- **Skills**: `SKILL.md` folders in the repository's `.kovan/skills` and `.claude/skills`, the desktop app's own skill folder, and `~/.claude/skills`. The model is
  told which exist and loads one with `use_skill`; typing `/skill-name args` loads it for that turn. `/skills` lists them (and names any that could not be read).
- **Notes**: the repository's `KOVAN.md`, `AGENTS.md`, `CLAUDE.md` (and the rules in subfolders, read as the agent reaches them), plus your own `~/.kovan/KOVAN.md` and `~/.claude/CLAUDE.md`.
- **Custom commands**: `.kovan/commands/<name>.md`, `.claude/commands/<name>.md` and `~/.claude/commands/`; the file is the prompt, `$ARGUMENTS` / `$1`…`$9` are what you typed after the name.

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

## Reporting to a status server of your own

`kovan` can report to any HTTP server you run, so a notch, a phone app or a chat bot reading from it can show what it is doing and
answer its permission questions. Set `KOVAN_HOOK_URL` and `KOVAN_HOOK_TOKEN` (or put them as `NAME=value` lines in `~/.kovan/hook.env`);
the token goes in `Authorization: Bearer`, or in the header named by `KOVAN_HOOK_TOKEN_HEADER`. Only a one-line summary (tool, file or
command, folder) is sent. The server answers four calls, described at the top of `src/hook-notch.ts`:
`POST /api/kovan/live`, `POST` / `GET` (long poll) / `DELETE /api/kovan/approval`. The terminal asks as well, and the first answer wins.
Nothing is sent when it is not set up; `KOVAN_NO_NOTCH=1` turns it off.

## Which model server

Anything OpenAI-compatible. OpenRouter is the default (the same one Kovan's own agent uses):

```sh
export OPENROUTER_API_KEY=…                       # openrouter/auto unless you pass -m
# or a gateway of your own (OmniRoute, a local server):
export KOVAN_BASE_URL=http://localhost:20128/v1 KOVAN_MODEL=auto/best-coding-fast  # KOVAN_API_KEY if it wants one
```

The same fields can live in `~/.config/kovan/agent.json` (`baseUrl`, `apiKey`, `model`, `dialect`); the environment wins.

Your own key or gateway always comes first. Signed in with `kovan login` and with nothing of your own set up, `kovan` uses your Kovan
account's managed usage instead (billed to the account, provider cost + 5%), if the server offers it. `KOVAN_PROVIDER=managed` asks
for the account even when you have a key; `KOVAN_PROVIDER=own` never falls back to it.

## Asking before it acts

`allow`/`request` ask before a command (and, in `request`, an edit): `y`es, `n`o, or `a`lways (this tool, for the rest of the session). Without a terminal
there is nobody to ask, so it refuses and says to use `--mode full`.

## Updates

A bundle (`pnpm --filter @kovan/cli bundle`) looks for a newer version every twelve hours and replaces itself only when the manifest
is signed with the release key (`latest.json.sig`, Ed25519, the desktop's Linux update key) and the file matches the manifest's hash.
Build the bundle with `KOVAN_UPDATE_PUBLIC_KEY` set, or it never updates itself; sign with `KOVAN_UPDATE_PRIVATE_KEY` set, or
installed copies won't accept it. `KOVAN_NO_UPDATE=1` turns updates off.

## Build and test

```sh
pnpm --filter @kovan/cli build     # dist/index.js is the `kovan` bin
pnpm --filter @kovan/cli test      # scripted model, scripted terminal, and a real OpenAI-compatible server
```
