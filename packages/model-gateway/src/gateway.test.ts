import { describe, expect, it } from 'vitest';
import { OpenRouterClient, toModelInfo } from './openrouter.js';
import { mergeReasoningDetails, SseParser, ToolCallAssembler } from './sse.js';
import type { StreamEvent } from './types.js';

describe('SseParser', () => {
  it('handles payloads split across chunks and ignores comments', () => {
    const p = new SseParser();
    expect(p.push(': OPENROUTER PROCESSING\n\ndata: {"a"')).toEqual([]);
    expect(p.push(':1}\n\ndata: [DONE]\n')).toEqual(['{"a":1}', '[DONE]']);
  });
});

describe('ToolCallAssembler', () => {
  it('joins argument fragments per index', () => {
    const a = new ToolCallAssembler();
    a.add({ index: 1, id: 'b', function: { name: 'list_dir', arguments: '{}' } });
    a.add({ index: 0, id: 'a', function: { name: 'read_file', arguments: '{"pa' } });
    a.add({ index: 0, function: { arguments: 'th":"x"}' } });
    expect(a.finish()).toEqual([
      { id: 'a', type: 'function', function: { name: 'read_file', arguments: '{"path":"x"}' } },
      { id: 'b', type: 'function', function: { name: 'list_dir', arguments: '{}' } },
    ]);
  });
});

describe('mergeReasoningDetails', () => {
  it('concatenates text of pieces with the same index', () => {
    expect(
      mergeReasoningDetails([
        { type: 'reasoning.text', index: 0, text: 'Thin' },
        { type: 'reasoning.text', index: 0, text: 'king', signature: 'sig' },
      ]),
    ).toEqual([{ type: 'reasoning.text', index: 0, text: 'Thinking', signature: 'sig' }]);
  });
});

describe('toModelInfo', () => {
  it('accepts the bare entries plain OpenAI-compatible servers return', () => {
    const m = toModelInfo({ id: 'qwen3-coder:30b' });
    expect(m).toMatchObject({ id: 'qwen3-coder:30b', name: 'qwen3-coder:30b', contextLength: 0 });
  });

  it('converts per-token prices to per-million and reads reasoning controls', () => {
    const info = toModelInfo({
      id: 'openai/gpt-5.6-luna',
      name: 'OpenAI: GPT 5.6 Luna',
      context_length: 1_050_000,
      architecture: { input_modalities: ['text', 'image'] },
      pricing: { prompt: '0.0000002', completion: '0.0000012', input_cache_read: '0.00000002' },
      supported_parameters: ['tools', 'reasoning'],
      reasoning: { mandatory: false, supported_efforts: ['low', 'high'], default_effort: 'low' },
    });
    expect(info).toMatchObject({
      name: 'GPT 5.6 Luna',
      provider: 'openai',
      tools: true,
      vision: true,
      reasoning: { mandatory: false, efforts: ['low', 'high'], defaultEffort: 'low' },
    });
    expect(info.pricing.input).toBeCloseTo(0.2);
    expect(info.pricing.cacheRead).toBeCloseTo(0.02);
    expect(info.pricing.cacheWrite).toBeNull();
  });
});

function sseResponse(lines: string[]): Response {
  const body = new ReadableStream({
    start(controller) {
      const enc = new TextEncoder();
      // Split awkwardly to exercise the parser.
      const text = lines.map((l) => `data: ${l}\n\n`).join('');
      for (let i = 0; i < text.length; i += 7) controller.enqueue(enc.encode(text.slice(i, i + 7)));
      controller.close();
    },
  });
  return new Response(body, { status: 200 });
}

describe('OpenRouterClient.stream', () => {
  it('yields reasoning, text, assembled tool calls and usage', async () => {
    let sent: Record<string, unknown> = {};
    const client = new OpenRouterClient({
      apiKey: 'k',
      fetch: async (_url, init) => {
        sent = JSON.parse(String(init?.body));
        return sseResponse([
          JSON.stringify({
            model: 'm',
            choices: [
              { delta: { reasoning: 'hmm', reasoning_details: [{ index: 0, text: 'hmm' }] } },
            ],
          }),
          JSON.stringify({ choices: [{ delta: { content: 'Reading.' } }] }),
          JSON.stringify({
            choices: [
              {
                delta: {
                  tool_calls: [
                    { index: 0, id: 'c1', function: { name: 'read_file', arguments: '{"path":' } },
                  ],
                },
              },
            ],
          }),
          JSON.stringify({
            choices: [
              {
                delta: { tool_calls: [{ index: 0, function: { arguments: '"a.ts"}' } }] },
                finish_reason: 'tool_calls',
              },
            ],
          }),
          JSON.stringify({
            choices: [],
            usage: {
              prompt_tokens: 10,
              completion_tokens: 5,
              cost: 0.001,
              prompt_tokens_details: { cached_tokens: 4 },
            },
          }),
          '[DONE]',
        ]);
      },
    });
    const events: StreamEvent[] = [];
    for await (const e of client.stream({
      model: 'm',
      messages: [{ role: 'user', content: 'hi' }],
      effort: 'low',
      tools: [{ name: 'read_file', description: 'd', parameters: {} }],
    })) {
      events.push(e);
    }
    expect(sent).toMatchObject({
      model: 'm',
      stream: true,
      reasoning: { effort: 'low' },
      usage: { include: true },
    });
    expect(events).toEqual([
      { type: 'reasoning', text: 'hmm' },
      { type: 'text', text: 'Reading.' },
      // The call as it is being written, then the finished call.
      { type: 'tool_progress', id: 'c1', name: 'read_file', arguments: '{"path":' },
      { type: 'tool_progress', id: 'c1', name: 'read_file', arguments: '{"path":"a.ts"}' },
      {
        type: 'tool_call',
        call: {
          id: 'c1',
          type: 'function',
          function: { name: 'read_file', arguments: '{"path":"a.ts"}' },
        },
      },
      {
        type: 'done',
        finishReason: 'tool_calls',
        model: 'm',
        reasoningDetails: [{ index: 0, text: 'hmm' }],
        usage: {
          promptTokens: 10,
          completionTokens: 5,
          cachedTokens: 4,
          reasoningTokens: 0,
          cost: 0.001,
        },
      },
    ]);
  });

  it('speaks plain Chat Completions to other OpenAI-compatible servers', async () => {
    let sent: Record<string, unknown> = {};
    let headers: Record<string, string> = {};
    const client = new OpenRouterClient({
      apiKey: '',
      baseUrl: 'http://localhost:11434/v1/',
      dialect: 'openai',
      appName: 'Kovan',
      fetch: async (url, init) => {
        expect(String(url)).toBe('http://localhost:11434/v1/chat/completions');
        sent = JSON.parse(String(init?.body));
        headers = init?.headers as Record<string, string>;
        return sseResponse([
          JSON.stringify({ choices: [{ delta: { reasoning_content: 'think' } }] }),
          JSON.stringify({ choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] }),
          JSON.stringify({ choices: [], usage: { prompt_tokens: 5, completion_tokens: 1 } }),
          '[DONE]',
        ]);
      },
    });
    const events: StreamEvent[] = [];
    for await (const e of client.stream({ model: 'llama', messages: [], effort: 'high' }))
      events.push(e);
    expect(sent).toMatchObject({
      stream_options: { include_usage: true },
      reasoning_effort: 'high',
    });
    expect(sent).not.toHaveProperty('usage');
    expect(sent).not.toHaveProperty('reasoning');
    expect(headers).not.toHaveProperty('Authorization');
    expect(headers).not.toHaveProperty('X-Title');
    expect(events.slice(0, 2)).toEqual([
      { type: 'reasoning', text: 'think' },
      { type: 'text', text: 'ok' },
    ]);
    expect(events.at(-1)).toMatchObject({ usage: { promptTokens: 5, cost: null } });
  });

  it('gives up a stream that goes silent, and keeps one that keeps talking', async () => {
    // Sends a reasoning chunk every `every` ms, `count` times, then hangs like a stalled stream.
    const silentAfter = (count: number, every: number) =>
      new OpenRouterClient({
        apiKey: 'k',
        idleMs: 40,
        fetch: async (_url, init) => {
          const body = new ReadableStream({
            start(controller) {
              const enc = new TextEncoder();
              let sent = 0;
              const tick = setInterval(() => {
                if (sent++ >= count) return clearInterval(tick);
                controller.enqueue(
                  enc.encode(
                    `data: ${JSON.stringify({ choices: [{ delta: { reasoning: 'x' } }] })}\n\n`,
                  ),
                );
              }, every);
              init?.signal?.addEventListener('abort', () => {
                clearInterval(tick);
                controller.error(new DOMException('aborted', 'AbortError'));
              });
            },
          });
          return new Response(body, { status: 200 });
        },
      });
    const seen: string[] = [];
    const run = async (client: OpenRouterClient) => {
      for await (const e of client.stream({ model: 'm', messages: [] })) seen.push(e.type);
    };
    // Six chunks 20 ms apart: longer than the idle limit in all, but never silent that long.
    await expect(run(silentAfter(6, 20))).rejects.toThrow(/sent nothing for 0 seconds/);
    expect(seen.filter((t) => t === 'reasoning')).toHaveLength(6);

    // Keep-alives alone don't keep a turn going.
    const keepAlive = new OpenRouterClient({
      apiKey: 'k',
      idleMs: 40,
      fetch: async (_url, init) => {
        const body = new ReadableStream({
          start(controller) {
            const tick = setInterval(
              () => controller.enqueue(new TextEncoder().encode(': OPENROUTER PROCESSING\n\n')),
              10,
            );
            init?.signal?.addEventListener('abort', () => {
              clearInterval(tick);
              controller.error(new DOMException('aborted', 'AbortError'));
            });
          },
        });
        return new Response(body, { status: 200 });
      },
    });
    await expect(run(keepAlive)).rejects.toThrow(/sent nothing/);

    // The caller's own stop stays a stop, not a timeout.
    const stop = new AbortController();
    const client = silentAfter(100, 5);
    const it = client.stream({ model: 'm', messages: [] }, stop.signal);
    await it.next();
    stop.abort();
    await expect(it.next()).rejects.toThrow(/aborted/);
  });

  it('surfaces provider errors with their message', async () => {
    const client = new OpenRouterClient({
      apiKey: 'k',
      fetch: async () =>
        new Response(JSON.stringify({ error: { message: 'Insufficient credits' } }), {
          status: 402,
        }),
    });
    await expect(client.stream({ model: 'm', messages: [] }).next()).rejects.toThrow(
      'Insufficient credits',
    );
  });
});
