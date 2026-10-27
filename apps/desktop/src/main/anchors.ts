/** Lines of a file a note or comment is pinned to, and the code that was there. */
export interface Anchor {
  startLine: number;
  endLine: number;
  snippet: string;
}

export type AnchorState =
  | { state: 'ok' }
  | { state: 'moved'; startLine: number; endLine: number }
  | { state: 'changed' }
  | { state: 'missing' };

const lines = (text: string) =>
  text
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((l) => l.trimEnd());

/** The anchored lines as they read now, to store as the snippet. */
export function snippetAt(content: string, startLine: number, endLine: number): string {
  return lines(content)
    .slice(startLine - 1, endLine)
    .join('\n');
}

/**
 * Is the code still where the anchor says? Exact lines first; otherwise the same code
 * elsewhere in the file ("moved"), or not at all ("changed"). Whitespace at line ends is ignored.
 */
export function checkAnchor(content: string | null, anchor: Anchor): AnchorState {
  if (content === null) return { state: 'missing' };
  const want = lines(anchor.snippet);
  while (want.length && want.at(-1) === '') want.pop();
  if (want.length === 0) return { state: 'ok' };
  const have = lines(content);
  const at = (start: number) => want.every((line, i) => have[start + i] === line);
  if (at(anchor.startLine - 1)) return { state: 'ok' };
  for (let i = 0; i + want.length <= have.length; i++)
    if (at(i)) return { state: 'moved', startLine: i + 1, endLine: i + want.length };
  return { state: 'changed' };
}

export function describeAnchorState(state: AnchorState, path: string, startLine: number): string {
  switch (state.state) {
    case 'moved':
      return `The code it points at moved from line ${startLine} to line ${state.startLine} of ${path}.`;
    case 'changed':
      return `The code it points at in ${path} changed.`;
    case 'missing':
      return `${path} no longer exists.`;
    default:
      return '';
  }
}
