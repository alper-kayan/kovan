// Small, self-checking coding tasks for comparing models and JevRouter on score and cost.
// Each task is a folder of files, a prompt, and a check script whose exit code is the verdict.

export interface EvalTask {
  id: string;
  level: 'easy' | 'medium' | 'hard';
  prompt: string;
  files: Record<string, string>;
  /** A Node script run in the task folder after the agent finishes; exit 0 means solved. */
  check: string;
}

const assertLib = `import assert from 'node:assert/strict';\n`;

export const TASKS: EvalTask[] = [
  {
    id: 'typo',
    level: 'easy',
    prompt:
      'The product name is misspelled as "Kovam" in README.md. Fix every occurrence to "Kovan".',
    files: {
      'README.md': '# Kovam\n\nKovam is a multiplayer IDE. Install Kovam from the website.\n',
    },
    check: `import { readFileSync } from 'node:fs';\nconst t = readFileSync('README.md', 'utf8');\nif (t.includes('Kovam') || (t.match(/Kovan/g) ?? []).length !== 3) process.exit(1);`,
  },
  {
    id: 'add-function',
    level: 'easy',
    prompt:
      'Add an exported function `multiply(a, b)` to math.js that returns the product, next to `add`.',
    files: { 'math.js': 'export function add(a, b) {\n  return a + b;\n}\n' },
    check: `${assertLib}const m = await import('./math.js');\nassert.equal(m.add(2, 3), 5);\nassert.equal(m.multiply(3, 4), 12);\nassert.equal(m.multiply(-2, 5), -10);`,
  },
  {
    id: 'parse-duration',
    level: 'medium',
    prompt:
      'parseDuration in duration.js should turn strings like "1h30m", "45s", "2h" and "1h2m3s" into seconds, but some inputs come out wrong. Find and fix the bug. Keep the export name.',
    files: {
      'duration.js': `const UNITS = { h: 3600, m: 60, s: 1 };\n\nexport function parseDuration(text) {\n  let total = 0;\n  for (const [, value, unit] of text.matchAll(/(\\d)([hms])/g)) {\n    total += Number(value) * UNITS[unit];\n  }\n  return total;\n}\n`,
    },
    check: `${assertLib}const { parseDuration } = await import('./duration.js');\nassert.equal(parseDuration('1h30m'), 5400);\nassert.equal(parseDuration('45s'), 45);\nassert.equal(parseDuration('2h'), 7200);\nassert.equal(parseDuration('1h2m3s'), 3723);\nassert.equal(parseDuration('90m'), 5400);\nassert.equal(parseDuration('120s'), 120);`,
  },
  {
    id: 'rename',
    level: 'medium',
    prompt:
      'Rename the function `getUsr` to `getUser` everywhere in this project (definition and every call site). Behaviour must stay the same.',
    files: {
      'users.js': `const USERS = { 1: 'Ada', 2: 'Linus' };\nexport function getUsr(id) {\n  return USERS[id] ?? null;\n}\n`,
      'greet.js': `import { getUsr } from './users.js';\nexport function greet(id) {\n  const name = getUsr(id);\n  return name ? \`Hello, \${name}!\` : 'Hello, stranger!';\n}\n`,
      'admin.js': `import { getUsr } from './users.js';\nexport function isAdmin(id) {\n  return getUsr(id) === 'Ada';\n}\n`,
    },
    check: `${assertLib}import { readFileSync } from 'node:fs';\nfor (const f of ['users.js', 'greet.js', 'admin.js']) assert.ok(!readFileSync(f, 'utf8').includes('getUsr'), f);\nconst u = await import('./users.js');\nassert.equal(u.getUser(1), 'Ada');\nconst { greet } = await import('./greet.js');\nassert.equal(greet(2), 'Hello, Linus!');\nassert.equal(greet(9), 'Hello, stranger!');\nconst { isAdmin } = await import('./admin.js');\nassert.equal(isAdmin(1), true);`,
  },
  {
    id: 'lru-cache',
    level: 'hard',
    prompt:
      'Implement `export class LRUCache` in lru.js: `new LRUCache(capacity)`, `get(key)` returns the value or undefined and marks it most recently used, `set(key, value)` inserts or updates and evicts the least recently used entry when over capacity, and a `size` getter. All operations O(1).',
    files: { 'lru.js': '// Implement LRUCache here.\n' },
    check: `${assertLib}const { LRUCache } = await import('./lru.js');\nconst c = new LRUCache(2);\nc.set('a', 1); c.set('b', 2);\nassert.equal(c.get('a'), 1);\nc.set('c', 3);\nassert.equal(c.get('b'), undefined);\nassert.equal(c.get('a'), 1);\nassert.equal(c.get('c'), 3);\nc.set('a', 10);\nc.set('d', 4);\nassert.equal(c.get('c'), undefined);\nassert.equal(c.get('a'), 10);\nassert.equal(c.size, 2);`,
  },
  {
    id: 'paginate',
    level: 'hard',
    prompt:
      'Users report that pagination skips items and the last page is sometimes missing. Find and fix the bugs in paginate.js. Pages are 1-based; `totalPages` must be 0 for an empty list.',
    files: {
      'paginate.js': `export function paginate(items, page, size) {\n  const totalPages = Math.floor(items.length / size);\n  const start = page * size;\n  return {\n    items: items.slice(start, start + size - 1),\n    page,\n    totalPages,\n    hasNext: page < totalPages - 1,\n  };\n}\n`,
    },
    check: `${assertLib}const { paginate } = await import('./paginate.js');\nconst list = Array.from({ length: 23 }, (_, i) => i + 1);\nconst p1 = paginate(list, 1, 10);\nassert.deepEqual(p1.items, [1,2,3,4,5,6,7,8,9,10]);\nassert.equal(p1.totalPages, 3);\nassert.equal(p1.hasNext, true);\nconst p3 = paginate(list, 3, 10);\nassert.deepEqual(p3.items, [21,22,23]);\nassert.equal(p3.hasNext, false);\nassert.equal(paginate([], 1, 10).totalPages, 0);\nassert.equal(paginate([], 1, 10).hasNext, false);\nassert.equal(paginate(list.slice(0, 20), 2, 10).hasNext, false);`,
  },
];
