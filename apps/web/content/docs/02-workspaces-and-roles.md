# Workspaces and roles

A workspace is one repository plus the people who work on it. Roles are set per workspace, and the server checks them on every action.

## Organizations and workspaces

Your account gets a personal organization the first time you sign in. An organization holds any number of workspaces, and each workspace is tied to one repository, identified by its remote (for example `github.com/owner/repo`).

Workspaces are private. Nothing is public by default, and only members can see that a workspace exists.

## Workspaces on your machine

Kovan does not copy a repository between people. Everyone works in their own clone. The link between a workspace and a folder on your disk is kept only on your machine; the server never learns your folder paths.

If you open a workspace that has no folder on this computer, Kovan shows **Workspace not set up on this machine**. Point it at your existing clone (Kovan checks that the remote matches) or let it clone the repository for you.

## Roles

| Role      | Can do                                                                                                                                                             |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Viewer    | See sessions, transcripts, diffs, plans, notes and history.                                                                                                        |
| Commenter | Everything a viewer can, plus comment, suggest, and hold work: claim a plan step, accept it, hand it back, mark it done. No agent needed.                          |
| Editor    | Everything a commenter can, plus all agent work: start and join sessions, prompt, steer, take over, run subagents, answer approvals, manage the plan, assign work. |
| Owner     | Everything an editor can, plus membership, roles, workspace settings and deletion.                                                                                 |

A role belongs to a workspace, not to a person. The owner of an organization can be a viewer in one of its workspaces.

Role changes apply on the server straight away. If someone is demoted while the app is open, their next action is refused. A workspace always keeps at least one owner.

## Inviting people

On the **People** page, choose **Invite**, enter a GitHub username or an email address, and pick a role. Someone who already has a Kovan account is added at once. Otherwise the invitation waits and is accepted when they first sign in. Either way they get an email.

Owners can change roles and remove members from the same page. Members can leave a workspace themselves.

## Team rules: KOVAN.md

A `KOVAN.md` file at the root of the repository holds the team's rules for agents. Kovan's own agent reads it with every conversation. It can also define:

- **Before Build** commands that run before an agent starts building, and
- **Required Checks** that a subagent's work must pass before it is merged into a lane.

## Workspace settings

Each workspace has a display name, a colored icon, a default base branch and an **Automatic Git sync** switch. See [Git sync and conflicts](/docs/git-sync-and-conflicts/).
