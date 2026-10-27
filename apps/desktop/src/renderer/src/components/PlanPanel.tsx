import { can, type PlanStep, type Session, type StepStatus } from '@kovan/shared';
import { Check, Circle, CircleDot, MoreHorizontal, Plus } from 'lucide-react';
import { useEffect, useState } from 'react';
import {
  addSteps,
  answerOffer,
  answerStepApproval,
  assignStep,
  deleteStep,
  loadPlan,
  releaseStep,
  setStepStatus,
  takeOver,
} from '../services/collab';
import { useStore } from '../store';
import { Avatar } from './ui';

// Stable empty values: a selector returning a fresh [] or {} re-renders forever.
const NONE_LIST: never[] = [];

const NEXT: Record<StepStatus, StepStatus> = { todo: 'doing', doing: 'done', done: 'todo' };
const STATUS_ICON = {
  todo: <Circle size={13} />,
  doing: <CircleDot size={13} />,
  done: <Check size={13} />,
} as const;

function StepMenu({
  step,
  session,
  canManage,
  mine,
  onClose,
}: {
  step: PlanStep;
  session: Session;
  canManage: boolean;
  mine: boolean;
  onClose: () => void;
}) {
  const members = useStore((s) => s.members[session.workspaceId]?.members ?? NONE_LIST);
  return (
    <div className="menu plan-menu" onMouseLeave={onClose}>
      {canManage && (
        <>
          <div className="menu-label">Assign to</div>
          {members.map((m) => (
            <button
              key={m.userId}
              className={`menu-item ${step.ownerId === m.userId ? 'on' : ''}`}
              onClick={() => {
                void assignStep(step.id, m.userId);
                onClose();
              }}
            >
              <span className="menu-title">{m.name}</span>
            </button>
          ))}
          {step.ownerId && (
            <button
              className="menu-item"
              onClick={() => {
                void assignStep(step.id, null);
                onClose();
              }}
            >
              <span className="menu-title">Nobody</span>
            </button>
          )}
        </>
      )}
      {mine && (
        <button
          className="menu-item"
          onClick={() => {
            void releaseStep(step.id);
            onClose();
          }}
        >
          <span className="menu-title">Hand back</span>
        </button>
      )}
      {canManage && (
        <button
          className="menu-item danger"
          onClick={() => {
            void deleteStep(step.id);
            onClose();
          }}
        >
          <span className="menu-title">Delete step</span>
        </button>
      )}
    </div>
  );
}

/** The session's one plan: steps, who owns each, and taking work over. */
/** A swarm's run of a step, in a word (the detail says why). */
const RUN_LABEL: Record<NonNullable<PlanStep['runState']>, string> = {
  waiting: 'waiting',
  waiting_for_approval: 'needs approval',
  running: 'running',
  done: 'done',
  failed: 'failed',
  blocked: 'blocked',
  cancelled: 'stopped',
};

export function PlanPanel({ session }: { session: Session }) {
  const plan = useStore((s) => s.plans[session.id]);
  const me = useStore((s) => s.user?.id);
  const role = useStore((s) => s.teamWorkspaces.find((w) => w.id === session.workspaceId)?.role);
  const members = useStore((s) => s.members[session.workspaceId]?.members ?? NONE_LIST);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [title, setTitle] = useState('');
  const [menu, setMenu] = useState<string | null>(null);

  useEffect(() => {
    void loadPlan(session.id);
  }, [session.id]);

  const live = session.status === 'active';
  const canManage = Boolean(role && can(role, 'plan.manage')) && live;
  const canClaim = Boolean(role && can(role, 'work.claim')) && live;
  const canApprove = Boolean(role && can(role, 'approval.answer')) && live;
  const steps = plan?.steps ?? [];
  const done = steps.filter((s) => s.status === 'done').length;
  const nameOf = (id: string | null) =>
    members.find((m) => m.userId === id)?.name ??
    session.participants.find((p) => p.userId === id)?.name ??
    'someone';
  const toMe = (plan?.offers ?? []).filter((o) => o.toUserId === me);
  const fromMe = new Set(
    (plan?.offers ?? []).filter((o) => o.fromUserId === me).map((o) => o.stepId),
  );

  return (
    <div className="plan">
      <div className="plan-progress">
        <div className="plan-bar">
          <span style={{ width: steps.length ? `${(done / steps.length) * 100}%` : 0 }} />
        </div>
        <span className="muted small mono">
          {done}/{steps.length}
        </span>
      </div>

      {toMe.map((o) => (
        <div key={o.id} className="plan-offer">
          <div>
            <b>{nameOf(o.fromUserId)}</b> asks to take over “
            {steps.find((s) => s.id === o.stepId)?.title}”.
          </div>
          <div className="plan-offer-actions">
            <button className="btn btn-primary btn-sm" onClick={() => void answerOffer(o.id, true)}>
              Hand it over
            </button>
            <button className="btn btn-sm" onClick={() => void answerOffer(o.id, false)}>
              Keep it
            </button>
          </div>
        </div>
      ))}

      {steps.length === 0 && (
        <div className="rail-empty">
          No plan yet. {canManage ? 'Add steps below, or let an agent propose a split.' : ''}
        </div>
      )}
      {steps.map((step) => {
        const mine = step.ownerId === me;
        const canMove = canManage || (mine && canClaim);
        return (
          <div key={step.id} className={`plan-step step-${step.status}`}>
            {canClaim && !mine && step.status !== 'done' && (
              <input
                type="checkbox"
                title="Select to take over"
                checked={selected.has(step.id)}
                onChange={(e) => {
                  const next = new Set(selected);
                  if (e.target.checked) next.add(step.id);
                  else next.delete(step.id);
                  setSelected(next);
                }}
              />
            )}
            <button
              className="step-status"
              title={canMove ? `${step.status}: click for ${NEXT[step.status]}` : step.status}
              disabled={!canMove}
              onClick={() => void setStepStatus(step.id, NEXT[step.status])}
            >
              {STATUS_ICON[step.status]}
            </button>
            <span className="step-title">
              {step.title}
              {fromMe.has(step.id) && (
                <span className="muted small"> · asked {nameOf(step.ownerId)}</span>
              )}
              {step.fromCommentId && <span className="muted small"> · from a comment</span>}
              {step.dependsOn.length > 0 && (
                <span className="muted small">
                  {' '}
                  · after{' '}
                  {step.dependsOn
                    .map((id) => steps.find((x) => x.id === id)?.title ?? 'an earlier step')
                    .join(', ')}
                </span>
              )}
              {step.runState && (
                <span
                  className={`run-chip run-${step.runState}`}
                  title={step.runDetail ?? undefined}
                >
                  {RUN_LABEL[step.runState]}
                </span>
              )}
              {step.approval === 'pending' && (
                <span className="step-approval">
                  Needs a yes before an agent starts it: {step.approvalReason}
                  {canApprove && (
                    <span className="step-approval-actions">
                      <button
                        className="btn btn-sm btn-primary"
                        onClick={() => void answerStepApproval(step.id, true)}
                      >
                        Approve
                      </button>
                      <button
                        className="btn btn-sm"
                        onClick={() => void answerStepApproval(step.id, false)}
                      >
                        Reject
                      </button>
                    </span>
                  )}
                </span>
              )}
              {step.approval && step.approval !== 'pending' && (
                <span className="muted small">
                  {' '}
                  · {step.approval} by {nameOf(step.approvedBy)}
                </span>
              )}
              {step.acceptance && (
                <span className="step-acceptance">Done means: {step.acceptance}</span>
              )}
            </span>
            {step.ownerId ? (
              <span title={nameOf(step.ownerId)}>
                <Avatar name={nameOf(step.ownerId)} size={18} />
              </span>
            ) : (
              <span className="muted small">free</span>
            )}
            {(canManage || mine) && (
              <span className="popover-anchor">
                <button
                  className="icon-btn"
                  title="More"
                  onClick={() => setMenu(menu === step.id ? null : step.id)}
                >
                  <MoreHorizontal size={13} />
                </button>
                {menu === step.id && (
                  <StepMenu
                    step={step}
                    session={session}
                    canManage={canManage}
                    mine={mine}
                    onClose={() => setMenu(null)}
                  />
                )}
              </span>
            )}
          </div>
        );
      })}

      {selected.size > 0 && (
        <button
          className="btn btn-primary btn-sm"
          onClick={() => {
            void takeOver(session.id, [...selected]);
            setSelected(new Set());
          }}
        >
          Take over {selected.size} step{selected.size > 1 ? 's' : ''}
        </button>
      )}

      {canManage && (
        <form
          className="plan-add"
          onSubmit={(e) => {
            e.preventDefault();
            if (!title.trim()) return;
            void addSteps(session.id, [{ title: title.trim() }]).then((ok) => ok && setTitle(''));
          }}
        >
          <Plus size={13} className="muted" />
          <input
            className="input"
            placeholder="Add a step"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
          />
        </form>
      )}
    </div>
  );
}
