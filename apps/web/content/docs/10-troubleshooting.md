# Troubleshooting

The problems people meet most often, and what to do about each.

## The window title says Offline

Kovan could not reach the server. You can keep working: agents continue on your machine, lane events are queued, and the app reconnects by itself with increasing waits between attempts. Shared features such as the board and presence come back when it does.

## "Workspace not set up on this machine"

The workspace has no folder on this computer yet. Choose your existing clone, or let Kovan clone the repository. If Kovan rejects your clone, its `origin` remote does not match the workspace's repository.

## I can't join a session

Kovan gives one reason at a time, with a fix:

| Reason                      | What to do                                                                 |
| --------------------------- | -------------------------------------------------------------------------- |
| Your role does not allow it | Ask an owner for the editor role. Viewers and commenters can watch.        |
| The session is full         | A session holds up to 20 agents. Watch, or wait until someone leaves.      |
| Workspace not open here     | Set the workspace up on this machine.                                      |
| No agent available          | Add a provider key, set up Kovan billing, or install Claude Code or Codex. |
| Wrong branch                | Use the button to switch to the session's branch.                          |
| Cannot push                 | See "Sync paused" below.                                                   |

## Sync paused

The banner says which of these happened:

- **Credentials rejected.** Sign in to your Git host again. Check with `git push --dry-run` in a terminal.
- **Blocked by a branch rule.** The remote refused the push. Ask a repository admin whether the session branch or the `refs/kovan/` refs are restricted.
- **Remote unreachable.** Check your network or VPN.

Choose **Retry** once it is fixed. Nothing is lost while sync is paused; your changes stay in your checkout.

## A file shows "2 versions"

You and a teammate changed the same lines. Open the **Conflicts** tab, compare the two, and choose **Keep mine** or **Take theirs**. See [Git sync and conflicts](/docs/git-sync-and-conflicts/).

## The session paused after I switched branches

Switching branches by hand inside a session's worktree pauses the session. Use **Switch back** on the banner, or **Resume** if you meant to.

## My agent asks for approval for everything

That is Ask first, the default. Change the mode in the chat box: **Edit freely** lets edits through and asks for commands; **Full access** asks for nothing. <kbd>Shift Tab</kbd> cycles the modes.

## Codex doesn't ask before acting in chat

Codex cannot pause to ask in the chat surface, so Ask first is read-only there. Open it in the terminal for step-by-step approval.

## The agent stopped with a usage limit

The lane waits for a takeover. A teammate can take over with the last synced snapshot, or you can continue when your limit resets or after you switch provider.

## Managed requests are refused

The message says why. The usual causes:

- no card saved, no allowance set, or the charges not authorized yet,
- the allowance is used up: raise or reset it,
- a payment failed: retry the invoice on the [billing page](/account/billing/).

## A command shows "Outcome unknown"

A push, deploy or similar command was cut off part-way. Kovan will not run it again by itself. Check what happened outside Kovan, then record the outcome on the card.

## The email link doesn't work

Sign-in and verification links expire after a short time and work once. You can open an email sign-in link on any device; its page asks for the code that Kovan (or the page you signed in from) shows while it waits. The code is never in the email. Type a wrong code five times and the link stops working: start signing in again. Request a new link if it has expired.

## I was invited but don't see the workspace

An invitation joins the account it was sent to: that GitHub username, or that email address once it is verified. Signed in with another address (an Apple private address, say)? Open the invite link from the email and join from there with the account you use. No email came, because the invite was for a GitHub username? Ask the person who invited you for the invite link.

## Kovan can't clone the repository

Kovan clones with your own Git access. If cloning fails with "not found" or "access denied", your GitHub account can't open the repository yet: ask its owner to add you there, then try again.

## Still stuck

For a security problem, write to **kovan@alperkayan.dev**. For anything else, write to us too: [Contact](/contact/) says what to include, and a person reads it. It helps to check the [changelog](/changelog/) first, in case it's fixed in a newer version.
