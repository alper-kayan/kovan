# Getting started

Kovan is a code editor where you and your teammates each work with an AI agent, and everyone sees every agent's work live. This page takes you from install to a first session with a teammate. Kovan is free during early access: you pay only for the AI your agents use.

## Install

Download Kovan from the [download page](/download/). There are builds for macOS (Apple silicon), Windows x64 and ARM64, and Linux x64 as an AppImage. On Windows the first start may show "Windows protected your PC": choose **More info**, then **Run anyway**. On an Intel Mac, use the [terminal agent](/docs/terminal-agent/).

## Joining a team

Invited by someone? Their email has a link: open it, and the page says whose workspace it is and what you need. Before you can work on the code with them, you need:

1. **Kovan on your computer.** To only follow along, the Kovan phone app is enough.
2. **Access to the repository** on GitHub (or wherever it lives). Kovan opens it with your own Git access; if you can't open it, ask the person who invited you to add you there too.
3. **A way to run models**, when you want an agent of your own: your OpenRouter key, your Claude Code or Codex account, or paying through Kovan. Kovan asks the first time you need it.

## Sign in

Open Kovan and choose **Sign in or create an account**. The app opens a sign-in page in your browser, where you can use GitHub, Google or an email link. An email link opens on any device, your phone too: its page asks for the code the app shows while it waits, so nobody else can use the link.

You can also choose **Continue without an account** and use Kovan by yourself, with your own keys. Signing in is what lets you share workspaces with other people and use the phone app.

## The checklist

The first time, a **Getting started** guide opens by itself; later, **Start** at the bottom of the left bar opens it again. Its steps:

| Step                     | What it does                                                                                       |
| ------------------------ | -------------------------------------------------------------------------------------------------- |
| Open a project folder    | Your project's files, a terminal and your changes; your agent works in it.                         |
| Get an AI agent ready    | Checks that an agent can answer, and if not, says what's missing and where to fix it.              |
| Verify your email        | Invitations and session alerts go to this address.                                                 |
| Connect GitHub           | Lets teammates invite you by GitHub username and lets Kovan open pull requests for you.            |
| Turn on notifications    | Kovan tells you when an agent finishes or asks for approval while the window is in the background. |
| Start your first session | A session is one shared task.                                                                      |
| Invite a teammate        | Add someone to your workspace with a role.                                                         |

## Open a repository

Use **Open folder**. If you open a folder inside a Git repository, the workspace root is the repository root. (The [terminal agent](/docs/terminal-agent/) works in the folder you start it in: `cd` there and run `kovan`.)

You now have a working editor, a terminal, a Git panel and an agent panel (<kbd>⌘L</kbd>; on Windows and Linux <kbd>Ctrl+L</kbd>). Press <kbd>⌘K</kbd> (<kbd>Ctrl+K</kbd>) for the command palette and <kbd>⌘P</kbd> (<kbd>Ctrl+P</kbd>) to go to a file.

## Give your agent a model

An agent needs an AI model to think with. Any one of these works:

- **Claude Code or Codex you already use.** In **Settings → Agents → Accounts**, choose **Use this computer's Claude Code** (or Codex): it runs with your own sign-in and settings, nothing extra to pay.
- **Your own key.** In **Settings → Model keys & spend**, paste an [OpenRouter](https://openrouter.ai) key (one account that reaches hundreds of models; you pay them per use). It's kept in your system's keychain.
- **Through Kovan.** Set up [Kovan billing](/docs/managed-usage-and-billing/): no key of your own, you pay what the model costs plus 5%, up to a monthly limit you set.

Until one is ready, the chat says what's missing before you send anything. See [Agents](/docs/agents-and-harnesses/).

## Share the workspace

Open **Workspaces** in the left bar and choose **+** (or **Share** next to a folder opened before) to share the repository with your team, then invite people from the **People** page by GitHub username or email. Each person works in their own copy (clone) of the same repository; Kovan knows they're the same project from the address of its remote (where it's pushed, such as GitHub).

## Start a session

On the **Sessions** board, choose **New**, describe the task, and pick a new branch or an existing one. Teammates see the session on their board and can join it or watch it. From here, read [Working together in a session](/docs/sessions-and-lanes/).

## Keyboard basics

| Keys                              | Action                                        |
| --------------------------------- | --------------------------------------------- |
| <kbd>⌘K</kbd> / <kbd>Ctrl K</kbd> | Command palette                               |
| <kbd>Enter</kbd>                  | Send the prompt                               |
| <kbd>Shift Enter</kbd>            | New line                                      |
| <kbd>Esc</kbd>                    | Close what is open, or stop the running agent |
| <kbd>Shift Tab</kbd>              | Cycle the permission mode                     |

Shortcuts can be changed in **Settings → Keyboard**.
