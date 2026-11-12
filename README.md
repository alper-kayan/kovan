# Kovan

Kovan is a multiplayer desktop IDE where a software team and its AI coding agents work in one
shared, live session. Everyone runs their own agent on their own machine (Kovan's built-in
agent, Claude Code or Codex) and the whole team sees every lane as it happens: what each agent
reads and edits, which approvals it waits on, and what it costs. Anyone can steer, take over or
hand off an agent's work, and agents check with each other before they touch the same files.

Website and downloads: <https://kovan.alperkayan.dev> (macOS, Windows, Linux; iOS and Android
companion apps).

## What it does

- **Shared sessions.** Each person's agent runs in a lane of the session. Teammates see
  streamed text, tool calls, diffs and approvals live, comment on a plan, steer a running turn
  or take it over when someone's usage limit runs out.
- **Your agent, your account.** Kovan's own agent works with 180+ models through OpenRouter
  (with JevRouter picking a model per task) or any OpenAI-compatible provider. Claude Code and
  Codex run as first-class lanes (`claude -p` stream JSON and `codex app-server`), on the
  person's own subscription, with automatic fallback down an agent + model order when one hits
  its limit.
- **Coordination before conflict.** Before an agent writes a file it is told about files that
  other live sessions have locked, changed or planned, and about nearby changes in the import
  graph. Agents share team context and memory over MCP.
- **Swarm.** A lead agent splits a task into a graph of subtasks for several agents, each in
  its own git worktree, then runs the project's own checks (typecheck, lint, test, build) and
  marks the work verified only if they pass. Persistent AI teammates can be mentioned like people.
- **Runs without a desk.** `agentd` takes work on a machine nobody sits at (a server, a
  Raspberry Pi) and reports back. An API with scoped keys, webhooks and an event stream lets
  other systems send work and follow it.
- **Phone.** The mobile app shows every lane, sends push notifications when an agent needs an
  answer, and approves (right from the notification), steers or starts work. It does not run agents.

## Repository

| Path                        | What                                                                    |
| --------------------------- | ----------------------------------------------------------------------- |
| `apps/desktop`              | Electron + React + Monaco app                                           |
| `apps/server`               | Coordination server: Fastify + WebSocket + PostgreSQL (Drizzle)         |
| `apps/mobile`               | Expo app for iOS and Android                                            |
| `apps/web`                  | Website: landing page, docs, model catalog, downloads, account          |
| `packages/cli`              | `kovan`, the terminal agent                                             |
| `packages/harness`          | Kovan's own agent loop, tools and approvals                             |
| `packages/runner`           | Running sessions: Claude Code and Codex lanes, Swarm, worktrees, checks |
| `packages/agentd`           | Headless daemon that runs agents on an unattended machine               |
| `packages/model-gateway`    | OpenRouter and OpenAI-compatible model access, usage and cost           |
| `packages/jevrouter`        | Picks a model for each task                                             |
| `packages/mcp-client`       | MCP client (stdio and HTTP, OAuth)                                      |
| `packages/mcp-coordination` | MCP server that gives external agents Kovan's team context              |
| `packages/git-engine`       | Wrapper around the system `git` (status, diff, stage, commit, branches) |
| `packages/shared`           | Shared types, schemas and the role/permission matrix                    |

Product notes (in Turkish) are in [docs/FEATURES.md](docs/FEATURES.md); self-hosting, signing and
release steps are in [deploy/README.md](deploy/README.md).

## Development

Requirements: Node >= 22.12 (see `.nvmrc`), pnpm 11, Docker.

```sh
pnpm install
cp .env.example .env
pnpm db:up        # Postgres 17 on localhost:5433
pnpm build
pnpm test         # server tests need the Postgres above
pnpm --filter @kovan/server dev    # coordination server on http://localhost:4807
pnpm --filter @kovan/desktop dev   # run the desktop app
```

Without `SMTP_URL`, the server doesn't send mail: sign-in and verification links are printed in
the server log and listed at `http://localhost:4807/dev/outbox`. GitHub and Google sign-in turn on
once their OAuth credentials are in `.env` (callback URLs: `http://localhost:4807/auth/github/callback`
and `http://localhost:4807/auth/google/callback`).

Open a folder straight away with `KOVAN_OPEN_FOLDER=<path>`. For end-to-end checks without
stealing focus, also set `KOVAN_REMOTE_DEBUG_PORT=9333` and drive the renderer with
`node apps/desktop/scripts/cdp.mjs '<js>'` (see the script header).

## Security

Please report vulnerabilities privately as described in [SECURITY.md](SECURITY.md).

## License

Kovan is free software under the [GNU Affero General Public License v3.0](LICENSE)
(`AGPL-3.0-only`). If you run a modified version as a network service, you must offer its
source to the people who use it.
