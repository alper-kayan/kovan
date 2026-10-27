import type { AgentEvent, PermissionMode } from '@kovan/harness';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { DetachedRun, LiveAgent } from '../run.js';
import { ClaudeStreamParser } from './claudeStream.js';
import { chooseClaudeModel, isJev, type JevClassifier } from './jevClaude.js';
import { ClaudeLiveInput } from './liveInput.js';
import { runJsonLines, stopGroup } from './process.js';
import type { ToolBridge } from './toolBridge.js';

type TurnEnd = Extract<AgentEvent, { type: 'turn_end' }>;

/** Kovan's permission modes in Claude Code's terms; nobody watches, so never "bypass". */
const MODE: Record<PermissionMode, string> = {
  plan: 'plan',
  request: 'default',
  allow: 'acceptEdits',
  full: 'acceptEdits',
};

const PROMPT =
  "You are an AI teammate in a Kovan swarm, working unattended on this machine for your team. Use the kovan MCP tools your task names. Commands are limited to checks (tests, linters, type checks, builds) and reading; anything else is refused, so don't try to push, commit, install or reach the network.";

/** A Kovan model id in Claude Code's terms: its alias, or null for Claude Code's default. */
export function claudeModel(model: string): string | null {
  const m = model.toLowerCase();
  if (!m.includes('claude') && !['opus', 'sonnet', 'haiku'].includes(m)) return null;
  return m.includes('opus')
    ? 'opus'
    : m.includes('haiku')
      ? 'haiku'
      : m.includes('sonnet')
        ? 'sonnet'
        : null;
}

export interface ClaudeDetachedOptions {
  /** The `claude` CLI. */
  binary: string;
  /** Where the per-run MCP configs go. */
  dataDir: string;
  bridge: ToolBridge;
  /** The built MCP entry (mcpRun.js) and the node that runs it. */
  mcpEntry: string;
  nodePath: string;
  pathEnv: string;
  /** Claude Code's own report of the account limit. */
  onLimit?: (info: Record<string, unknown>) => void;
  /** JevRouter's classifier, for teammates set to JevRouter; without it Jev uses its rules. */
  jev?: JevClassifier;
  /** Answers the agent's questions (see `claudeDecider`); without it the agent decides. */
  decide?: (task: string, questions: unknown) => Promise<string>;
}

/**
 * Decides an agent's question the way its person likely would, with one short Claude Code call
 * on the same subscription (Haiku, no tools): the task and the question in, the choice and
 * one reason out.
 */
export function claudeDecider(binary: string, pathEnv: string, cwd: string) {
  return async (task: string, questions: unknown): Promise<string> => {
    const prompt = [
      'An AI agent working unattended on a coding task asks its person the questions below. Nobody is there. Answer as the person most likely would, from the task alone: for each question pick the best option (or give a short answer), with one short reason.',
      'Reply with plain text only, one line per question: "<question> → <answer> (<reason>)".',
      '',
      `The task:\n${task.slice(0, 4000)}`,
      '',
      `The questions:\n${JSON.stringify(questions).slice(0, 4000)}`,
    ].join('\n');
    const out = await new Promise<string>((resolve, reject) => {
      const child = execFile(
        binary,
        [
          '-p',
          prompt,
          '--model',
          'haiku',
          '--max-turns',
          '1',
          '--output-format',
          'json',
          '--strict-mcp-config',
        ],
        { cwd, env: { ...process.env, PATH: pathEnv }, timeout: 120_000, maxBuffer: 1_000_000 },
        (error, stdout) => (error ? reject(error) : resolve(stdout)),
      );
      child.stdin?.end();
    });
    const result = (JSON.parse(out) as { result?: unknown }).result;
    if (typeof result !== 'string' || !result.trim()) throw new Error('No decision');
    return result.trim().slice(0, 2000);
  };
}

/**
 * Runs one Kovan task with Claude Code on the person's own subscription: the run's tools come
 * through a local MCP bridge, its permission prompts go to the run's approval, and its stream
 * becomes Kovan's agent events. Costs are the subscription's, so turns cost Kovan nothing.
 */
export async function runClaudeDetached(
  run: DetachedRun,
  o: ClaudeDetachedOptions,
): Promise<TurnEnd> {
  let input: ClaudeLiveInput | null = null;
  const { id, unregister } = o.bridge.register({
    root: run.root,
    tools: run.tools ?? [],
    approve: (request) => run.approve(request),
    signal: run.signal,
    ...(run.checkWrite ? { checkWrite: run.checkWrite } : {}),
    ...(run.turnContext ? { context: run.turnContext } : {}),
    pending: () => input?.pending ?? 0,
    ...(o.decide
      ? {
          decide: async (questions: unknown) => {
            const answer = await o.decide!(run.task, questions);
            // The decision shows in the lane, so people see what was chosen for them.
            run.onEvent({
              type: 'text',
              text: `\n\n_Kovan answered a question for the agent:_ ${answer}\n\n`,
            });
            return answer;
          },
        }
      : {}),
  });
  const config = join(o.dataDir, 'mcp', `${id}.json`);
  await mkdir(join(o.dataDir, 'mcp'), { recursive: true });
  await writeFile(
    config,
    JSON.stringify({
      mcpServers: {
        kovan: {
          command: o.nodePath,
          args: [o.mcpEntry],
          env: {
            KOVAN_BRIDGE_FILE: o.bridge.file,
            KOVAN_RUN_ID: id,
            // Started by the desktop app, "node" is the app itself run as Node.
            ...(process.versions['electron'] ? { ELECTRON_RUN_AS_NODE: '1' } : {}),
          },
        },
      },
    }),
    { mode: 0o600 },
  );
  // A swarm's run: Claude Code's hooks ask the bridge before each write and give the team note.
  const coordinated = Boolean(run.checkWrite || run.turnContext);
  const settings = join(o.dataDir, 'mcp', `${id}.settings.json`);
  if (coordinated) {
    const q = (v: string) => `'${v.replace(/'/g, `'\\''`)}'`;
    const command = [
      `KOVAN_BRIDGE_FILE=${q(o.bridge.file)}`,
      `KOVAN_RUN_ID=${q(id)}`,
      ...(process.versions['electron'] ? ['ELECTRON_RUN_AS_NODE=1'] : []),
      q(o.nodePath),
      q(o.mcpEntry),
      '--hook',
    ].join(' ');
    const hook = (timeout: number) => [{ type: 'command', command, timeout }];
    await writeFile(
      settings,
      JSON.stringify({
        hooks: {
          PreToolUse: [{ matcher: 'Edit|MultiEdit|Write|NotebookEdit', hooks: hook(30) }],
          PostToolUse: [{ matcher: '*', hooks: hook(15) }],
        },
      }),
      { mode: 0o600 },
    );
  }
  const note = run.turnContext ? await run.turnContext().catch(() => null) : null;
  const task = note ? `${run.task}\n\n${note}` : run.task;
  // A teammate set to JevRouter gets the model Jev picks for this very task.
  const jev = isJev(run.model) ? await chooseClaudeModel(run.task, o.jev) : null;
  const model = jev ? jev.alias : claudeModel(run.model);
  if (jev)
    run.onEvent({
      type: 'route',
      decision: {
        model: `claude-code/${jev.alias}`,
        effort: null,
        tier: jev.tier,
        reason: jev.reason,
        switched: false,
        usage: jev.usage,
        classifierModel: jev.classifierModel,
      },
    });
  // Jev's classifier is the one real cost here; the agent's turns are the subscription's.
  const routing = jev?.usage?.cost ?? 0;
  const args = [
    '-p',
    // The task goes in on stdin, so messages from teammates can follow while it works.
    '--input-format',
    'stream-json',
    '--output-format',
    'stream-json',
    '--verbose',
    '--permission-mode',
    MODE[run.mode],
    '--mcp-config',
    config,
    // Only Kovan's tools here: not the person's own MCP servers.
    '--strict-mcp-config',
    '--permission-prompt-tool',
    'mcp__kovan__approval_prompt',
    '--allowedTools',
    'mcp__kovan',
    '--append-system-prompt',
    PROMPT,
    ...(coordinated ? ['--settings', settings] : []),
    ...(model ? ['--model', model] : []),
  ];
  let end: TurnEnd | null = null;
  let proc: ReturnType<typeof runJsonLines> | null = null;
  const parser = new ClaudeStreamParser(
    randomUUID(),
    run.root,
    (event) => {
      // The subscription pays: nothing counts against Kovan budgets.
      if (event.type === 'usage') event = { ...event, usage: { ...event.usage, cost: 0 } };
      if (event.type === 'turn_end') {
        event = { ...event, cost: routing };
        end = event;
      }
      run.onEvent(event);
    },
    o.onLimit,
  );
  try {
    proc = runJsonLines(
      o.binary,
      args,
      { cwd: run.root, pathEnv: o.pathEnv, name: 'Claude Code', input: true },
      (line) => {
        if (input!.line(line)) parser.push(line);
      },
    );
    input = new ClaudeLiveInput(proc.child, run.onEvent);
    input.start(task);
    const live: LiveAgent = {
      get running() {
        return input!.running;
      },
      steer: (s) => input!.steer(s),
      stop: () => stopGroup(proc!.child),
    };
    run.onAgent?.(live);
    const stop = () => stopGroup(proc!.child);
    run.signal.addEventListener('abort', stop, { once: true });
    const error = await proc.done;
    run.signal.removeEventListener('abort', stop);
    input.end();
    if (!parser.finished) {
      if (run.signal.aborted) parser.finish('stopped');
      else if (error) parser.finish('error', 0, error);
      else parser.finish('done');
    }
  } finally {
    unregister();
    await rm(config, { force: true });
    if (coordinated) await rm(settings, { force: true });
  }
  return (
    end ?? {
      type: 'turn_end',
      turnId: '',
      reason: 'error',
      cost: 0,
      error: 'Claude Code did not finish',
    }
  );
}
