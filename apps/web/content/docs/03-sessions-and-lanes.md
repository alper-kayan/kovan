# Working together in a session

A session is one task on one branch with one plan, shared by everyone in it. Inside a session each person has a lane: their own conversation with their own agent.

## The Sessions board

The board is the first screen. Every live session is a card that shows the task, its status, who is in it, which agents are running and whose account the current turn uses, plan progress and the files touched so far.

Above the cards, the alerts strip lists only things that need a person: an approval waiting, a takeover offer, a conflict. Each can be answered there with one click.

Finished sessions move to **History**, with the transcript (for as long as it is retained), the final diff and the plan.

## Starting, joining, watching

Start a session with a task and either a new branch or an existing one. Teammates can then:

- **Join**: get their own lane and work in the session, or
- **Watch**: follow along read-only. Watchers are visible to everyone; there is no hidden watching.

Before you join, Kovan checks what could stop you: your role, room in the session, whether the workspace is set up on this machine, whether you have an agent available, the branch, and whether you can push. If something is in the way you get one clear reason and a way to fix it. A session holds up to 20 agents.

## Lanes

Lanes sit side by side. Prompts you write go to your own agent in your own lane, and everyone sees every lane as it streams: thinking, tool calls, edits and answers.

The composer says what will happen before you send: which agent and model will run, and who pays for it. You choose the intent yourself:

| Intent     | Effect                                            |
| ---------- | ------------------------------------------------- |
| Prompt now | Starts a turn.                                    |
| Queue next | Runs when the current turn ends.                  |
| Guide      | Adds direction to your own running turn.          |
| Subagent   | Starts a parallel child task in its own worktree. |

Drafts and queued prompts are kept per lane.

## Approvals

Agents begin in **Ask first** mode, where edits and commands need approval. An approval card shows the exact action. Any editor in the session can answer it, and the first valid answer wins. The answer is enforced on the machine that runs the action, not only in the interface, and it covers that one action once.

## The plan

Each session has one plan. Steps have an owner and a status, and the progress on the card comes from the plan. Work is owned by people, not agents: a commenter with no agent can still hold a step and finish it.

You can ask to take steps over. Steps nobody owns and nobody has started move to you at once; for the rest the current owner is asked.

## Comments

Comments attach to the session, to a moment in a lane, to lines in a file or to a hunk of a diff. A comment can become a plan step, a code suggestion, or a prompt to your own agent with the surrounding code as context. Resolving a comment never deletes it, and a comment is marked outdated when the code under it moves. Commenting uses no model.

## Overlap warnings

Before a prompt runs, Kovan compares your branch, open files, the files named in your prompt and your plan steps with the other live sessions. Work on the same file is **overlapping**; work on a related task is **adjacent**. The warning names the teammate and the session, and offers to join them, split the work, coordinate, or send anyway.

A session can also lock exact file paths. Locks are advisory: connected agents are told not to edit those files, but nothing on disk stops them.

## Steer, take over, hand off

- **Steer** adds direction to your own running turn. If the turn ends first, your text comes back to the composer.
- **Take over** ends a teammate's turn at a safe checkpoint and starts a new one on your account, carrying the plan, the code and the context. If two people try at once, one wins and the other can watch.
- **Hand off** passes your lane to a teammate with its snapshot, context and plan steps. They can accept or decline.

When an agent hits a usage limit, its lane waits for a takeover and shows how old the last synced snapshot is.

## Shared notes

Kovan keeps short notes attached to files and commits: decisions, pitfalls, conventions. Agents in the workspace read them and write new ones as they work. A note written by an agent stays unverified until a person accepts it, and a note is flagged when the code it points at moves, so the next agent nearby rewrites it. People can read, edit and retire any note.
