# Agents and harnesses

A harness is the program that runs an agent: it talks to the model, offers it tools and applies what it does. Kovan has its own and can also drive the command-line agents you already use.

## The Kovan harness

Kovan's built-in agent works in your repository with these tools:

| Tool                            | What it does                                             |
| ------------------------------- | -------------------------------------------------------- |
| `read_file`, `list_dir`, `grep` | Read and search the workspace.                           |
| `write_file`, `edit_file`       | Create a file, or replace an exact piece of text in one. |
| `run_shell`                     | Run a command in the workspace.                          |

Every tool stays inside the workspace. Each conversation starts with the workspace, its Git status and the team's `KOVAN.md`. Thinking, tool calls and answers stream as they happen, and edits appear in the editor while the model is still writing them.

Press <kbd>Esc</kbd> to stop. The command's whole process group is ended and tools that were waiting do not start.

## Permission modes

| Mode    | Behaviour                                                                     |
| ------- | ----------------------------------------------------------------------------- |
| Plan    | Read-only tools. The agent investigates and writes a plan; nothing is edited. |
| Request | Every edit and every command asks first. This is the default.                 |
| Allow   | Edits go ahead; commands ask first.                                           |
| Full    | Everything runs without asking.                                               |

An approval covers one exact action, once. In a session, switching an agent to Full is shown to everyone.

## Claude Code and Codex

Kovan looks for agent CLIs on your machine and lists them in **Settings → Agents** with their version and path. A CLI that cannot be used is shown dimmed with the reason, not hidden.

Each person connects their own CLI with their own login, so different people in one session can use different providers. Kovan does not change your global configuration: it passes its settings to each run it starts.

There are two ways to run a CLI:

- **In the chat surface.** Output from Claude Code and Codex is shown with the same rows as Kovan's own agent, and later turns continue the same conversation.
- **In a terminal.** The CLI's own interface runs in a real terminal with nothing filtered.

A few differences are worth knowing:

- Claude Code's permission requests arrive as Kovan approval cards.
- Codex cannot pause in the chat surface to ask, so Request mode is read-only there. Use the terminal for step-by-step approval with Codex.
- Neither CLI can be steered in the middle of a turn. A steer message is delivered with the next prompt.

## Coordination tools

Agents that Kovan starts get a small set of MCP tools for working as part of a team:

| Tool               | Purpose                                                             |
| ------------------ | ------------------------------------------------------------------- |
| `get_team_context` | Who is in the workspace, what they are working on, locks and notes. |
| `propose_split`    | Suggest how to divide a task.                                       |
| `claim_plan_step`  | Take an unowned step of the plan.                                   |
| `assign_work`      | Put work on the board for a person.                                 |
| `message_agent`    | Send a message to a teammate's agent or an AI teammate.             |
| `record_memory`    | Save a note about the code for the next agent.                      |

Each tool's description tells the agent when not to use it.

## Connecting a repository

**Settings → Agents** can connect a repository to your CLIs in one click. Kovan writes the hook and MCP configuration the CLIs read, and keeps those files out of Git through `.git/info/exclude`, so nothing is committed and the team's tracked files are not touched.

## Without an agent

You do not need an agent to take part. You can watch sessions, comment, and hold and finish work.
