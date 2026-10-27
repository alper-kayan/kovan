/** The longest tool result the model gets; the rest is cut with a note. */
export const MAX_RESULT_CHARS = 40_000;

type Content =
  | { type: 'text'; text: string }
  | { type: 'image'; data: string; mimeType: string }
  | { type: 'audio'; data: string; mimeType: string }
  | {
      type: 'resource';
      resource: { uri: string; mimeType?: string; text?: string; blob?: string };
    }
  | { type: 'resource_link'; uri: string; name?: string; mimeType?: string }
  | { type: string; [key: string]: unknown };

/** Base64 length to bytes, roughly. */
const bytes = (base64: string) => Math.floor((base64.length * 3) / 4);

/**
 * A tool result as text for the model: text as is; images, audio and binary resources as a
 * line saying what they were (the model can't see them here); structured content as JSON when
 * there is no text. Long results are cut.
 */
export function resultText(
  result: {
    content?: unknown;
    structuredContent?: unknown;
    isError?: unknown;
    toolResult?: unknown;
  },
  max = MAX_RESULT_CHARS,
): string {
  const parts: string[] = [];
  const content = Array.isArray(result.content) ? (result.content as Content[]) : [];
  for (const c of content) {
    if (c.type === 'text' && typeof c['text'] === 'string') parts.push(c['text']);
    else if ((c.type === 'image' || c.type === 'audio') && typeof c['data'] === 'string')
      parts.push(
        `[${c.type}: ${String(c['mimeType'] ?? 'unknown type')}, ${bytes(c['data'])} bytes]`,
      );
    else if (c.type === 'resource') {
      const r = (c as Extract<Content, { type: 'resource' }>).resource;
      parts.push(
        typeof r.text === 'string'
          ? `[resource ${r.uri}]\n${r.text}`
          : `[resource ${r.uri}: ${r.mimeType ?? 'binary'}${r.blob ? `, ${bytes(r.blob)} bytes` : ''}]`,
      );
    } else if (c.type === 'resource_link')
      parts.push(`[link: ${String(c['name'] ?? c['uri'])} ${String(c['uri'])}]`);
    else parts.push(`[${c.type} content]`);
  }
  if (parts.length === 0 && result.structuredContent !== undefined)
    parts.push(JSON.stringify(result.structuredContent, null, 2));
  // Servers on the old protocol answer with `toolResult`.
  if (parts.length === 0 && result.toolResult !== undefined)
    parts.push(
      typeof result.toolResult === 'string' ? result.toolResult : JSON.stringify(result.toolResult),
    );
  let text = parts.join('\n').trim() || '(no output)';
  if (text.length > max)
    text = `${text.slice(0, max)}\n… cut: the tool returned ${text.length} characters`;
  return text;
}

const SECRET_KEY = /(token|secret|password|passwd|api[-_]?key|auth|credential|cookie|session)/i;
export const MASK = '••••••';

/**
 * Arguments with secrets hidden, for approval cards, transcripts and logs: values under names
 * that look secret, and any of the server's own secret values wherever they appear.
 */
export function maskSecrets<T>(value: T, secrets: readonly string[] = []): T {
  const hide = (s: string) => secrets.reduce((acc, secret) => acc.split(secret).join(MASK), s);
  const walk = (v: unknown, key: string | null): unknown => {
    if (typeof v === 'string') return key && SECRET_KEY.test(key) && v ? MASK : hide(v);
    if (Array.isArray(v)) return v.map((x) => walk(x, key));
    if (v && typeof v === 'object')
      return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x, k)]));
    return v;
  };
  return walk(value, null) as T;
}
