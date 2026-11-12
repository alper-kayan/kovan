import type { Participant, Session, SessionApproval, Workspace } from '@kovan/shared';
import { describe, expect, it } from 'vitest';
import {
  alertsOf,
  applyMessage,
  branchFor,
  EMPTY_BOARD,
  lastDays,
  sessionState,
  type Board,
} from './board';

const person = (userId: string, name: string, extra: Partial<Participant> = {}): Participant => ({
  userId,
  name,
  avatarUrl: null,
  mode: 'join',
  harness: 'kovan',
  model: null,
  state: 'idle',
  joinedAt: '2026-10-15T08:00:00Z',
  awaitingReason: null,
  snapshotAt: null,
  snapshotSha: null,
  snapshotRef: null,
  paused: null,
  kind: 'human',
  hostId: null,
  hostName: null,
  ...extra,
});

const session = (id: string, extra: Partial<Session> = {}): Session => ({
  id,
  workspaceId: 'w1',
  title: `Session ${id}`,
  branch: null,
  status: 'active',
  createdBy: 'alice',
  createdAt: '2026-10-15T08:00:00Z',
  updatedAt: '2026-10-15T08:00:00Z',
  endedAt: null,
  participants: [person('alice', 'Alice')],
  touchedFiles: [],
  running: [],
  pendingApprovals: 0,
  cost: 0,
  plan: { done: 0, total: 0 },
  tasks: { waiting: 0, running: 0, done: 0, failed: 0, blocked: 0, cancelled: 0 },
  taskApprovals: [],
  locks: [],
  unknownOutcomes: 0,
  subagents: 0,
  swarm: null,
  pr: null,
  issue: null,
  machine: null,
  worktreePath: null,
  ...extra,
});

const approval = (status: SessionApproval['status']): SessionApproval => ({
  sessionId: 's1',
  laneUserId: 'bob',
  requestId: 'r1',
  tool: 'bash',
  kind: 'command',
  title: 'Run a command',
  detail: 'npm test',
  status,
  answeredBy: null,
  answeredByName: null,
  createdAt: '2026-10-15T08:00:00Z',
});

const withSessions = (...list: Session[]): Board => ({
  ...EMPTY_BOARD,
  sessions: { w1: list },
});

describe('the board', () => {
  it('names one state per session, the most pressing first', () => {
    expect(sessionState(session('a'))).toBe('idle');
    expect(sessionState(session('a', { running: [{ userId: 'alice', model: null }] }))).toBe(
      'running',
    );
    expect(
      sessionState(
        session('a', { running: [{ userId: 'alice', model: null }], pendingApprovals: 1 }),
      ),
    ).toBe('waiting');
    expect(
      sessionState(
        session('a', {
          pendingApprovals: 1,
          participants: [person('bob', 'Bob', { state: 'awaiting' })],
        }),
      ),
    ).toBe('awaiting');
    expect(sessionState(session('a', { status: 'ended' }))).toBe('ended');
    // A swarm's tasks count, and a quiet session with changes isn't "nothing happening".
    const swarm = (status: string) => ({
      id: 's',
      status,
      spent: 0,
      budget: null,
      pausedReason: null,
      launchedBy: null,
      outcome: null,
    });
    expect(sessionState(session('a', { swarm: swarm('running') }))).toBe('running');
    expect(sessionState(session('a', { swarm: swarm('paused') }))).toBe('paused');
    expect(sessionState(session('a', { touchedFiles: ['src/cart.js'] }))).toBe('review');
  });

  it('keeps live sessions newest first and drops ended ones with their approvals', () => {
    let board = withSessions(session('s1', { updatedAt: '2026-10-15T08:00:00Z' }));
    board = applyMessage(board, { type: 'approval', approval: approval('pending') });
    board = applyMessage(board, {
      type: 'session',
      session: session('s2', { updatedAt: '2026-10-15T09:00:00Z' }),
    });
    expect(board.sessions['w1']!.map((s) => s.id)).toEqual(['s2', 's1']);
    expect(board.approvals).toHaveLength(1);

    board = applyMessage(board, { type: 'session', session: session('s1', { status: 'ended' }) });
    expect(board.sessions['w1']!.map((s) => s.id)).toEqual(['s2']);
    expect(board.approvals).toHaveLength(0);
  });

  it('removes an approval card once anyone answers it', () => {
    let board = applyMessage(withSessions(session('s1')), {
      type: 'approval',
      approval: approval('pending'),
    });
    // The same card again replaces it rather than doubling it.
    board = applyMessage(board, { type: 'approval', approval: approval('pending') });
    expect(board.approvals).toHaveLength(1);
    board = applyMessage(board, { type: 'approval', approval: approval('approved') });
    expect(board.approvals).toHaveLength(0);
  });

  it('forgets a workspace the person was removed from', () => {
    let board: Board = {
      ...withSessions(session('s1')),
      workspaces: [
        {
          id: 'w1',
          orgId: 'o',
          name: 'w',
          repoUrl: null,
          defaultBranch: 'main',
          color: null,
          autoGitSync: false,
          gitSyncChangedBy: null,
          gitSyncChangedAt: null,
          agentMonthlyLimit: null,
          othersAgents: 'owners',
          recommendedPlugins: [],
          mode: 'team',
          role: 'editor',
        },
      ],
      approvals: [approval('pending')],
    };
    board = applyMessage(board, { type: 'membership', workspaceId: 'w1', role: null });
    expect(board).toEqual(EMPTY_BOARD);
  });

  it('lists what waits for someone, and only handoffs meant for this person', () => {
    const s1 = session('s1', {
      participants: [
        person('alice', 'Alice', { state: 'awaiting', awaitingReason: 'usage limit.' }),
        person('bob', 'Bob', { state: 'awaiting', awaitingReason: 'Weekly limit reached.' }),
      ],
      taskApprovals: [{ stepId: 'p1', title: 'Add a migration', reason: 'touches the database' }],
      swarm: {
        id: 'sw',
        outcome: null,
        status: 'paused',
        spent: 1,
        budget: 1,
        pausedReason: 'Budget reached',
        launchedBy: 'alice',
      },
    });
    const handoff = (id: string, toUserId: string, status: 'ready' | 'requested') => ({
      id,
      sessionId: 's1',
      kind: 'handoff' as const,
      fromUserId: 'bob',
      toUserId,
      status,
      snapshotSha: null,
      snapshotRef: null,
      snapshotAt: null,
      context: null,
      createdAt: '2026-10-15T08:00:00Z',
    });
    const ws = (role: Workspace['role']): Workspace => ({
      id: 'w1',
      orgId: 'o',
      name: 'w',
      repoUrl: null,
      defaultBranch: 'main',
      color: null,
      autoGitSync: false,
      gitSyncChangedBy: null,
      gitSyncChangedAt: null,
      agentMonthlyLimit: null,
      othersAgents: 'owners',
      recommendedPlugins: [],
      mode: 'team',
      role,
    });
    const board: Board = {
      ...withSessions(s1),
      workspaces: [ws('owner')],
      approvals: [approval('pending')],
      flow: {
        w1: {
          handoffs: [
            handoff('h1', 'alice', 'ready'),
            handoff('h2', 'carol', 'ready'),
            handoff('h3', 'alice', 'requested'),
          ],
          outcomes: [],
        },
      },
    };
    const alerts = alertsOf(board, 'alice');
    expect(alerts.map((a) => a.kind)).toEqual(['approval', 'task', 'swarm', 'awaiting', 'handoff']);
    // Your own stopped lane isn't yours to take over.
    expect(alerts.find((a) => a.kind === 'awaiting')).toMatchObject({
      name: 'Bob',
      reason: 'Weekly limit reached',
    });
    expect(alertsOf(board, 'alice', 'other')).toEqual([]);
    // A viewer is asked for nothing it can't do: only what was handed to them.
    expect(alertsOf({ ...board, workspaces: [ws('viewer')] }, 'alice').map((a) => a.kind)).toEqual([
      'handoff',
    ]);
    // An editor answers for Bob's agent only where the workspace lets editors do it.
    const editor = { ...board, workspaces: [ws('editor')] };
    expect(alertsOf(editor, 'alice').some((a) => a.kind === 'approval')).toBe(false);
    expect(
      alertsOf(
        { ...editor, workspaces: [{ ...ws('editor'), othersAgents: 'editors' }] },
        'alice',
      ).some((a) => a.kind === 'approval'),
    ).toBe(true);
  });
});

describe('a new session’s branch', () => {
  it('is named like the desktop names it', () => {
    expect(branchFor('Stats helpers: median & mode!')).toBe('kovan/stats-helpers-median-mode');
    expect(branchFor('  ')).toBe('');
  });
  it('does not reuse a branch a live session works on', () => {
    expect(branchFor('Stats', ['kovan/stats', 'kovan/stats-2', null])).toBe('kovan/stats-3');
  });
});

describe('lastDays', () => {
  it('fills every day of the window, oldest first', () => {
    const days = lastDays(
      [
        { day: '2026-10-14', cost: 0.5 },
        { day: '2026-09-01', cost: 9 },
      ],
      3,
      new Date('2026-10-16T08:00:00Z'),
    );
    expect(days).toEqual([
      { day: '2026-10-14', cost: 0.5 },
      { day: '2026-10-15', cost: 0 },
      { day: '2026-10-16', cost: 0 },
    ]);
  });
});
