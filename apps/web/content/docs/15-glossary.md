# Glossary

**Agent.** An AI that writes and changes code for you: it reads files, edits them and runs commands, asking first when you want it to. Kovan has its own agent and also runs Claude Code and Codex.

**AI teammate.** An agent with a name and a role that is a member of the workspace, such as "Bora, reviewer". You give it work in a session, or put it in a swarm. It runs on the computer of whoever gives it work.

**Approval.** An agent asking "may I do this?" before an edit or a command. Who may answer depends on the role and the workspace's settings.

**Brain.** The workspace's shared notes: decisions, gotchas and conventions. Every agent working there reads them.

**Checks.** The project's own tests, linters and builds. In a swarm a task counts as done only once they pass.

**Lane.** One person's (or AI teammate's) place in a session: their agent's conversation, which everyone in the session sees live.

**Model.** The AI behind an agent, such as Claude Sonnet or GPT. Kovan's own agent can use hundreds of them.

**JevRouter.** Kovan's model picker: it gives each step to the cheapest model likely to get it right.

**MCP server.** A plug-in that gives agents more tools, such as GitHub or a database. See [Plugins and MCP](/docs/plugins-and-mcp/).

**Permission mode.** What an agent may do without asking: Plan only (reads and plans), Ask first (asks before every edit and command), Edit freely (edits, asks before commands), Full access (asks nothing).

**Role.** What a person may do in a workspace: Viewer (watches), Commenter (also comments), Editor (runs agents and changes code), Owner (also manages people and settings).

**Session.** One task the team works on together, on its own Git branch, with a lane for each person in it.

**Swarm.** Several AI teammates working on one goal: a lead splits it into tasks, the others build them side by side, and each is checked before it counts.

**Workspace.** A project shared with a team: the repository, its people, sessions and settings. The code stays in each person's own copy.
