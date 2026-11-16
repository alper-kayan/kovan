import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * A React component that returns early before calling a hook calls fewer hooks on that render than
 * on the next one ("Rendered more hooks than during the previous render", React error #310). The
 * session room did exactly that: it showed "Opening the session…" and then crashed when the room
 * arrived. This reads each component's source and reports a hook declared after an early return.
 */
const HOOK_LINE = /^ {2}(const|let) .*=\s*use[A-Z]\w*\(/;
const EARLY_RETURN_ONE_LINE = /^ {2}if \(.*\) (return|null)\b/;
const EARLY_RETURN_BLOCK = /^ {2}if \(.*\)$/;

export function hooksAfterEarlyReturn(source: string): string[] {
  const lines = source.split('\n');
  const starts = lines.flatMap((l, i) =>
    /^(export )?(default )?function [A-Z]\w*\(/.test(l) ? [i] : [],
  );
  starts.push(lines.length);
  const found: string[] = [];
  for (let k = 0; k + 1 < starts.length; k++) {
    const [from, to] = [starts[k]!, starts[k + 1]!];
    const name = /function (\w+)/.exec(lines[from]!)![1];
    let early: number | null = null;
    for (let i = from + 1; i < to; i++) {
      const line = lines[i]!;
      if (
        early === null &&
        (EARLY_RETURN_ONE_LINE.test(line) ||
          (EARLY_RETURN_BLOCK.test(line) && /^\s+return\b/.test(lines[i + 1] ?? '')))
      )
        early = i;
      else if (early !== null && HOOK_LINE.test(line))
        found.push(
          `${name}: a hook at line ${i + 1} follows the early return at line ${early + 1}`,
        );
    }
  }
  return found;
}

describe('hooks run in the same order on every render', () => {
  it('finds a hook declared after an early return', () => {
    const bad = [
      'function Room() {',
      '  const room = useStore((s) => s.room);',
      '  if (!room) return null;',
      '  const [w, setW] = useState(0);',
      '  return w;',
      '}',
    ].join('\n');
    expect(hooksAfterEarlyReturn(bad)).toHaveLength(1);
    const good = bad.replace(
      '  if (!room) return null;\n  const [w, setW] = useState(0);',
      '  const [w, setW] = useState(0);\n  if (!room) return null;',
    );
    expect(hooksAfterEarlyReturn(good)).toEqual([]);
  });

  it('holds for every component of the app', () => {
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) walk(path);
        else if (path.endsWith('.tsx')) files.push(path);
      }
    };
    const root = join(import.meta.dirname, '../renderer/src');
    walk(root);
    expect(files.length).toBeGreaterThan(20);
    const problems = files.flatMap((f) =>
      hooksAfterEarlyReturn(readFileSync(f, 'utf8')).map((p) => `${f.replace(root, '')}: ${p}`),
    );
    expect(problems).toEqual([]);
  });
});
