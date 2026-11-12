import type {
  ChatMessage,
  ChatRequest,
  ContentPart,
  Effort,
  RouteDecision,
  StreamEvent,
  ToolCall,
  Usage,
} from '@kovan/model-gateway';
import { git } from '@kovan/git-engine';
import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import {
  compactPoint,
  estimateTokens,
  isContextOverflow,
  nearWindow,
  SUMMARY_HEADER,
  SUMMARY_PROMPT,
  transcriptOf,
} from './compact.js';
import { FolderRules } from './folderRules.js';
import { resolveInside } from './paths.js';
import { editProgress } from './partial.js';
import { isRiskyCommand } from './recovery.js';
import {
  NO_PROGRESS_NOTE,
  ReplyWatch,
  RUNAWAY_MESSAGES,
  StepWatch,
  type RunawayReason,
} from './runaway.js';
import {
  parseSkillCommand,
  skillCatalog,
  skillReadRoots,
  skillText,
  useSkillTool,
  type SkillSet,
} from './skills.js';
import { ALL_TOOLS, runTool, type Tool, type ToolKind, type ToolResult } from './tools.js';

/**
 * Permission modes, as in the composer:
 * plan    - read-only: edit and command tools aren't offered at all
 * request - ask before every edit and command
 * allow   - edit files freely, ask before commands
 * full    - run anything without asking
 */
export type PermissionMode = 'plan' | 'request' | 'allow' | 'full';

export function needsApproval(mode: PermissionMode, kind: ToolKind): boolean {
  if (kind === 'read' || kind === 'team') return false;
  if (mode === 'full') return false;
  // Someone else's tool asks in Allow mode too, like a command.
  if (mode === 'allow') return kind === 'command' || kind === 'external';
  return true;
}

export function toolsForMode(mode: PermissionMode, extra: Tool[] = []): Tool[] {
  const all = [...ALL_TOOLS, ...extra];
  return mode === 'plan'
    ? all.filter(
        (t) => t.kind === 'read' || t.kind === 'team' || (t.kind === 'external' && t.readOnly),
      )
    : all;
}

export interface ApprovalRequest {
  id: string;
  tool: string;
  kind: ToolKind;
  /** "Run this?" / "Edit this file?" */
  title: string;
  /** The exact command, or the edit summary. */
  detail: string;
  path?: string;
  /** A GitHub issue about to be created: the card lets the person edit it first. */
  issue?: IssueDraft;
  /** A repository MCP server asking to start: the card offers once / always / no. */
  trustKey?: string;
}

export interface IssueDraft {
  /** "owner/name": where it goes, one of `repos`. */
  repo: string;
  /** The repositories it may go to (this checkout's and the person's other workspaces'). */
  repos: string[];
  title: string;
  body: string;
  labels: string[];
  /** Open issues that look like the same thing. */
  similar: { number: number; title: string; url: string }[];
}

/** What the person changed on the card before approving. */
export interface IssueEdits {
  repo: string;
  title: string;
  body: string;
  labels: string[];
  /** Comment on this open issue instead of creating a new one. */
  commentOn: number | null;
  /** Create issues in this repository without asking from now on. */
  dontAsk: boolean;
}

export type AgentEvent =
  | { type: 'turn_start'; turnId: string; model: string }
  | { type: 'reasoning'; text: string }
  | { type: 'text'; text: string }
  | {
      type: 'tool_start';
      id: string;
      name: string;
      summary: string;
      args: Record<string, unknown>;
      /** A helper agent's step: the id of the tool call that started that helper. */
      parent?: string;
    }
  | { type: 'approval'; request: ApprovalRequest }
  | { type: 'approval_resolved'; id: string; approved: boolean }
  | { type: 'tool_end'; id: string; ok: boolean; output: string; meta?: ToolResult['meta'] }
  | { type: 'route'; decision: RouteDecision }
  | {
      type: 'usage';
      usage: Usage;
      model: string | null;
      /** "routing" is the router's own classifier call. */
      kind: 'model' | 'routing';
      /** The provider reported no cost, so it was priced from the rate card. */
      estimated: boolean;
    }
  /**
   * An edit the model is still writing: the file, the text it replaces (once written) and the
   * new text so far. For showing the agent typing; not kept in the transcript.
   */
  | {
      type: 'tool_progress';
      id: string;
      name: string;
      path: string | null;
      anchor: string | null;
      text: string;
    }
  | {
      type: 'turn_end';
      turnId: string;
      reason: 'done' | 'stopped' | 'error' | 'step_limit';
      error?: string;
      cost: number;
      /** Stopped at a safe checkpoint (no action in flight), e.g. for a takeover. */
      checkpoint?: boolean;
    }
  /**
   * Guidance added to a running turn. "delivered" once the model has it; "returned" when the
   * turn ended first, so the text can go back to the composer.
   */
  | {
      type: 'steer';
      id: string;
      text: string;
      fromUserId?: string;
      fromName?: string;
      status: 'delivered' | 'returned';
    }
  /** An action cut off mid-flight: never retried; a person records what happened. */
  | { type: 'outcome_unknown'; toolId: string; command: string; evidence: string }
  /** The older part of the conversation was summarized to fit the model's context window. */
  | { type: 'compacted'; before: number; after: number };

/** Streams one model turn. Abstracted so tests can script the model. */
export interface ModelStreamer {
  stream(request: ChatRequest, signal?: AbortSignal): AsyncIterable<StreamEvent>;
}

export interface AgentOptions {
  model: ModelStreamer;
  modelId: string;
  effort: Effort | null;
  mode: PermissionMode;
  root: string;
  isRepo: boolean;
  systemPrompt: string;
  /** Resolves to true to run the action, false to skip it. Called once per gated action. */
  approve: (request: ApprovalRequest) => Promise<boolean>;
  onEvent: (event: AgentEvent) => void;
  maxSteps?: number;
  /** Prices a call when the provider doesn't report a cost. */
  price?: (model: string, usage: Usage) => number | null;
  /** Tools beyond the built-in ones, e.g. Kovan's team tools (plans, Brain notes). */
  extraTools?: Tool[];
  /**
   * Read at the start of every turn and given to the model as a system note: what the team
   * knows right now (Brain notes, the session plan). Failing or empty is fine.
   */
  turnContext?: () => Promise<string | null>;
  /**
   * The skills this agent can use, read at the start of every turn (they live in files that
   * can change between turns). Failing or empty means none.
   */
  skills?: () => Promise<SkillSet | null>;
  /**
   * Tools that can change between turns (an MCP server's), read at the start of every turn.
   * Failing means none this turn.
   */
  turnTools?: () => Promise<Tool[]>;
  /**
   * Asked before each file write (with the path): a note holds the write and goes to the
   * model instead (a teammate is changing that code); null lets it go ahead. Failing is null.
   */
  checkWrite?: (path: string) => Promise<string | null>;
  /**
   * The context window of a model, in tokens (null: unknown). Near it, the older part of the
   * conversation is summarized by the same model and the newest part kept as it is.
   */
  contextWindow?: (model: string) => number | null;
  /** How often the team note is read again during a turn (tests make it short). */
  contextRefreshMs?: number;
}

/** This turn's skills: the tool that loads them, their list for the model, readable folders. */
interface TurnSkills {
  tool: Tool | null;
  catalog: string | null;
  readRoots: string[];
}

/** How often a running turn reads the team note again (it costs a few server calls). */
const CONTEXT_REFRESH_MS = 20_000;

/** A conversation with one agent: its history, and the loop that runs each turn. */
export class Agent {
  readonly messages: ChatMessage[];
  private abort: AbortController | null = null;
  private steers: { id: string; text: string; fromUserId?: string; fromName?: string }[] = [];
  private checkpointWanted = false;
  private inTool = false;
  /** This turn's team context; not kept in the history, so it is always current. */
  private teamNote: string | null = null;
  /** Rules kept in the repository's folders, read as the agent reaches them. */
  private folderRules: FolderRules | null = null;
  private teamNoteAt = 0;
  private turnSkills: TurnSkills = { tool: null, catalog: null, readRoots: [] };
  private turnTools: Tool[] = [];

  constructor(
    private options: AgentOptions,
    history: ChatMessage[] = [],
  ) {
    this.messages = history.length ? history : [{ role: 'system', content: options.systemPrompt }];
  }

  get running(): boolean {
    return this.abort !== null;
  }

  /** Switch model, effort or mode between turns. */
  configure(
    patch: Partial<Pick<AgentOptions, 'modelId' | 'effort' | 'mode' | 'model' | 'extraTools'>>,
  ): void {
    this.options = { ...this.options, ...patch };
  }

  stop(): void {
    this.abort?.abort();
  }

  /**
   * Stops at the next safe checkpoint: right away when no action is in flight, otherwise once
   * the current one finishes. Nothing is left half-done.
   */
  stopAtCheckpoint(): void {
    if (!this.abort) return;
    this.checkpointWanted = true;
    if (!this.inTool) this.abort.abort();
  }

  /** Adds guidance to the running turn; the model gets it before its next step. */
  steer(steer: { id: string; text: string; fromUserId?: string; fromName?: string }): boolean {
    if (!this.abort) return false;
    this.steers.push(steer);
    return true;
  }

  async send(content: string | ContentPart[]): Promise<void> {
    if (this.abort) throw new Error('The agent is already working');
    const abort = new AbortController();
    this.abort = abort;
    const turnId = randomUUID();
    const { onEvent, maxSteps = 60 } = this.options;
    let cost = 0;
    onEvent({ type: 'turn_start', turnId, model: this.options.modelId });
    const skills = (await this.options.skills?.().catch(() => null))?.skills ?? [];
    const root = this.options.root;
    this.turnSkills = {
      tool: skills.some((s) => s.enabled) ? useSkillTool(skills, root) : null,
      catalog: skillCatalog(skills),
      readRoots: await skillReadRoots(skills, root).catch(() => []),
    };
    // "/release-notes …": the person picked the skill; it is loaded with their message.
    const typed = typeof content === 'string' ? content : null;
    const invoked = typed === null ? null : parseSkillCommand(typed, skills);
    if (invoked) {
      const id = `skill-${randomUUID()}`;
      const { name } = invoked.skill;
      onEvent({
        type: 'tool_start',
        id,
        name: 'use_skill',
        summary: `Used skill ${name}`,
        args: { name },
      });
      const loaded = await skillText(invoked.skill, root);
      onEvent({ type: 'tool_end', id, ok: true, output: loaded });
      this.messages.push({
        role: 'user',
        content: `${typed}\n\n[I invoked the skill "${name}". Its instructions follow; apply them to my request${invoked.rest ? ' above' : ''}.]\n\n${loaded}`,
      });
    } else this.messages.push({ role: 'user', content });
    this.teamNote = (await this.options.turnContext?.().catch(() => null)) ?? null;
    this.teamNoteAt = Date.now();
    this.turnTools = (await this.options.turnTools?.().catch(() => [])) ?? [];

    const finish = (reason: 'done' | 'stopped' | 'error' | 'step_limit', error?: string) => {
      this.abort = null;
      // Guidance the model never got goes back to whoever wrote it.
      for (const s of this.steers.splice(0)) onEvent({ type: 'steer', ...s, status: 'returned' });
      const checkpoint = this.checkpointWanted && reason === 'stopped';
      this.checkpointWanted = false;
      onEvent({
        type: 'turn_end',
        turnId,
        reason,
        cost,
        ...(error ? { error } : {}),
        ...(checkpoint ? { checkpoint: true } : {}),
      });
    };

    const steps = new StepWatch();
    let compactedForOverflow = false;
    try {
      for (let step = 0; step < maxSteps; step++) {
        // What the team is doing changes while a long turn runs: read again between steps.
        if (step > 0) await this.refreshTeamNote();
        // Near the model's window: the older part is summarized before the request goes out.
        cost += await this.compactIfNear(abort.signal);
        for (const s of this.steers.splice(0)) {
          const who = s.fromName ? ` from ${s.fromName}` : '';
          this.messages.push({ role: 'user', content: `Guidance${who} while you work: ${s.text}` });
          onEvent({ type: 'steer', ...s, status: 'delivered' });
        }
        const tools = toolsForMode(this.options.mode, [
          ...(this.options.extraTools ?? []),
          ...(this.turnSkills.tool ? [this.turnSkills.tool] : []),
          ...this.turnTools,
        ]);
        let text = '';
        const calls: ToolCall[] = [];
        let reasoningDetails: unknown[] = [];
        // A reply that runs away is cut off on its own, without stopping the whole turn's signal.
        const reply = new AbortController();
        const cut = () => reply.abort();
        abort.signal.addEventListener('abort', cut, { once: true });
        const watch = new ReplyWatch();
        const written = new Map<string, number>();
        let runaway: RunawayReason | null = null;
        const stream = this.options.model.stream(
          {
            model: this.options.modelId,
            messages: this.withModeNote(),
            tools: tools.map((t) => t.spec),
            effort: this.options.effort,
          },
          reply.signal,
        );
        let overflow = false;
        try {
          for await (const event of stream) {
            if (event.type === 'text' || event.type === 'reasoning')
              runaway = watch.add(event.type, event.text);
            else if (event.type === 'tool_progress') {
              runaway = watch.add('arguments', event.arguments.slice(written.get(event.id) ?? 0));
              written.set(event.id, event.arguments.length);
            }
            if (runaway) break;
            if (event.type === 'route') {
              onEvent(event);
              if (event.decision.usage)
                cost += this.recordUsage(
                  event.decision.usage,
                  event.decision.classifierModel,
                  'routing',
                );
            } else if (event.type === 'reasoning') onEvent(event);
            else if (event.type === 'text') {
              text += event.text;
              onEvent(event);
            } else if (event.type === 'tool_call') calls.push(event.call);
            else if (event.type === 'tool_progress') this.progress(event);
            else if (event.type === 'done') {
              reasoningDetails = event.reasoningDetails;
              if (event.model) this.lastModel = event.model;
              if (event.usage) {
                this.lastPromptTokens = event.usage.promptTokens;
                cost += this.recordUsage(event.usage, event.model, 'model');
              }
            }
          }
        } catch (error) {
          // Too long for the model after all (the estimate was low): summarize once and retry.
          if (compactedForOverflow || abort.signal.aborted || !isContextOverflow(error))
            throw error;
          overflow = true;
        }
        abort.signal.removeEventListener('abort', cut);
        if (overflow) {
          compactedForOverflow = true;
          const spent = await this.compact(abort.signal, true);
          if (spent === null)
            throw new Error('The conversation is too long for this model, even summarized.');
          cost += spent;
          step--;
          continue;
        }
        if (runaway) {
          reply.abort();
          // A reply cut off never gets the provider's usage, but it was billed: estimate it
          // from what streamed (about four characters a token) so budgets still see it.
          cost += this.recordUsage(
            {
              promptTokens: Math.ceil(JSON.stringify(this.messages).length / 4),
              completionTokens: Math.ceil(watch.size / 4),
              cachedTokens: 0,
              reasoningTokens: 0,
              cost: null,
            },
            this.options.modelId,
            'model',
          );
          return finish('error', RUNAWAY_MESSAGES[runaway]);
        }
        // Nothing at all came back (no text, no tool call) on the turn's first step: say so,
        // instead of a turn that ends in silence with only its cost.
        if (step === 0 && calls.length === 0 && !text.trim())
          return finish(
            'error',
            'The model sent back an empty answer, so nothing happened. Try again, or pick another model.',
          );
        this.messages.push({
          role: 'assistant',
          content: text || null,
          ...(calls.length ? { tool_calls: calls } : {}),
          ...(reasoningDetails.length ? { reasoning_details: reasoningDetails } : {}),
        });
        if (calls.length === 0) return finish('done');

        const ran: { name: string; args: string; output: string; invalid: boolean }[] = [];
        for (const call of calls) {
          if (abort.signal.aborted) {
            this.messages.push({
              role: 'tool',
              tool_call_id: call.id,
              content: 'Stopped by the user before this ran.',
            });
            continue;
          }
          this.inTool = true;
          try {
            const result = await this.runCall(call, tools, abort.signal);
            ran.push({ name: call.function.name, args: call.function.arguments, ...result });
            this.messages.push({ role: 'tool', tool_call_id: call.id, content: result.output });
          } finally {
            this.inTool = false;
          }
          // A checkpoint was asked for while this ran: stop here, before the next action.
          if (this.checkpointWanted) abort.abort();
        }
        if (abort.signal.aborted) return finish('stopped');
        // A one-call step may repeat the last: the files' state tells progress from none.
        const tree = ran.length === 1 ? await this.treeState() : null;
        const watched = steps.step(ran, tree);
        if (watched.stop) return finish('error', RUNAWAY_MESSAGES[watched.stop]);
        if (watched.warn) this.messages.push({ role: 'user', content: NO_PROGRESS_NOTE });
      }
      return finish('step_limit');
    } catch (error) {
      if (abort.signal.aborted) return finish('stopped');
      // Keep the history valid: a dangling user turn is fine, a dangling tool call is not.
      const last = this.messages.at(-1);
      if (last?.role === 'assistant' && last.tool_calls) {
        for (const call of last.tool_calls)
          this.messages.push({
            role: 'tool',
            tool_call_id: call.id,
            content: 'Not run: the turn failed.',
          });
      }
      return finish('error', error instanceof Error ? error.message : String(error));
    }
  }

  /**
   * The team note again (locks, plan, teammates' work), at most every CONTEXT_REFRESH_MS during
   * a turn; a failed read keeps the last one. Changed or not, the model sees the newest.
   */
  private async refreshTeamNote(): Promise<void> {
    if (!this.options.turnContext) return;
    if (Date.now() - this.teamNoteAt < (this.options.contextRefreshMs ?? CONTEXT_REFRESH_MS))
      return;
    this.teamNoteAt = Date.now();
    const note = await this.options.turnContext().catch(() => undefined);
    if (note !== undefined) this.teamNote = note;
  }

  /** The files' state (a git repository's changes, hashed), or null when it can't be read. */
  private async treeState(): Promise<string | null> {
    if (!this.options.isRepo) return null;
    try {
      // Works before the first commit too (no HEAD needed).
      const [status, unstaged, staged] = await Promise.all([
        git(this.options.root, ['status', '--porcelain=v1', '--untracked-files=all']),
        git(this.options.root, ['diff']),
        git(this.options.root, ['diff', '--cached']),
      ]);
      return createHash('sha256')
        .update(status)
        .update('\0')
        .update(unstaged)
        .update('\0')
        .update(staged)
        .digest('hex');
    } catch {
      return null;
    }
  }

  private lastModel: string | null = null;
  private lastPromptTokens = 0;

  /** Summarizes the older part when the conversation nears the model's window; its cost. */
  private async compactIfNear(signal: AbortSignal): Promise<number> {
    const window = this.options.contextWindow?.(this.lastModel ?? this.options.modelId);
    if (!window) return 0;
    const tokens = Math.max(estimateTokens(this.withModeNote()), this.lastPromptTokens);
    if (!nearWindow(tokens, window)) return 0;
    return (await this.compact(signal)) ?? 0;
  }

  /**
   * Replaces the older part of the conversation (after the system prompt) with a summary by the
   * same model, keeping about the newest 20k tokens as they are. In place: whoever keeps this
   * history keeps the compacted one. Returns its cost, or null when there was nothing to do.
   */
  private async compact(signal: AbortSignal, overflowed = false): Promise<number | null> {
    const window = this.options.contextWindow?.(this.lastModel ?? this.options.modelId) ?? 128_000;
    // After the model refused it as too long, the estimate was low: keep only the newest quarter.
    const keep = overflowed
      ? Math.max(1, Math.floor(estimateTokens(this.messages) / 4))
      : Math.min(20_000, window * 0.25);
    const point = compactPoint(this.messages, keep);
    if (point === null) return null;
    const head = this.messages[0]?.role === 'system' ? 1 : 0;
    const before = estimateTokens(this.messages);
    let summary = '';
    let cost = 0;
    for await (const event of this.options.model.stream(
      {
        model: this.options.modelId,
        messages: [
          { role: 'system', content: SUMMARY_PROMPT },
          {
            role: 'user',
            content: transcriptOf(this.messages.slice(head, point), Math.floor(window * 4 * 0.5)),
          },
        ],
        tools: [],
        effort: null,
      },
      signal,
    )) {
      if (event.type === 'text') summary += event.text;
      else if (event.type === 'done' && event.usage)
        cost += this.recordUsage(event.usage, event.model, 'model');
    }
    if (!summary.trim()) return null;
    this.messages.splice(head, point - head, {
      role: 'user',
      content: `${SUMMARY_HEADER}\n\n${summary.trim()}`,
    });
    this.lastPromptTokens = 0;
    this.options.onEvent({ type: 'compacted', before, after: estimateTokens(this.messages) });
    return cost;
  }

  /** Emits a usage event and returns its cost, pricing it from the rate card when needed. */
  private recordUsage(usage: Usage, model: string | null, kind: 'model' | 'routing'): number {
    const estimated = usage.cost === null;
    const cost = usage.cost ?? (model ? this.options.price?.(model, usage) : null) ?? 0;
    this.options.onEvent({ type: 'usage', usage: { ...usage, cost }, model, kind, estimated });
    return cost;
  }

  private lastProgress = new Map<string, { at: number; text: string }>();

  /** Passes on an edit being written, a few times a second at most. */
  private progress(event: { id: string; name: string; arguments: string }): void {
    const now = Date.now();
    const last = this.lastProgress.get(event.id);
    if (last && now - last.at < 80) return;
    const edit = editProgress(event.arguments);
    if (!edit || edit.text === last?.text) return;
    this.lastProgress.set(event.id, { at: now, text: edit.text });
    this.options.onEvent({ type: 'tool_progress', id: event.id, name: event.name, ...edit });
  }

  /** The history with a reminder of the current mode, so switching modes mid-conversation is respected. */
  private withModeNote(): ChatMessage[] {
    const note = MODE_NOTES[this.options.mode];
    const rules = this.folderRules?.note() ?? null;
    return [
      ...this.messages,
      ...(this.turnSkills.catalog
        ? [{ role: 'system' as const, content: this.turnSkills.catalog }]
        : []),
      ...(this.teamNote ? [{ role: 'system' as const, content: this.teamNote }] : []),
      ...(rules ? [{ role: 'system' as const, content: rules }] : []),
      { role: 'system', content: note },
    ];
  }

  /** Runs one call; `invalid` when it couldn't run at all (unknown tool, broken arguments). */
  private async runCall(
    call: ToolCall,
    tools: Tool[],
    signal: AbortSignal,
  ): Promise<{ output: string; invalid: boolean }> {
    const tool = tools.find((t) => t.spec.name === call.function.name);
    let args: Record<string, unknown>;
    try {
      args = JSON.parse(call.function.arguments || '{}') as Record<string, unknown>;
    } catch {
      return {
        output: `Error: arguments for ${call.function.name} were not valid JSON.`,
        invalid: true,
      };
    }
    if (!tool) {
      const known = tools.map((t) => t.spec.name).join(', ');
      return {
        output: `Error: unknown tool "${call.function.name}". Available tools: ${known}.`,
        invalid: true,
      };
    }
    return { output: await this.runKnown(call, tool, args, signal), invalid: false };
  }

  private async runKnown(
    call: ToolCall,
    tool: Tool,
    args: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<string> {
    const { onEvent } = this.options;
    const shown = tool.display?.(args) ?? args;
    const summary = tool.describe(shown);
    onEvent({ type: 'tool_start', id: call.id, name: tool.spec.name, summary, args: shown });

    // A folder with rules of its own the model hasn't seen yet: they come first.
    if (typeof args['path'] === 'string') {
      this.folderRules ??= new FolderRules(this.options.root);
      const found = await this.folderRules.touch(args['path']).catch(() => []);
      if (found.length && tool.kind === 'edit') {
        const held = `Held this edit: ${found.join(', ')} ${found.length === 1 ? 'has' : 'have'} rules for this folder, now in your context. Follow them, then make the edit again.`;
        onEvent({ type: 'tool_end', id: call.id, ok: false, output: held });
        return held;
      }
    }

    // A message came in while it worked: the model reads it (next step) before it writes.
    if (tool.kind === 'edit' && this.steers.length) {
      const from = [...new Set(this.steers.map((s) => s.fromName ?? 'a teammate'))].join(', ');
      const held = `Held this edit: a new message from ${from} came in while you worked. Read it (it comes with your next step), then make the edit again if it still applies.`;
      onEvent({ type: 'tool_end', id: call.id, ok: false, output: held });
      return held;
    }

    // Before it collides with a teammate's work: held once, with why, before anyone is asked.
    if (tool.kind === 'edit' && typeof args['path'] === 'string' && this.options.checkWrite) {
      const held = await this.options.checkWrite(args['path']).catch(() => null);
      if (held) {
        onEvent({ type: 'tool_end', id: call.id, ok: false, output: held });
        return held;
      }
    }

    if (needsApproval(this.options.mode, tool.kind) && !tool.allowed?.()) {
      const request: ApprovalRequest = {
        id: call.id,
        tool: tool.spec.name,
        kind: tool.kind,
        title:
          tool.kind === 'command'
            ? 'Run this?'
            : tool.kind === 'external'
              ? 'Use this tool?'
              : 'Make this edit?',
        detail:
          tool.kind === 'command'
            ? String(args['command'] ?? '')
            : tool.kind === 'external'
              ? `${tool.origin ?? tool.spec.name}\n${JSON.stringify(shown, null, 2)}`
              : approvalDetail(tool.spec.name, args, await existingText(this.options.root, args)),
        ...(typeof args['path'] === 'string' && tool.kind !== 'external'
          ? { path: args['path'] }
          : {}),
      };
      onEvent({ type: 'approval', request });
      const approved = await Promise.race([
        this.options.approve(request),
        new Promise<false>((resolve) =>
          signal.addEventListener('abort', () => resolve(false), { once: true }),
        ),
      ]);
      onEvent({ type: 'approval_resolved', id: call.id, approved });
      if (!approved) {
        const output = signal.aborted
          ? 'Stopped by the user.'
          : 'The user denied this action. Ask how they would like to proceed, or try another approach. If you finish without it, say in your summary that it was denied and what is left undone.';
        onEvent({ type: 'tool_end', id: call.id, ok: false, output });
        return output;
      }
    }

    const result = await runTool(tool, args, {
      root: this.options.root,
      isRepo: this.options.isRepo,
      signal,
      readRoots: this.turnSkills.readRoots,
    });
    // A command with effects beyond this machine was cut off: nobody knows if it happened.
    const command = typeof args['command'] === 'string' ? args['command'] : '';
    if (signal.aborted && tool.kind === 'command' && isRiskyCommand(command))
      onEvent({
        type: 'outcome_unknown',
        toolId: call.id,
        command,
        evidence: `Sent: ${command}\n\nOutput before it was cut off:\n${result.output.slice(-4000)}`,
      });
    onEvent({
      type: 'tool_end',
      id: call.id,
      ok: result.ok,
      output: result.output,
      ...(result.meta ? { meta: result.meta } : {}),
    });
    return result.output;
  }
}

function approvalDetail(
  tool: string,
  args: Record<string, unknown>,
  before: string | null,
): string {
  if (tool === 'edit_file') {
    return `--- ${String(args['path'])}\n- ${String(args['old_string']).split('\n').join('\n- ')}\n+ ${String(args['new_string']).split('\n').join('\n+ ')}`;
  }
  const content = String(args['content'] ?? '');
  if (before === null)
    return `New file ${String(args['path'])} (${content.split('\n').length} lines)\n${content.slice(0, 2000)}`;
  // Writing over a file that exists: what goes, not just what comes, so a deletion shows.
  const gone = new Map<string, number>();
  for (const line of before.split('\n')) gone.set(line, (gone.get(line) ?? 0) + 1);
  const added: string[] = [];
  for (const line of content.split('\n')) {
    const n = gone.get(line) ?? 0;
    if (n > 0) gone.set(line, n - 1);
    else added.push(line);
  }
  const removed = before.split('\n').filter((line) => {
    const n = gone.get(line) ?? 0;
    if (n <= 0) return false;
    gone.set(line, n - 1);
    return true;
  });
  const body = [...removed.map((l) => `- ${l}`), ...added.map((l) => `+ ${l}`)].join('\n');
  return `Replaces all of ${String(args['path'])}: ${removed.length} line${removed.length === 1 ? '' : 's'} removed, ${added.length} added\n${body.slice(0, 2000)}`;
}

const MODE_NOTES: Record<PermissionMode, string> = {
  plan: 'Current mode: PLAN. Investigate with the read-only tools and propose a step-by-step plan. Do not try to edit files or run commands; those tools are unavailable in this mode.',
  request:
    'Current mode: REQUEST. Call edit and command tools directly when the task needs them: Kovan shows each call to the user as an approval card and only runs it once they approve. Do not ask for permission in text first.',
  allow:
    'Current mode: ALLOW. Edit files directly. Call command tools directly too: Kovan asks the user to approve each command. Do not ask for permission in text first.',
  full: 'Current mode: FULL. Edit files and run commands directly without asking. Still avoid destructive commands.',
};

/** A file an approval would write over, as it is now; null when it is new (or unreadable). */
async function existingText(root: string, args: Record<string, unknown>): Promise<string | null> {
  if (typeof args['path'] !== 'string' || typeof args['content'] !== 'string') return null;
  try {
    return await readFile(await resolveInside(root, args['path']), 'utf8');
  } catch {
    return null;
  }
}
