import { describe, expect, it } from 'vitest';
import { parseDiff } from './diff';

const DIFF = `diff --git a/src/stats.js b/src/stats.js
index 1111111..2222222 100644
--- a/src/stats.js
+++ b/src/stats.js
@@ -1,4 +1,5 @@ export function mean(values) {
 /** The average. */
-export const mean = (v) => v.reduce((a, b) => a + b) / v.length;
+export const mean = (v) => v.reduce((a, b) => a + b, 0) / v.length;
+export const range = (v) => Math.max(...v) - Math.min(...v);
 
 export default mean;
\\ No newline at end of file
diff --git a/test/new.test.js b/test/new.test.js
new file mode 100644
index 0000000..3333333
--- /dev/null
+++ b/test/new.test.js
@@ -0,0 +1,2 @@
+import test from 'node:test';
+test('range', () => {});
diff --git a/old.txt b/old.txt
deleted file mode 100644
index 4444444..0000000
--- a/old.txt
+++ /dev/null
@@ -1 +0,0 @@
-gone
diff --git a/a.md b/docs/a.md
similarity index 100%
rename from a.md
rename to docs/a.md
diff --git a/logo.png b/logo.png
index 5555555..6666666 100644
Binary files a/logo.png and b/logo.png differ
`;

describe('parseDiff', () => {
  it('reads files, hunks and the numbers of each line', () => {
    const files = parseDiff(DIFF);
    expect(files.map((f) => [f.path, f.status, f.added, f.removed])).toEqual([
      ['src/stats.js', 'modified', 2, 1],
      ['test/new.test.js', 'added', 2, 0],
      ['old.txt', 'deleted', 0, 1],
      ['docs/a.md', 'renamed', 0, 0],
      ['logo.png', 'modified', 0, 0],
    ]);
    const [stats] = files;
    expect(stats!.hunks[0]!.header).toBe('export function mean(values) {');
    expect(stats!.hunks[0]!.lines).toEqual([
      { kind: 'ctx', text: '/** The average. */', oldNo: 1, newNo: 1 },
      {
        kind: 'del',
        text: 'export const mean = (v) => v.reduce((a, b) => a + b) / v.length;',
        oldNo: 2,
        newNo: null,
      },
      {
        kind: 'add',
        text: 'export const mean = (v) => v.reduce((a, b) => a + b, 0) / v.length;',
        oldNo: null,
        newNo: 2,
      },
      {
        kind: 'add',
        text: 'export const range = (v) => Math.max(...v) - Math.min(...v);',
        oldNo: null,
        newNo: 3,
      },
      { kind: 'ctx', text: '', oldNo: 3, newNo: 4 },
      { kind: 'ctx', text: 'export default mean;', oldNo: 4, newNo: 5 },
    ]);
    expect(files[3]!.oldPath).toBe('a.md');
    expect(files[4]!.binary).toBe(true);
  });

  it('ignores a truncation note and an empty diff', () => {
    expect(parseDiff('')).toEqual([]);
    const cut = parseDiff(
      'diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b\n… (diff truncated)\n',
    );
    expect(cut[0]!.hunks[0]!.lines).toHaveLength(2);
  });
});
