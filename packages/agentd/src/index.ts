#!/usr/bin/env node
import { userInfo } from 'node:os';
import { fileURLToPath } from 'node:url';
import { Brain } from './brain.js';
import { relayEnv, relayRoutes } from './gitRelay.js';
import { loadConfig } from './config.js';
import { Daemon } from './daemon.js';
import { detectAgents, findRepos } from './detect.js';
import { Runner } from './run.js';
import { JEV_CLASSIFIER_MODEL } from '@kovan/jevrouter';
import { OpenRouterClient } from '@kovan/model-gateway';
import {
  claudeDecider,
  codexHasAppServer,
  ToolBridge,
  type ClaudeDetachedOptions,
  type CodexDetachedOptions,
} from '@kovan/runner';
import { join } from 'node:path';
import { launchdPlist, systemdUnit } from './units.js';

const HELP = `kovan-agentd: runs Kovan's agents on this machine, with nobody at it.

It registers as a machine (of an organization or one workspace), reports every 30 seconds and runs the swarms
sent to it (machine: "auto" or its id) in session worktrees of the checkouts it holds.
Commands an agent runs are limited to checks and reading (tests, linters, builds, git
status/diff/log); pushing, publishing, deleting and installing are refused.

Environment:
  KOVAN_SERVER_URL      the Kovan server, e.g. https://kovan.alperkayan.dev
  KOVAN_API_KEY         an API key with the "machine" scope: an organization's (serves every
                        workspace whose repository it holds) or one workspace's
  KOVAN_AGENT           claude (Claude Code on your own subscription), codex (Codex on your
                        OpenAI plan), kovan (Kovan's agent on OpenRouter) or auto (default:
                        claude when this machine has it, else codex without OPENROUTER_API_KEY)
  KOVAN_CLAUDE_BIN      the claude CLI, when it isn't on PATH
  KOVAN_CODEX_BIN       the codex CLI, when it isn't on PATH
  OPENROUTER_API_KEY    the model key for Kovan's own agent (not needed with Claude Code)
  KOVAN_REPOS           checkouts it offers, comma separated (or KOVAN_WORKSPACE_ROOT: a folder
                        whose repositories it offers)
  KOVAN_MACHINE_NAME    its name in Kovan (default: the host name)
  KOVAN_SLOTS           runs at once (default 2; 1 on a Raspberry Pi)
  KOVAN_DATA_DIR        worktrees and state (default ~/.kovan-agentd)
  KOVAN_PUSH=1          push the session branch when a swarm finishes

Run it as its own user, without push credentials or sudo: tests run the repository's code.

  kovan-agentd                     run
  kovan-agentd unit systemd        print a systemd unit (/etc/kovan-agentd.env holds the variables)
  kovan-agentd unit launchd        print a launchd agent for macOS (from this environment)
`;

const log = (line: string) => console.log(`${new Date().toISOString()} ${line}`);

async function main(args: string[]): Promise<void> {
  if (args.includes('--help') || args.includes('-h')) {
    process.stdout.write(HELP);
    return;
  }
  const script = fileURLToPath(import.meta.url);
  if (args[0] === 'unit') {
    if (args[1] === 'systemd')
      process.stdout.write(
        systemdUnit({
          node: process.execPath,
          script,
          user: userInfo().username,
          envFile: '/etc/kovan-agentd.env',
        }),
      );
    else if (args[1] === 'launchd') {
      const config = loadConfig();
      const keep = Object.fromEntries(
        Object.entries(process.env).filter(
          ([k, v]) =>
            v &&
            (k.startsWith('KOVAN_') || k === 'OPENROUTER_API_KEY' || k === 'PATH' || k === 'HOME'),
        ) as [string, string][],
      );
      process.stdout.write(
        launchdPlist({ node: process.execPath, script, env: keep, logDir: config.dataDir }),
      );
    } else throw new Error('Say which: kovan-agentd unit systemd | launchd');
    return;
  }

  const config = loadConfig();
  let daemon: Daemon | null = null;
  const brain = new Brain(
    config.serverUrl,
    config.apiKey,
    config.name,
    (m) => daemon?.onMessage(m),
    log,
  );
  // A workspace's machine key, or an organization's (it serves all its workspaces).
  const { key } = await brain
    .request<{ key: { scopes: string[]; workspaceId: string | null; orgId: string | null } }>(
      'GET',
      '/api/keys/me',
    )
    .catch(() => {
      throw new Error('KOVAN_API_KEY must be an API key with the machine scope.');
    });
  if (!key.scopes.includes('machine'))
    throw new Error('KOVAN_API_KEY needs the machine scope (Settings → Integrations).');
  const scope = key.orgId ? { orgId: key.orgId } : { workspaceId: key.workspaceId! };
  const repos = await findRepos(config.repoPaths);
  // Git through Kovan: no GitHub key on this machine, the workspace's access is used instead.
  if (config.gitRelay)
    Object.assign(
      process.env,
      relayEnv(
        await relayRoutes((m, path) => brain.request(m, path), config.serverUrl, repos, log),
        config.apiKey,
      ),
    );
  const agents = await detectAgents(Boolean(config.openRouterKey));
  const claudeBinary =
    config.claudeBinary ?? (agents.some((a) => a.name === 'claude') ? 'claude' : null);
  if (config.agent === 'claude' && !claudeBinary)
    throw new Error(
      'KOVAN_AGENT=claude, but the claude CLI is not on PATH (or set KOVAN_CLAUDE_BIN).',
    );
  const codexBinary =
    config.codexBinary ?? (agents.some((a) => a.name === 'codex') ? 'codex' : null);
  if (config.agent === 'codex' && !codexBinary)
    throw new Error(
      'KOVAN_AGENT=codex, but the codex CLI is not on PATH (or set KOVAN_CODEX_BIN).',
    );
  const useCodex =
    config.agent === 'codex' ||
    (config.agent === 'auto' && !claudeBinary && !config.openRouterKey && Boolean(codexBinary));
  let codex: CodexDetachedOptions | undefined;
  if (useCodex && codexBinary) {
    if (!(await codexHasAppServer(codexBinary, process.env['PATH'] ?? '')))
      throw new Error('This Codex has no app server (codex app-server): update it to run swarms.');
    const bridge = new ToolBridge(join(config.dataDir, 'bridge.json'));
    await bridge.start();
    codex = {
      binary: codexBinary,
      bridge,
      mcpEntry:
        process.env['KOVAN_CLAUDE_MCP_ENTRY'] ||
        fileURLToPath(import.meta.resolve('@kovan/runner/claude-mcp')),
      nodePath: process.execPath,
      pathEnv: process.env['PATH'] ?? '',
    };
  }
  let claude: ClaudeDetachedOptions | undefined;
  if (!codex && config.agent !== 'kovan' && claudeBinary) {
    const bridge = new ToolBridge(join(config.dataDir, 'bridge.json'));
    const decider = claudeDecider(claudeBinary, process.env['PATH'] ?? '', config.dataDir);
    await bridge.start();
    claude = {
      binary: claudeBinary,
      dataDir: config.dataDir,
      bridge,
      // Inside the desktop app's bundle the bridge is a file of its own (set by the app).
      mcpEntry:
        process.env['KOVAN_CLAUDE_MCP_ENTRY'] ||
        fileURLToPath(import.meta.resolve('@kovan/runner/claude-mcp')),
      nodePath: process.execPath,
      pathEnv: process.env['PATH'] ?? '',
      // A question the agent would ask its person: Kovan decides with Claude (Haiku).
      decide: (task, questions) => decider(task, questions),
      // With a model key, JevRouter's classifier picks the Claude model (only Jev uses the key).
      ...(config.openRouterKey
        ? {
            jev: {
              model: JEV_CLASSIFIER_MODEL,
              client: new OpenRouterClient({
                apiKey: config.openRouterKey,
                appName: 'Kovan agentd',
                appUrl: 'https://kovan.alperkayan.dev',
              }),
            },
          }
        : {}),
      onLimit: (info) =>
        info['status'] && info['status'] !== 'allowed'
          ? log(`Claude limit: ${JSON.stringify(info).slice(0, 200)}`)
          : undefined,
    };
  }
  const runner = new Runner(config.openRouterKey, undefined, claude, codex);
  // Say which of them does the work here, so people sending work know whose account pays.
  const worker = claude ? 'claude' : codex ? 'codex' : 'kovan';
  for (const a of agents) a.works = a.name === worker;
  daemon = new Daemon(
    {
      name: config.name,
      platform: config.platform,
      slots: config.slots,
      agents,
      repos,
      dataDir: config.dataDir,
      scope,
      pushWhenDone: config.pushWhenDone,
      endWhenDone: config.endWhenDone,
    },
    {
      request: (m, path, body, options) => brain.request(m, path, body, options),
      follow: (id) => brain.follow(id),
      laneEvent: (s, e, t, a) => brain.laneEvent(s, e, t, a),
      run: (run) => runner.run(run),
      log,
    },
  );
  brain.connect();
  await daemon.start();
  log(`Work here runs on ${runner.agent}.`);
  if (claude)
    log(
      claude.jev
        ? `JevRouter picks the Claude model with ${JEV_CLASSIFIER_MODEL} on OpenRouter.`
        : 'JevRouter picks the Claude model by its rules (set OPENROUTER_API_KEY for its classifier).',
    );
  if (!claude && !codex && !config.openRouterKey)
    log('No claude or codex CLI and no OPENROUTER_API_KEY: swarms sent here will fail to run.');

  let stopping = false;
  const stop = (signal: string) => {
    if (stopping) return;
    stopping = true;
    log(`${signal}: pausing what runs here and stopping.`);
    void daemon!.stop('agentd was stopped').finally(() => {
      brain.close();
      process.exit(0);
    });
  };
  process.on('SIGTERM', () => stop('SIGTERM'));
  process.on('SIGINT', () => stop('SIGINT'));
}

main(process.argv.slice(2)).catch((error: unknown) => {
  console.error(`kovan-agentd: ${(error as Error).message}`);
  process.exit(1);
});
