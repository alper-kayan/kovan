# Security and privacy

Kovan is local-first. Your repository stays in your checkouts and the server never keeps a copy of it; the server holds what the team needs to coordinate, and that includes the code a shared session works on. The [privacy policy](/privacy/) is the full statement of what is collected, who processes it and how long it is kept.

## What stays on your machines

- **Your repository.** The Kovan server never keeps a copy of it. Sync between teammates goes through your own Git remote with your own credentials.
- **Git credentials and SSH keys.** Kovan uses the Git you already have configured and does not store them.
- **Folder paths.** The link between a workspace and a folder on your disk is kept only on your computer. The one exception is a machine you register to run agents unattended (`agentd`): it reports the repositories it holds and where, so work can be sent to it.
- **Your provider key.** It is stored in your operating system's keychain.

## What the server stores

- accounts, organizations, workspaces, members and roles,
- sessions, plans, locks, comments, notes and activity,
- snapshot metadata: commit, ref and time, never file contents,
- transcript chunks of session lanes, which include code an agent read or wrote,
- the changes of a shared session: each member's diff against the base branch, new files included, so teammates and the phone app can review it. A live diff is replaced as work goes on; when the session ends only the final diff is kept,
- for Kovan billing: usage records and invoices.

Diffs and transcripts are redacted and encrypted the same way (below).

## Git traffic of unattended machines

A machine you register to run agents unattended (`agentd`) fetches and pushes through the server, which adds the workspace's GitHub token so the machine never holds it. The traffic is passed on, not stored.

## Transcripts

What an agent says and does in a session lane is streamed to the server so that teammates can follow it. Before a chunk is stored:

1. secrets are redacted by pattern,
2. long output is trimmed, and
3. the chunk is encrypted.

Transcripts, and the final diffs of ended sessions, are kept for 90 days by default. An organization can change the period, and expired ones are deleted on a schedule.

Live keystroke-level writing events, which show an agent typing in a teammate's editor, are relayed but not saved.

## Encryption

Transcript chunks, session diffs and GitHub tokens are encrypted by the server before they are written to the database. The server holds the keys, which can be rotated. This is encryption at rest, not end-to-end encryption.

Sign-in sessions are random tokens. The server stores only a hash of each, and any of them can be revoked. The desktop app keeps its token in the operating system's encrypted store.

## Models and your prompts

When an agent runs, your prompt and the code it reads are sent to the model provider you chose: through your own key, through Kovan billing, or through the CLI you connected. Overlap detection and task summaries may also send a short summary derived from your prompt to a small model.

## Permissions

Agents start in Ask first mode. An approval authorizes one exact action once, and it is enforced on the machine that runs the action, not only in the interface. Roles are checked on the server for every request, and a demoted member's next action is refused.

File locks and worktrees keep work apart. They are advisory and are not security boundaries.

## Error reports

Kovan can send error reports linked to your account to help fix failures. Prompts and code are not included. Turn this off in **Settings → Privacy**.

## Sign-in

You can sign in with GitHub, Google or an email link. A verified email address joins those methods into one account.

## Reporting a vulnerability

Email **kovan@alperkayan.dev**. The [security page](/security/) explains what to include and what happens next.
