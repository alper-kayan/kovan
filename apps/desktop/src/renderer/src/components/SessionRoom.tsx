import { can, type LaneEvent, type Participant, type Session } from '@kovan/shared';
import {
  ArrowLeft,
  CircleAlert,
  Eye,
  ArrowUp,
  ChevronRight,
  FileCode2,
  Gauge,
  GitBranch,
  Hand,
  History,
  ListPlus,
  Lock,
  X,
  ListChecks,
  MessageSquare,
  LogIn,
  LogOut,
  Square,
  Users,
  Workflow,
  Bot,
  Hexagon,
} from 'lucide-react';
import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  foldEvents,
  HARNESS_NAMES,
  JEV_MODEL_ID,
  type ConversationEvent,
  type Harness,
} from '../../../shared/agent';
import { answerApproval } from '../services/agent';
import {
  answerTeamApproval,
  closeSession,
  endSession,
  fixBlocker,
  joinSession,
  leaveSession,
  openSession,
  openSessionCheckout,
  sessionState,
  watchSession,
} from '../services/sessions';
import { readLocal, setState, showView, useStore, writeLocal } from '../store';
import { Chat, Composer, formatCost, type ApprovalHandler } from './AgentPanel';
import { SessionComments, TranscriptThread } from './Comments';
import { handOff, lockPath, steer, takeOverLane, unlockPath } from '../services/flow';
import { discardSubagent, retrySubagent, startSubagent, subagentPath } from '../services/sync';
import { openWorkspace } from '../services/workspace';
import { suggestTeam } from '@kovan/jevrouter';
import { ReplayView } from './ReplayView';
import { SwarmRoom } from './SwarmRoom';
import { SessionFiles } from '../fileOpener';
import { TaskGraph } from './TaskGraph';
import { loadMachines, workspaceMode } from '../services/team';
import { machineOptions, machineWorker } from '../machineChoice';
import {
  taskCostAt,
  type AgentSpendStats,
  type Machine,
  type Subagent,
  type Swarm,
} from '@kovan/shared';
import {
  addAiToSession,
  controlAgent,
  launchSwarm,
  loadAgentSpend,
  loadCatalogPrices,
  saveSwarm,
  sendSwarmMessage,
  setSwarmStatus,
} from '../services/swarm';
import { PlanPanel } from './PlanPanel';
import { Avatar } from './ui';

// Stable empty values: a selector returning a fresh [] or {} re-renders forever.
const NONE_LIST: never[] = [];
const NONE_MAP: Record<string, never> = {};

const STATE_LABEL = {
  running: 'Running',
  waiting: 'Needs approval',
  awaiting: 'Awaiting takeover',
  idle: 'Idle',
  ended: 'Ended',
} as const;

function agentLine(p: Participant): string {
  const harness = p.harness ? (HARNESS_NAMES[p.harness as Harness] ?? p.harness) : 'Agent';
  // CLI lanes report "claude-code · claude-haiku-5-5"; the harness is already named.
  const model =
    p.model === JEV_MODEL_ID
      ? 'JevRouter'
      : (p.model
          ?.replace(/^(claude-code|codex) · /, '')
          .replace(/^claude-(?=opus|sonnet|haiku)/, '') ?? null);
  return model && model !== 'default' ? `${harness} · ${model}` : harness;
}

/** Keeps a scroller pinned to the newest output unless the reader scrolled up. */
function useStick(dep: unknown) {
  const ref = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  useLayoutEffect(() => {
    const el = ref.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [dep]);
  const onScroll = (e: React.UIEvent<HTMLDivElement>) => {
    const el = e.currentTarget;
    stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
  };
  return { ref, onScroll };
}

const RAIL_WIDTH = 270;

/**
 * A drag handle between two columns. It resizes the column before it (a lane) or after it (the
 * rail), from that column's width when the drag began; a double click resets it.
 */
function Splitter({
  resizes,
  min,
  max,
  onChange,
  onDone,
  onReset,
}: {
  resizes: 'before' | 'after';
  min: number;
  max: number;
  onChange(width: number): void;
  onDone?(width: number): void;
  onReset(): void;
}) {
  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    const handle = e.currentTarget;
    const column = resizes === 'before' ? handle.previousElementSibling : handle.nextElementSibling;
    if (!column) return;
    e.preventDefault();
    const startX = e.clientX;
    const start = column.getBoundingClientRect().width;
    let width = start;
    handle.classList.add('dragging');
    const move = (ev: PointerEvent) => {
      const dx = ev.clientX - startX;
      width = Math.round(Math.min(max, Math.max(min, start + (resizes === 'before' ? dx : -dx))));
      onChange(width);
    };
    const up = () => {
      handle.classList.remove('dragging');
      onDone?.(width);
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };
  return (
    <div
      className="nav-resizer room-splitter"
      role="separator"
      aria-orientation="vertical"
      title="Drag to resize · double-click to reset"
      onPointerDown={onPointerDown}
      onDoubleClick={onReset}
    />
  );
}

function Lane({
  session,
  participant,
  events,
  mine,
  canAnswer,
  width,
}: {
  session: Session;
  participant: Participant;
  events: LaneEvent[];
  mine: boolean;
  canAnswer: boolean;
  /** Set once someone drags its edge; otherwise lanes share the room evenly. */
  width?: number | undefined;
}) {
  const conversation = useStore((s) => s.conversation);
  const local = mine && conversation?.session?.id === session.id ? conversation : null;
  const source = (local?.events ??
    (events as unknown as ConversationEvent[])) as ConversationEvent[];
  const items = useMemo(() => foldEvents(source), [source]);
  const { ref, onScroll } = useStick(items);
  const [commenting, setCommenting] = useState<number | null>(null);
  const live = session.status === 'active';
  const state = live ? participant.state : 'idle';

  const approvals: ApprovalHandler = local
    ? { answer: answerApproval, note: 'any Editor · first wins' }
    : {
        answer: (id, ok) => void answerTeamApproval(session.id, participant.userId, id, ok),
        note: canAnswer ? 'any Editor · first wins' : 'Editors answer approvals',
      };

  return (
    <section
      className={`lane ${mine ? 'lane-mine' : ''}`}
      style={width ? { flex: `0 0 ${width}px` } : undefined}
    >
      <header className="lane-head">
        {participant.kind === 'agent' ? (
          <span className="ai-avatar sm" title="AI teammate">
            <Bot size={12} />
          </span>
        ) : (
          <Avatar name={participant.name} src={participant.avatarUrl} size={20} />
        )}
        <span className="lane-name">
          {participant.name}
          {participant.kind === 'agent' && <span className="ai-badge">AI</span>}
          {mine && <span className="muted"> (you)</span>}
        </span>
        <span className="lane-agent mono">{agentLine(participant)}</span>
        <span className={`state-chip state-${state}`}>{STATE_LABEL[state]}</span>
      </header>
      <div className="lane-scroll" ref={ref} onScroll={onScroll}>
        {items.length === 0 ? (
          <div className="lane-empty">
            {mine && live
              ? 'Prompt your agent below. Everyone in the session sees this lane live.'
              : `Nothing from ${participant.name}'s agent yet.`}
          </div>
        ) : (
          <Chat
            items={items}
            userName={participant.kind === 'agent' ? 'Task' : participant.name}
            avatarUrl={participant.avatarUrl}
            approvals={approvals}
            annotate={{
              comment: (i) => setCommenting(commenting === i ? null : i),
              after: (i, excerpt) => (
                <TranscriptThread
                  session={session}
                  laneUserId={participant.userId}
                  index={i}
                  excerpt={excerpt}
                  composing={commenting === i}
                  onDone={() => setCommenting(null)}
                />
              ),
            }}
          />
        )}
        {state === 'running' && items.at(-1)?.kind !== 'tool' && (
          <div className="thinking">
            <span className="dot-pulse" /> Working…
          </div>
        )}
      </div>
      {live &&
        (local ? (
          <Composer />
        ) : mine ? (
          <div className="lane-foot">
            Your lane runs on another machine. Open this workspace here to prompt from this one.
          </div>
        ) : participant.kind === 'agent' ? (
          <TaskBox session={session} participant={participant} />
        ) : (
          <SteerBox session={session} participant={participant} />
        ))}
    </section>
  );
}

/** In an AI teammate's lane: give it a task, or guide the one it is on. */
function TaskBox({ session, participant }: { session: Session; participant: Participant }) {
  const role = useStore((s) => s.teamWorkspaces.find((w) => w.id === session.workspaceId)?.role);
  const [text, setText] = useState('');
  const canAsk = Boolean(role && can(role, 'agent.steer'));
  const running = participant.state === 'running' || participant.state === 'waiting';
  const name = participant.name;
  const send = () =>
    void steer(session.id, participant.userId, text.trim()).then((ok) => ok && setText(''));
  return (
    <div className="steer-box">
      <textarea
        className="composer-input"
        rows={2}
        disabled={!canAsk}
        placeholder={
          !canAsk
            ? `${name} is an AI teammate. Your role can watch.`
            : running
              ? `${name} is working. Guide it…`
              : `Give ${name} a task…`
        }
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey && text.trim()) {
            e.preventDefault();
            send();
          }
        }}
      />
      <div className="steer-bar">
        <span className="muted small">
          {session.machine
            ? `Runs on ${session.machine.name}`
            : participant.hostName
              ? `Runs on ${participant.hostName}'s machine · paid by ${participant.hostName}`
              : 'Not running on any machine'}
        </span>
        <span className="spacer" />
        {canAsk && (
          <button className="send-btn" title="Send (Enter)" disabled={!text.trim()} onClick={send}>
            <ArrowUp size={14} />
          </button>
        )}
      </div>
    </div>
  );
}

/**
 * In a teammate's lane: guide their running agent (it runs on their account), or take over
 * their work — their agent stops at a safe checkpoint and yours carries on.
 */
function SteerBox({ session, participant }: { session: Session; participant: Participant }) {
  const role = useStore((s) => s.teamWorkspaces.find((w) => w.id === session.workspaceId)?.role);
  const [text, setText] = useState('');
  const canSteer = Boolean(role && can(role, 'agent.steer'));
  const canTake = Boolean(role && can(role, 'agent.takeover'));
  const running = participant.state === 'running' || participant.state === 'waiting';
  const name = participant.name;
  return (
    <div className="steer-box">
      <textarea
        className="composer-input"
        rows={2}
        disabled={!canSteer || !running}
        placeholder={
          !canSteer
            ? `${name} is using ${agentLine(participant)}. Your role can watch.`
            : running
              ? `${name} is using ${agentLine(participant)}. Steer their agent…`
              : participant.state === 'awaiting'
                ? `${name}'s agent stopped (${participant.awaitingReason ?? 'usage limit'}). Take over to continue.`
                : `${name} is using ${agentLine(participant)}. Their agent is idle.`
        }
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey && text.trim()) {
            e.preventDefault();
            void steer(session.id, participant.userId, text.trim()).then((ok) => ok && setText(''));
          }
        }}
      />
      <div className="steer-bar">
        <span className="muted small">
          {running
            ? `Guidance runs on ${name}'s account`
            : participant.snapshotAt
              ? `Last checkpoint ${ago(participant.snapshotAt)}`
              : ''}
        </span>
        <span className="spacer" />
        {canTake && (
          <button
            className={`btn btn-sm ${participant.state === 'awaiting' ? 'btn-primary' : ''}`}
            title="Their agent stops at a safe checkpoint; yours continues on your account"
            onClick={() => void takeOverLane(session.id, participant.userId, name)}
          >
            <Hand size={12} /> Take over
          </button>
        )}
        {canSteer && running && (
          <button
            className="send-btn"
            title="Steer (Enter)"
            disabled={!text.trim()}
            onClick={() =>
              void steer(session.id, participant.userId, text.trim()).then(
                (ok) => ok && setText(''),
              )
            }
          >
            <ArrowUp size={14} />
          </button>
        )}
      </div>
    </div>
  );
}

function ago(iso: string): string {
  const minutes = Math.round((Date.now() - new Date(iso).getTime()) / 60_000);
  return minutes < 1
    ? 'just now'
    : minutes < 60
      ? `${minutes} min ago`
      : `${Math.round(minutes / 60)} h ago`;
}

function DiffText({ diff }: { diff: string }) {
  return (
    <pre className="final-diff mono">
      {diff.split('\n').map((line, i) => (
        <div
          key={i}
          className={
            line.startsWith('+') && !line.startsWith('+++')
              ? 'add'
              : line.startsWith('-') && !line.startsWith('---')
                ? 'del'
                : line.startsWith('@@')
                  ? 'hunk'
                  : line.startsWith('diff ')
                    ? 'file'
                    : ''
          }
        >
          {line || ' '}
        </div>
      ))}
    </pre>
  );
}

function SessionTab({ session }: { session: Session }) {
  const room = useStore((s) => s.room);
  const user = useStore((s) => s.user);
  const presence = useStore((s) => s.presence[session.workspaceId] ?? NONE_LIST);
  const role = useStore((s) => s.teamWorkspaces.find((w) => w.id === session.workspaceId)?.role);
  const me = session.participants.find((p) => p.userId === user?.id);
  const live = session.status === 'active';
  const online = new Set(presence.map((p) => p.userId));
  const blocker = room?.blocker ?? null;
  const fixLabel =
    blocker?.fix === 'branch'
      ? `Switch to ${blocker.branch}`
      : blocker?.fix === 'setup'
        ? 'Set up the workspace'
        : blocker?.fix === 'provider'
          ? 'Open Providers'
          : null;

  return (
    <>
      <div className="rail-people">
        {session.participants.map((p) => (
          <div key={p.userId} className="rail-person">
            <span className="rail-avatar">
              {p.kind === 'agent' ? (
                <span className="ai-avatar sm" title="AI teammate">
                  <Bot size={12} />
                </span>
              ) : (
                <Avatar name={p.name} src={p.avatarUrl} size={22} />
              )}
              {online.has(p.userId) && <span className="online-dot" />}
            </span>
            <span className="rail-name">
              <span>
                {p.name}
                {p.kind === 'agent' && <span className="ai-badge">AI</span>}
                {p.userId === user?.id && <span className="muted"> (you)</span>}
              </span>
              <span className="rail-sub">
                {p.mode === 'watch'
                  ? 'watching'
                  : p.kind === 'agent' && (session.machine || p.hostName)
                    ? `${agentLine(p)} · on ${session.machine?.name ?? `${p.hostName}'s machine`}`
                    : agentLine(p)}
              </span>
            </span>
            {p.mode === 'watch' ? (
              <Eye size={13} className="muted" />
            ) : (
              <span className={`rail-state state-${live ? p.state : 'idle'}`}>
                {live ? STATE_LABEL[p.state].toLowerCase() : ''}
              </span>
            )}
          </div>
        ))}
        {session.participants.length === 0 && <div className="rail-empty">No one here yet.</div>}
      </div>

      {blocker && (
        <div className="rail-blocker">
          <CircleAlert size={14} />
          <div>
            <div>{blocker.reason}</div>
            {fixLabel && (
              <button className="btn btn-sm" onClick={() => void fixBlocker(session)}>
                {fixLabel}
              </button>
            )}
          </div>
        </div>
      )}

      {live && (
        <div className="rail-actions">
          {me?.mode !== 'join' && (
            <button
              className="btn btn-primary btn-sm"
              disabled={room?.joining}
              onClick={() => void joinSession(session)}
            >
              <LogIn size={13} /> {room?.joining ? 'Checking…' : 'Join with your agent'}
            </button>
          )}
          {!me && (
            <button className="btn btn-sm" onClick={() => void watchSession(session)}>
              <Eye size={13} /> Watch
            </button>
          )}
          {me && (
            <button className="btn btn-sm" onClick={() => void leaveSession(session)}>
              <LogOut size={13} /> Leave
            </button>
          )}
          {role && can(role, 'session.join') && (
            <button
              className="btn btn-sm btn-danger-ghost"
              onClick={() => void endSession(session)}
            >
              <Square size={11} /> End session
            </button>
          )}
        </div>
      )}

      <div className="rail-section">
        <div className="rail-label">Branch</div>
        <div className="mono small">
          <GitBranch size={12} /> {session.branch ?? 'no branch'}
        </div>
      </div>
      {session.machine && (
        <div className="rail-section">
          <div className="rail-label">Machine</div>
          <div className="mono small" title={session.worktreePath ?? undefined}>
            {session.machine.name}
            {session.worktreePath && <div className="muted rail-path">{session.worktreePath}</div>}
          </div>
        </div>
      )}
      {session.issue && (
        <div className="rail-section">
          <div className="rail-label">Issue</div>
          <div className="mono small" title="Its pull request closes this issue">
            {session.issue.url ? (
              <a href={session.issue.url} target="_blank" rel="noreferrer">
                #{session.issue.number}
              </a>
            ) : (
              `#${session.issue.number}`
            )}
          </div>
        </div>
      )}
      <div className="rail-section">
        <div className="rail-label">Spent in this session</div>
        <div className="mono small">{formatCost(session.cost)}</div>
      </div>
      {session.touchedFiles.length > 0 && (
        <div className="rail-section">
          <div className="rail-label">Touched files</div>
          {session.touchedFiles.slice(0, 12).map((f) => (
            <div key={f} className="rail-file mono" title={f}>
              <FileCode2 size={12} /> {f}
            </div>
          ))}
          {session.touchedFiles.length > 12 && (
            <div className="muted small">and {session.touchedFiles.length - 12} more</div>
          )}
        </div>
      )}
    </>
  );
}

/** The right rail: people and actions, the plan, and the session's comments. */
const ACTIVITY_FILTERS: { id: string; label: string; kinds: string[] | null }[] = [
  { id: 'all', label: 'All', kinds: null },
  {
    id: 'turns',
    label: 'Turns',
    kinds: ['turn_started', 'turn_interrupted', 'steer', 'limit_hit'],
  },
  { id: 'permissions', label: 'Permissions', kinds: ['mode_changed', 'lock', 'unlock'] },
  { id: 'takeovers', label: 'Takeovers', kinds: ['takeover_requested', 'handed_over'] },
  {
    id: 'swarm',
    label: 'Swarm',
    kinds: [
      'agent_added',
      'swarm_launched',
      'swarm_paused',
      'swarm_done',
      'swarm_stopped',
      'reassigned',
    ],
  },
  {
    id: 'git',
    label: 'Git',
    kinds: [
      'subagent_started',
      'subagent_integrated',
      'subagent_failed',
      'paused',
      'resumed',
      'sync_paused',
      'conflict',
      'pr_opened',
      'merged',
    ],
  },
  {
    id: 'other',
    label: 'Other',
    kinds: ['comment', 'outcome_unknown', 'outcome_recorded', 'joined', 'left'],
  },
];

function ActivityFeed({ session }: { session: Session }) {
  const feed = useStore((s) => s.activity[session.id]);
  const [filter, setFilter] = useState('all');
  const kinds = ACTIVITY_FILTERS.find((f) => f.id === filter)?.kinds ?? null;
  const shown = (feed ?? []).filter((a) => !kinds || kinds.includes(a.kind));
  return (
    <div className="activity">
      <div className="activity-filters">
        {ACTIVITY_FILTERS.map((f) => (
          <button
            key={f.id}
            className={filter === f.id ? 'on' : ''}
            onClick={() => setFilter(f.id)}
          >
            {f.label}
          </button>
        ))}
      </div>
      {shown.length === 0 && <div className="rail-empty">Nothing yet.</div>}
      {shown.slice(0, 80).map((a) => (
        <div key={a.id} className={`activity-row kind-${a.kind}`}>
          <div>{a.text}</div>
          <div className="muted small mono">
            {new Date(a.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
            {a.detail ? ` · ${a.detail}` : ''}
          </div>
        </div>
      ))}
    </div>
  );
}

/** Who spent what in this session, from the turns in the lanes. */
function UsagePanel({ session }: { session: Session }) {
  const lanes = useStore((s) => s.room?.lanes ?? NONE_MAP);
  const conversation = useStore((s) => s.conversation);
  const me = useStore((s) => s.user?.id);
  const rows = session.participants
    .filter((p) => p.mode === 'join')
    .map((p) => {
      const events =
        p.userId === me && conversation?.session?.id === session.id
          ? (conversation.events as { type: string; cost?: number }[])
          : ((lanes[p.userId] ?? []) as { type: string; cost?: number }[]);
      const ends = events.filter((e) => e.type === 'turn_end');
      return { p, turns: ends.length, cost: ends.reduce((sum, e) => sum + (e.cost ?? 0), 0) };
    });
  return (
    <div className="usage-rows">
      {rows.map(({ p, turns, cost }) => (
        <div key={p.userId} className="usage-row">
          <span>{p.name}</span>
          <span className="muted small">{agentLine(p)}</span>
          <span className="spacer" />
          <span className="mono small">
            {turns} turn{turns === 1 ? '' : 's'} · {formatCost(cost)}
          </span>
        </div>
      ))}
      <div className="usage-row total">
        <span>Session</span>
        <span className="spacer" />
        <span className="mono small">{formatCost(session.cost)}</span>
      </div>
    </div>
  );
}

function QueuePanel({ session }: { session: Session }) {
  const conversation = useStore((s) => s.conversation);
  const queued = useStore((s) =>
    conversation?.session?.id === session.id ? s.queues[conversation.id] : undefined,
  );
  if (!queued?.length)
    return <div className="rail-empty">Nothing queued. Pick “Queue next” in your composer.</div>;
  return (
    <div className="threads">
      {queued.map((q, i) => (
        <div key={i} className="queue-item" title={q.text}>
          <span className="mono muted">{i + 1}</span>
          <span className="queue-text">{q.text}</span>
        </div>
      ))}
    </div>
  );
}

function LocksPanel({ session }: { session: Session }) {
  const me = useStore((s) => s.user?.id);
  const role = useStore((s) => s.teamWorkspaces.find((w) => w.id === session.workspaceId)?.role);
  const [path, setPath] = useState('');
  const name = (id: string) => session.participants.find((p) => p.userId === id)?.name ?? 'someone';
  const canLock = Boolean(role && can(role, 'session.join')) && session.status === 'active';
  return (
    <div className="locks">
      {session.locks.map((l) => (
        <div key={l.path} className="rail-file mono" title={`Locked by ${name(l.userId)}`}>
          <Lock size={11} /> {l.path}
          <span className="spacer" />
          <span className="muted small">{name(l.userId)}</span>
          {(l.userId === me || role === 'owner') && (
            <button
              className="icon-btn"
              title="Unlock"
              onClick={() => void unlockPath(session.id, l.path)}
            >
              <X size={11} />
            </button>
          )}
        </div>
      ))}
      {canLock && (
        <form
          className="plan-add"
          onSubmit={(e) => {
            e.preventDefault();
            if (path.trim()) void lockPath(session.id, path.trim()).then(() => setPath(''));
          }}
        >
          <Lock size={12} className="muted" />
          <input
            className="input mono"
            placeholder="Lock a file: agents won't edit it"
            value={path}
            onChange={(e) => setPath(e.target.value)}
          />
        </form>
      )}
    </div>
  );
}

function HandOffMenu({ session }: { session: Session }) {
  const members = useStore((s) => s.members[session.workspaceId]?.members ?? NONE_LIST);
  const me = useStore((s) => s.user?.id);
  const workspace = useStore((s) => s.teamWorkspaces.find((w) => w.id === session.workspaceId));
  const [open, setOpen] = useState(false);
  // Alone in a Solo workspace there is nobody to hand work to.
  if (workspaceMode(workspace) === 'solo') return null;
  return (
    <span className="popover-anchor">
      <button
        className="btn btn-sm"
        onClick={() => setOpen(!open)}
        title="Give your lane's work to a teammate"
      >
        <Hand size={12} /> Hand off
      </button>
      {open && (
        <div className="menu plan-menu" onMouseLeave={() => setOpen(false)}>
          <div className="menu-label">Hand your work to</div>
          {members
            .filter((m) => m.userId !== me)
            .map((m) => (
              <button
                key={m.userId}
                className="menu-item"
                onClick={() => {
                  setOpen(false);
                  void handOff(session.id, m.userId, m.name);
                }}
              >
                <span className="menu-title">{m.name}</span>
                <span className="menu-hint">{m.role}</span>
              </button>
            ))}
        </div>
      )}
    </span>
  );
}

/** The right rail: the video's sections, each folding open on its own. */
const SUB_LABEL: Record<Subagent['status'], string> = {
  running: 'RUNNING',
  checking: 'CHECKING',
  passed: 'PASSED',
  integrated: 'INTEGRATED',
  failed: 'FAILED',
  conflict: 'CONFLICT',
  cancelled: 'DISCARDED',
  answered: 'ANSWERED',
};

const CHECK_MARK: Record<Subagent['checks'][number]['status'], string> = {
  passed: '✓',
  failed: '✗',
  not_run: '–',
  blocked: '⊘',
};

function SubagentRow({ sub, mine }: { sub: Subagent; mine: boolean }) {
  const done = sub.status === 'integrated' || sub.status === 'answered';
  const bad = sub.status === 'failed' || sub.status === 'conflict';
  const progress =
    sub.status === 'running'
      ? Math.min(85, 10 + sub.rev * 12)
      : sub.status === 'checking'
        ? 85 + (sub.checksTotal ? (sub.checksPassed / sub.checksTotal) * 15 : 0)
        : 100;
  return (
    <div className="subagent">
      <div className="subagent-head">
        <span className={`subagent-status ${sub.status}`}>{SUB_LABEL[sub.status]}</span>
        <span className="subagent-task" title={sub.task}>
          {sub.task}
        </span>
      </div>
      <div className="subagent-meta">
        <span className="add">+{sub.added}</span>
        <span className="del">−{sub.removed}</span>
        {sub.checksTotal > 0 && (
          <span title="Checks passed">
            {sub.checksPassed}/{sub.checksTotal}
          </span>
        )}
        <span title="Revisions: each edit it made">rev {sub.rev}</span>
        <span className="spacer" />
        <span>{sub.parentName}</span>
      </div>
      {sub.status !== 'cancelled' && (
        <div className={`subagent-bar ${done ? 'done' : bad ? 'bad' : ''}`}>
          <span style={{ width: `${progress}%` }} />
        </div>
      )}
      {sub.detail && (
        <div className="subagent-detail" title={sub.detail}>
          {sub.detail}
        </div>
      )}
      {sub.checks.length > 0 && (
        <ul className="subagent-checks">
          {sub.checks.map((c) => (
            <li key={c.name} className={`check-${c.status}`} title={c.detail ?? c.command ?? ''}>
              <span className="check-mark">{CHECK_MARK[c.status]}</span>
              <span className="check-name">{c.name}</span>
              <span className="check-state">
                {c.status === 'not_run' ? 'not run' : c.status}
                {c.ms !== null && c.status !== 'not_run' ? ` · ${(c.ms / 1000).toFixed(1)}s` : ''}
              </span>
            </li>
          ))}
        </ul>
      )}
      {mine && bad && (
        <div className="subagent-actions">
          <button
            className="btn btn-sm"
            onClick={() =>
              void subagentPath(sub.id).then((p) => {
                if (p) void openWorkspace(p);
              })
            }
          >
            Review
          </button>
          <button className="btn btn-sm" onClick={() => void retrySubagent(sub.id)}>
            Check again
          </button>
          <button className="btn btn-sm" onClick={() => void discardSubagent(sub.id)}>
            Discard
          </button>
        </div>
      )}
      {mine && sub.status === 'running' && (
        <div className="subagent-actions">
          <button className="btn btn-sm" onClick={() => void discardSubagent(sub.id)}>
            Stop
          </button>
        </div>
      )}
    </div>
  );
}

function SubagentsPanel({ session }: { session: Session }) {
  const subs = useStore((s) => s.subagents[session.id]) ?? NONE_LIST;
  const me = useStore((s) => s.user?.id);
  const lane = useStore((s) =>
    s.conversation?.session?.id === session.id ? s.conversation.id : null,
  );
  const [task, setTask] = useState('');
  return (
    <div className="subagents">
      {subs.length === 0 && (
        <p className="muted small">
          A subagent takes a side task in its own worktree from a snapshot of your lane; your agent
          keeps going. It joins your lane once its checks pass, exactly once.
        </p>
      )}
      {subs.map((sub) => (
        <SubagentRow key={sub.id} sub={sub} mine={sub.parentUserId === me} />
      ))}
      {lane && session.status === 'active' && (
        <form
          className="rail-form"
          onSubmit={(e) => {
            e.preventDefault();
            if (!task.trim()) return;
            void startSubagent(lane, task.trim()).then((ok) => ok && setTask(''));
          }}
        >
          <input
            className="input"
            placeholder="A side task for a subagent…"
            value={task}
            onChange={(e) => setTask(e.target.value)}
          />
        </form>
      )}
    </div>
  );
}

const NO_AGENTS: never[] = [];
const usd = (n: number) => `$${n.toFixed(n < 1 ? 4 : 2)}`;

/** Setting up a swarm: the goal, who leads, who works, the budget. Saved before anything runs. */
function SwarmSetup({ session, swarm }: { session: Session; swarm: Swarm | null }) {
  const agents = useStore((s) => s.aiAgents[session.workspaceId]) ?? NO_AGENTS;
  const reusable = swarm && (swarm.status === 'draft' || swarm.status === 'paused') ? swarm : null;
  const [goal, setGoal] = useState(reusable?.goal ?? '');
  const [picked, setPicked] = useState<string[]>(reusable?.agents.map((a) => a.agentId) ?? []);
  const [lead, setLead] = useState<string | null>(reusable?.leadAgentId ?? null);
  const [budget, setBudget] = useState(reusable?.budget?.toString() ?? '1.00');
  const [unlimited, setUnlimited] = useState(reusable ? reusable.budget === null : false);
  const [parallel, setParallel] = useState(reusable?.maxParallel ?? 2);
  const [mode, setMode] = useState<Swarm['mode']>(reusable?.mode ?? 'allow');
  const [busy, setBusy] = useState(false);
  const [why, setWhy] = useState<string | null>(null);
  const [taskBudget, setTaskBudget] = useState(reusable?.taskBudget?.toString() ?? '');
  const [review, setReview] = useState(reusable?.review ?? true);
  const [spend, setSpend] = useState<AgentSpendStats | null>(null);
  useEffect(() => {
    void loadAgentSpend(session.workspaceId).then(setSpend);
  }, [session.workspaceId]);
  const models = useStore((st) => st.models);
  const [catalog, setCatalog] = useState<Record<string, { input: number; output: number }>>({});
  useEffect(() => {
    void loadCatalogPrices().then(setCatalog);
  }, []);
  const workspace = useStore((st) => st.teamWorkspaces.find((w) => w.id === session.workspaceId));
  const solo = workspaceMode(workspace) === 'solo';
  // Where it runs: here, or on one of the workspace's machines (agentd).
  const [machines, setMachines] = useState<Machine[]>([]);
  const [on, setOn] = useState<string>(session.machine?.id ?? 'here');
  useEffect(() => {
    void loadMachines(`/api/workspaces/${session.workspaceId}`)
      .then(setMachines)
      .catch(() => setMachines([]));
  }, [session.workspaceId]);
  const places = machineOptions(machines, workspace?.repoUrl ?? null);
  const place = places.find((p) => p.value === on);
  const elsewhere = on !== 'here';
  if (agents.length === 0)
    return (
      <p className="muted small">
        A swarm puts several AI teammates on one goal: a lead splits it, the others work in
        parallel. Add AI teammates on the People page first.{' '}
        <button className="link-btn" onClick={() => showView('people')}>
          Open People
        </button>
      </p>
    );
  const chosen = picked.length ? picked : [];
  const leadId = lead && chosen.includes(lead) ? lead : (chosen[0] ?? null);
  const amount = Number(budget);
  const perTask = taskBudget.trim() ? Number(taskBudget) : null;
  // Without history here, the workers' models' prices say what a task should cost.
  const workers = chosen.filter((id) => id !== leadId);
  const priced = (workers.length ? workers : chosen).map((id) => {
    const model = agents.find((a) => a.id === id)?.model ?? '';
    const prices = models.find((m) => m.id === model)?.pricing ?? catalog[model];
    return { model, cost: prices ? taskCostAt(prices) : null };
  });
  const unpriced = [...new Set(priced.filter((p) => !p.cost).map((p) => p.model))];
  const costs = priced.flatMap((p) => (p.cost ? [p.cost] : []));
  const byPrice = costs.length
    ? {
        typical: costs.reduce((n, c) => n + c.typical, 0) / costs.length,
        large: Math.max(...costs.map((c) => c.large)),
      }
    : null;
  const valid =
    goal.trim() &&
    chosen.length > 0 &&
    (unlimited || amount >= 0.01) &&
    (perTask === null || perTask >= 0.01) &&
    // A session on a machine stays there; the machine chosen must be able to take it.
    (Boolean(session.machine) || !place?.unavailable);
  // JevRouter's free rules size the goal; the teammates whose instructions fit it are picked.
  const suggest = () => {
    const s = suggestTeam(goal, agents, solo ? { maxWorkers: 2 } : {});
    if (!s) return;
    setPicked([s.leadId, ...s.workerIds]);
    setLead(s.leadId);
    setParallel(Math.min(4, s.maxParallel));
    // A small goal doesn't need a team: saying so beats spending on one.
    setWhy(
      s.small
        ? `${s.reason}. One agent is enough here: you can also just prompt your own agent in your lane.`
        : `${s.reason}${solo ? ' · Solo workspace: at most two workers' : ''}`,
    );
  };
  const save = async (andLaunch: boolean) => {
    if (!valid) return;
    setBusy(true);
    const saved = await saveSwarm(session.id, {
      goal: goal.trim(),
      leadAgentId: leadId,
      agentIds: chosen,
      budget: unlimited ? null : amount,
      taskBudget: perTask,
      review,
      maxParallel: parallel,
      mode,
    });
    if (saved && andLaunch) await launchSwarm(session, saved, on);
    setBusy(false);
  };
  return (
    <div className="swarm-setup">
      <textarea
        className="input"
        rows={3}
        placeholder="The shared goal, e.g. Add total, product and mean helpers with tests"
        value={goal}
        onChange={(e) => setGoal(e.target.value)}
      />
      <div className="swarm-suggest">
        <button
          type="button"
          className="btn btn-sm"
          disabled={!goal.trim()}
          title="Pick the lead, the teammates and how many work at once from the goal's size"
          onClick={suggest}
        >
          Suggest a team
        </button>
        {why && <span className="muted small">{why}</span>}
      </div>
      <div className="swarm-agents">
        {agents.map((a) => (
          <label key={a.id} className="swarm-agent-pick">
            <input
              type="checkbox"
              checked={chosen.includes(a.id)}
              onChange={(e) =>
                setPicked(e.target.checked ? [...chosen, a.id] : chosen.filter((x) => x !== a.id))
              }
            />
            <span>{a.name}</span>
            {chosen.includes(a.id) && (
              <button
                type="button"
                className={`lead-pick ${leadId === a.id ? 'on' : ''}`}
                title="The lead splits the goal and reviews the results"
                onClick={() => setLead(a.id)}
              >
                {leadId === a.id ? 'Lead' : 'Make lead'}
              </button>
            )}
          </label>
        ))}
      </div>
      <div className="swarm-row">
        <label className="swarm-field">
          Budget
          <input
            className="input mono"
            type="number"
            min={0.01}
            step="any"
            disabled={unlimited}
            value={budget}
            onChange={(e) => setBudget(e.target.value)}
          />
        </label>
        <label className="swarm-check">
          <input
            type="checkbox"
            checked={unlimited}
            onChange={(e) => setUnlimited(e.target.checked)}
          />
          Unlimited
        </label>
        <label className="swarm-field" title="Most one task may spend; past it, the task stops">
          Per task
          <input
            className="input mono"
            type="number"
            min={0.01}
            step="any"
            placeholder="none"
            value={taskBudget}
            onChange={(e) => setTaskBudget(e.target.value)}
          />
        </label>
        <label className="swarm-field">
          At once
          <select
            className="select"
            value={parallel}
            onChange={(e) => setParallel(Number(e.target.value))}
          >
            {[1, 2, 3, 4].map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </label>
        <label className="swarm-field">
          Permissions
          <select
            className="select"
            value={mode}
            onChange={(e) => setMode(e.target.value as Swarm['mode'])}
          >
            <option value="allow">Allow edits</option>
            <option value="full">Full</option>
          </select>
        </label>
        {(machines.length > 0 || session.machine) && (
          <label
            className="swarm-field"
            title="This computer, or a machine that runs agents for the workspace (agentd)"
          >
            Run on
            {session.machine ? (
              <select className="select" value="session" disabled>
                <option value="session">{session.machine.name}</option>
              </select>
            ) : (
              <select className="select" value={on} onChange={(e) => setOn(e.target.value)}>
                {places.map((p) => (
                  <option key={p.value} value={p.value} disabled={p.unavailable !== null}>
                    {p.unavailable ? `${p.label} (${p.unavailable})` : p.label}
                  </option>
                ))}
              </select>
            )}
          </label>
        )}
      </div>
      <label
        className="swarm-check"
        title="Before a task's change joins, the lead (or another agent, if the lead wrote it) reads the diff against the task and its 'done means'. One more model call per task."
      >
        <input type="checkbox" checked={review} onChange={(e) => setReview(e.target.checked)} />
        Review each task before it joins
      </label>
      {spend && (
        <p className="muted small swarm-spend">
          {spend.perTask
            ? `A finished task here cost ~${usd(spend.perTask.average)} (up to ~${usd(spend.perTask.p90)}, ${spend.tasks} task${spend.tasks === 1 ? '' : 's'}).`
            : byPrice
              ? `No cost history here yet. At these models' prices a task costs ~${usd(byPrice.typical)}, a larger one ~${usd(byPrice.large)} (from tasks Kovan measured); the lead's planning and reviews add a few calls.${unpriced.length ? ` No price for ${unpriced.join(', ')}.` : ''}`
              : chosen.length
                ? `No cost history here yet, and no known price for ${unpriced.join(', ') || 'these models'}.`
                : 'No cost history here yet: pick the team to see what a task should cost.'}{' '}
          {spend.monthLimit !== null
            ? `This month: ${usd(spend.monthSpent)} of the workspace's ${usd(spend.monthLimit)} limit.`
            : `This month: ${usd(spend.monthSpent)}, no workspace limit.`}
        </p>
      )}
      <div className="swarm-actions">
        <span className="muted small">
          {session.machine
            ? `Runs on ${session.machine.name}, where this session runs, with ${machineWorker(machines.find((m) => m.id === session.machine!.id))}.`
            : elsewhere
              ? `${
                  on === 'auto'
                    ? 'Kovan picks the least busy machine that holds the repository.'
                    : `Runs on ${machines.find((m) => m.id === on)?.name ?? 'that machine'} with ${machineWorker(machines.find((m) => m.id === on))}.`
                } It starts from the session branch as pushed: push your local commits first.${
                  mode === 'full' ? ' Nobody watches there, so Full runs as Allow edits.' : ''
                }`
              : 'Runs on this machine; its agents bill your provider key.'}
        </span>
        <span className="spacer" />
        <button className="btn btn-sm" disabled={!valid || busy} onClick={() => void save(false)}>
          Save
        </button>
        <button
          className="btn btn-sm btn-primary"
          disabled={!valid || busy || session.status !== 'active'}
          onClick={() => void save(true)}
        >
          <Hexagon size={12} /> Launch
        </button>
      </div>
    </div>
  );
}

/** The swarm's live chat: agents to each other, and people to agents. */
function SwarmChat({ swarm }: { swarm: Swarm }) {
  const messages = useStore((s) => s.swarms[swarm.sessionId]?.messages) ?? NO_AGENTS;
  const [to, setTo] = useState<string>('');
  const [text, setText] = useState('');
  const { ref, onScroll } = useStick(messages.length);
  return (
    <div className="swarm-chat">
      <button
        className="swarm-chat-head"
        title="Open the swarm's chat"
        onClick={() => setState({ roomTab: 'swarm' })}
      >
        <Hexagon size={11} /> SWARM ·{' '}
        {swarm.status === 'running' ? 'LIVE' : swarm.status.toUpperCase()}
        <span className="spacer" />
        <span className="swarm-chat-open">Open chat</span>
      </button>
      <div className="swarm-chat-body" ref={ref} onScroll={onScroll}>
        {messages.length === 0 && (
          <div className="muted small">Agents talk to each other here.</div>
        )}
        {messages.map((m) => (
          <div key={m.id} className="swarm-msg">
            <b>{m.fromName}</b>
            <span className="muted"> → {m.toName ?? 'everyone'}</span> {m.text}
          </div>
        ))}
      </div>
      {swarm.status !== 'done' && swarm.status !== 'stopped' && (
        <form
          className="swarm-chat-form"
          onSubmit={(e) => {
            e.preventDefault();
            if (!text.trim()) return;
            void sendSwarmMessage(swarm, to || null, text.trim()).then((ok) => ok && setText(''));
          }}
        >
          <select className="select" value={to} onChange={(e) => setTo(e.target.value)}>
            <option value="">Everyone</option>
            {swarm.agents.map((a) => (
              <option key={a.agentId} value={a.agentId}>
                {a.name}
              </option>
            ))}
          </select>
          <input
            className="input"
            placeholder="Message the swarm…"
            value={text}
            onChange={(e) => setText(e.target.value)}
          />
        </form>
      )}
    </div>
  );
}

function SwarmPanel({ session }: { session: Session }) {
  const swarm = useStore((s) => s.swarms[session.id]?.swarm ?? null);
  const me = useStore((s) => s.user?.id);
  const role = useStore((s) => s.teamWorkspaces.find((w) => w.id === session.workspaceId)?.role);
  const [fresh, setFresh] = useState(false);
  // A new swarm exists now: show it, not the setup.
  const swarmId = swarm?.id;
  useEffect(() => setFresh(false), [swarmId]);
  const canRun = Boolean(role && can(role, 'session.start'));
  // "New swarm" shows the setup until a new one exists (then that one shows).
  const setup = fresh && (swarm?.status === 'done' || swarm?.status === 'stopped');
  if (!swarm || swarm.status === 'draft' || setup)
    return canRun ? (
      <SwarmSetup
        key={setup ? 'new' : (swarm?.id ?? 'new')}
        session={session}
        swarm={setup ? null : swarm}
      />
    ) : (
      <p className="muted small">No swarm in this session.</p>
    );
  const over = swarm.budget !== null ? Math.min(100, (swarm.spent / swarm.budget) * 100) : 0;
  const running = swarm.status === 'running';
  return (
    <div className="swarm">
      <div className="swarm-head">
        <span className={`swarm-status ${swarm.status}`}>{swarm.status.toUpperCase()}</span>
        <span className="muted small">
          {session.machine
            ? `on ${session.machine.name}`
            : swarm.launchedByName
              ? `on ${swarm.launchedByName}'s machine`
              : ''}
        </span>
      </div>
      <div className="swarm-goal">{swarm.goal}</div>
      <div
        className="swarm-budget"
        title="Spent of the budget; the swarm pauses itself when it is reached"
      >
        <span className="mono">
          {usd(swarm.spent)} / {swarm.budget === null ? 'unlimited' : usd(swarm.budget)}
        </span>
        {swarm.budget !== null && (
          <span className={`swarm-bar ${over >= 100 ? 'full' : ''}`}>
            <span style={{ width: `${over}%` }} />
          </span>
        )}
      </div>
      {swarm.pausedReason && <div className="swarm-reason">{swarm.pausedReason}</div>}
      <div className="swarm-agent-list">
        {swarm.agents.map((a) => (
          <div key={a.agentId} className="swarm-agent">
            <span className="ai-avatar sm">
              <Bot size={12} />
            </span>
            <div className="swarm-agent-text">
              <div>
                {a.name}
                {a.role === 'lead' && <span className="ai-badge">LEAD</span>}
                <span className={`swarm-agent-state ${a.status}`}> {a.status}</span>
              </div>
              {a.task && <div className="muted small swarm-task">{a.task}</div>}
            </div>
            <span className="mono small muted">{usd(a.spent)}</span>
            {running && a.status === 'working' && (
              <span className="swarm-agent-actions">
                <select
                  className="select"
                  value=""
                  title="Move its work to another agent"
                  onChange={(e) =>
                    e.target.value &&
                    void controlAgent(swarm, 'reassign', a.agentId, e.target.value)
                  }
                >
                  <option value="">Move…</option>
                  {swarm.agents
                    .filter((x) => x.agentId !== a.agentId)
                    .map((x) => (
                      <option key={x.agentId} value={x.agentId}>
                        to {x.name}
                      </option>
                    ))}
                </select>
                <button
                  className="icon-btn"
                  title={`Stop ${a.name}`}
                  onClick={() => void controlAgent(swarm, 'stop', a.agentId)}
                >
                  <Square size={11} />
                </button>
              </span>
            )}
          </div>
        ))}
      </div>
      <div className="swarm-actions">
        {running && (
          <>
            <button className="btn btn-sm" onClick={() => void setSwarmStatus(swarm, 'paused')}>
              Pause
            </button>
            <button className="btn btn-sm" onClick={() => void setSwarmStatus(swarm, 'stopped')}>
              Stop
            </button>
          </>
        )}
        {swarm.status === 'paused' && canRun && (
          <>
            {(!swarm.launchedBy || swarm.launchedBy === me || session.machine) && (
              <button
                className="btn btn-sm btn-primary"
                onClick={() => void launchSwarm(session, swarm)}
              >
                Resume
              </button>
            )}
            <button className="btn btn-sm" onClick={() => setFresh(false)}>
              Settings below
            </button>
            <button className="btn btn-sm" onClick={() => void setSwarmStatus(swarm, 'stopped')}>
              Stop
            </button>
          </>
        )}
        {(swarm.status === 'done' || swarm.status === 'stopped') &&
          canRun &&
          session.status === 'active' && (
            <button className="btn btn-sm" onClick={() => setFresh(true)}>
              New swarm
            </button>
          )}
      </div>
      {swarm.status === 'paused' && canRun && <SwarmSetup session={session} swarm={swarm} />}
      <SwarmChat swarm={swarm} />
    </div>
  );
}

/** Puts one of the workspace's AI teammates in the session, run on this machine. */
function AddAiTeammate({ session }: { session: Session }) {
  const agents = useStore((s) => s.aiAgents[session.workspaceId]) ?? NO_AGENTS;
  const free = agents.filter(
    (a) => !session.participants.some((p) => p.userId === a.id && p.mode === 'join'),
  );
  if (free.length === 0) return null;
  return (
    <label className="add-ai">
      <Bot size={13} />
      <select
        className="select"
        value=""
        onChange={(e) => e.target.value && void addAiToSession(session, e.target.value)}
      >
        <option value="">Add an AI teammate…</option>
        {free.map((a) => (
          <option key={a.id} value={a.id}>
            {a.name} · {a.model}
          </option>
        ))}
      </select>
    </label>
  );
}

function Rail({ session, width }: { session: Session; width: number }) {
  const [open, setOpen] = useState<Record<string, boolean>>({
    people: true,
    swarm: true,
    plan: true,
    activity: true,
  });
  const plan = useStore((s) => s.plans[session.id]);
  const comments = useStore((s) => s.comments[session.workspaceId]);
  const feed = useStore((s) => s.activity[session.id]);
  const subs = useStore((s) => s.subagents[session.id]);
  const swarmInfo = useStore((s) => s.swarms[session.id]?.swarm ?? null);
  const me = useStore((s) => s.user?.id);
  const joined = session.participants.some((p) => p.userId === me && p.mode === 'join');
  const openComments = (comments ?? []).filter(
    (c) =>
      c.sessionId === session.id &&
      !c.parentId &&
      c.status === 'open' &&
      (c.anchor.kind === 'session' || c.anchor.kind === 'transcript'),
  ).length;
  const steps = plan?.steps ?? [];
  const section = (
    id: string,
    icon: React.ReactNode,
    title: string,
    count: string | null,
    body: React.ReactNode,
  ) => (
    <div className="rail-section-fold">
      <button className="rail-fold-head" onClick={() => setOpen({ ...open, [id]: !open[id] })}>
        <ChevronRight size={12} className={open[id] ? 'turned' : ''} />
        {icon}
        <span>{title}</span>
        {count && <span className="rail-count">{count}</span>}
      </button>
      {open[id] && <div className="rail-fold-body">{body}</div>}
    </div>
  );
  return (
    <aside className="room-rail" style={{ width }}>
      {section(
        'people',
        <Users size={13} />,
        'People',
        String(session.participants.length),
        <>
          <SessionTab session={session} />
          {joined && session.status === 'active' && <HandOffMenu session={session} />}
          {session.status === 'active' && <AddAiTeammate session={session} />}
        </>,
      )}
      {section(
        'swarm',
        <Hexagon size={13} />,
        'Swarm',
        swarmInfo ? swarmInfo.status : null,
        <SwarmPanel session={session} />,
      )}
      {section(
        'plan',
        <ListChecks size={13} />,
        'Plan',
        steps.length ? `${steps.filter((x) => x.status === 'done').length}/${steps.length}` : null,
        <PlanPanel session={session} />,
      )}
      {section(
        'subagents',
        <Workflow size={13} />,
        'Subagents',
        subs?.length ? String(subs.length) : null,
        <SubagentsPanel session={session} />,
      )}
      {section('queue', <ListPlus size={13} />, 'Queue', null, <QueuePanel session={session} />)}
      {section(
        'locks',
        <Lock size={13} />,
        'Locks',
        session.locks.length ? String(session.locks.length) : null,
        <LocksPanel session={session} />,
      )}
      {section(
        'comments',
        <MessageSquare size={13} />,
        'Comments',
        openComments ? String(openComments) : null,
        <SessionComments session={session} />,
      )}
      {section(
        'activity',
        <History size={13} />,
        'Activity',
        feed?.length ? String(feed.length) : null,
        <ActivityFeed session={session} />,
      )}
      {section('usage', <Gauge size={13} />, 'Usage', null, <UsagePanel session={session} />)}
    </aside>
  );
}

export function SessionRoom() {
  const room = useStore((s) => s.room);
  const user = useStore((s) => s.user);
  const workspaces = useStore((s) => s.teamWorkspaces);
  const tab = useStore((s) => s.roomTab);
  const setTab = (roomTab: typeof tab) => setState({ roomTab });
  const conversation = useStore((s) => s.conversation);
  const session = room?.session ?? null;
  const swarm = useStore((s) => (session ? (s.swarms[session.id]?.swarm ?? null) : null));
  // Another session opens on its lanes.
  const sessionId = session?.id;
  useEffect(() => setState({ roomTab: 'lanes' }), [sessionId]);

  if (!room || !session)
    return (
      <section className="page">
        <div className="room-loading muted">Opening the session…</div>
      </section>
    );

  const ws = workspaces.find((w) => w.id === session.workspaceId);
  const role = ws?.role;
  const canAnswer = Boolean(role && can(role, 'approval.answer'));
  const lanes = session.participants.filter((p) => p.mode === 'join');
  // People whose lanes have events but who left still show in history.
  const extra = Object.keys(room.lanes)
    .filter((id) => !lanes.some((p) => p.userId === id))
    .map((id): Participant => ({
      userId: id,
      name: 'Former participant',
      avatarUrl: null,
      mode: 'join',
      harness: null,
      model: null,
      state: 'idle',
      joinedAt: '',
      awaitingReason: null,
      snapshotAt: null,
      snapshotSha: null,
      snapshotRef: null,
      paused: null,
      kind: 'human',
      hostId: null,
      hostName: null,
    }));
  const state = sessionState(session);
  const joined = lanes.some((p) => p.userId === user?.id);
  const [laneWidths, setLaneWidths] = useState<Record<string, number>>({});
  const [railWidth, setRailWidth] = useState(() => readLocal('kovan.roomRailWidth', RAIL_WIDTH));
  const laneHere = conversation?.session?.id === session.id;

  return (
    <section className="room">
      <header className="room-head">
        <button
          className="icon-btn"
          title="Back to Sessions"
          onClick={() => {
            closeSession();
            showView('sessions');
          }}
        >
          <ArrowLeft size={15} />
        </button>
        <span className="room-title">{session.title}</span>
        <span className="room-sub">/ {ws?.name ?? 'workspace'}</span>
        <span className={`state-chip state-${state}`}>{STATE_LABEL[state]}</span>
        <span className="spacer" />
        {joined && !laneHere && session.status === 'active' && (
          <button
            className="btn btn-sm"
            title="Your lane works in this session's own checkout"
            onClick={() =>
              void openSessionCheckout(session).then(async (ok) => {
                if (ok) await openSession(session.id);
              })
            }
          >
            <GitBranch size={13} /> Open my checkout
          </button>
        )}
        <div className="segmented">
          <button className={tab === 'lanes' ? 'on' : ''} onClick={() => setTab('lanes')}>
            {session.status === 'ended' ? 'Transcript' : 'Lanes'}
          </button>
          <button
            className={tab === 'tasks' ? 'on' : ''}
            title="The tasks as a graph: what waits for what, and where each one stands"
            onClick={() => setTab('tasks')}
          >
            Tasks
          </button>
          <button
            className={tab === 'replay' ? 'on' : ''}
            title="What happened, in order, with where things stood at any moment"
            onClick={() => setTab('replay')}
          >
            Replay
          </button>
          {swarm && swarm.status !== 'draft' && (
            <button
              className={tab === 'swarm' ? 'on' : ''}
              title="The swarm's agents talking to each other, and you to them"
              onClick={() => setTab('swarm')}
            >
              Swarm
            </button>
          )}
          {session.status === 'ended' && (
            <button className={tab === 'diff' ? 'on' : ''} onClick={() => setTab('diff')}>
              Final diff
            </button>
          )}
        </div>
      </header>
      <SessionFiles session={session}>
        <div className="room-body">
          {tab === 'swarm' && swarm ? (
            <SwarmRoom session={session} swarm={swarm} />
          ) : tab === 'tasks' ? (
            <TaskGraph session={session} />
          ) : tab === 'replay' ? (
            <ReplayView session={session} />
          ) : tab === 'diff' && session.status === 'ended' ? (
            <div className="room-diff">
              {room.diff ? (
                <DiffText diff={room.diff} />
              ) : (
                <div className="lane-empty">No final diff was saved for this session.</div>
              )}
            </div>
          ) : (
            <div className="lanes">
              {[...lanes, ...extra].map((p, i, all) => (
                <Fragment key={p.userId}>
                  <Lane
                    session={session}
                    participant={p}
                    events={room.lanes[p.userId] ?? []}
                    mine={p.userId === user?.id}
                    canAnswer={canAnswer}
                    width={laneWidths[p.userId]}
                  />
                  {i < all.length - 1 && (
                    <Splitter
                      resizes="before"
                      min={240}
                      max={1400}
                      onChange={(w) => setLaneWidths((x) => ({ ...x, [p.userId]: w }))}
                      onReset={() => setLaneWidths({})}
                    />
                  )}
                </Fragment>
              ))}
              {lanes.length + extra.length === 0 && (
                <div className="lanes-empty">
                  <div className="empty-title">No agents here yet</div>
                  <p className="empty-text">
                    Join with your agent to take a lane. Everyone in the session sees every lane
                    live; watchers are visible too.
                  </p>
                </div>
              )}
            </div>
          )}
          <Splitter
            resizes="after"
            min={220}
            max={640}
            onChange={setRailWidth}
            onDone={(w) => writeLocal('kovan.roomRailWidth', w)}
            onReset={() => {
              setRailWidth(RAIL_WIDTH);
              writeLocal('kovan.roomRailWidth', RAIL_WIDTH);
            }}
          />
          <Rail session={session} width={railWidth} />
        </div>
      </SessionFiles>
    </section>
  );
}
