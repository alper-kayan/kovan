import type { SubagentOutcome } from '@kovan/runner';
import { describe, expect, it } from 'vitest';
import { Delegations, MAX_DELEGATION_ROUNDS } from './delegations.js';

const outcome = (status: SubagentOutcome['status'], reply: string): SubagentOutcome => ({
  status,
  detail: null,
  reply,
  checks: { passed: 2, total: 2 },
  results: [],
  verification: 'verified',
  untested: [],
  impact: null,
});

function setup() {
  const settle = new Map<string, (o: SubagentOutcome) => void>();
  const notices: string[] = [];
  const resumed: string[] = [];
  let busy = false;
  let n = 0;
  const d = new Delegations({
    delegate: async (_task, onSettled) => {
      const id = `sub-${++n}`;
      settle.set(id, onSettled);
      return { id };
    },
    running: () => busy,
    notice: (t) => notices.push(t),
    resume: async (t) => {
      resumed.push(t);
    },
  });
  return { d, settle, notices, resumed, setBusy: (b: boolean) => (busy = b) };
}

const run = (d: Delegations, task: string) => d.tool().run({ task }, {} as never);

describe("an agent's delegated work", () => {
  it('waits while subagents run, then goes on with every result once the last ends', async () => {
    const { d, settle, notices, resumed, setBusy } = setup();
    setBusy(true);
    expect((await run(d, 'Write the totals helper with tests')).output).toContain('sub-1');
    await run(d, 'Add the discounts module and its tests');
    // The turn ends while both run.
    setBusy(false);
    d.check();
    d.check();
    expect(notices).toEqual([
      'Waiting for delegated work: 2 subagents still running. The agent goes on by itself when they finish.',
    ]);
    settle.get('sub-1')!(outcome('integrated', 'Added totals().'));
    expect(resumed).toEqual([]);
    settle.get('sub-2')!(outcome('failed', 'Tests failed.'));
    expect(resumed).toHaveLength(1);
    expect(resumed[0]).toContain(
      '"Write the totals helper with tests": integrated · checks 2/2 · Added totals().',
    );
    expect(resumed[0]).toContain('"Add the discounts module and its tests": failed');
  });

  it('waits for the turn to end when work finishes during it', async () => {
    const { d, settle, resumed, setBusy } = setup();
    setBusy(true);
    await run(d, 'Write the totals helper with tests');
    settle.get('sub-1')!(outcome('integrated', 'Done.'));
    expect(resumed).toEqual([]);
    setBusy(false);
    d.check();
    expect(resumed).toHaveLength(1);
  });

  it('goes on by itself only a few times before the person writes again', async () => {
    const { d, settle, notices, resumed } = setup();
    for (let i = 1; i <= MAX_DELEGATION_ROUNDS + 1; i++) {
      await run(d, `Task number ${i} done fully`);
      settle.get(`sub-${i}`)!(outcome('integrated', 'ok'));
    }
    expect(resumed).toHaveLength(MAX_DELEGATION_ROUNDS);
    expect(notices.at(-1)).toContain('Send a message to have the agent go on');
    d.personWrote();
    await run(d, 'Task number five done fully');
    settle.get(`sub-${MAX_DELEGATION_ROUNDS + 2}`)!(outcome('integrated', 'ok'));
    expect(resumed).toHaveLength(MAX_DELEGATION_ROUNDS + 1);
  });

  it('asks for a full task and reports a failed start', async () => {
    const { d } = setup();
    expect((await run(d, 'short')).ok).toBe(false);
    const failing = new Delegations({
      delegate: async () => {
        throw new Error('Subagents run beside a session lane.');
      },
      running: () => false,
      notice: () => undefined,
      resume: async () => undefined,
    });
    expect((await run(failing, 'Write the totals helper')).output).toContain('session lane');
  });
});
