# Swarm and AI teammates

Swarm lets several agents work on one goal at the same time under a budget. AI teammates are agents that belong to a workspace the way a person does.

## Swarm

A Swarm lives in a session. In the session's **Swarm** section you set:

- the **goal**, in a sentence or two,
- the **agents** that take part and which one **leads**,
- a **budget** in US dollars, or explicitly unlimited,
- how many agents may run at once, and
- the permission mode they work in.

You can save these as a draft before any agent starts, and change them while the Swarm is paused.

### How it runs

1. The lead reads the code, read-only, and splits the goal into tasks.
2. Each task becomes a plan step owned by an agent.
3. The workers run in parallel, each in its own Git worktree.
4. A worker's result is merged once, and only if it applies cleanly and passes the required checks.
5. The lead reviews the results and writes a summary in the Swarm chat.

### Controls

You can pause, stop and resume the Swarm. You can also stop a single agent, move its task to another agent, or send direction into one agent's lane.

### Budget

The cost of every model call is recorded on the server. When the budget is reached the server pauses the Swarm and the agents stop at once. Only the person who started it can resume it.

Everything a Swarm spends is paid by the person who started it, including the lead's planning and review.

### Swarm chat

Agents write to each other in the Swarm chat, and people can write to one agent or to all of them. A message to a running agent arrives as direction straight away; a message to an idle one goes with its next prompt.

### Learning

When a task's result passes its checks, Kovan can turn it into a short note that later agents in the workspace receive. Preferences you express in the chat are treated differently: they stay private to you, as unverified suggestions, until you accept them. Review both on the **Brain** page (the brain icon in the left bar) under **Learning**, where you can accept, correct or forget each one.

## AI teammates

An AI teammate is a member of a workspace that happens to be an agent. It has a name, a model, a permission mode and written instructions about what it does and how it works.

- It appears on the **People** page with an **AI** badge.
- It has the editor role. It can own plan steps and join a session with its own lane.
- It has no login of its own.
- It runs on the machine of the person who added it, with that person's provider, and that person pays. The lane says so: "Runs on ada's machine · paid by ada".

The person who added it, or a workspace owner, can retire it.

## The Agents page

The **Agents** page draws everything that is running as a graph: repositories, their sessions, and the agents in each. Running agents are outlined in green, and a Swarm is a dashed box with its latest messages. Click a session to open it.
