import type {
  AgentEvent,
  ApprovalRequest,
  IssueDraft,
  IssueEdits,
  PermissionMode,
} from '@kovan/harness';
import type { Effort } from '@kovan/model-gateway';
import type { MentionStatus } from '@kovan/shared';
import { resetLabel } from './limits.js';

export type { AgentEvent, ApprovalRequest, IssueDraft, IssueEdits, PermissionMode };

export interface Attachment {
  kind: 'markdown' | 'image';
  name: string;
  /** Text for markdown, a data: URL for images. */
  content: string;
}

/** Everything a conversation shows: the agent's events plus the prompts that started each turn. */
export type ConversationEvent =
  | AgentEvent
  | { type: 'user'; text: string; attachments: string[]; at: number }
  /** The lane's permission mode changed (teammates are told, loudly for Full). */
  | { type: 'mode'; mode: PermissionMode }
  /** A checkpoint of the checkout, pushed to the person's remote for whoever takes over. */
  | { type: 'snapshot'; sha: string; ref: string }
  /** The account ran out: the lane waits for someone to take over. */
  | { type: 'limit_hit'; reason: string }
  /** Another agent took the conversation over (its account ran out, or the person switched). */
  | {
      type: 'switch';
      from: Harness;
      to: Harness;
      model: string;
      /** The model it left; missing on switches saved before models were part of the order. */
      fromModel?: string;
      /** Why, in a few words ("usage limit reached"). */
      reason: string;
      /** When the agent it left opens again, if known. */
      resetsAt: number | null;
    }
  /** Auto picked who runs the conversation. */
  | { type: 'auto'; to: Harness; model: string; reason: string }
  /** A line from Kovan itself, outside any turn. */
  | { type: 'notice'; tone: 'info' | 'warn'; text: string }
  /** Whose account the turn that follows is billed to, in words ("your Claude subscription"). */
  | { type: 'payer'; payer: string }
  /** The person called an AI teammate in with @; it answers in this conversation. */
  | { type: 'mention'; agentId: string; name: string; text: string; requestId: string; at: number }
  /** How a called-in teammate's work on it stands, and its answer once it has one. */
  | {
      type: 'teammate';
      agentId: string;
      name: string;
      requestId: string;
      status: MentionStatus;
      text: string | null;
      at: number;
    };

/** Who runs the conversation: Kovan's own agent, or the user's Claude Code or Codex. */
export type Harness = 'kovan' | 'claude-code' | 'codex';

/** The agent CLIs Kovan can run, in chat and in the terminal. */
export type ExternalHarness = Exclude<Harness, 'kovan'>;

export const HARNESS_NAMES: Record<Harness, string> = {
  kovan: 'Kovan',
  'claude-code': 'Claude Code',
  codex: 'Codex',
};

/** One step of the person's order: an agent and the model it starts with. */
export interface AgentOption {
  harness: Harness;
  /** "default" or a model of Claude Code or Codex; for Kovan a catalog id or JevRouter. */
  model: string;
  /**
   * Which of the person's Claude or OpenAI accounts runs it (an id from Settings → Agents →
   * Accounts); missing: the one the CLI is signed in with on this machine.
   */
  account?: string | undefined;
}

/**
 * Another Claude Code or Codex account on this machine: its own sign-in, kept in its own folder
 * (CLAUDE_CONFIG_DIR, CODEX_HOME). The CLI's usual sign-in is the default and isn't listed.
 */
export interface AgentAccount {
  id: string;
  harness: ExternalHarness;
  /** What the person calls it ("Work", "Personal"). */
  name: string;
  createdAt: number;
}

export interface ConversationConfig {
  /** Missing on conversations saved before external agents existed; read it as "kovan". */
  harness?: Harness;
  /** JevRouter picks the agent (`harness` and `model`) from the first prompt. */
  auto?: boolean;
  /** For Claude Code and Codex: "default", an alias (sonnet, opus, haiku) or a model id. */
  model: string;
  effort: Effort | null;
  mode: PermissionMode;
  /** For Claude Code and Codex: which of the person's accounts it runs as; missing: the default. */
  account?: string | undefined;
}

export const CLAUDE_MODELS: { id: string; label: string }[] = [
  { id: 'default', label: 'Default' },
  { id: 'sonnet', label: 'Sonnet' },
  { id: 'opus', label: 'Opus' },
  { id: 'haiku', label: 'Haiku' },
];

/** Codex picks its own model unless one is named; these are from its built-in list (0.162). */
export const CODEX_MODELS: { id: string; label: string }[] = [
  { id: 'default', label: 'Default' },
  { id: 'gpt-6.1-sol', label: 'GPT-6.1 Sol' },
  { id: 'gpt-6-astra', label: 'GPT-6 Astra' },
  { id: 'gpt-6-luna', label: 'GPT-6 Luna' },
  { id: 'gpt-5.6-terra', label: 'GPT-5.6 Terra' },
];

export interface ConversationSummary {
  id: string;
  title: string;
  updatedAt: number;
  cost: number;
  /** Set when this conversation is the person's lane in a shared session. */
  session?: SessionLink;
}

/** The shared session a lane conversation belongs to. */
export interface SessionLink {
  id: string;
  workspaceId: string;
  title: string;
}

export interface Conversation extends ConversationSummary, ConversationConfig {
  root: string;
  events: ConversationEvent[];
  running: boolean;
}

export interface ProviderStatus {
  openrouter: { configured: boolean; source: 'keychain' | 'environment' | null };
  /** How many custom OpenAI-compatible providers have models to offer. */
  customModels: number;
  /** Kovan's agent can use managed usage (signed in, and not set to your own key only). */
  managed: boolean;
}

/** An OpenAI-compatible endpoint the person added (Ollama, LM Studio, vLLM, a company proxy…). */
export interface CustomProviderInfo {
  /** Short slug; its models appear as "@<id>/<model>". */
  id: string;
  name: string;
  baseUrl: string;
  hasKey: boolean;
  models: string[];
  fetchedAt: number | null;
}

export interface CustomProviderInput {
  /** Set when editing an existing provider. */
  id?: string | undefined;
  name: string;
  baseUrl: string;
  /** A new key; null removes the saved one; leave out to keep it. */
  apiKey?: string | null | undefined;
}

/** "@ollama/qwen3-coder:30b" → { provider: "ollama", model: "qwen3-coder:30b" }. */
export function parseCustomModelId(id: string): { provider: string; model: string } | null {
  const m = /^@([a-z0-9-]+)\/(.+)$/.exec(id);
  return m ? { provider: m[1]!, model: m[2]! } : null;
}

/** Rows the chat renders, folded from the event stream. */
export type ChatItem =
  | { kind: 'prompt'; text: string; attachments: string[]; at: number }
  /** A message to an AI teammate called in with @. */
  | { kind: 'mention'; agentId: string; name: string; text: string; at: number }
  /** A called-in teammate at work on it, then its answer (one row per call). */
  | {
      kind: 'teammate';
      agentId: string;
      name: string;
      requestId: string;
      status: MentionStatus;
      text: string | null;
      at: number;
    }
  /** A one-line note in the transcript: guidance, a mode change, a limit, an unknown outcome. */
  | { kind: 'note'; tone: 'info' | 'warn'; text: string }
  | { kind: 'reasoning'; text: string }
  | { kind: 'text'; text: string }
  | {
      kind: 'tool';
      id: string;
      name: string;
      summary: string;
      status: 'running' | 'waiting' | 'ok' | 'failed' | 'denied';
      output: string | null;
      meta?: { path?: string; added?: number; removed?: number; exitCode?: number | null };
      approval: ApprovalRequest | null;
      /** The steps of the helper agent this call started (Claude Code's Agent tool). */
      steps?: Extract<ChatItem, { kind: 'tool' }>[];
    }
  | { kind: 'route'; model: string; tier: string; reason: string }
  | {
      kind: 'end';
      reason: 'done' | 'stopped' | 'error' | 'step_limit';
      error?: string;
      cost: number;
      model: string | null;
      /** Every call the turn paid for: the model's own and the router's. */
      receipt: ReceiptLine[];
      /** Whose account paid ("your Claude subscription"), when known. */
      payer?: string;
    };

export interface ReceiptLine {
  model: string;
  kind: 'model' | 'routing';
  promptTokens: number;
  completionTokens: number;
  cachedTokens: number;
  cost: number;
  estimated: boolean;
  /** No price is known: the call was billed to the person's own account (Codex). */
  unpriced?: boolean;
}

/** Folds events into chat rows; consecutive reasoning or text deltas join into one row. */
export function foldEvents(events: ConversationEvent[]): ChatItem[] {
  const items: ChatItem[] = [];
  const tools = new Map<string, Extract<ChatItem, { kind: 'tool' }>>();
  let lastModel: string | null = null;
  let receipt: ReceiptLine[] = [];
  let payer: string | null = null;
  for (const e of events) {
    const last = items.at(-1);
    switch (e.type) {
      case 'user':
        items.push({ kind: 'prompt', text: e.text, attachments: e.attachments, at: e.at });
        break;
      case 'turn_start':
        lastModel = e.model;
        receipt = [];
        break;
      case 'route':
        if (e.decision.switched)
          items.push({
            kind: 'route',
            model: e.decision.model,
            tier: e.decision.tier,
            reason: e.decision.reason,
          });
        break;
      case 'reasoning':
        if (last?.kind === 'reasoning') last.text += e.text;
        else items.push({ kind: 'reasoning', text: e.text });
        break;
      case 'text':
        if (last?.kind === 'text') last.text += e.text;
        else items.push({ kind: 'text', text: e.text });
        break;
      case 'tool_start': {
        const item: Extract<ChatItem, { kind: 'tool' }> = {
          kind: 'tool',
          id: e.id,
          name: e.name,
          summary: e.summary,
          status: 'running',
          output: null,
          approval: null,
        };
        tools.set(e.id, item);
        const parent = e.parent ? tools.get(e.parent) : undefined;
        if (parent) (parent.steps ??= []).push(item);
        else items.push(item);
        break;
      }
      case 'approval': {
        const item = tools.get(e.request.id);
        if (item) {
          item.status = 'waiting';
          item.approval = e.request;
        } else {
          // A call the transcript never showed still gets its card: the agent waits on it.
          const asked: Extract<ChatItem, { kind: 'tool' }> = {
            kind: 'tool',
            id: e.request.id,
            name: e.request.tool,
            summary: `Asked ${e.request.tool}`,
            status: 'waiting',
            output: null,
            approval: e.request,
          };
          tools.set(asked.id, asked);
          items.push(asked);
        }
        break;
      }
      case 'approval_resolved': {
        const item = tools.get(e.id);
        if (item) item.status = e.approved ? 'running' : 'denied';
        break;
      }
      case 'tool_end': {
        const item = tools.get(e.id);
        if (item) {
          if (item.status !== 'denied') item.status = e.ok ? 'ok' : 'failed';
          item.output = e.output;
          if (e.meta) item.meta = e.meta;
        }
        break;
      }
      case 'usage': {
        if (e.kind !== 'routing') lastModel = e.model ?? lastModel;
        const line = receipt.find((r) => r.model === (e.model ?? '?') && r.kind === e.kind);
        if (line) {
          line.promptTokens += e.usage.promptTokens;
          line.completionTokens += e.usage.completionTokens;
          line.cachedTokens += e.usage.cachedTokens;
          line.cost += e.usage.cost ?? 0;
          line.estimated ||= e.estimated;
          if (e.usage.cost !== null) delete line.unpriced;
        } else {
          receipt.push({
            model: e.model ?? '?',
            kind: e.kind,
            promptTokens: e.usage.promptTokens,
            completionTokens: e.usage.completionTokens,
            cachedTokens: e.usage.cachedTokens,
            cost: e.usage.cost ?? 0,
            estimated: e.estimated,
            ...(e.usage.cost === null && !e.estimated ? { unpriced: true } : {}),
          });
        }
        break;
      }
      case 'steer':
        items.push({
          kind: 'note',
          tone: e.status === 'delivered' ? 'info' : 'warn',
          text:
            e.status === 'delivered'
              ? `↪ Guidance${e.fromName ? ` from ${e.fromName}` : ''}: ${e.text}`
              : `Guidance came back (the turn ended first): ${e.text}`,
        });
        break;
      case 'compacted':
        items.push({
          kind: 'note',
          tone: 'info',
          text: `Summarized the older part of the conversation to fit the model's context (about ${Math.round(e.before / 1000)}k → ${Math.round(e.after / 1000)}k tokens). The newest messages are kept as they were.`,
        });
        break;
      case 'outcome_unknown':
        items.push({
          kind: 'note',
          tone: 'warn',
          text: `Outcome unknown: \`${e.command}\` was cut off mid-flight. It won't be retried; someone records what happened.`,
        });
        break;
      case 'limit_hit':
        items.push({
          kind: 'note',
          tone: 'warn',
          text: `Usage limit hit (${e.reason}). Awaiting takeover.`,
        });
        break;
      case 'switch':
        items.push({
          kind: 'note',
          tone: 'info',
          text: `${optionLabel({ harness: e.from, model: e.fromModel ?? 'default' })}: ${e.reason}${e.resetsAt ? ` (opens ${resetLabel(e.resetsAt, Date.now())})` : ''} → continuing with ${optionLabel({ harness: e.to, model: e.model })}`,
        });
        break;
      case 'auto':
        items.push({
          kind: 'note',
          tone: 'info',
          text: `Auto → ${optionLabel({ harness: e.to, model: e.model })}: ${e.reason}`,
        });
        break;
      case 'notice':
        items.push({ kind: 'note', tone: e.tone, text: e.text });
        break;
      case 'mention':
        items.push({ kind: 'mention', agentId: e.agentId, name: e.name, text: e.text, at: e.at });
        break;
      case 'teammate': {
        const row = items.find(
          (i): i is Extract<ChatItem, { kind: 'teammate' }> =>
            i.kind === 'teammate' && i.requestId === e.requestId,
        );
        if (row) {
          row.status = e.status;
          row.text = e.text;
          row.at = e.at;
        } else
          items.push({
            kind: 'teammate',
            agentId: e.agentId,
            name: e.name,
            requestId: e.requestId,
            status: e.status,
            text: e.text,
            at: e.at,
          });
        break;
      }
      case 'mode':
        items.push({
          kind: 'note',
          tone: e.mode === 'full' ? 'warn' : 'info',
          text: `Switched to ${e.mode[0]!.toUpperCase()}${e.mode.slice(1)} permissions${e.mode === 'full' ? ': no approvals, everyone is told' : ''}`,
        });
        break;
      case 'turn_end':
        // A turn stopped mid-action leaves no tool spinning.
        for (const item of tools.values())
          if (item.status === 'running' || item.status === 'waiting') item.status = 'failed';
        items.push({
          kind: 'end',
          reason: e.reason,
          cost: e.cost,
          model: lastModel,
          receipt,
          ...(e.error ? { error: e.error } : {}),
          ...(payer ? { payer } : {}),
        });
        break;
      case 'payer':
        payer = e.payer;
        break;
    }
  }
  return items;
}

/** Joins consecutive text and reasoning deltas so stored transcripts stay small. */
export function compactEvents(events: ConversationEvent[]): ConversationEvent[] {
  const out: ConversationEvent[] = [];
  for (const e of events) {
    const last = out.at(-1);
    if ((e.type === 'text' || e.type === 'reasoning') && last?.type === e.type) {
      out[out.length - 1] = { ...last, text: last.text + e.text };
    } else {
      out.push(e);
    }
  }
  return out;
}

/** The virtual model that lets JevRouter choose (mirrors @kovan/jevrouter's JEV_MODEL_ID). */
export const JEV_MODEL_ID = 'kovan/jevrouter';

/** The models offered for an agent's CLI; Kovan's own come from the catalog. */
const CLI_MODELS: Record<ExternalHarness, { id: string; label: string }[]> = {
  'claude-code': CLAUDE_MODELS,
  codex: CODEX_MODELS,
};

/** "Claude Code · Opus", "Codex", "Kovan · JevRouter", "Kovan · deepseek-ai/DeepSeek-V3". */
export function optionLabel(option: AgentOption, modelName?: string, accountName?: string): string {
  const agent = `${HARNESS_NAMES[option.harness]}${accountName ? ` (${accountName})` : ''}`;
  if (option.harness === 'kovan') {
    if (option.model === JEV_MODEL_ID) return `${agent} · JevRouter`;
    return `${agent} · ${modelName ?? parseCustomModelId(option.model)?.model ?? option.model}`;
  }
  if (option.model === 'default') return agent;
  const known = CLI_MODELS[option.harness].find((m) => m.id === option.model);
  return `${agent} · ${known?.label ?? option.model}`;
}

export const sameOption = (a: AgentOption, b: AgentOption): boolean =>
  a.harness === b.harness && a.model === b.model && (a.account ?? null) === (b.account ?? null);

/** The model an agent starts with when the order doesn't name one. */
export function defaultOption(harness: Harness): AgentOption {
  return { harness, model: harness === 'kovan' ? JEV_MODEL_ID : 'default' };
}
