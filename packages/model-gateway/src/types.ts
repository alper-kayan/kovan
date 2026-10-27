/** Conversation messages in the OpenAI-compatible shape OpenRouter speaks. */
export type ContentPart =
  { type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } };

export interface ToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

export type ChatMessage =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string | ContentPart[] }
  | {
      role: 'assistant';
      content: string | null;
      tool_calls?: ToolCall[];
      /** Provider reasoning blocks, passed back so multi-step tool use keeps its chain of thought. */
      reasoning_details?: unknown[];
    }
  | { role: 'tool'; tool_call_id: string; content: string };

export interface ToolSpec {
  name: string;
  description: string;
  /** JSON Schema for the arguments. */
  parameters: Record<string, unknown>;
}

export type Effort = 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export interface ChatRequest {
  model: string;
  messages: ChatMessage[];
  tools?: ToolSpec[];
  /** Reasoning effort, for models that support it. */
  effort?: Effort | null;
  maxTokens?: number;
}

export interface Usage {
  promptTokens: number;
  completionTokens: number;
  cachedTokens: number;
  reasoningTokens: number;
  /** USD charged by the provider, when it reports one. */
  cost: number | null;
}

/** Why a router picked a model for this call (see @kovan/jevrouter). */
export interface RouteDecision {
  model: string;
  effort: Effort | null;
  tier: string;
  reason: string;
  /** True when this call uses a different model than the previous one. */
  switched: boolean;
  /** What deciding cost (the classifier call), already included in turn totals. */
  usage: Usage | null;
  classifierModel: string | null;
}

export type StreamEvent =
  | { type: 'route'; decision: RouteDecision }
  | { type: 'reasoning'; text: string }
  | { type: 'text'; text: string }
  | { type: 'tool_call'; call: ToolCall }
  /**
   * A tool call while the model is still writing it: its arguments so far (partial JSON). Lets
   * the app show an agent typing an edit as it is generated.
   */
  | { type: 'tool_progress'; id: string; name: string; arguments: string }
  | {
      type: 'done';
      finishReason: string | null;
      usage: Usage | null;
      /** The model that actually answered (routers may pick a different one). */
      model: string | null;
      reasoningDetails: unknown[];
    };

export interface ModelInfo {
  id: string;
  name: string;
  provider: string;
  contextLength: number;
  maxOutput: number | null;
  /** USD per million tokens. */
  pricing: { input: number; output: number; cacheRead: number | null; cacheWrite: number | null };
  tools: boolean;
  vision: boolean;
  reasoning: { mandatory: boolean; efforts: Effort[]; defaultEffort: Effort | null } | null;
  created: number;
}
