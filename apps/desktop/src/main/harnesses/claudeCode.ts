import type { AgentEvent, PermissionMode } from '@kovan/harness';
import type { ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { ClaudeStreamParser } from '@kovan/runner';
import { ClaudeLiveInput, runJsonLines, stopGroup, type ExternalRunner } from '@kovan/runner';

/** Kovan's permission modes in Claude Code's terms. */
export const CLAUDE_PERMISSION_MODE: Record<PermissionMode, string> = {
  plan: 'plan',
  request: 'manual',
  allow: 'acceptEdits',
  full: 'bypassPermissions',
};

/** Added to Claude Code's own system prompt for Kovan-launched sessions. */
export const KOVAN_APPEND_PROMPT =
  'You are running inside Kovan, a shared workspace where teammates and their agents work on this repository at the same time. Use the kovan MCP tools to see team context and coordinate; call get_team_context at the start of a task.';

export interface ClaudeCodeOptions {
  binary: string;
  root: string;
  /** "default" lets Claude Code choose; otherwise an alias (sonnet, opus, haiku) or a model id. */
  model: string;
  mode: PermissionMode;
  mcpConfigFile: string;
  /** Claude Code's own session, so later turns continue the same conversation. */
  sessionId: string | null;
  onSession: (sessionId: string) => void;
  onEvent: (event: AgentEvent) => void;
  /** Claude Code's own report of its account limit (`rate_limit_info`). */
  onLimit?: (info: Record<string, unknown>) => void;
  /** The user's login-shell PATH, so Claude Code finds node, git and friends. */
  pathEnv: string;
  /** The account it runs as: its folder (CLAUDE_CONFIG_DIR); empty for the CLI's own sign-in. */
  env?: Record<string, string>;
}

/** Runs Claude Code headless (`claude -p … --output-format stream-json`), one process per turn. */
export class ClaudeCodeRunner implements ExternalRunner {
  private child: ChildProcess | null = null;
  private stopped = false;

  private input: ClaudeLiveInput | null = null;

  constructor(private options: ClaudeCodeOptions) {}

  get running(): boolean {
    return this.child !== null;
  }

  configure(patch: Partial<Pick<ClaudeCodeOptions, 'model' | 'mode'>>): void {
    this.options = { ...this.options, ...patch };
  }

  stop(): void {
    this.stopped = true;
    stopGroup(this.child);
  }

  /** A teammate's message for the running turn (Claude Code takes it at its next step). */
  steer(steer: { id: string; text: string; fromUserId?: string; fromName?: string }): boolean {
    return this.input?.steer(steer) ?? false;
  }

  async send(prompt: string): Promise<void> {
    if (this.child) throw new Error('Claude Code is already working');
    const o = this.options;
    const sessionId = o.sessionId ?? randomUUID();
    const args = [
      '-p',
      // The prompt goes in on stdin, so teammates' messages can follow while it works.
      '--input-format',
      'stream-json',
      '--output-format',
      'stream-json',
      '--verbose',
      // Tool calls arrive while they're written, so the editor can show the agent typing.
      '--include-partial-messages',
      '--permission-mode',
      CLAUDE_PERMISSION_MODE[o.mode],
      '--mcp-config',
      o.mcpConfigFile,
      '--permission-prompt-tool',
      'mcp__kovan__approval_prompt',
      // Kovan's own coordination tools never need a permission prompt.
      '--allowedTools',
      'mcp__kovan',
      '--append-system-prompt',
      KOVAN_APPEND_PROMPT,
      ...(o.model && o.model !== 'default' ? ['--model', o.model] : []),
      ...(o.sessionId ? ['--resume', o.sessionId] : ['--session-id', sessionId]),
    ];
    if (!o.sessionId) o.onSession(sessionId);

    const parser = new ClaudeStreamParser(randomUUID(), o.root, o.onEvent, o.onLimit);
    this.stopped = false;
    let input: ClaudeLiveInput | null = null;
    const run = runJsonLines(
      o.binary,
      args,
      { cwd: o.root, pathEnv: o.pathEnv, name: 'Claude Code', input: true, env: o.env ?? {} },
      (line) => {
        if (input!.line(line)) parser.push(line);
      },
    );
    this.child = run.child;
    input = new ClaudeLiveInput(run.child, o.onEvent);
    this.input = input;
    input.start(prompt);
    const error = await run.done;
    input.end();
    this.input = null;
    this.child = null;
    if (parser.sessionId && parser.sessionId !== o.sessionId) {
      o.sessionId = parser.sessionId;
      o.onSession(parser.sessionId);
    } else {
      o.sessionId = sessionId;
    }
    if (this.stopped) parser.finish('stopped');
    else if (error) parser.finish('error', 0, error);
    else parser.finish('done');
  }
}
