import { can, graphColumns, swarmBadge, type PlanStep, type Session } from '@kovan/shared';
import { Pause, Square } from 'lucide-react';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { answerStepApproval, loadPlan } from '../services/collab';
import { controlAgent, setSwarmStatus } from '../services/swarm';
import { workspaceMode } from '../services/team';
import { useStore } from '../store';

const RUN_LABEL: Record<NonNullable<PlanStep['runState']>, string> = {
  waiting: 'waiting',
  waiting_for_approval: 'needs approval',
  running: 'running',
  done: 'done',
  failed: 'failed',
  blocked: 'blocked',
  cancelled: 'stopped',
};

const usd = (n: number) => `$${n < 1 ? n.toFixed(4) : n.toFixed(2)}`;

/**
 * The session's tasks as a graph: each one after what it depends on, with its state, agent,
 * spend and why it stands where it does. What can be done about a task is done here: approve
 * or reject it, stop its agent, pause or stop the swarm. Everything shown comes from the Brain.
 */
export function TaskGraph({ session }: { session: Session }) {
  const plan = useStore((s) => s.plans[session.id]);
  const swarm = useStore((s) => s.swarms[session.id]?.swarm ?? null);
  const workspace = useStore((s) => s.teamWorkspaces.find((w) => w.id === session.workspaceId));
  const members = useStore((s) => s.members[session.workspaceId]?.members);
  const me = useStore((s) => s.user?.id);
  const box = useRef<HTMLDivElement>(null);
  const [lines, setLines] = useState<{ from: string; to: string; d: string }[]>([]);

  useEffect(() => {
    if (!plan) void loadPlan(session.id);
  }, [plan, session.id]);

  const steps = plan?.steps ?? [];
  const columns = graphColumns(steps.map((s) => ({ ...s, key: s.id })));
  const role = workspace?.role;
  const canApprove = Boolean(role && can(role, 'approval.answer')) && session.status === 'active';
  const canSteer = Boolean(role && can(role, 'agent.steer')) && session.status === 'active';
  const nameOf = (id: string | null) =>
    session.participants.find((p) => p.userId === id)?.name ??
    members?.find((m) => m.userId === id)?.name ??
    (id ? 'someone' : 'nobody yet');

  // Edges are drawn between the cards as they lay out.
  useLayoutEffect(() => {
    const root = box.current;
    if (!root) return;
    const draw = () => {
      const base = root.getBoundingClientRect();
      const at = (id: string) => root.querySelector<HTMLElement>(`[data-step="${id}"]`);
      const next: { from: string; to: string; d: string }[] = [];
      for (const s of steps)
        for (const dep of s.dependsOn) {
          const a = at(dep)?.getBoundingClientRect();
          const b = at(s.id)?.getBoundingClientRect();
          if (!a || !b) continue;
          const x1 = a.right - base.left + root.scrollLeft;
          const y1 = a.top + a.height / 2 - base.top + root.scrollTop;
          const x2 = b.left - base.left + root.scrollLeft;
          const y2 = b.top + b.height / 2 - base.top + root.scrollTop;
          const mid = (x1 + x2) / 2;
          next.push({
            from: dep,
            to: s.id,
            d: `M${x1},${y1} C${mid},${y1} ${mid},${y2} ${x2},${y2}`,
          });
        }
      setLines(next);
    };
    draw();
    const observer = new ResizeObserver(draw);
    observer.observe(root);
    return () => observer.disconnect();
  }, [plan]);

  const counts = steps.reduce<Record<string, number>>((acc, s) => {
    const k = s.runState ?? 'not run';
    acc[k] = (acc[k] ?? 0) + 1;
    return acc;
  }, {});
  const mode = workspaceMode(workspace);
  return (
    <div className="task-graph-page">
      <div className="task-graph-head">
        <span className="muted small">
          {workspace ? `${workspace.name} · ${mode === 'solo' ? 'Solo' : 'Team'}` : ''}
          {role ? ` · you are ${role}${canApprove ? ', you can approve tasks' : ''}` : ''}
        </span>
        <span className="task-graph-counts mono small">
          {Object.entries(counts)
            .map(([k, n]) => `${n} ${k.replace(/_/g, ' ')}`)
            .join(' · ')}
        </span>
        <span className="spacer" />
        {swarm && (
          <span className="mono small">
            Swarm {swarmBadge(swarm).label.toLowerCase()} · {usd(swarm.spent)}
            {swarm.budget !== null ? ` of ${usd(swarm.budget)}` : ''}
          </span>
        )}
        {swarm?.status === 'running' && canSteer && (
          <>
            <button className="btn btn-sm" onClick={() => void setSwarmStatus(swarm, 'paused')}>
              <Pause size={12} /> Pause
            </button>
            <button className="btn btn-sm" onClick={() => void setSwarmStatus(swarm, 'stopped')}>
              <Square size={11} /> Stop
            </button>
          </>
        )}
      </div>
      {swarm?.pausedReason && <div className="swarm-reason">{swarm.pausedReason}</div>}
      {steps.length === 0 ? (
        <div className="replay-empty muted">
          No tasks yet. A swarm's lead splits its goal into tasks here; people add plan steps in the
          Plan section.
        </div>
      ) : (
        <div className="task-graph" ref={box}>
          <svg className="task-graph-edges">
            {lines.map((l) => (
              <path key={`${l.from}:${l.to}`} d={l.d} />
            ))}
          </svg>
          {columns.map((column, i) => (
            <div key={i} className="task-graph-column">
              {column.map((s) => (
                <div
                  key={s.id}
                  data-step={s.id}
                  className={`task-node ${s.runState ? `node-${s.runState}` : ''}`}
                >
                  <div className="task-node-head">
                    {s.runState ? (
                      <span className={`run-chip run-${s.runState}`}>{RUN_LABEL[s.runState]}</span>
                    ) : (
                      <span className="run-chip">{s.status}</span>
                    )}
                    <span className="spacer" />
                    {s.spent > 0 && <span className="mono small muted">{usd(s.spent)}</span>}
                  </div>
                  <div className="task-node-title">{s.title}</div>
                  <div className="muted small">{nameOf(s.ownerId)}</div>
                  {s.acceptance && <div className="small muted">Done means: {s.acceptance}</div>}
                  {s.runDetail && (
                    <div className="task-node-why small" title={s.runDetail}>
                      {s.runDetail.split('\n')[0]}
                    </div>
                  )}
                  {s.approval === 'pending' && (
                    <div className="task-node-actions">
                      <span className="small">{s.approvalReason}</span>
                      {canApprove && (
                        <>
                          <button
                            className="btn btn-sm btn-primary"
                            onClick={() => void answerStepApproval(s.id, true)}
                          >
                            Approve
                          </button>
                          <button
                            className="btn btn-sm"
                            onClick={() => void answerStepApproval(s.id, false)}
                          >
                            Reject
                          </button>
                        </>
                      )}
                    </div>
                  )}
                  {s.runState === 'running' &&
                    swarm?.status === 'running' &&
                    canSteer &&
                    s.ownerId &&
                    swarm.agents.some((a) => a.agentId === s.ownerId) && (
                      <div className="task-node-actions">
                        <button
                          className="btn btn-sm"
                          title={`Stop ${nameOf(s.ownerId)}'s work on this task`}
                          onClick={() => void controlAgent(swarm, 'stop', s.ownerId!)}
                        >
                          <Square size={11} /> Stop task
                        </button>
                      </div>
                    )}
                  {s.approval && s.approval !== 'pending' && (
                    <div className="muted small">
                      {s.approval} by {s.approvedBy === me ? 'you' : nameOf(s.approvedBy)}
                    </div>
                  )}
                </div>
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
