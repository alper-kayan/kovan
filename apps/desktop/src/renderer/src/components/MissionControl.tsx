import { can, swarmBadge, type Session, type Workspace } from '@kovan/shared';
import { t } from '../i18n';
import { DialogKeys } from './DialogKeys';
import {
  ArrowUpDown,
  Check,
  ChevronsUpDown,
  CircleHelp,
  Eye,
  FileCode2,
  Hand,
  Layers,
  Plus,
  Radio,
  Search,
  X,
} from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { addWorkspace, signIn, useOrgWorkspaces } from '../services/team';
import {
  answerTeamApproval,
  harnessLine,
  loadHistory,
  nameOf,
  openNewSession,
  openSession,
  sessionState,
  startSession,
} from '../services/sessions';
import { setState, useStore } from '../store';

/**
 * Why no session can be started from here, and the way to one: an account, a shared
 * workspace, or the Editor role. Working alone needs none of it: the agent chat does.
 */
function NoSessionYet({
  workspaces,
  close,
}: {
  workspaces: { name: string; role: string }[];
  close: () => void;
}) {
  const signedIn = useStore((s) => s.signedIn);
  const alone = (
    <p className="setting-desc">
      Working alone? You don't need a session: give your agent a task in the chat on the right.
    </p>
  );
  if (!signedIn)
    return (
      <>
        <p className="setting-desc">
          A session is a task you share with teammates: everyone's agents work side by side on one
          branch, and you see each other's work live. Sessions need an account.
        </p>
        <button
          type="button"
          className="btn btn-primary"
          onClick={() => {
            close();
            void signIn('login');
          }}
        >
          Sign in
        </button>
        {alone}
      </>
    );
  if (workspaces.length === 0)
    return (
      <>
        <p className="setting-desc">
          Sessions live in a shared workspace: a repository your team works on together. Share a
          folder to make one; then you can start a session in it and invite people.
        </p>
        <button
          type="button"
          className="btn btn-primary"
          onClick={() => {
            close();
            void addWorkspace();
          }}
        >
          Share a folder
        </button>
        {alone}
      </>
    );
  return (
    <>
      <p className="setting-desc">
        In {workspaces.map((w) => w.name).join(', ')} your role lets you watch sessions and comment,
        not start them. Ask an owner of the workspace to make you an Editor.
      </p>
      {alone}
    </>
  );
}
import { acceptHandoff, declineHandoff, recordOutcome, takeOverLane } from '../services/flow';
import { answerStepApproval } from '../services/collab';
import { formatCost } from './AgentPanel';
import { KovanMark } from './Logo';
import { PageHeader } from './PageHeader';
import { AvatarStack, EmptyState, Segmented } from './ui';

/** The same words as the phone: what's going on, not the state machine's names. */
const STATE_LABEL = {
  running: 'Working',
  waiting: 'Needs a yes',
  awaiting: 'Stopped: someone needs to take over',
  idle: 'Nothing running',
  ended: 'Ended',
} as const;

function ago(iso: string): string {
  const minutes = Math.round((Date.now() - new Date(iso).getTime()) / 60_000);
  if (minutes < 1) return t('just now');
  if (minutes < 60) return t('{n}m ago', { n: minutes });
  const hours = Math.round(minutes / 60);
  return hours < 48 ? t('{n}h ago', { n: hours }) : t('{n}d ago', { n: Math.round(hours / 24) });
}

/** The card's swarm line: its state, its tasks by state, and spend against the budget. */
function SwarmLine({ session }: { session: Session }) {
  const swarm = session.swarm!;
  const t = session.tasks;
  const parts = [
    t.running && `${t.running} running`,
    t.waiting && `${t.waiting} waiting`,
    session.taskApprovals.length && `${session.taskApprovals.length} need approval`,
    t.done && `${t.done} done`,
    t.failed && `${t.failed} failed`,
    t.blocked && `${t.blocked} blocked`,
  ].filter(Boolean);
  const share = swarm.budget ? Math.min(100, (swarm.spent / swarm.budget) * 100) : 0;
  return (
    <div className="session-card-swarm" title={swarm.pausedReason ?? undefined}>
      <div className="small">
        <span className={`swarm-status ${swarmBadge(swarm).tone}`}>
          {swarmBadge(swarm).label.toUpperCase()}
        </span>{' '}
        <span className={t.failed || t.blocked ? 'swarm-line-bad' : 'muted'}>
          {parts.join(' · ') || 'no tasks yet'}
        </span>
      </div>
      <div className="session-card-plan">
        <div className={`plan-bar ${share >= 100 ? 'full' : ''}`}>
          <span style={{ width: `${share}%` }} />
        </div>
        <span className="muted small mono">
          {formatCost(swarm.spent)}
          {swarm.budget !== null ? ` / ${formatCost(swarm.budget)}` : ''}
        </span>
      </div>
    </div>
  );
}

function SessionCard({ session }: { session: Session }) {
  const state = sessionState(session);
  const sponsors = session.running.map((r) => nameOf(session, r.userId));
  const joined = session.participants.filter((p) => p.mode === 'join');
  const watching = session.participants.filter((p) => p.mode === 'watch');
  return (
    <button className="session-card" onClick={() => void openSession(session.id)}>
      <div className="session-card-title">{session.title}</div>
      <div className={`session-status state-${state}`}>
        <Radio size={11} /> {STATE_LABEL[state]}
        {sponsors.length > 0 && (
          <span className="muted">
            {' '}
            · on {sponsors.map((n) => `${n}'s`).join(', ')} account{sponsors.length > 1 ? 's' : ''}
          </span>
        )}
      </div>
      <div className="session-card-meta mono">
        {harnessLine(session) || t('no agents yet')}
        {session.branch ? ` · ${session.branch}` : ''}
      </div>
      {session.plan.total > 0 && (
        <div className="session-card-plan" title="Plan progress">
          <div className="plan-bar">
            <span style={{ width: `${(session.plan.done / session.plan.total) * 100}%` }} />
          </div>
          <span className="muted small mono">
            {session.plan.done}/{session.plan.total}
          </span>
        </div>
      )}
      {session.swarm && <SwarmLine session={session} />}
      {session.touchedFiles.length > 0 && (
        <div className="session-card-files mono">
          <FileCode2 size={11} /> {session.touchedFiles.slice(0, 2).join(', ')}
          {session.touchedFiles.length > 2 ? ` +${session.touchedFiles.length - 2}` : ''}
        </div>
      )}
      <div className="session-card-foot">
        <AvatarStack people={joined} size={20} />
        {watching.length > 0 && (
          <span className="muted small" title={watching.map((w) => w.name).join(', ')}>
            <Eye size={12} /> {watching.length}
          </span>
        )}
        <span className="spacer" />
        <span className="muted small mono">
          {session.cost > 0 ? `${formatCost(session.cost)} · ` : ''}
          {ago(
            session.status === 'ended' ? (session.endedAt ?? session.updatedAt) : session.updatedAt,
          )}
        </span>
      </div>
    </button>
  );
}

/** Only what needs someone: approval cards waiting in live sessions. One click answers. */
function Alerts({ sessions }: { sessions: Session[] }) {
  const approvals = useStore((s) => s.approvals);
  const workspaces = useStore((s) => s.teamWorkspaces);
  const userId = useStore((s) => s.user?.id);
  const flow = useStore((s) => s.flow);
  const handoffs = Object.values(flow)
    .flatMap((f) => f.handoffs)
    .filter((h) => h.toUserId === userId && h.kind === 'handoff' && h.status === 'ready');
  const outcomes = Object.values(flow).flatMap((f) => f.outcomes);
  // Lanes whose agent stopped (a usage limit) and wait for someone to take over.
  const awaiting = sessions.flatMap((s) =>
    s.participants
      .filter((p) => p.state === 'awaiting' && p.userId !== userId)
      .map((p) => ({ session: s, p })),
  );
  // Tasks a swarm won't start without a yes, and swarms that stopped themselves (budget, limit).
  const taskAsks = sessions.flatMap((s) => s.taskApprovals.map((a) => ({ session: s, a })));
  const pausedSwarms = sessions.filter(
    (s) => s.swarm?.status === 'paused' && s.swarm.pausedReason && s.status === 'active',
  );
  if (
    approvals.length +
      handoffs.length +
      outcomes.length +
      awaiting.length +
      taskAsks.length +
      pausedSwarms.length ===
    0
  )
    return null;
  const sessionOf = (a: { sessionId: string }) =>
    sessions.find((s) => s.id === a.sessionId) ?? null;
  const nameIn = (sessionId: string, id: string) => nameOf(sessionOf({ sessionId }), id);
  return (
    <div className="alerts">
      {taskAsks.map(({ session, a }) => {
        const role = workspaces.find((w) => w.id === session.workspaceId)?.role;
        const mayAnswer = Boolean(role && can(role, 'approval.answer'));
        return (
          <div key={`t:${a.stepId}`} className="alert">
            <CircleHelp size={14} className="alert-icon" />
            <div className="alert-text">
              <div>
                A swarm task needs a yes: <b>{a.title}</b>
              </div>
              <div className="muted small">
                {a.reason} · {session.title}
              </div>
            </div>
            {mayAnswer && (
              <>
                <button
                  className="btn btn-primary btn-sm"
                  onClick={() => void answerStepApproval(a.stepId, true)}
                >
                  <Check size={13} /> Approve
                </button>
                <button
                  className="btn btn-sm"
                  onClick={() => void answerStepApproval(a.stepId, false)}
                >
                  <X size={13} /> Reject
                </button>
              </>
            )}
            <button className="btn btn-ghost btn-sm" onClick={() => void openSession(session.id)}>
              Open
            </button>
          </div>
        );
      })}
      {pausedSwarms.map((s) => (
        <div key={`sw:${s.id}`} className="alert alert-danger">
          <Hand size={14} className="alert-icon" />
          <div className="alert-text">
            <div>A swarm paused itself: {s.swarm!.pausedReason}</div>
            <div className="muted small">
              {s.title} · raise the budget and resume, or stop it, in the session
            </div>
          </div>
          <button className="btn btn-sm btn-primary" onClick={() => void openSession(s.id)}>
            Open
          </button>
        </div>
      ))}
      {awaiting.map(({ session, p }) => (
        <div key={`aw:${session.id}:${p.userId}`} className="alert alert-danger">
          <Hand size={14} className="alert-icon" />
          <div className="alert-text">
            <div>
              <b>{p.name}'s</b> agent stopped:{' '}
              {(p.awaitingReason ?? 'usage limit').replace(/\.$/, '')}. Someone needs to take over.
            </div>
            <div className="muted small">
              {session.title} ·{' '}
              {p.snapshotAt ? `last checkpoint ${ago(p.snapshotAt)}` : 'no checkpoint yet'}
            </div>
          </div>
          <button
            className="btn btn-primary btn-sm"
            onClick={() => void takeOverLane(session.id, p.userId, p.name)}
          >
            Take over
          </button>
          <button className="btn btn-ghost btn-sm" onClick={() => void openSession(session.id)}>
            Open
          </button>
        </div>
      ))}
      {handoffs.map((h) => (
        <div key={`h:${h.id}`} className="alert">
          <Hand size={14} className="alert-icon" />
          <div className="alert-text">
            <div>
              <b>{nameIn(h.sessionId, h.fromUserId)}</b> handed you their work.
            </div>
            <div className="muted small">
              {sessionOf(h)?.title} · {h.context?.reason}
              {h.snapshotAt ? ` · snapshot ${ago(h.snapshotAt)}` : ''}
            </div>
          </div>
          <button className="btn btn-primary btn-sm" onClick={() => void acceptHandoff(h)}>
            Pick it up
          </button>
          <button className="btn btn-sm" onClick={() => void declineHandoff(h)}>
            Decline
          </button>
        </div>
      ))}
      {outcomes.map((o) => (
        <div key={`o:${o.id}`} className="alert alert-danger">
          <CircleHelp size={14} className="alert-icon" />
          <div className="alert-text">
            <div>
              Outcome unknown: <span className="mono">{o.command}</span>
            </div>
            <div className="muted small">
              {nameIn(o.sessionId, o.laneUserId)}'s agent was cut off mid-flight. It won't be
              retried; what happened?
            </div>
          </div>
          <button className="btn btn-sm" onClick={() => void recordOutcome(o, 'succeeded')}>
            It went through
          </button>
          <button className="btn btn-sm" onClick={() => void recordOutcome(o, 'failed')}>
            It failed
          </button>
          <button className="btn btn-sm" onClick={() => void recordOutcome(o, 'not_run')}>
            Didn't run
          </button>
        </div>
      ))}
      {approvals.map((a) => {
        const session = sessionOf(a);
        const role = workspaces.find((w) => w.id === session?.workspaceId)?.role;
        const mayAnswer = Boolean(role && can(role, 'approval.answer'));
        return (
          <div key={`${a.sessionId}:${a.laneUserId}:${a.requestId}`} className="alert">
            <CircleHelp size={14} className="alert-icon" />
            <div className="alert-text">
              <div>
                <b>{a.laneUserId === userId ? 'Your' : `${nameOf(session, a.laneUserId)}'s`}</b>{' '}
                agent asks: {a.title}
              </div>
              <div className="alert-detail mono">{a.detail.split('\n')[0]}</div>
              <div className="muted small">{session?.title}</div>
            </div>
            {mayAnswer && (
              <>
                <button
                  className="btn btn-primary btn-sm"
                  onClick={() =>
                    void answerTeamApproval(a.sessionId, a.laneUserId, a.requestId, true)
                  }
                >
                  <Check size={13} /> Approve
                </button>
                <button
                  className="btn btn-sm"
                  onClick={() =>
                    void answerTeamApproval(a.sessionId, a.laneUserId, a.requestId, false)
                  }
                >
                  <X size={13} /> Deny
                </button>
              </>
            )}
            <button className="btn btn-ghost btn-sm" onClick={() => void openSession(a.sessionId)}>
              Open
            </button>
          </div>
        );
      })}
    </div>
  );
}

/**
 * What a session sends to the team's Git remote, said before it starts: the branch, and each
 * person's checkpoints (uncommitted edits too) on hidden refs, while Git sync is on.
 */
function WhatGoesOut({ workspace, branch }: { workspace: Workspace; branch: string | null }) {
  const remote = workspace.repoUrl ? workspace.repoUrl.replace(/^https?:\/\/|\.git$/g, '') : null;
  const where = remote ?? t("the folder's Git remote (if it has one)");
  return (
    <p className="small muted what-goes-out">
      {branch
        ? `${t(
            'The branch {branch} is pushed to {where} so teammates start from the same commit.',
            {
              branch,
              where,
            },
          )} `
        : null}
      {workspace.autoGitSync
        ? t(
            "While it runs, everyone's work in it (uncommitted edits too) is saved to {where} as hidden checkpoints, so teammates see it and can take it over. Turn this off with Git sync in Settings → Workspaces.",
            { where },
          )
        : t(
            "Git sync is off in this workspace: work stays on each person's machine until they push it.",
          )}
    </p>
  );
}

function NewSessionDialog() {
  const open = useStore((s) => s.newSessionOpen);
  const workspaces = useOrgWorkspaces();
  const bindings = useStore((s) => s.bindings);
  const current = useStore((s) => s.workspace?.root);
  const startable = workspaces.filter((w) => can(w.role, 'session.start'));
  const preferred =
    startable.find((w) => bindings[w.id] && bindings[w.id] === current) ??
    startable.find((w) => bindings[w.id]) ??
    startable[0];
  const [workspaceId, setWorkspaceId] = useState('');
  const [title, setTitle] = useState('');
  const [branchMode, setBranchMode] = useState<'new' | 'current'>('new');
  const [busy, setBusy] = useState(false);
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40);
  const [branch, setBranch] = useState('');
  useEffect(() => {
    if (open) {
      setWorkspaceId(preferred?.id ?? '');
      setTitle('');
      setBranch('');
      setBranchMode('new');
    }
    // Only when the dialog opens.
  }, [open]);
  if (!open) return null;
  const ws = workspaces.find((w) => w.id === workspaceId);
  const branchName = branch || (slug ? `kovan/${slug}` : '');
  const close = () => setState({ newSessionOpen: false });

  return (
    <div className="overlay modal-overlay" onMouseDown={close}>
      <form
        className="modal dialog"
        onMouseDown={(e) => e.stopPropagation()}
        onSubmit={(e) => {
          e.preventDefault();
          if (!ws || !title.trim()) return;
          setBusy(true);
          void startSession({
            workspace: ws,
            title: title.trim(),
            newBranch: branchMode === 'new' ? branchName : null,
          }).then((ok) => {
            setBusy(false);
            if (ok) close();
          });
        }}
      >
        <DialogKeys onClose={close} />
        <div className="modal-head">
          <h2 className="modal-title">New session</h2>
          <p className="modal-desc">
            One task, one branch. Teammates join with their own agents in lanes side by side.
          </p>
          <button type="button" className="icon-btn modal-close" title="Close" onClick={close}>
            <X size={15} />
          </button>
        </div>
        <div className="dialog-body">
          {startable.length === 0 ? (
            <NoSessionYet workspaces={workspaces} close={close} />
          ) : (
            <>
              <label className="field-label">
                Workspace
                <select
                  className="select"
                  value={workspaceId}
                  onChange={(e) => setWorkspaceId(e.target.value)}
                >
                  {startable.map((w) => (
                    <option key={w.id} value={w.id}>
                      {w.name}
                      {bindings[w.id] ? '' : ' (not set up on this machine)'}
                    </option>
                  ))}
                </select>
              </label>
              <label className="field-label">
                Task
                <input
                  className="input"
                  autoFocus
                  placeholder="Fix the lobby join race"
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  maxLength={120}
                />
              </label>
              <div className="field-label">
                Branch
                <Segmented
                  value={branchMode}
                  options={[
                    { value: 'new', label: 'New branch' },
                    { value: 'current', label: 'Current branch' },
                  ]}
                  onChange={setBranchMode}
                />
                {branchMode === 'new' && (
                  <input
                    className="input mono"
                    placeholder="kovan/your-task"
                    value={branchName}
                    onChange={(e) => setBranch(e.target.value)}
                  />
                )}
              </div>
              {ws && (
                <WhatGoesOut workspace={ws} branch={branchMode === 'new' ? branchName : null} />
              )}
            </>
          )}
        </div>
        <div className="dialog-foot">
          <button type="button" className="btn" onClick={close}>
            Cancel
          </button>
          {startable.length > 0 && (
            <button
              type="submit"
              className="btn btn-primary"
              disabled={
                busy || !ws || !title.trim() || (branchMode === 'new' && !branchName.trim())
              }
            >
              {busy ? 'Starting…' : 'Start session'}
            </button>
          )}
        </div>
      </form>
    </div>
  );
}

export function MissionControlPage() {
  const signedIn = useStore((s) => s.signedIn);
  const workspaces = useOrgWorkspaces();
  // Someone in several organizations sees one at a time (the sidebar's switcher).
  const multiOrg = useStore((s) => s.orgs.length > 1);
  const recent = useStore((s) => s.recent.length);
  const all = useStore((s) => s.sessions);
  const history = useStore((s) => s.history);
  const filter = useStore((s) => s.boardWorkspace);
  const tab = useStore((s) => s.boardTab);
  const [query, setQuery] = useState('');
  const [searching, setSearching] = useState(false);

  useEffect(() => {
    if (tab === 'history') void loadHistory();
  }, [tab]);

  const live = useMemo(() => Object.values(all).flat(), [all]);
  const shown = useMemo(() => {
    const source = tab === 'active' ? all : history;
    const inOrg = new Set(workspaces.map((w) => w.id));
    return Object.entries(source)
      .filter(([id]) => (filter ? id === filter : !multiOrg || inOrg.has(id)))
      .flatMap(([, list]) => list)
      .filter((s) => !query || s.title.toLowerCase().includes(query.toLowerCase()))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }, [tab, all, history, filter, query, workspaces, multiOrg]);

  const filterName = filter ? workspaces.find((w) => w.id === filter)?.name : null;
  // Filters, sorting and search over nothing are noise: they come with the first session.
  const any =
    Object.values(all).some((l) => l.length > 0) ||
    Object.values(history).some((l) => l.length > 0) ||
    Boolean(filter || query);
  const cycleFilter = () => {
    const ids = [null, ...workspaces.map((w) => w.id)];
    setState({ boardWorkspace: ids[(ids.indexOf(filter) + 1) % ids.length] ?? null });
  };

  return (
    <section className="page">
      <PageHeader title="Sessions">
        <Segmented
          value={tab}
          options={[
            { value: 'active', label: 'Live' },
            { value: 'history', label: 'History' },
          ]}
          onChange={(boardTab) => setState({ boardTab })}
        />
        {any && (
          <button className="filter" onClick={cycleFilter} title="Filter by workspace">
            <Layers size={13} />
            {filterName ?? t('All workspaces ({n})', { n: signedIn ? workspaces.length : recent })}
            <ChevronsUpDown size={12} />
          </button>
        )}
        {any && (
          <span className="filter" title="Sorted by last activity">
            <ArrowUpDown size={13} />
            Last active first
          </span>
        )}
        {!any ? null : searching ? (
          <input
            className="input board-search"
            autoFocus
            placeholder="Search sessions"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onBlur={() => !query && setSearching(false)}
          />
        ) : (
          <button
            className="icon-btn icon-btn-outline"
            title="Search sessions"
            onClick={() => setSearching(true)}
          >
            <Search size={14} />
          </button>
        )}
        <button className="btn btn-primary" onClick={openNewSession}>
          <Plus size={14} /> New session
        </button>
      </PageHeader>
      {tab === 'active' && <Alerts sessions={live} />}
      {shown.length > 0 ? (
        <div className="board">
          {shown.map((s) => (
            <SessionCard key={s.id} session={s} />
          ))}
        </div>
      ) : (
        <EmptyState
          icon={<KovanMark size={46} strokeWidth={1.1} />}
          title={tab === 'active' ? 'No sessions here yet' : 'No finished sessions yet'}
        >
          <p className="empty-text">
            {tab === 'active'
              ? 'A session is one task your team works on together. Teammates join with their own AI agents, and everyone sees what each agent does as it happens.'
              : 'Ended sessions land here with their transcript and final diff.'}
          </p>
          {tab === 'active' &&
            (signedIn && workspaces.length === 0 ? (
              <button className="btn btn-primary btn-sm" onClick={() => void addWorkspace()}>
                Add a workspace
              </button>
            ) : (
              <button className="btn btn-primary btn-sm" onClick={openNewSession}>
                New session
              </button>
            ))}
        </EmptyState>
      )}
      <NewSessionDialog />
    </section>
  );
}
