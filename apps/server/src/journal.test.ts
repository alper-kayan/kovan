import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { journalEvents } from './db/schema.js';
import { auth, connect, oauthLogin, startHarness, type Harness } from './test/harness.js';

let h: Harness;
type Person = { token: string; id: string };
type Msg = { type: string; [k: string]: unknown };
let alice: Person; // owner
let dave: Person; // viewer
let eve: Person; // outside
let workspaceId: string;

async function api(person: Person, method: string, url: string, payload?: object) {
  const res = await h.app.inject({
    method: method as 'GET',
    url,
    headers: auth(person.token),
    ...(payload ? { payload } : {}),
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- loose JSON in tests
  return { status: res.statusCode, body: res.json() as Record<string, any> };
}

beforeAll(async () => {
  h = await startHarness();
  const login = async (code: string, n: string) => {
    const r = await oauthLogin(h, 'github', code, { providerUserId: n, login: code, name: code });
    return { token: r.token, id: r.user.id };
  };
  alice = await login('alice', '1');
  dave = await login('dave', '4');
  eve = await login('eve', '5');
  const orgId = (await api(alice, 'GET', '/api/me')).body.orgs[0].id;
  workspaceId = (
    await api(alice, 'POST', '/api/workspaces', { orgId, name: 'journal', repoUrl: null })
  ).body.workspace.id;
  await api(alice, 'POST', `/api/workspaces/${workspaceId}/invites`, {
    githubLogin: 'dave',
    role: 'viewer',
  });
});

afterAll(async () => {
  await h.close();
});

const SECRET = 'sk-or-v1-0123456789abcdef0123456789abcdef';

describe('the journal and replay', () => {
  it('records agent work in order, masks secrets, and merges what the lanes did', async () => {
    const s = (
      await api(alice, 'POST', `/api/workspaces/${workspaceId}/sessions`, {
        title: 'Journal',
        branch: 'kovan/journal',
      })
    ).body.session;
    await api(alice, 'POST', `/api/sessions/${s.id}/join`, { mode: 'join' });
    const wren = (
      await api(alice, 'POST', `/api/workspaces/${workspaceId}/agents`, {
        name: 'Wren',
        model: 'openai/gpt-5.6-luna',
      })
    ).body.agent;
    const swarm = (
      await api(alice, 'PUT', `/api/sessions/${s.id}/swarm`, {
        goal: 'Add median()',
        leadAgentId: wren.id,
        agentIds: [wren.id],
        budget: 1,
      })
    ).body.swarm;
    await api(alice, 'POST', `/api/swarms/${swarm.id}/launch`);
    const step = (
      await api(alice, 'POST', `/api/sessions/${s.id}/plan/steps`, {
        steps: [{ title: 'Add median()', ownerId: wren.id }],
      })
    ).body.plan.steps[0];
    for (const runState of ['waiting', 'running'])
      await api(alice, 'PATCH', `/api/plan-steps/${step.id}`, { runState });
    await api(alice, 'POST', `/api/swarms/${swarm.id}/report`, {
      agentId: wren.id,
      cost: 0.002,
      stepId: step.id,
    });
    const sub = (
      await api(alice, 'POST', `/api/sessions/${s.id}/subagents`, { task: 'Wren: Add median()' })
    ).body.subagent;
    await api(alice, 'PATCH', `/api/subagents/${sub.id}`, { status: 'checking' });
    await api(alice, 'PATCH', `/api/subagents/${sub.id}`, {
      status: 'failed',
      detail: `npm test failed: OPENROUTER_API_KEY=${SECRET}`,
      checks: [
        { name: 'npm run test', command: 'npm run test', status: 'failed', detail: 'boom', ms: 9 },
      ],
    });
    await api(alice, 'PATCH', `/api/plan-steps/${step.id}`, {
      runState: 'failed',
      runDetail: `npm test failed: OPENROUTER_API_KEY=${SECRET}`,
    });

    // The lane: a model turn with a tool call and a failed one.
    const c = await connect(h, alice.token);
    await c.waitFor((m) => m.type === 'welcome');
    c.send({ type: 'subscribe', workspaceId });
    c.send({ type: 'session.subscribe', sessionId: s.id });
    await c.waitFor<Msg>((m) => m.type === 'session.snapshot');
    c.send({
      type: 'lane.events',
      sessionId: s.id,
      events: [
        { type: 'turn_start', turnId: 't1', model: 'openai/gpt-5.6-luna' },
        { type: 'text', text: 'thinking out loud' },
        { type: 'tool_start', id: 'c1', name: 'run_shell', summary: 'Ran npm test', args: {} },
        { type: 'tool_end', id: 'c1', ok: false, output: `token ${SECRET}` },
        // A skill, and a repository MCP server the person declined: not a failure.
        {
          type: 'tool_start',
          id: 'k1',
          name: 'use_skill',
          summary: 'Used skill release-notes',
          args: { name: 'release-notes' },
        },
        { type: 'tool_end', id: 'k1', ok: true, output: 'Skill "release-notes"' },
        {
          type: 'tool_start',
          id: 'm1',
          name: 'mcp_trust',
          summary: 'Started github from .mcp.json',
          args: { server: 'github', file: '.mcp.json' },
        },
        {
          type: 'approval',
          request: {
            id: 'm1',
            tool: 'mcp_trust',
            kind: 'external',
            title: 'This repository wants to start the MCP server "github"',
            detail: 'Runs npx github-server',
          },
        },
        { type: 'approval_resolved', id: 'm1', approved: false },
        { type: 'tool_end', id: 'm1', ok: false, output: "Didn't start github." },
        { type: 'turn_end', turnId: 't1', reason: 'done', cost: 0.001 },
      ],
    });
    await new Promise((r) => setTimeout(r, 50));
    await h.ctx.sessions.flushAll();
    c.close();

    // A viewer reads the replay; someone outside the workspace can't.
    expect((await api(eve, 'GET', `/api/sessions/${s.id}/replay`)).status).toBe(404);
    const replay = await api(dave, 'GET', `/api/sessions/${s.id}/replay`);
    expect(replay.status).toBe(200);
    const events = replay.body.events as {
      source: string;
      seq: number | null;
      kind: string;
      summary: string;
      detail: string | null;
      refs: Record<string, string>;
      data: Record<string, unknown> | null;
    }[];
    const journal = events.filter((e) => e.source === 'journal');
    // In the order things happened, each with a place in it.
    expect(journal.map((e) => e.seq)).toEqual(
      [...journal.map((e) => e.seq)].sort((a, b) => a! - b!),
    );
    expect(journal.map((e) => e.kind)).toEqual(
      expect.arrayContaining([
        'swarm.configured',
        'activity.swarm_launched',
        'plan.steps_added',
        'task.state',
        'cost',
        'activity.subagent_started',
        'subagent.status',
        'activity.task_failed',
      ]),
    );
    const moves = journal
      .filter((e) => e.kind === 'task.state')
      .map((e) => [e.data!['from'], e.data!['to']]);
    expect(moves).toEqual([
      [null, 'waiting'],
      ['waiting', 'running'],
      ['running', 'failed'],
    ]);
    expect(journal.find((e) => e.kind === 'cost')).toMatchObject({
      refs: { stepId: step.id, swarmId: swarm.id },
      data: { amount: 0.002, stepSpent: 0.002 },
    });
    expect(
      journal.find((e) => e.kind === 'subagent.status' && e.data!['to'] === 'failed')!.data![
        'checks'
      ],
    ).toEqual([{ name: 'npm run test', status: 'failed', detail: 'boom' }]);
    // What the lane did is in the same timeline (its chatter is not).
    const lane = events.filter((e) => e.source === 'lane').map((e) => e.kind);
    expect(lane).toEqual([
      'lane.turn_start',
      'lane.tool',
      'lane.tool_failed',
      'lane.tool',
      'lane.tool',
      'lane.approval',
      'lane.approval_resolved',
      'lane.turn_end',
    ]);
    expect(events.filter((e) => e.kind === 'lane.tool').map((e) => e.summary)).toEqual([
      'Ran npm test',
      'Used skill release-notes',
      'Started github from .mcp.json',
    ]);
    // No secret anywhere.
    expect(JSON.stringify(events)).not.toContain(SECRET);
    expect(JSON.stringify(events)).toContain('[redacted]');

    // The journal is kept as long as transcripts, no longer.
    await h.ctx.db.execute(sql`update journal_events set created_at = now() - interval '91 days'`);
    await h.ctx.sessions.sweepRetention();
    const left = await h.ctx.db.select({ n: sql<number>`count(*)::int` }).from(journalEvents);
    expect(left[0]!.n).toBe(0);
  });
});
