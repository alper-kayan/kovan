<!-- One "## <version> · <date>" heading per release, newest first. -->

## 0.1.9 · 2026-11-10

### Agents

- In **Settings → Agents → Accounts**, a signed-in account no longer offers **Sign in**, and a long email no longer runs into the buttons. Each account shows its usage under its status, or that it shows after the account's first turn.

## 0.1.8 · 2026-11-10

### Agents

- Claude Code and Codex run only as accounts you add in **Settings → Agents → Accounts**; Kovan no longer uses the sign-in the CLI already has on your computer. If you used Claude Code or Codex in Kovan before, add your account there once: it signs in inside Kovan, and your conversations carry on with it.

## 0.1.7 · 2026-10-26

### Agents

- Adding a Claude Code or Codex account opens one sign-in, in view: the terminal shows in the editor, and a second click brings that sign-in back instead of opening another browser page.

## 0.1.6 · 2026-10-25

### Agents

- When Claude Code hands work to helper agents, their steps show under the task that started them, and a helper's request for approval gets its card. Before, such a request never showed, and the run waited.

## 0.1.5 · 2026-10-25

### Updates

- Kovan looks for a new version as soon as it opens again, then every ten minutes.

## 0.1.4 · 2026-10-25

### Updates

- Kovan looks for a new version every ten minutes, the first time ten minutes after it opens ("Check for updates" in Settings → General looks right away).

## 0.1.3 · 2026-10-25

### Call a teammate in with @

- Write "@" and an AI teammate's name in your agent conversation or in a session comment, and that teammate looks into it: it reads the conversation (or the comment thread and the code it is about) and answers right there, as a reply in the conversation or its own comment in the thread.
- It reads freely, and asks you before it changes a file or runs a command. Approve it on the desktop or from the notification on your phone.
- A teammate that isn't in the session joins it when you call it in, and runs on your machine.
- On the phone: the same @ suggestions in the box for your agent and on code comments, and the answers in your lane.
- AI teammates look like themselves everywhere: an amber robot with an AI badge.

### Your account

- Change your name in Settings → Account, and choose Kovan's picture or your GitHub photo.

### Updates

- While an update downloads, the sidebar shows it with its progress, then "Update ready".

## 0.1.2 · 2026-10-25

### Updates

- New versions download on their own; when one is ready, a pill above your name in the sidebar restarts Kovan into it.

### Agents

- Add more than one Claude Code or Codex account in Settings → Agents → Accounts. Each signs in once in a terminal and keeps its own sign-in; the accounts you already use stay as they are.
- Pick an account for each step of your agent order and in the composer's agent menu. Limits are counted per account, and when one account runs out the conversation goes on with the next.

### Composer

- An empty conversation suggests a few things to start with, and the composer's controls say plainly what they do: who runs the agent, what it may do (Plan only, Ask first, Edit freely, Full access) and Send.

## 0.1.1 · 2026-10-25

### Workspaces and organizations

- Settings → Workspaces: rename a workspace, pick its color and its base branch.
- Automatic Git sync is one switch for the whole workspace, and everyone sees who turned it on or off.
- For people in several organizations, a switcher in the sidebar: the workspaces, Sessions and new sessions are those of one organization, and a workspace you add goes there. Create and rename organizations in Settings → Organization.
- Create a GitHub issue from a comment or from an agent's reply, with the same review as an agent's own draft.

### Swarms and AI teammates

- The lead's open questions come to you as questions you can answer, and a swarm can wait for the answers before it starts.
- A monthly limit for each AI teammate, counting the tasks given to it directly as well as its swarm tasks.
- Without cost history in a workspace, the swarm setup estimates a task from its models' prices.
- A task can carry a command that proves it is done (a test of what it changes), run after the project's checks.

### Fixes

- Editing an AI teammate no longer resets its permissions and effort.
- Budget and limit fields take amounts like 0.20.

## 0.1.0 · 2026-10-13

First release of Kovan, a multiplayer desktop IDE for software teams and the coding agents they run.

### Desktop app

- Builds for macOS (Apple silicon), Windows x64 and ARM64, and Linux x64 (AppImage).
- An editor with a file explorer, terminal, Git panel with side-by-side diffs, command palette and editable shortcuts.
- Dark and light themes.

### Agents

- A native harness that reads, searches and edits your repository and runs commands, with four permission modes: Plan, Request, Allow and Full.
- Approval cards that authorize one exact action, once.
- Claude Code and Codex in Kovan's chat surface or in their own terminal, with coordination tools over MCP.
- Edits that stream into the editor while the model writes them.

### Models

- More than 180 models through OpenRouter, with your own key or with managed usage.
- JevRouter, which picks a model for each task and can be steered with directives such as `[jev: only use Opus]`.
- The cost of each turn, shown as it is reported.

### Working as a team

- Workspaces with viewer, commenter, editor and owner roles, checked on the server.
- A Sessions board with live cards and an alerts strip for approvals, takeovers and conflicts.
- Sessions with one branch and one plan, and a live lane for each person.
- Comments on sessions, lane moments, file lines and diff hunks.
- Overlap warnings before a prompt runs, advisory file locks, steer, take over and hand off.
- Shared notes attached to files and commits, flagged when the code moves.

### Git

- A worktree for each session and each subagent.
- Snapshot sync through shadow refs on your own remote, with a three-way check; conflicts keep both versions.
- Parallel subagents whose work is merged once, after its checks pass.
- Pull requests created from a session.

### Swarm

- A lead agent that splits a goal across AI teammates under a budget, with pause, stop and resume.
- AI teammates as members of a workspace.
- An Agents page that draws repositories, sessions and agents as a graph.

### Managed usage

- Provider cost × 1.05, charged once a day, with a spending allowance or an explicit unlimited setting.
- Invoices, receipts and 30 days of usage by run, model and workspace.

### Security

- Code stays on your machines; the server stores coordination data only.
- Transcripts are secret-redacted, encrypted and kept for 90 days by default.
