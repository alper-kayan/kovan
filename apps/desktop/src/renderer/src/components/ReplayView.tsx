import type { ReplayEvent, Session, TaskState } from '@kovan/shared';
import { pressable } from './ui';
import { ChevronLeft, ChevronRight, RefreshCw } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { api } from '../services/api';
import { reportError } from '../store';

type Filter = 'all' | 'tasks' | 'agents' | 'checks' | 'cost' | 'approvals';

const FILTERS: { id: Filter; label: string; match: (kind: string) => boolean }[] = [
  { id: 'all', label: 'All', match: () => true },
  {
    id: 'tasks',
    label: 'Tasks',
    match: (k) => k === 'task.state' || k.startsWith('plan.') || k.startsWith('activity.task_'),
  },
  { id: 'agents', label: 'Agents', match: (k) => k.startsWith('lane.') && !k.includes('approval') },
  {
    id: 'checks',
    label: 'Checks',
    match: (k) => k === 'subagent.status' || k.startsWith('activity.subagent_'),
  },
  { id: 'cost', label: 'Cost', match: (k) => k === 'cost' || k === 'lane.turn_end' },
  {
    id: 'approvals',
    label: 'Approvals',
    match: (k) =>
      k.startsWith('lane.approval') ||
      [
        'activity.task_approved',
        'activity.task_rejected',
        'activity.task_waiting_for_approval',
      ].includes(k),
  },
];

const time = (at: string) =>
  new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });

/** A short label for an event's kind ("task", "tool", "check"). */
function badge(kind: string): string {
  if (kind === 'task.state' || kind.startsWith('plan.')) return 'task';
  if (kind === 'cost') return 'cost';
  if (kind === 'subagent.status') return 'check';
  if (kind.startsWith('lane.approval')) return 'approval';
  if (kind.startsWith('lane.')) return kind.slice(5).replace('_', ' ');
  if (kind.startsWith('swarm.')) return 'swarm';
  return 'activity';
}

/** Where things stood at one moment of the replay: tasks, spend, the last checks. */
function stateAt(events: ReplayEvent[]) {
  const tasks = new Map<
    string,
    { title: string; state: TaskState | 'new'; detail: string | null }
  >();
  const checks = new Map<string, { task: string; list: { name: string; status: string }[] }>();
  let spent = 0;
  for (const e of events) {
    if (e.kind === 'plan.steps_added')
      for (const s of (e.data?.['steps'] as { id: string; title: string }[] | undefined) ?? [])
        tasks.set(s.id, { title: s.title, state: 'new', detail: null });
    if (e.kind === 'task.state' && e.refs.stepId) {
      const prior = tasks.get(e.refs.stepId);
      tasks.set(e.refs.stepId, {
        title: String(e.data?.['title'] ?? prior?.title ?? 'A task'),
        state: e.data?.['to'] as TaskState,
        detail: typeof e.data?.['detail'] === 'string' ? e.data['detail'] : null,
      });
    }
    if (e.kind === 'cost' && typeof e.data?.['amount'] === 'number') spent += e.data['amount'];
    if (e.kind === 'subagent.status' && e.refs.subagentId && Array.isArray(e.data?.['checks']))
      checks.set(e.refs.subagentId, {
        task: e.summary.split(':')[0] ?? e.summary,
        list: e.data['checks'] as { name: string; status: string }[],
      });
  }
  return { tasks: [...tasks.values()], checks: [...checks.values()], spent };
}

/**
 * A session's replay: everything the Brain recorded and the agents did, in order, with a
 * scrubber to see where things stood at any moment. Read only: it runs nothing.
 */
export function ReplayView({ session }: { session: Session }) {
  const [events, setEvents] = useState<ReplayEvent[] | null>(null);
  const [cursor, setCursor] = useState(0);
  const [filter, setFilter] = useState<Filter>('all');
  const [open, setOpen] = useState<number | null>(null);

  const load = () =>
    void (
      api.invoke('brain:request', 'GET', `/api/sessions/${session.id}/replay`) as Promise<{
        events: ReplayEvent[];
      }>
    )
      .then((r) => {
        setEvents(r.events);
        setCursor(Math.max(0, r.events.length - 1));
      })
      .catch(reportError);
  useEffect(load, [session.id]);

  const match = FILTERS.find((f) => f.id === filter)!.match;
  const shown = useMemo(
    () => (events ?? []).map((e, i) => ({ e, i })).filter(({ e }) => match(e.kind)),
    [events, match],
  );
  const now = useMemo(() => stateAt((events ?? []).slice(0, cursor + 1)), [events, cursor]);

  if (!events) return <div className="replay-empty muted">Loading the replay…</div>;
  if (events.length === 0)
    return (
      <div className="replay-empty muted">
        Nothing recorded yet. Agent work in this session (plans, tasks, checks, costs, tool calls)
        shows up here as it happens.
      </div>
    );
  const at = events[cursor]!;
  return (
    <div className="replay">
      <div className="replay-main">
        <div className="replay-bar">
          <button
            className="icon-btn"
            title="Back one event"
            disabled={cursor === 0}
            onClick={() => setCursor(cursor - 1)}
          >
            <ChevronLeft size={14} />
          </button>
          <input
            className="replay-scrub"
            type="range"
            min={0}
            max={events.length - 1}
            value={cursor}
            onChange={(e) => setCursor(Number(e.target.value))}
          />
          <button
            className="icon-btn"
            title="Forward one event"
            disabled={cursor === events.length - 1}
            onClick={() => setCursor(cursor + 1)}
          >
            <ChevronRight size={14} />
          </button>
          <span className="mono small muted">
            {cursor + 1}/{events.length} · {time(at.at)}
          </span>
          <button className="icon-btn" title="Load again" onClick={load}>
            <RefreshCw size={13} />
          </button>
        </div>
        <div className="segmented replay-filters">
          {FILTERS.map((f) => (
            <button
              key={f.id}
              className={filter === f.id ? 'on' : ''}
              onClick={() => setFilter(f.id)}
            >
              {f.label}
            </button>
          ))}
        </div>
        <ol className="replay-list">
          {shown.map(({ e, i }) => (
            <li
              key={i}
              className={`replay-item ${i > cursor ? 'later' : ''} ${i === cursor ? 'current' : ''}`}
              onClick={() => {
                setCursor(i);
                setOpen(open === i ? null : i);
              }}
              {...pressable(() => {
                setCursor(i);
                setOpen(open === i ? null : i);
              })}
              aria-expanded={open === i}
            >
              <span className="mono small muted replay-time">{time(e.at)}</span>
              <span className={`replay-badge ${badge(e.kind).replace(' ', '-')}`}>
                {badge(e.kind)}
              </span>
              <span className="replay-text">
                {/* Activity lines already name who did it. */}
                {e.actorName && !e.kind.startsWith('activity.') && <strong>{e.actorName} </strong>}
                {e.summary}
                {open === i && e.detail && <span className="replay-detail">{e.detail}</span>}
              </span>
            </li>
          ))}
        </ol>
        <p className="muted small">
          Replay shows what happened; it runs nothing. Times of agent steps come from their lane and
          are accurate to about a second.
        </p>
      </div>
      <aside className="replay-side">
        <div className="replay-side-title">At {time(at.at)}</div>
        <div className="replay-side-row">
          <span className="muted">Swarm spend so far</span>
          <span className="mono">${now.spent.toFixed(4)}</span>
        </div>
        <div className="replay-side-title">Tasks</div>
        {now.tasks.length === 0 && <div className="muted small">No tasks yet.</div>}
        {now.tasks.map((t, i) => (
          <div key={i} className="replay-task" title={t.detail ?? undefined}>
            <span className={`run-chip run-${t.state}`}>{t.state.replace(/_/g, ' ')}</span>
            <span>{t.title}</span>
          </div>
        ))}
        {now.checks.length > 0 && <div className="replay-side-title">Last checks</div>}
        {now.checks.map((c, i) => (
          <div key={i} className="replay-checks">
            <div className="small">{c.task}</div>
            {c.list.map((x, j) => (
              <div key={j} className={`small check-${x.status}`}>
                {x.status === 'passed'
                  ? '✓'
                  : x.status === 'failed'
                    ? '✗'
                    : x.status === 'blocked'
                      ? '⊘'
                      : '–'}{' '}
                {x.name}
              </div>
            ))}
          </div>
        ))}
      </aside>
    </div>
  );
}
