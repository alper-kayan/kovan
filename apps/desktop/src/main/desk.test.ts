import type { DeskAction, ServerMessage, Session } from '@kovan/shared';
import { describe, expect, it, vi } from 'vitest';
import { Desk, type DeskDeps } from './desk.js';

const session = {
  id: 's1',
  workspaceId: 'w1',
  title: 'Lobby race',
  branch: 'kovan/lobby',
  participants: [{ userId: 'bob', name: 'Bob' }],
} as unknown as Session;

function setup(over: Partial<DeskDeps> = {}) {
  const calls: { method: string; path: string; body?: unknown }[] = [];
  const deps: DeskDeps = {
    request: vi.fn(async <T>(method: string, path: string, body?: unknown) => {
      calls.push({ method, path, body });
      if (path === '/api/sessions/s1') return { session } as T;
      return { ok: true } as T;
    }) as DeskDeps['request'],
    machineId: () => 'laptop',
    canCarry: vi.fn(async () => true),
    hasWorkspace: vi.fn(async () => true),
    takeover: vi.fn(async () => ({ status: 'requested', resume: null })),
    continueWith: vi.fn(async () => ({ resume: 'Resuming at step 2 of 3.' })),
    handoff: vi.fn(async () => ({})),
    checkout: vi.fn(async () => ({ root: '/work/lobby' })),
    launchSwarm: vi.fn(async () => ({})),
    prompt: vi.fn(async () => 'started' as const),
    ...over,
  };
  return { desk: new Desk(deps), deps, calls };
}

const ask = (action: DeskAction): ServerMessage => ({
  type: 'desk',
  request: { id: 'r1', action, createdAt: '2026-10-15T09:00:00Z' },
});
const done = (calls: { path: string; body?: unknown }[]) =>
  calls.find((c) => c.path === '/api/desk/r1/done')?.body;

describe('work asked for on the phone', () => {
  it('claims it, does it here and says how it went', async () => {
    const { desk, deps, calls } = setup();
    await desk.onMessage(ask({ kind: 'takeover', sessionId: 's1', laneUserId: 'bob' }));
    expect(calls.map((c) => c.path)).toEqual([
      '/api/sessions/s1',
      '/api/desk/r1/claim',
      '/api/desk/r1/done',
    ]);
    expect(deps.takeover).toHaveBeenCalledWith('s1', 'bob');
    expect(done(calls)).toEqual({
      machineId: 'laptop',
      ok: true,
      message:
        "Asked Bob's agent to stop at a safe checkpoint; your desktop carries on from there.",
    });
  });

  it("leaves it to another computer when this one can't carry the lane", async () => {
    const { desk, deps, calls } = setup({ canCarry: vi.fn(async () => false) });
    await desk.onMessage(ask({ kind: 'continue', handoffId: 'h1', sessionId: 's1' }));
    expect(calls.map((c) => c.path)).toEqual(['/api/sessions/s1']);
    expect(deps.continueWith).not.toHaveBeenCalled();
  });

  it('does nothing when another of the person’s computers claimed it first', async () => {
    const { desk, deps } = setup({
      request: vi.fn(async <T>(_m: string, path: string) => {
        if (path.endsWith('/claim')) throw new Error('Another of your computers took it');
        return { session } as T;
      }) as DeskDeps['request'],
    });
    await desk.onMessage(ask({ kind: 'handoff', sessionId: 's1', toUserId: 'bob' }));
    expect(deps.handoff).not.toHaveBeenCalled();
  });

  it('resumes a swarm in the session’s checkout and reports a failure as one', async () => {
    const { desk, deps, calls } = setup({
      launchSwarm: vi.fn(async () => {
        throw new Error('The budget is spent ($1.00 of $1.00): raise it first');
      }),
    });
    await desk.onMessage(ask({ kind: 'resume', swarmId: 'sw1', sessionId: 's1' }));
    expect(deps.checkout).toHaveBeenCalledWith({
      id: 's1',
      workspaceId: 'w1',
      title: 'Lobby race',
      branch: 'kovan/lobby',
    });
    expect(deps.launchSwarm).toHaveBeenCalledWith('sw1', '/work/lobby');
    expect(done(calls)).toMatchObject({
      ok: false,
      message: 'The budget is spent ($1.00 of $1.00): raise it first',
    });
  });

  it('launches a swarm set up on the phone in the session’s checkout', async () => {
    const { desk, deps, calls } = setup();
    await desk.onMessage(ask({ kind: 'launch', swarmId: 'sw1', sessionId: 's1' }));
    expect(deps.launchSwarm).toHaveBeenCalledWith('sw1', '/work/lobby');
    expect(done(calls)).toMatchObject({
      ok: true,
      message: 'The swarm is running on your desktop, on your key.',
    });
  });

  it('prompts the person’s own agent wherever the workspace is set up', async () => {
    const { desk, deps, calls } = setup({ canCarry: vi.fn(async () => false) });
    await desk.onMessage(ask({ kind: 'prompt', sessionId: 's1', text: 'Add a median helper' }));
    expect(deps.prompt).toHaveBeenCalledWith(session, 'Add a median helper');
    expect(done(calls)).toMatchObject({ ok: true, message: 'Your agent started on your desktop.' });
  });

  it('says a working agent takes the prompt as guidance', async () => {
    const { desk, calls } = setup({ prompt: vi.fn(async () => 'steered' as const) });
    await desk.onMessage(ask({ kind: 'prompt', sessionId: 's1', text: 'Use integers' }));
    expect(done(calls)).toMatchObject({
      message: 'Your agent is working: it takes this before its next step.',
    });
  });

  it('leaves a prompt alone when this machine doesn’t have the workspace', async () => {
    const { desk, deps, calls } = setup({ hasWorkspace: vi.fn(async () => false) });
    await desk.onMessage(ask({ kind: 'prompt', sessionId: 's1', text: 'Hi' }));
    expect(calls.map((c) => c.path)).toEqual(['/api/sessions/s1']);
    expect(deps.prompt).not.toHaveBeenCalled();
  });
});
