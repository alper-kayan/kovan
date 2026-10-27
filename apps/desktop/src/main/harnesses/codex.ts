import type { AgentEvent, PermissionMode } from '@kovan/harness';
import type { ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { KOVAN_APPEND_PROMPT } from './claudeCode.js';
import { readCodexRateLimits } from './codexLimits.js';
import {
  CODEX_SANDBOX,
  codexMcpArgs,
  CodexStreamParser,
  NO_TOTALS,
  runJsonLines,
  stopGroup,
  toml,
  type CodexTotals,
  type ExternalRunner,
  type McpServerSpec,
} from '@kovan/runner';

export { CODEX_SANDBOX, codexMcpArgs, type McpServerSpec } from '@kovan/runner';

const PLAN_NOTE =
  'Plan mode: investigate and reply with a step-by-step plan. Do not change files or run commands that change anything.';

export interface CodexOptions {
  binary: string;
  root: string;
  /** "default" lets Codex choose; otherwise a Codex model slug. */
  model: string;
  mode: PermissionMode;
  mcpServer: McpServerSpec;
  /** Codex's own thread, so later turns continue the same conversation. */
  threadId: string | null;
  onThread: (threadId: string) => void;
  onEvent: (event: AgentEvent) => void;
  /** Codex's `rate_limits` for the thread, read after each turn. */
  onLimit?: (limits: Record<string, unknown>) => void;
  pathEnv: string;
  /** The account it runs as: its folder (CODEX_HOME); empty for the CLI's own sign-in. */
  env?: Record<string, string>;
}

/** Runs Codex headless (`codex exec --json`), one process per turn. */
export class CodexRunner implements ExternalRunner {
  private child: ChildProcess | null = null;
  private stopped = false;
  /** Codex reports usage for the whole thread; kept to work out each turn's share. */
  private totals: CodexTotals = NO_TOTALS;

  constructor(private options: CodexOptions) {}

  get running(): boolean {
    return this.child !== null;
  }

  configure(patch: Partial<Pick<CodexOptions, 'model' | 'mode'>>): void {
    this.options = { ...this.options, ...patch };
  }

  stop(): void {
    this.stopped = true;
    stopGroup(this.child);
  }

  async send(prompt: string): Promise<void> {
    if (this.child) throw new Error('Codex is already working');
    const o = this.options;
    const args = [
      'exec',
      ...(o.threadId ? ['resume', o.threadId] : []),
      '--json',
      '--skip-git-repo-check',
      '-c',
      `sandbox_mode=${toml(CODEX_SANDBOX[o.mode])}`,
      ...codexMcpArgs(o.mcpServer),
      ...(o.model && o.model !== 'default' ? ['-m', o.model] : []),
      [
        // On the first turn only; setting developer_instructions would replace the person's own.
        ...(o.threadId ? [] : [KOVAN_APPEND_PROMPT]),
        ...(o.mode === 'plan' ? [PLAN_NOTE] : []),
        prompt,
      ].join('\n\n'),
    ];
    const parser = new CodexStreamParser(
      randomUUID(),
      o.root,
      o.model === 'default' ? 'default' : o.model,
      o.onEvent,
      this.totals,
    );
    this.stopped = false;
    const run = runJsonLines(
      o.binary,
      args,
      { cwd: o.root, pathEnv: o.pathEnv, name: 'Codex', env: o.env ?? {} },
      (line) => parser.push(line),
    );
    this.child = run.child;
    const error = await run.done;
    this.child = null;
    this.totals = parser.totals;
    if (parser.threadId && parser.threadId !== o.threadId) {
      o.threadId = parser.threadId;
      o.onThread(parser.threadId);
    }
    // Before the turn ends, so whoever handles a limit error already knows when it resets.
    if (o.threadId && o.onLimit) {
      const limits = await readCodexRateLimits(o.threadId, o.env?.['CODEX_HOME']).catch(() => null);
      if (limits) o.onLimit(limits);
    }
    if (this.stopped) parser.finish('stopped');
    else if (error) parser.finish('error', error);
    else parser.finish('done');
  }
}
