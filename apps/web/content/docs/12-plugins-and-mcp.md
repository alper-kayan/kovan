# Plugins and MCP servers

Both give agents more to work with. They live in the desktop app under **Settings → Agents → Skills, tools and plugins**.

## MCP servers

An MCP server gives agents tools: GitHub, a database, a browser, your company's own systems. Add one by its command (it runs on your computer) or by its address (it runs elsewhere). Values such as tokens are kept in your system's keychain, not in the list.

- **Test** shows the server's tools before you save it.
- Each call asks first under "Ask first" and "Edit freely", unless you choose **Always allow** when it asks.
- A repository can bring its own servers in `.mcp.json` or `.kovan/mcp.json`. They start only after you allow them, and ask again when the file changes.
- Servers that sign you in through the browser (OAuth) do it from the same list.

The servers you add here reach Claude Code too when it runs in Kovan, next to Kovan's own team tools. With "this computer's Claude Code" (Settings → Agents → Accounts), your own Claude Code settings and servers come along as well.

## Plugins

A plugin is a bundle of skills, commands and MCP servers from a Git repository: install it by its address. Before anything is installed the preview shows what's in it, including the parts Kovan won't use.

Plugins update from their repository; remove one and its parts go with it. A workspace owner can recommend plugins to the team, and everyone sees the suggestion in the same place.

Only add plugins and servers you trust: their tools run with your agent's permissions.

## Skills

A skill is a set of instructions an agent follows for one kind of task. Type `/` at the start of a message to call one directly; agents also pick them up when they fit.
