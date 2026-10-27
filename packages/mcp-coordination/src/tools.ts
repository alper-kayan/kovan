import { readFile } from 'node:fs/promises';
import type { ToolDefinition } from './server.js';

/** How the MCP server reaches the Kovan app on this machine (written by the app at start-up). */
export interface BridgeInfo {
  port: number;
  token: string;
}

export interface BridgeContext {
  /** Path of bridge.json in Kovan's data folder. */
  bridgeFile: string;
  /** Repository the agent works in. */
  root: string;
  /** The Kovan conversation this agent belongs to, when Kovan launched it. */
  conversationId: string | null;
}

export type BridgeCall = (
  tool: string,
  args: Record<string, unknown>,
) => Promise<{ text: string; isError?: boolean }>;

/** Calls the Kovan app's loopback bridge. Fails soft: the agent keeps working without Kovan. */
export function bridgeCaller(ctx: BridgeContext): BridgeCall {
  return async (tool, args) => {
    let info: BridgeInfo;
    try {
      info = JSON.parse(await readFile(ctx.bridgeFile, 'utf8')) as BridgeInfo;
    } catch {
      return {
        text: 'Kovan is not running on this machine, so team context is unavailable. Continue the task on your own.',
        isError: true,
      };
    }
    try {
      const response = await fetch(`http://127.0.0.1:${info.port}/tool`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${info.token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ tool, args, root: ctx.root, conversationId: ctx.conversationId }),
        // Approvals wait for a person; everything else is quick.
        signal: AbortSignal.timeout(
          tool === 'approval_prompt' || tool === 'create_issue' ? 30 * 60_000 : 15_000,
        ),
      });
      if (!response.ok)
        return {
          text: `Kovan could not answer (HTTP ${response.status}). Continue on your own.`,
          isError: true,
        };
      return (await response.json()) as { text: string; isError?: boolean };
    } catch {
      return { text: "Kovan didn't respond. Continue the task on your own.", isError: true };
    }
  };
}

export const INSTRUCTIONS = `You are working inside Kovan, a shared workspace where teammates and their agents work on the same repository at the same time.
- Call get_team_context once at the start of a task to see who else is working here and on what; avoid editing files a teammate's agent is changing unless the user asks.
- Use the other kovan tools to coordinate (split work, claim and update plan steps, record durable project knowledge) instead of guessing what others are doing.
- Follow the Brain notes in the team context. When a note is FLAGGED and you work near its code, check the code and rewrite the note with record_memory (replaces: its id). When notes are DISPUTED, they may disagree: don't pick one silently; tell the person which notes conflict.
- Record a decision with why it was made, what follows from it, and the modules it governs.
- Work is owned by people; you act for the person who prompted you.`;

const obj = (properties: Record<string, unknown>, required: string[] = []) => ({
  type: 'object',
  properties,
  required,
  additionalProperties: false,
});

export function coordinationTools(call: BridgeCall): ToolDefinition[] {
  const via =
    (name: string): ToolDefinition['handler'] =>
    (args) =>
      call(name, args);
  return [
    {
      name: 'get_team_context',
      description:
        "Live team context for this repository: who is online and has it open, your role, live sessions and the files they touch, this session's plan, and the Brain notes (decisions, gotchas, conventions pinned to code). Use at the start of a task and before changing shared areas. Don't call it repeatedly within one task; it changes slowly.",
      inputSchema: obj({}),
      handler: via('get_team_context'),
    },
    {
      name: 'propose_split',
      description:
        "Propose splitting the current task into steps that teammates' agents could take. Use only for tasks big enough to parallelise; don't use for small or single-file changes.",
      inputSchema: obj(
        {
          summary: { type: 'string', description: 'One line describing the whole task' },
          steps: {
            type: 'array',
            items: obj(
              { title: { type: 'string' }, files: { type: 'array', items: { type: 'string' } } },
              ['title'],
            ),
          },
        },
        ['summary', 'steps'],
      ),
      handler: via('propose_split'),
    },
    {
      name: 'claim_plan_step',
      description:
        "Claim an unowned step of the session plan before working on it. Don't claim steps someone else owns; ask them instead.",
      inputSchema: obj({ stepId: { type: 'string' } }, ['stepId']),
      handler: via('claim_plan_step'),
    },
    {
      name: 'update_plan_step',
      description:
        "Mark a plan step you own as doing or done when your work on it starts or is finished. Don't change steps other people own.",
      inputSchema: obj(
        { stepId: { type: 'string' }, status: { type: 'string', enum: ['todo', 'doing', 'done'] } },
        ['stepId', 'status'],
      ),
      handler: via('update_plan_step'),
    },
    {
      name: 'assign_work',
      description:
        "Assign a board item to a teammate (by GitHub username). Only when the user asks you to hand work to someone; don't assign work on your own initiative.",
      inputSchema: obj(
        { to: { type: 'string' }, title: { type: 'string' }, note: { type: 'string' } },
        ['to', 'title'],
      ),
      handler: via('assign_work'),
    },
    {
      name: 'message_agent',
      description:
        "Send a short message to another agent in this session: a teammate's agent or an AI teammate, e.g. to coordinate on a shared file. Keep it actionable. Don't use it for status chatter or to reach the user.",
      inputSchema: obj(
        {
          to: {
            type: 'string',
            description: 'Name (or GitHub username) of the teammate or AI teammate',
          },
          text: { type: 'string' },
        },
        ['to', 'text'],
      ),
      handler: via('message_agent'),
    },
    {
      name: 'record_memory',
      description:
        "Save a short, durable note pinned to a file for every future agent: a decision, a gotcha, or a convention. Don't record temporary state, task progress, or anything the code itself makes obvious. To rewrite a FLAGGED note (its code moved or changed), pass its id as replaces.",
      inputSchema: obj(
        {
          path: {
            type: 'string',
            description: 'File the note is about, relative to the repo root',
          },
          line: { type: 'number', description: 'First line of the code it is about' },
          endLine: { type: 'number' },
          replaces: { type: 'string', description: 'Id of a flagged note this rewrites' },
          kind: { type: 'string', enum: ['decision', 'gotcha', 'convention'] },
          text: { type: 'string', description: 'One or two sentences' },
          why: { type: 'string', description: 'For a decision: why it was made' },
          consequences: {
            type: 'string',
            description: 'For a decision: what follows from it (what others must or must not do)',
          },
          affects: {
            type: 'array',
            items: { type: 'string' },
            description: 'For a decision: the folders or files (modules, services) it governs',
          },
        },
        ['path', 'kind', 'text'],
      ),
      handler: via('record_memory'),
    },
    {
      name: 'create_issue',
      description:
        "Open a GitHub issue (or comment on an existing one) for something that should be tracked rather than fixed now: a bug you found outside the task, follow-up work, a question for maintainers. The person sees the issue in Kovan and approves or edits it before anything is sent, so the call can take a while. Write a specific title and a body with what happens, what was expected and where in the code. Don't use it for the task you are doing, or to report progress.",
      inputSchema: obj(
        {
          title: { type: 'string', description: 'Short and specific' },
          body: {
            type: 'string',
            description: 'Markdown. What, where (files, lines), how to reproduce',
          },
          repo: {
            type: 'string',
            description:
              'owner/name of the repository the problem belongs to. Leave out for the repository you are working in.',
          },
          labels: { type: 'array', items: { type: 'string' } },
          comment_on: {
            type: 'number',
            description:
              'Number of an open issue to add this as a comment to, instead of a new issue',
          },
        },
        ['title', 'body'],
      ),
      handler: via('create_issue'),
    },
    {
      name: 'approval_prompt',
      description:
        "Used by Kovan to ask the person to approve a tool call (Claude Code's permission prompt). Don't call it yourself.",
      inputSchema: obj(
        {
          tool_name: { type: 'string' },
          input: { type: 'object' },
          tool_use_id: { type: 'string' },
        },
        ['tool_name', 'input'],
      ),
      handler: via('approval_prompt'),
    },
  ];
}
