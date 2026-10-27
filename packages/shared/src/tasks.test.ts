import { describe, expect, it } from 'vitest';
import {
  canMoveSubagent,
  canMoveTask,
  graphColumns,
  graphProblem,
  nextTasks,
  orderTestOnlyTasks,
  serializeOverlaps,
  verificationOf,
  type CheckResult,
  type TaskState,
} from './tasks.js';

const check = (status: CheckResult['status'], command: string | null = 'pnpm test') => ({
  name: command ?? 'Applies cleanly',
  command,
  status,
  detail: null,
  ms: 1,
});

describe('canMoveSubagent', () => {
  it('allows the normal path and rework, and nothing after the end', () => {
    expect(canMoveSubagent('running', 'checking')).toBe(true);
    expect(canMoveSubagent('checking', 'passed')).toBe(true);
    expect(canMoveSubagent('passed', 'integrated')).toBe(true);
    expect(canMoveSubagent('failed', 'running')).toBe(true);
    expect(canMoveSubagent('failed', 'checking')).toBe(true);
    expect(canMoveSubagent('checking', 'checking')).toBe(true);
    expect(canMoveSubagent('running', 'passed')).toBe(false);
    expect(canMoveSubagent('running', 'integrated')).toBe(false);
    expect(canMoveSubagent('integrated', 'running')).toBe(false);
    expect(canMoveSubagent('cancelled', 'checking')).toBe(false);
  });
});

describe('canMoveTask', () => {
  it('follows the task lifecycle and keeps done and cancelled final', () => {
    expect(canMoveTask(null, 'running')).toBe(true);
    expect(canMoveTask('waiting', 'running')).toBe(true);
    expect(canMoveTask('waiting', 'waiting_for_approval')).toBe(true);
    expect(canMoveTask('waiting_for_approval', 'running')).toBe(false);
    expect(canMoveTask('waiting', 'done')).toBe(false);
    expect(canMoveTask('running', 'waiting')).toBe(true);
    expect(canMoveTask('failed', 'waiting')).toBe(true);
    expect(canMoveTask('blocked', 'running')).toBe(false);
    expect(canMoveTask('done', 'waiting')).toBe(false);
    expect(canMoveTask('cancelled', 'waiting')).toBe(false);
  });
});

describe('verificationOf', () => {
  it('counts as verified only when the project’s own checks ran and passed', () => {
    expect(verificationOf([check('passed', null), check('passed')])).toBe('verified');
    expect(verificationOf([check('passed', null)])).toBe('unverified');
    expect(verificationOf([check('passed', null), check('failed')])).toBe('failed');
    expect(verificationOf([check('passed'), check('not_run')])).toBe('failed');
    expect(verificationOf([check('blocked')])).toBe('failed');
    expect(verificationOf([])).toBe('failed');
  });
});

describe('graphProblem', () => {
  it('accepts a graph and names what is wrong with a bad one', () => {
    expect(
      graphProblem([
        { key: 'a', dependsOn: [] },
        { key: 'b', dependsOn: ['a'] },
        { key: 'c', dependsOn: ['a', 'b'] },
      ]),
    ).toBeNull();
    expect(graphProblem([{ key: 'a', dependsOn: ['x'] }])).toContain('"x", which is not a task');
    expect(graphProblem([{ key: 'a', dependsOn: ['a'] }])).toContain('depends on itself');
    expect(
      graphProblem([
        { key: 'a', dependsOn: ['c'] },
        { key: 'b', dependsOn: ['a'] },
        { key: 'c', dependsOn: ['b'] },
      ]),
    ).toContain('a → c → b → a');
    expect(
      graphProblem([
        { key: 'a', dependsOn: [] },
        { key: 'a', dependsOn: [] },
      ]),
    ).toContain('Two tasks');
  });
});

describe('nextTasks', () => {
  const graph = [
    { key: 'model', dependsOn: [] },
    { key: 'docs', dependsOn: [] },
    { key: 'api', dependsOn: ['model'] },
    { key: 'ui', dependsOn: ['api'] },
  ];

  it('starts independent tasks together and dependent ones in order', () => {
    const states: Record<string, TaskState> = {
      model: 'waiting',
      docs: 'waiting',
      api: 'waiting',
      ui: 'waiting',
    };
    expect(nextTasks(graph, (k) => states[k]!).ready).toEqual(['model', 'docs']);
    states['model'] = 'running';
    states['docs'] = 'running';
    expect(nextTasks(graph, (k) => states[k]!).ready).toEqual([]);
    states['model'] = 'done';
    expect(nextTasks(graph, (k) => states[k]!).ready).toEqual(['api']);
  });

  it('blocks what depends on a failed task, down the line', () => {
    const states: Record<string, TaskState> = {
      model: 'failed',
      docs: 'done',
      api: 'waiting',
      ui: 'waiting',
    };
    expect(nextTasks(graph, (k) => states[k]!)).toEqual({
      ready: [],
      blocked: [{ key: 'api', by: 'model' }],
    });
    states['api'] = 'blocked';
    expect(nextTasks(graph, (k) => states[k]!).blocked).toEqual([{ key: 'ui', by: 'api' }]);
  });
});

describe('serializeOverlaps', () => {
  it('orders side-by-side tasks that touch the same files, and leaves the rest parallel', () => {
    const tasks = [
      { key: 'a', dependsOn: [] as string[], files: ['src/stats.js'] },
      { key: 'b', dependsOn: [] as string[], files: ['./src/stats.js', 'test/b.test.js'] },
      { key: 'c', dependsOn: [] as string[], files: ['docs'] },
      { key: 'd', dependsOn: [] as string[], files: ['docs/api.md'] },
      { key: 'e', dependsOn: [] as string[], files: ['src/other.js'] },
    ];
    expect(serializeOverlaps(tasks)).toEqual([
      { task: 'b', after: 'a', files: ['src/stats.js'] },
      { task: 'd', after: 'c', files: ['docs'] },
    ]);
    expect(tasks.map((t) => t.dependsOn)).toEqual([[], ['a'], [], ['c'], []]);
    expect(graphProblem(tasks)).toBeNull();
  });

  it('leaves tasks alone that are already in order, directly or through others', () => {
    const tasks = [
      { key: 'a', dependsOn: [] as string[], files: ['x.ts'] },
      { key: 'b', dependsOn: ['a'], files: ['y.ts'] },
      { key: 'c', dependsOn: ['b'], files: ['x.ts'] },
    ];
    expect(serializeOverlaps(tasks)).toEqual([]);
  });

  it('chains three tasks on one file without a circle', () => {
    const tasks = [
      { key: 'a', dependsOn: [] as string[], files: ['x.ts'] },
      { key: 'b', dependsOn: [] as string[], files: ['x.ts'] },
      { key: 'c', dependsOn: [] as string[], files: ['x.ts'] },
    ];
    serializeOverlaps(tasks);
    expect(tasks.map((t) => t.dependsOn)).toEqual([[], ['a'], ['b']]);
    expect(graphProblem(tasks)).toBeNull();
  });
});

describe('graphColumns', () => {
  it('puts each task one column after the latest it depends on', () => {
    const t = (key: string, ...dependsOn: string[]) => ({ key, dependsOn });
    const columns = graphColumns([
      t('model'),
      t('docs'),
      t('api', 'model'),
      t('ui', 'api', 'docs'),
      t('e2e', 'ui', 'model'),
      t('other', 'gone'),
    ]);
    expect(columns.map((c) => c.map((x) => x.key))).toEqual([
      ['model', 'docs', 'other'],
      ['api'],
      ['ui'],
      ['e2e'],
    ]);
  });
});

describe('orderTestOnlyTasks', () => {
  it('makes a tests-only task wait for the code it tests', () => {
    const tasks = [
      { key: 'code', dependsOn: [] as string[], files: ['src/mode.js'] },
      { key: 'tests', dependsOn: [] as string[], files: ['test/mode.test.js'] },
      { key: 'docs', dependsOn: [] as string[], files: [] as string[] },
      { key: 'both', dependsOn: [] as string[], files: ['src/x.js', 'test/x.test.js'] },
    ];
    expect(orderTestOnlyTasks(tasks)).toEqual([
      { task: 'tests', after: 'code' },
      { task: 'tests', after: 'both' },
    ]);
    expect(graphProblem(tasks)).toBeNull();
    // Already in order (or the other way round): left alone.
    const ordered = [
      { key: 'tests', dependsOn: [] as string[], files: ['test/a.test.js'] },
      { key: 'code', dependsOn: ['tests'], files: ['src/a.js'] },
    ];
    expect(orderTestOnlyTasks(ordered)).toEqual([]);
  });
});
