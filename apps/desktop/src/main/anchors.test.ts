import { describe, expect, it } from 'vitest';
import { checkAnchor, describeAnchorState, snippetAt } from './anchors.js';

const file = ['// math', 'export function add(a, b) {', '  return a + b;', '}', ''].join('\n');
const anchor = { startLine: 2, endLine: 4, snippet: snippetAt(file, 2, 4) };

describe('checkAnchor', () => {
  it('holds while the code stays put, whitespace at line ends aside', () => {
    expect(anchor.snippet).toBe('export function add(a, b) {\n  return a + b;\n}');
    expect(checkAnchor(file.replace('a + b;', 'a + b;   '), anchor)).toEqual({ state: 'ok' });
  });

  it('notices code that moved', () => {
    const moved = [
      '// math',
      '',
      'import x from "y";',
      '',
      file.split('\n').slice(1).join('\n'),
    ].join('\n');
    const state = checkAnchor(moved, anchor);
    expect(state).toEqual({ state: 'moved', startLine: 5, endLine: 7 });
    expect(describeAnchorState(state, 'src/math.ts', 2)).toBe(
      'The code it points at moved from line 2 to line 5 of src/math.ts.',
    );
  });

  it('notices code that changed or a file that is gone', () => {
    expect(checkAnchor(file.replace('a + b', 'b + a'), anchor)).toEqual({ state: 'changed' });
    expect(checkAnchor(null, anchor)).toEqual({ state: 'missing' });
  });
});
