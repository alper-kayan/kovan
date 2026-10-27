# Getting started

Kovan is a desktop IDE that a team shares with the coding agents it runs. This page takes you from install to a first session with a teammate.

## Install

Download Kovan from the [download page](/download/). There are builds for macOS (Apple silicon), Windows x64 and ARM64, and Linux x64 as an AppImage.

## Sign in

Open Kovan and choose **Log in**. The app opens a sign-in page in your browser, where you can use GitHub, Google or an email link. An email link has to be opened on the same computer the app is waiting on.

You can also choose **Continue without an account** and use Kovan by yourself as a local IDE. Signing in is what lets you share workspaces with other people.

## The checklist

The sidebar shows a **Getting started** checklist with six steps:

| Step                     | What it does                                                                                       |
| ------------------------ | -------------------------------------------------------------------------------------------------- |
| Verify your email        | Invitations and session alerts go to this address.                                                 |
| Connect GitHub           | Lets teammates invite you by GitHub username and lets Kovan open pull requests for you.            |
| Start with Kovan         | Open a repository.                                                                                 |
| Turn on notifications    | Kovan tells you when an agent finishes or asks for approval while the window is in the background. |
| Start your first session | A session is one shared task.                                                                      |
| Invite a teammate        | Add someone to your workspace with a role.                                                         |

## Open a repository

Use **Open folder**, or run `kovan <folder>` from a terminal. If you open a folder inside a Git repository, the workspace root is the repository root.

You now have a working editor, a terminal, a Git panel and an agent panel (<kbd>⌘L</kbd>). Press <kbd>⌘K</kbd> for the command palette and <kbd>⌘P</kbd> to go to a file.

## Give your agent a model

The built-in agent needs a model provider. In **Settings → Providers & spend**, either:

- paste your own OpenRouter key, which is stored in your operating system's keychain, or
- choose **Managed** and set up [managed usage](/docs/managed-usage-and-billing/), so you need no key of your own.

If you already use Claude Code or Codex, Kovan finds them on your machine and can run them instead. See [Agents and harnesses](/docs/agents-and-harnesses/).

## Share the workspace

Click **+** next to **Workspaces** to share the open repository with your team, then invite people from the **People** page by GitHub username or email. Each person opens their own clone of the same repository; Kovan matches it by its remote.

## Start a session

On the **Sessions** board, choose **New**, describe the task, and pick a new branch or an existing one. Teammates see the session on their board and can join it or watch it. From here, read [Sessions and lanes](/docs/sessions-and-lanes/).

## Keyboard basics

| Keys                              | Action                                        |
| --------------------------------- | --------------------------------------------- |
| <kbd>⌘K</kbd> / <kbd>Ctrl K</kbd> | Command palette                               |
| <kbd>Enter</kbd>                  | Send the prompt                               |
| <kbd>Shift Enter</kbd>            | New line                                      |
| <kbd>Esc</kbd>                    | Close what is open, or stop the running agent |
| <kbd>Shift Tab</kbd>              | Cycle the permission mode                     |

Shortcuts can be changed in **Settings → Keyboard**.
