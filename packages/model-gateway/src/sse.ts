/**
 * Incremental Server-Sent Events parser: feed it chunks as they arrive, get complete `data:`
 * payloads back. Comment lines (": keep-alive") and other fields are ignored.
 */
export class SseParser {
  private buffer = '';

  push(chunk: string): string[] {
    this.buffer += chunk;
    const out: string[] = [];
    let newline: number;
    while ((newline = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.slice(0, newline).replace(/\r$/, '');
      this.buffer = this.buffer.slice(newline + 1);
      if (line.startsWith('data:')) out.push(line.slice(5).trimStart());
    }
    return out;
  }
}

/** Assembles streamed tool-call fragments (keyed by index) into complete calls. */
export class ToolCallAssembler {
  private readonly calls = new Map<number, { id: string; name: string; arguments: string }>();

  /** Adds a fragment and returns the call as written so far. */
  add(fragment: {
    index?: number;
    id?: string;
    function?: { name?: string; arguments?: string };
  }): { id: string; name: string; arguments: string } {
    const index = fragment.index ?? 0;
    const call = this.calls.get(index) ?? { id: '', name: '', arguments: '' };
    if (fragment.id) call.id = fragment.id;
    if (fragment.function?.name) call.name += fragment.function.name;
    if (fragment.function?.arguments) call.arguments += fragment.function.arguments;
    this.calls.set(index, call);
    return { id: call.id || `call_${index}`, name: call.name, arguments: call.arguments };
  }

  finish(): { id: string; type: 'function'; function: { name: string; arguments: string } }[] {
    return [...this.calls.entries()]
      .sort(([a], [b]) => a - b)
      .map(([index, c]) => ({
        id: c.id || `call_${index}`,
        type: 'function' as const,
        function: { name: c.name, arguments: c.arguments || '{}' },
      }));
  }
}

/**
 * Streams deliver reasoning_details in pieces; pieces with the same index belong to one block.
 * Text fields are concatenated, everything else takes the latest value.
 */
export function mergeReasoningDetails(pieces: unknown[]): unknown[] {
  const blocks = new Map<number | string, Record<string, unknown>>();
  pieces.forEach((piece, position) => {
    if (typeof piece !== 'object' || piece === null) return;
    const p = piece as Record<string, unknown>;
    const key = typeof p['index'] === 'number' ? p['index'] : `#${position}`;
    const block = blocks.get(key) ?? {};
    for (const [field, value] of Object.entries(p)) {
      if (
        (field === 'text' || field === 'summary' || field === 'data') &&
        typeof value === 'string' &&
        typeof block[field] === 'string'
      ) {
        block[field] = (block[field] as string) + value;
      } else {
        block[field] = value;
      }
    }
    blocks.set(key, block);
  });
  return [...blocks.values()];
}
