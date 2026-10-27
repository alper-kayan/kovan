import type { ApprovalRequest, Tool, ToolKind } from '@kovan/harness';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { dirname } from 'node:path';

/** A run's side of the bridge: its tools, and who decides its permission prompts. */
export interface BridgedRun {
  root: string;
  tools: Tool[];
  approve(request: ApprovalRequest): Promise<boolean>;
  signal: AbortSignal;
  /**
   * Answers a question the agent would ask a person (Claude Code's AskUserQuestion): nobody is
   * at this machine, so something decides for them. Without it, the agent decides itself.
   */
  decide?(questions: unknown): Promise<string>;
  /** Before a write: a note to hold it with, or null (Claude Code's PreToolUse hook asks). */
  checkWrite?(path: string): Promise<string | null>;
  /** The team note, given after a tool call when it changed (the PostToolUse hook asks). */
  context?(): Promise<string | null>;
  /** Messages written to its turn that its model hasn't seen yet. */
  pending?(): number;
}

/** How often a run's team note is given again, at most (when it changed). */
const NOTE_REFRESH_MS = 20_000;

/** What the MCP server inside Claude Code lists: a tool's name, description and schema. */
export interface BridgedTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

const APPROVAL: BridgedTool = {
  name: 'approval_prompt',
  description:
    "Claude Code's permission prompt, answered by Kovan's policy for this machine. Don't call it yourself.",
  inputSchema: {
    type: 'object',
    properties: {
      tool_name: { type: 'string' },
      input: { type: 'object' },
      tool_use_id: { type: 'string' },
    },
    required: ['tool_name', 'input'],
  },
};

const EDITS = new Set(['Edit', 'MultiEdit', 'Write', 'NotebookEdit']);

/** Claude Code's tool call in Kovan's terms, for the policy that answers it. */
export function asApproval(
  id: string,
  toolName: string,
  input: Record<string, unknown>,
): ApprovalRequest {
  const kind: ToolKind =
    toolName === 'Bash' ? 'command' : EDITS.has(toolName) ? 'edit' : 'external';
  const detail =
    kind === 'command'
      ? String(input['command'] ?? '')
      : kind === 'edit'
        ? String(input['file_path'] ?? input['notebook_path'] ?? '')
        : `${toolName}\n${JSON.stringify(input).slice(0, 2000)}`;
  return {
    id,
    tool: toolName,
    kind,
    title:
      kind === 'command' ? 'Run this?' : kind === 'edit' ? 'Make this edit?' : 'Use this tool?',
    detail,
  };
}

/**
 * The loopback endpoint the MCP server inside Claude Code calls: for each run it lists that
 * run's tools (a swarm's assign_tasks, review_verdict, message_agent…), runs them, and answers
 * Claude Code's permission prompts with the run's own approval. It listens on 127.0.0.1 only,
 * with a random token kept in a file only this user can read.
 */
export class ToolBridge {
  private server: Server | null = null;
  private readonly token = randomBytes(24).toString('base64url');
  private readonly runs = new Map<string, BridgedRun>();
  /** The team note each run last got, and when. */
  private readonly notes = new Map<string, { note: string; at: number }>();

  constructor(readonly file: string) {}

  register(run: BridgedRun): { id: string; unregister: () => void } {
    const id = randomUUID();
    this.runs.set(id, run);
    return {
      id,
      unregister: () => {
        this.runs.delete(id);
        this.notes.delete(id);
      },
    };
  }

  async start(): Promise<void> {
    const expected = Buffer.from(`Bearer ${this.token}`);
    this.server = createServer((req, res) => {
      const auth = Buffer.from(req.headers.authorization ?? '');
      if (
        req.method !== 'POST' ||
        auth.length !== expected.length ||
        !timingSafeEqual(auth, expected)
      ) {
        res.writeHead(404).end();
        return;
      }
      let body = '';
      req.setEncoding('utf8');
      req.on('data', (chunk: string) => {
        body += chunk;
        if (body.length > 2_000_000) req.destroy();
      });
      req.on('end', () => {
        void this.answer(body).then((out) =>
          res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(out)),
        );
      });
    });
    this.server.requestTimeout = 0;
    await new Promise<void>((resolve) => this.server!.listen(0, '127.0.0.1', resolve));
    const port = (this.server.address() as { port: number }).port;
    await mkdir(dirname(this.file), { recursive: true });
    await writeFile(this.file, JSON.stringify({ port, token: this.token }), { mode: 0o600 });
  }

  async stop(): Promise<void> {
    this.server?.close();
    await rm(this.file, { force: true });
  }

  /** Claude Code's hooks for a run: hold a write, or give the team note after a tool call. */
  private async hook(id: string, run: BridgedRun, input: Record<string, unknown>): Promise<string> {
    const event = input['hook_event_name'];
    if (event === 'PreToolUse') {
      if (!EDITS.has(String(input['tool_name'] ?? ''))) return '';
      const args = (input['tool_input'] ?? {}) as Record<string, unknown>;
      const raw = String(args['file_path'] ?? args['notebook_path'] ?? '');
      // Claude Code may name it by the folder's real path (/private/var/… for /var/…).
      const roots = [run.root, await realpath(run.root).catch(() => run.root)];
      const root = roots.find((r) => raw.startsWith(`${r}/`));
      const path = root ? raw.slice(root.length + 1) : raw;
      const held = run.pending?.()
        ? 'Held this edit: a new message came in while you worked. Read it (it comes with your next step), then make the edit again if it still applies.'
        : ((await run.checkWrite?.(path).catch(() => null)) ?? null);
      if (!held) return '';
      return JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'deny',
          permissionDecisionReason: held,
        },
      });
    }
    if (event === 'PostToolUse' && run.context) {
      const last = this.notes.get(id);
      if (last && Date.now() - last.at < NOTE_REFRESH_MS) return '';
      const note = await run.context().catch(() => null);
      if (!note || note === last?.note) return '';
      this.notes.set(id, { note, at: Date.now() });
      return JSON.stringify({
        hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: note },
      });
    }
    return '';
  }

  private async answer(body: string): Promise<unknown> {
    let message: { run?: string; op?: string; tool?: string; args?: Record<string, unknown> };
    try {
      message = JSON.parse(body) as typeof message;
    } catch {
      return { text: 'Bad request', isError: true };
    }
    const run = message.run ? this.runs.get(message.run) : undefined;
    if (!run)
      return message.op === 'list' ? { tools: [] } : { text: 'This run is over.', isError: true };
    if (message.op === 'list')
      return {
        tools: [
          APPROVAL,
          ...run.tools.map((t) => ({
            name: t.spec.name,
            description: t.spec.description,
            inputSchema: t.spec.parameters,
          })),
        ],
      };
    const args = message.args ?? {};
    if (message.op === 'hook') return { text: await this.hook(message.run!, run, args) };
    if (message.tool === 'approval_prompt') {
      const input = (args['input'] ?? {}) as Record<string, unknown>;
      const request = asApproval(
        String(args['tool_use_id'] ?? randomUUID()),
        String(args['tool_name'] ?? ''),
        input,
      );
      // Nobody is at this machine to answer a question: Kovan decides, and the agent says so.
      if (request.tool === 'AskUserQuestion') {
        const decided = run.decide
          ? await run.decide(input['questions'] ?? input).catch(() => null)
          : null;
        return {
          text: JSON.stringify({
            behavior: 'deny',
            message: decided
              ? `Nobody is at this machine, so Kovan answered for them: ${decided} Go on with these answers and mention them in your reply.`
              : 'Nobody can answer questions here. Pick the most reasonable option, say in your reply what you assumed, and carry on.',
          }),
        };
      }
      // The run's own Kovan tools (assign_tasks, review_verdict…) are its job, never a risk.
      const ok =
        String(args['tool_name'] ?? '').startsWith('mcp__kovan__') ||
        (await run.approve(request).catch(() => false));
      return {
        text: JSON.stringify(
          ok
            ? { behavior: 'allow', updatedInput: input }
            : {
                behavior: 'deny',
                message:
                  "Refused: on this machine an agent may only run checks (tests, linters, builds) and read, one plain command at a time (no pipes, chains or redirects: run `npm test`, not `npm test | tail`); it can't push, publish, delete, install or reach out.",
              },
        ),
      };
    }
    const tool = run.tools.find((t) => t.spec.name === message.tool);
    if (!tool) return { text: `Unknown tool ${String(message.tool)}`, isError: true };
    try {
      const result = await tool.run(args, { root: run.root, isRepo: true, signal: run.signal });
      return { text: result.output, isError: !result.ok };
    } catch (error) {
      return { text: `Error: ${(error as Error).message}`, isError: true };
    }
  }
}
