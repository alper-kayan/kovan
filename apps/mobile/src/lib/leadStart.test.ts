import { describe, expect, it } from 'vitest';
import { QUICK_BUDGET, startWithLead } from './leadStart';

type Call = { method: string; path: string; body?: unknown };

/** A tiny server: it remembers what it was asked, and can refuse a teammate's name once. */
function fake(options: { agents?: unknown[]; refuse?: string } = {}) {
  const calls: Call[] = [];
  let n = 0;
  let refused = false;
  const api = (async (method: string, path: string, body?: unknown) => {
    calls.push({ method, path, body });
    if (method === 'GET' && path.endsWith('/agents')) return { agents: options.agents ?? [] };
    if (method === 'GET' && path.endsWith('/members')) return { members: [{ name: 'Ada' }] };
    if (method === 'POST' && path.endsWith('/agents')) {
      const input = body as { name: string; role: string };
      if (options.refuse && input.name === options.refuse && !refused) {
        refused = true;
        throw new Error('That name is taken');
      }
      return { agent: { id: `a${++n}`, name: input.name, role: input.role, archived: false } };
    }
    if (method === 'POST' && path.endsWith('/sessions')) return { session: { id: 's1' } };
    if (method === 'PUT') return { swarm: { id: 'w1' } };
    throw new Error(`unexpected ${method} ${path}`);
  }) as Parameters<typeof startWithLead>[0];
  return { api, calls };
}

const input = {
  workspaceId: 'ws',
  goal: 'Redesign the settings page component and add tests',
  branches: [] as (string | null)[],
  owner: true,
};

describe('startWithLead', () => {
  it('sets a team up when there is none, then opens the session and saves the swarm', async () => {
    const { api, calls } = fake();
    const result = await startWithLead(api, input);
    const made = calls.filter((c) => c.method === 'POST' && c.path.endsWith('/agents'));
    expect(made).toHaveLength(3);
    // A lead first, with its job title, and a name nobody in the workspace has.
    expect((made[0]!.body as { role: string }).role).toBe('Tech lead');
    const names = made.map((c) => (c.body as { name: string }).name);
    expect(new Set(names).size).toBe(3);
    expect(names).not.toContain('Ada');
    // The owner's teammates carry a limit of their own.
    expect((made[0]!.body as { monthlyLimit: number }).monthlyLimit).toBe(10);
    const session = calls.find((c) => c.path.endsWith('/sessions'))!;
    expect((session.body as { branch: string }).branch).toMatch(
      /^kovan\/redesign-the-settings-page/,
    );
    const swarm = calls.find((c) => c.method === 'PUT')!;
    expect(swarm.body).toMatchObject({
      leadAgentId: result.created[0]!.id,
      budget: QUICK_BUDGET,
      mode: 'allow',
      review: true,
    });
    expect((swarm.body as { agentIds: string[] }).agentIds).toHaveLength(3);
    expect(result.session.id).toBe('s1');
    expect(result.swarm.id).toBe('w1');
  });

  it('uses the team the workspace already has', async () => {
    const team = [
      { id: 'lena', name: 'Lena', archived: false, instructions: 'Leads the swarm and reviews.' },
      { id: 'deniz', name: 'Deniz', archived: false, instructions: 'Builds frontend screens.' },
    ];
    const { api, calls } = fake({ agents: team });
    const result = await startWithLead(api, { ...input, owner: false });
    expect(calls.some((c) => c.method === 'POST' && c.path.endsWith('/agents'))).toBe(false);
    expect(result.created).toEqual([]);
    const swarm = calls.find((c) => c.method === 'PUT')!;
    expect(
      (swarm.body as { agentIds: string[] }).agentIds.every((id) => ['lena', 'deniz'].includes(id)),
    ).toBe(true);
  });

  it('moves to the next name when one is refused', async () => {
    const { api, calls } = fake({ refuse: 'Lena' });
    const result = await startWithLead(api, input);
    const posted = calls
      .filter((c) => c.method === 'POST' && c.path.endsWith('/agents'))
      .map((c) => (c.body as { name: string }).name);
    expect(posted[0]).toBe('Lena');
    expect(posted[1]).not.toBe('Lena');
    expect(result.created).toHaveLength(3);
    expect(result.created.map((a) => a.name)).not.toContain('Lena');
  });

  it('does not archive-skip: archived teammates do not count as a team', async () => {
    const { api, calls } = fake({
      agents: [{ id: 'old', name: 'Old', archived: true, instructions: '' }],
    });
    const result = await startWithLead(api, input);
    expect(calls.filter((c) => c.method === 'POST' && c.path.endsWith('/agents'))).toHaveLength(3);
    expect(result.created).toHaveLength(3);
  });
});
