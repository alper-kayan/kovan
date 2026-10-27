import { mergeReasoningDetails, SseParser, ToolCallAssembler } from './sse.js';
import type { ChatRequest, Effort, ModelInfo, StreamEvent, Usage } from './types.js';

export class ModelError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'ModelError';
  }
}

export interface OpenRouterOptions {
  apiKey: string;
  /** Any OpenAI-compatible endpoint works; OpenRouter by default. */
  baseUrl?: string;
  /**
   * "openrouter" sends OpenRouter's extensions (usage accounting, the reasoning object);
   * "openai" sticks to the plain Chat Completions API that other servers accept.
   */
  dialect?: 'openrouter' | 'openai';
  appName?: string;
  appUrl?: string;
  /** Extra headers on every request (Kovan's managed endpoint reads the run and workspace). */
  headers?: Record<string, string>;
  fetch?: typeof fetch;
  /**
   * How long a streamed turn may go without any data before it is given up (keep-alive comments
   * don't count). Local servers get longer: loading a model is slow.
   */
  idleMs?: number;
}

interface RawModel {
  id: string;
  /** Plain OpenAI-compatible servers often send only the id. */
  name?: string;
  created?: number;
  context_length?: number;
  architecture?: { input_modalities?: string[] };
  pricing?: Record<string, string | undefined>;
  top_provider?: { max_completion_tokens?: number | null };
  supported_parameters?: string[];
  reasoning?: { mandatory?: boolean; supported_efforts?: string[]; default_effort?: string };
}

const perMillion = (value: string | undefined) =>
  value === undefined ? null : Number(value) * 1_000_000;

export function toModelInfo(raw: RawModel): ModelInfo {
  const params = raw.supported_parameters ?? [];
  const canReason =
    params.includes('reasoning') || params.includes('reasoning_effort') || Boolean(raw.reasoning);
  return {
    id: raw.id,
    name: raw.name?.replace(/^[^:]+:\s*/, '') ?? raw.id,
    provider: raw.id.split('/')[0] ?? '',
    contextLength: raw.context_length ?? 0,
    maxOutput: raw.top_provider?.max_completion_tokens ?? null,
    pricing: {
      input: perMillion(raw.pricing?.['prompt']) ?? 0,
      output: perMillion(raw.pricing?.['completion']) ?? 0,
      cacheRead: perMillion(raw.pricing?.['input_cache_read']),
      cacheWrite: perMillion(raw.pricing?.['input_cache_write']),
    },
    tools: params.includes('tools'),
    vision: raw.architecture?.input_modalities?.includes('image') ?? false,
    reasoning: canReason
      ? {
          mandatory: raw.reasoning?.mandatory ?? false,
          efforts: (raw.reasoning?.supported_efforts ??
            (params.includes('reasoning_effort') ? ['low', 'medium', 'high'] : [])) as Effort[],
          defaultEffort: (raw.reasoning?.default_effort as Effort | undefined) ?? null,
        }
      : null,
    created: raw.created ?? 0,
  };
}

function toUsage(raw: Record<string, unknown> | undefined): Usage | null {
  if (!raw) return null;
  const prompt = raw['prompt_tokens_details'] as { cached_tokens?: number } | undefined;
  const completion = raw['completion_tokens_details'] as { reasoning_tokens?: number } | undefined;
  return {
    promptTokens: Number(raw['prompt_tokens'] ?? 0),
    completionTokens: Number(raw['completion_tokens'] ?? 0),
    cachedTokens: prompt?.cached_tokens ?? 0,
    reasoningTokens: completion?.reasoning_tokens ?? 0,
    cost: typeof raw['cost'] === 'number' ? raw['cost'] : null,
  };
}

export class OpenRouterClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: OpenRouterOptions) {
    this.baseUrl = (options.baseUrl ?? 'https://openrouter.ai/api/v1').replace(/\/$/, '');
    this.fetchImpl = options.fetch ?? fetch;
  }

  private get openai(): boolean {
    return this.options.dialect === 'openai';
  }

  private headers(): Record<string, string> {
    return {
      // Local servers (Ollama, LM Studio) usually need no key.
      ...(this.options.apiKey ? { Authorization: `Bearer ${this.options.apiKey}` } : {}),
      'Content-Type': 'application/json',
      ...(this.options.appName && !this.openai ? { 'X-Title': this.options.appName } : {}),
      ...(this.options.appUrl && !this.openai ? { 'HTTP-Referer': this.options.appUrl } : {}),
      ...this.options.headers,
    };
  }

  async listModels(signal?: AbortSignal): Promise<ModelInfo[]> {
    const response = await this.fetchImpl(`${this.baseUrl}/models`, {
      headers: this.headers(),
      ...(signal ? { signal } : {}),
    });
    if (!response.ok)
      throw new ModelError(`Could not list models (HTTP ${response.status})`, response.status);
    // Ollama answers `"data": null` when no model is pulled yet.
    const { data } = (await response.json()) as { data: RawModel[] | null };
    return (data ?? []).map(toModelInfo);
  }

  /** Streams one model turn: reasoning, text and complete tool calls, then a final "done". */
  async *stream(request: ChatRequest, signal?: AbortSignal): AsyncGenerator<StreamEvent> {
    const body: Record<string, unknown> = {
      model: request.model,
      messages: request.messages,
      stream: true,
      ...(this.openai ? { stream_options: { include_usage: true } } : { usage: { include: true } }),
    };
    if (request.tools?.length) {
      body['tools'] = request.tools.map((t) => ({ type: 'function', function: t }));
    }
    if (request.effort && this.openai) {
      if (request.effort !== 'none') body['reasoning_effort'] = request.effort;
    } else if (request.effort)
      body['reasoning'] =
        request.effort === 'none' ? { enabled: false } : { effort: request.effort };
    if (request.maxTokens) body['max_tokens'] = request.maxTokens;

    // A stream that goes silent would hold the turn forever: past the idle limit it is stopped.
    const idleMs = this.options.idleMs ?? (this.openai ? 300_000 : 180_000);
    const idle = new AbortController();
    let timer = setTimeout(() => idle.abort(), idleMs);
    const awake = () => {
      clearTimeout(timer);
      timer = setTimeout(() => idle.abort(), idleMs);
    };
    try {
      yield* this.streamTurn(
        body,
        signal ? AbortSignal.any([signal, idle.signal]) : idle.signal,
        awake,
      );
    } catch (error) {
      if (idle.signal.aborted && !signal?.aborted)
        throw new ModelError(
          `The model sent nothing for ${Math.round(idleMs / 1000)} seconds, so the request was stopped. Try again.`,
          504,
        );
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  private async *streamTurn(
    body: Record<string, unknown>,
    signal: AbortSignal,
    awake: () => void,
  ): AsyncGenerator<StreamEvent> {
    const response = await this.fetchImpl(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify(body),
      signal,
    });
    if (!response.ok || !response.body) {
      const text = await response.text().catch(() => '');
      let message = `Model request failed (HTTP ${response.status})`;
      try {
        const parsed = JSON.parse(text) as { error?: { message?: string } };
        if (parsed.error?.message) message = parsed.error.message;
      } catch {
        // Not JSON; keep the generic message.
      }
      throw new ModelError(message, response.status);
    }

    const parser = new SseParser();
    const toolCalls = new ToolCallAssembler();
    const reasoningDetails: unknown[] = [];
    let finishReason: string | null = null;
    let usage: Usage | null = null;
    let model: string | null = null;
    const decoder = new TextDecoder();

    for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
      // Keep-alive comments don't count: a stalled model can send them for ever.
      const payloads = parser.push(decoder.decode(chunk, { stream: true }));
      if (payloads.length > 0) awake();
      for (const data of payloads) {
        if (data === '[DONE]') continue;
        let event: Record<string, unknown>;
        try {
          event = JSON.parse(data) as Record<string, unknown>;
        } catch {
          continue;
        }
        if (event['error']) {
          const err = event['error'] as { message?: string; code?: number };
          throw new ModelError(err.message ?? 'The model stopped with an error', err.code ?? 500);
        }
        model = (event['model'] as string | undefined) ?? model;
        if (event['usage']) usage = toUsage(event['usage'] as Record<string, unknown>);
        for (const choice of (event['choices'] as Record<string, unknown>[] | undefined) ?? []) {
          const delta = (choice['delta'] ?? {}) as Record<string, unknown>;
          if (typeof delta['reasoning'] === 'string' && delta['reasoning'])
            yield { type: 'reasoning', text: delta['reasoning'] };
          // DeepSeek, vLLM and llama.cpp stream thinking here instead.
          else if (typeof delta['reasoning_content'] === 'string' && delta['reasoning_content'])
            yield { type: 'reasoning', text: delta['reasoning_content'] };
          if (Array.isArray(delta['reasoning_details']))
            reasoningDetails.push(...(delta['reasoning_details'] as unknown[]));
          if (typeof delta['content'] === 'string' && delta['content'])
            yield { type: 'text', text: delta['content'] };
          for (const fragment of (delta['tool_calls'] as
            Parameters<ToolCallAssembler['add']>[0][] | undefined) ?? []) {
            const call = toolCalls.add(fragment);
            if (call.name && fragment.function?.arguments) yield { type: 'tool_progress', ...call };
          }
          if (choice['finish_reason']) finishReason = choice['finish_reason'] as string;
        }
      }
    }
    for (const call of toolCalls.finish()) yield { type: 'tool_call', call };
    yield {
      type: 'done',
      finishReason,
      usage,
      model,
      reasoningDetails: mergeReasoningDetails(reasoningDetails),
    };
  }
}
