# Terminal agent

`kovan` is Kovan's coding agent in the terminal: the same agent loop as the desktop app, with a prompt in front of it. It runs on macOS, Linux and Windows and needs Node.js 22 or newer.

## Install

On macOS and Linux:

```sh
curl -fsSL https://kovan.alperkayan.dev/install.sh | sh
```

On Windows, in PowerShell:

```powershell
irm https://kovan.alperkayan.dev/install.ps1 | iex
```

Both install for you alone, without admin rights. The program goes to `~/.kovan/cli/` and a `kovan` command next to it: to `~/.local/bin` on macOS and Linux (if that folder isn't on your `PATH` yet, the script prints the line to add to `~/.zshrc` or `~/.bashrc`), and to `%USERPROFILE%\.kovan\bin` on Windows, which is added to your user `PATH`.

Before anything is installed, the script checks that the release is signed with Kovan's release key and that the file matches the release's hash. A download that fails either check is not installed.

## Use it

```sh
kovan                      # a conversation with the agent, in this folder
kovan "fix the failing test"  # one message: it does the work and exits
kovan -c                   # continue the last conversation in this folder
kovan sessions             # conversations kept on this machine
kovan config               # which server and model it talks to
```

In a conversation, type `/` for the commands, skills and custom commands, and `/help` for the keys. `Tab` changes the permission mode, `Esc` stops a running turn.

Conversations are kept the same way the desktop app keeps its own, so a conversation you start in the terminal shows in the app's chat list for that folder.

## Which model it uses

Your own key or gateway always comes first:

- `OPENROUTER_API_KEY` for any model through OpenRouter, or
- `KOVAN_BASE_URL` and `KOVAN_MODEL` (plus `KOVAN_API_KEY` if it needs one) for an OpenAI-compatible gateway of your own.

With nothing of your own set up, sign in with `kovan login` and `kovan` uses your Kovan account's [managed usage](/docs/managed-usage-and-billing/), if the server offers it. `KOVAN_PROVIDER=managed` asks for the account even when you have a key; `KOVAN_PROVIDER=own` never uses it.

The Claude Code and Codex accounts you added in the desktop app (**Settings → Agents → Accounts**) can also run a conversation: pick them with `/models`.

## Asking before it acts

| Mode      | What it does on its own                      |
| --------- | -------------------------------------------- |
| `plan`    | Only reads; changes nothing.                 |
| `request` | Asks before every edit and command.          |
| `allow`   | Edits files, asks before commands (default). |
| `full`    | Asks nothing.                                |

When it asks, answer `y` (yes), `n` (no) or `a` (always, for that tool, for the rest of the session). Start it with `--mode <mode>`, or change it with `Tab` or `/mode`.

## What it reads

What you already wrote for Claude Code works here, in the same formats:

- **Skills**: `SKILL.md` folders in the repository's `.kovan/skills` and `.claude/skills`, and in `~/.claude/skills`. Type `/skill-name` to use one.
- **Notes**: the repository's `KOVAN.md`, `AGENTS.md` and `CLAUDE.md`, plus your own `~/.kovan/KOVAN.md` and `~/.claude/CLAUDE.md`.
- **Custom commands**: `.kovan/commands/<name>.md` and `.claude/commands/<name>.md`; `$ARGUMENTS` is what you typed after the name.

`KOVAN_NO_CLAUDE=1` leaves everything of Claude Code's alone.

## Updates

`kovan` looks for a new version in the background every twelve hours and installs it only when it is signed with Kovan's release key. When one has been installed, the status row says **Update installed · Restart to update**. Run `kovan update` to look right away, or set `KOVAN_NO_UPDATE=1` to turn updates off.

## Remove it

On macOS and Linux:

```sh
rm -rf ~/.kovan/cli ~/.local/bin/kovan
```

On Windows, delete `%USERPROFILE%\.kovan\cli` and `%USERPROFILE%\.kovan\bin`, and take `%USERPROFILE%\.kovan\bin` out of your user `PATH` (**Settings → System → About → Advanced system settings → Environment Variables**).

Your conversations stay in the desktop app's data folder, and your sign-in in `~/.kovan/auth.json` (remove it with `kovan logout` first if you want it gone too).

## Windows notes

- Claude Code and Codex are found as `claude.exe` (the native build) or as npm's `claude.cmd` / `codex.cmd`; an npm command is started through its script with Node, never through `cmd.exe`, so nothing in your prompt is read as a shell command.
- Commands the agent runs go through PowerShell.
- Providers you added in the desktop app work here too: their keys are unlocked by Windows for your user account (DPAPI), the same way the desktop app reads them.
