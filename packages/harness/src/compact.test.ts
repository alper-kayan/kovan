import type { ChatMessage } from '@kovan/model-gateway';
import { describe, expect, it } from 'vitest';
import {
  compactPoint,
  estimateTokens,
  isContextOverflow,
  nearWindow,
  transcriptOf,
} from './compact.js';

const big = (n: number) => 'x'.repeat(n * 4);
const call = (id: string): ChatMessage => ({
  role: 'assistant',
  content: null,
  tool_calls: [
    { id, type: 'function', function: { name: 'read_file', arguments: '{"path":"a.ts"}' } },
  ],
});

describe('compacting a conversation', () => {
  it('knows when a conversation nears the window', () => {
    expect(estimateTokens([{ role: 'user', content: big(100) }])).toBe(100);
    expect(nearWindow(100_000, 128_000)).toBe(false);
    expect(nearWindow(110_000, 128_000)).toBe(true);
    // Small windows keep at least 16k tokens free.
    expect(nearWindow(20_000, 32_000)).toBe(true);
  });

  it('keeps the newest part, never a tool result without its call', () => {
    const messages: ChatMessage[] = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: big(5000) },
      call('c1'),
      { role: 'tool', tool_call_id: 'c1', content: big(5000) },
      { role: 'user', content: 'next' },
      call('c2'),
      { role: 'tool', tool_call_id: 'c2', content: big(3000) },
    ];
    // About 3k tokens kept: starts at the assistant call, not at its result.
    expect(compactPoint(messages, 3000)).toBe(5);
    // Nothing old enough to be worth a summary.
    expect(compactPoint(messages.slice(0, 2), 100)).toBeNull();
    // One huge old message is worth a summary on its own.
    expect(compactPoint(messages.slice(0, 3), 100)).toBe(2);
  });

  it('writes the summarized part as text, cutting long outputs and the middle', () => {
    const text = transcriptOf(
      [
        { role: 'user', content: 'Fix the cart' },
        call('c1'),
        { role: 'tool', tool_call_id: 'c1', content: big(1000) },
      ],
      100_000,
    );
    expect(text).toContain('[user] Fix the cart');
    expect(text).toContain('[tool call] read_file {"path":"a.ts"}');
    expect(text).toContain('…[cut]');
    expect(transcriptOf([{ role: 'user', content: big(1000) }], 1000)).toContain('…[middle cut]…');
  });

  it('recognizes "too long for the model" errors', () => {
    expect(
      isContextOverflow(new Error("This model's maximum context length is 128000 tokens")),
    ).toBe(true);
    expect(isContextOverflow(new Error('prompt is too long: 210000 tokens > 200000 maximum'))).toBe(
      true,
    );
    expect(isContextOverflow(new Error('Rate limit reached'))).toBe(false);
  });
});
