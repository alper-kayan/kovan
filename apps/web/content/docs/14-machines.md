# Machines: agents that keep working

Normally an agent runs inside the desktop app and stops when you quit it. A machine keeps taking work without anyone at it: your own computer in the background, or a server.

## Your computer, in the background

**Settings → Agents → Issues and background work → Background agents** starts a small program that runs on this computer as a machine of your organization. Work sent to it (from Kovan, the phone or an integration) goes on after you quit the app, in the folders you've opened, with Claude Code on your subscription.

## A server

`kovan-agentd` runs the same way on a server or a small computer such as a Raspberry Pi. It needs:

- a checkout of each repository it should work on,
- an [API key](/docs/integrations-and-api/) with the `machine` scope (an organization's key serves every workspace whose repository it holds),
- an agent: Claude Code or Codex signed in on that machine, or an OpenRouter key for Kovan's own agent.

It is set up with environment variables (`KOVAN_SERVER_URL`, `KOVAN_API_KEY`, `KOVAN_REPOS` and others; `kovan-agentd --help` lists them) and can print a systemd or launchd service for itself. The repository has a Dockerfile for it under `deploy/`.

## What it will and won't do

Work sent with "any machine" goes to one that holds the repository. Commands its agents run are limited to checks and reading (tests, linters, builds, `git status`, `diff`, `log`); pushing, publishing, deleting and installing are refused. Run it as its own user, without push credentials or admin rights: the tests it runs are the repository's code.

Fetching and pushing go through Kovan's server, which adds the workspace's GitHub token, so the machine never holds it.
