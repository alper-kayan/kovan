import {
  can,
  mayActOnLane,
  swarmBadge,
  type Action,
  type Handoff,
  type Outcome,
  type ServerMessage,
  type Session,
  type SessionApproval,
  type SwarmOutcome,
  type Workspace,
} from '@kovan/shared';
import { locale, t } from './i18n';

/** Everything the phone shows across workspaces, kept current by the server's live messages. */
export interface Board {
  workspaces: Workspace[];
  /** Live sessions per workspace, newest activity first. */
  sessions: Record<string, Session[]>;
  /** Approval cards waiting in live sessions. */
  approvals: SessionApproval[];
  /** Open handoffs and unrecorded outcomes per workspace. */
  flow: Record<string, { handoffs: Handoff[]; outcomes: Outcome[] }>;
}

export const EMPTY_BOARD: Board = { workspaces: [], sessions: {}, approvals: [], flow: {} };

export type SessionState =
  'running' | 'waiting' | 'awaiting' | 'paused' | 'review' | 'idle' | 'ended';

/** A card's state in words, in the app's language. */
export function stateLabel(state: SessionState): string {
  switch (state) {
    case 'running':
      return t('Working');
    case 'waiting':
      return t('Needs a yes');
    case 'awaiting':
      return t('Stopped: someone needs to take over');
    case 'paused':
      return t('Swarm paused');
    case 'review':
      return t('Changes to review');
    case 'idle':
      return t('Nothing running');
    case 'ended':
      return t('Ended');
  }
}

/** The card's one state, the same order of importance as the desktop board. */
export function sessionState(session: Session): SessionState {
  if (session.status === 'ended') return 'ended';
  if (session.participants.some((p) => p.state === 'awaiting')) return 'awaiting';
  if (session.pendingApprovals > 0 || session.taskApprovals.length > 0) return 'waiting';
  // A swarm counts: its tasks run even when no person's lane does.
  if (session.running.length > 0 || session.tasks.running > 0) return 'running';
  if (session.swarm?.status === 'running') return 'running';
  if (session.swarm?.status === 'paused') return 'paused';
  // Quiet, with work done: not the same as nothing happening.
  if (session.touchedFiles.length > 0 && !session.pr) return 'review';
  return 'idle';
}

/** A swarm's badge ("RUNNING", "DONE · 1 FAILED") in the app's language, in capitals. */
export function swarmLabel(swarm: { status: string; outcome?: SwarmOutcome | null }): string {
  const badge = swarmBadge(swarm);
  const o = swarm.outcome;
  const label =
    badge.tone === 'failed' && swarm.status === 'done'
      ? t('Failed')
      : badge.tone === 'partial' && o
        ? t('Done · {n} failed', { n: o.failed + o.blocked })
        : swarm.status === 'draft'
          ? t('Draft')
          : swarm.status === 'running'
            ? t('Running')
            : swarm.status === 'paused'
              ? t('Paused')
              : swarm.status === 'done'
                ? t('Done')
                : swarm.status === 'stopped'
                  ? t('Stopped')
                  : badge.label;
  return label.toLocaleUpperCase(locale());
}

export function ago(iso: string, now = Date.now()): string {
  const minutes = Math.round((now - new Date(iso).getTime()) / 60_000);
  if (minutes < 1) return t('just now');
  if (minutes < 60) return t('{n}m ago', { n: minutes });
  const hours = Math.round(minutes / 60);
  return hours < 48 ? t('{n}h ago', { n: hours }) : t('{n}d ago', { n: Math.round(hours / 24) });
}

/** Money for people: "$0", "< $0.01", "$0.07", "$12.40". */
export const usd = (n: number) => (n <= 0 ? '$0' : n < 0.01 ? '< $0.01' : `$${n.toFixed(2)}`);

/** Every one of the last `n` days, oldest first, with zero where nothing was spent. */
export function lastDays(
  byDay: { day: string; cost: number }[],
  n: number,
  now = new Date(),
): { day: string; cost: number }[] {
  const costs = new Map(byDay.map((d) => [d.day, d.cost]));
  const out: { day: string; cost: number }[] = [];
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - i));
    const day = d.toISOString().slice(0, 10);
    out.push({ day, cost: costs.get(day) ?? 0 });
  }
  return out;
}

export const nameOf = (session: Session | null | undefined, userId: string | null) =>
  session?.participants.find((p) => p.userId === userId)?.name ?? t('Someone');

const approvalKey = (a: SessionApproval) => `${a.sessionId}:${a.laneUserId}:${a.requestId}`;

const byActivity = (a: Session, b: Session) => b.updatedAt.localeCompare(a.updatedAt);

/** Board after one live message; messages the board doesn't show leave it as it was. */
export function applyMessage(board: Board, message: ServerMessage): Board {
  switch (message.type) {
    case 'session': {
      const s = message.session;
      const rest = (board.sessions[s.workspaceId] ?? []).filter((x) => x.id !== s.id);
      const list = s.status === 'active' ? [s, ...rest].sort(byActivity) : rest;
      return {
        ...board,
        sessions: { ...board.sessions, [s.workspaceId]: list },
        // An ended session's cards go with it.
        approvals:
          s.status === 'active'
            ? board.approvals
            : board.approvals.filter((a) => a.sessionId !== s.id),
      };
    }
    case 'approval': {
      const a = message.approval;
      const rest = board.approvals.filter((x) => approvalKey(x) !== approvalKey(a));
      return { ...board, approvals: a.status === 'pending' ? [...rest, a] : rest };
    }
    case 'handoff': {
      const flow = board.flow[message.workspaceId] ?? { handoffs: [], outcomes: [] };
      const h = message.handoff;
      const rest = flow.handoffs.filter((x) => x.id !== h.id);
      const open = h.status === 'requested' || h.status === 'ready';
      return {
        ...board,
        flow: {
          ...board.flow,
          [message.workspaceId]: { ...flow, handoffs: open ? [...rest, h] : rest },
        },
      };
    }
    case 'outcome': {
      const flow = board.flow[message.workspaceId] ?? { handoffs: [], outcomes: [] };
      const o = message.outcome;
      const rest = flow.outcomes.filter((x) => x.id !== o.id);
      return {
        ...board,
        flow: {
          ...board.flow,
          [message.workspaceId]: {
            ...flow,
            outcomes: o.status === 'unknown' ? [...rest, o] : rest,
          },
        },
      };
    }
    case 'workspace':
      return {
        ...board,
        workspaces: board.workspaces.map((w) =>
          w.id === message.workspace.id ? message.workspace : w,
        ),
      };
    case 'membership':
      if (message.role !== null) return board;
      return {
        workspaces: board.workspaces.filter((w) => w.id !== message.workspaceId),
        sessions: omit(board.sessions, message.workspaceId),
        approvals: board.approvals.filter(
          (a) => !board.sessions[message.workspaceId]?.some((s) => s.id === a.sessionId),
        ),
        flow: omit(board.flow, message.workspaceId),
      };
    default:
      return board;
  }
}

function omit<T>(record: Record<string, T>, key: string): Record<string, T> {
  return Object.fromEntries(Object.entries(record).filter(([k]) => k !== key));
}

/** One line of the alert strip: something that waits for a person. */
export type Alert =
  | { kind: 'approval'; key: string; session: Session; approval: SessionApproval }
  | { kind: 'task'; key: string; session: Session; stepId: string; title: string; reason: string }
  | { kind: 'swarm'; key: string; session: Session; reason: string }
  | {
      kind: 'awaiting';
      key: string;
      session: Session;
      userId: string;
      name: string;
      reason: string;
      snapshotAt: string | null;
    }
  | { kind: 'handoff'; key: string; session: Session; handoff: Handoff }
  | { kind: 'outcome'; key: string; session: Session; outcome: Outcome };

/**
 * What needs someone, in the order it matters: approvals hold an agent mid-turn, task approvals
 * and paused swarms hold a swarm, stopped lanes wait for a takeover, then handoffs to this
 * person and actions nobody has recorded.
 */
export function alertsOf(board: Board, userId: string | null, workspaceId?: string): Alert[] {
  const sessions = Object.entries(board.sessions)
    .filter(([id]) => !workspaceId || id === workspaceId)
    .flatMap(([, list]) => list);
  const find = (id: string) => sessions.find((s) => s.id === id);
  // Only what this person can act on: a viewer's "needs you" isn't everyone else's to-do list.
  const wsOf = (s: Session) => board.workspaces.find((w) => w.id === s.workspaceId);
  const may = (s: Session, action: Action) => {
    const role = wsOf(s)?.role;
    return Boolean(role && can(role, action));
  };
  const out: Alert[] = [];
  for (const a of board.approvals) {
    const session = find(a.sessionId);
    if (!session) continue;
    const ws = wsOf(session);
    const lane = session.participants.find((p) => p.userId === a.laneUserId);
    if (
      !mayActOnLane({
        role: ws?.role,
        userId,
        lane: { userId: a.laneUserId, hostId: lane?.hostId ?? null },
        othersAgents: ws?.othersAgents,
        action: 'approval.answer',
      })
    )
      continue;
    out.push({ kind: 'approval', key: `a:${approvalKey(a)}`, session, approval: a });
  }
  for (const session of sessions)
    if (may(session, 'approval.answer'))
      for (const task of session.taskApprovals)
        out.push({ kind: 'task', key: `t:${task.stepId}`, session, ...task });
  for (const session of sessions)
    if (
      may(session, 'agent.steer') &&
      session.swarm?.status === 'paused' &&
      session.swarm.pausedReason
    )
      out.push({
        kind: 'swarm',
        key: `s:${session.id}`,
        session,
        reason: session.swarm.pausedReason,
      });
  for (const session of sessions)
    for (const p of session.participants)
      if (p.state === 'awaiting' && p.userId !== userId && may(session, 'agent.takeover'))
        out.push({
          kind: 'awaiting',
          key: `w:${session.id}:${p.userId}`,
          session,
          userId: p.userId,
          name: p.name,
          reason: (p.awaitingReason ?? t('usage limit')).replace(/\.$/, ''),
          snapshotAt: p.snapshotAt,
        });
  for (const [id, flow] of Object.entries(board.flow)) {
    if (workspaceId && id !== workspaceId) continue;
    for (const h of flow.handoffs) {
      const session = find(h.sessionId);
      if (session && h.toUserId === userId && h.kind === 'handoff' && h.status === 'ready')
        out.push({ kind: 'handoff', key: `h:${h.id}`, session, handoff: h });
    }
    for (const o of flow.outcomes) {
      const session = find(o.sessionId);
      if (session && may(session, 'approval.answer'))
        out.push({ kind: 'outcome', key: `o:${o.id}`, session, outcome: o });
    }
  }
  return out;
}

const HARNESS_NAMES: Record<string, string> = {
  kovan: 'Kovan',
  'claude-code': 'Claude Code',
  codex: 'Codex',
};

export const harnessName = (harness: string | null) =>
  harness ? (HARNESS_NAMES[harness] ?? harness) : null;

/** The agents at work in a session ("Kovan · Claude Code"), each named once. */
export function harnessLine(session: Session): string {
  const names = new Set(
    session.participants
      .filter((p) => p.mode === 'join' && p.harness)
      .map((p) => harnessName(p.harness)!),
  );
  return [...names].join(' · ');
}

/**
 * The branch a new session gets, as the desktop names it: "kovan/" and the title's words, with
 * "-2", "-3"… when a live session already works on that branch (they would share a checkout).
 */
export function branchFor(title: string, taken: Iterable<string | null> = []): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40);
  if (!slug) return '';
  const used = new Set(taken);
  let branch = `kovan/${slug}`;
  for (let n = 2; used.has(branch); n++) branch = `kovan/${slug}-${n}`;
  return branch;
}
