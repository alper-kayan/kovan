import type { PlanStep, Session, Swarm, SwarmMessage } from '@kovan/shared';
import {
  ArrowLeft,
  ArrowUp,
  Check,
  CheckCheck,
  CircleAlert,
  Clock,
  CornerUpLeft,
  Hexagon,
  MessageCircleQuestion,
  Search,
  X,
} from 'lucide-react';
import { Fragment, useLayoutEffect, useRef, useState } from 'react';
import { answerStepApproval } from '../services/collab';
import { sendSwarmMessage } from '../services/swarm';
import { setState, useStore } from '../store';
import { dayLabel, messageStatus, needsAttention, searchMessages } from '../swarmChat';
import { Avatar } from './ui';

const NO_MESSAGES: SwarmMessage[] = [];
const NO_STEPS: PlanStep[] = [];
const KIND_LABEL: Record<string, string> = {
  question: 'Question',
  answer: 'Answer',
  blocker: 'Blocked',
};
const time = (iso: string) =>
  new Date(iso).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });

/**
 * The swarm's chat on its own page: the agents talk to each other by name, people steer them
 * all or one, and each message says whether its agent has it yet (queued, delivered, read).
 */
export function SwarmRoom({ session, swarm }: { session: Session; swarm: Swarm }) {
  const messages = useStore((s) => s.swarms[session.id]?.messages) ?? NO_MESSAGES;
  const steps = useStore((s) => s.plans[session.id]?.steps) ?? NO_STEPS;
  const [query, setQuery] = useState('');
  const [to, setTo] = useState<string | null>(null);
  const [replyTo, setReplyTo] = useState<SwarmMessage | null>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const body = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (body.current) body.current.scrollTop = body.current.scrollHeight;
  }, [messages.length]);

  const agentIds = swarm.agents.map((a) => a.agentId);
  // Whose agent it is: the machine or person running its lane.
  const hostOf = (id: string) =>
    session.participants.find((p) => p.userId === id)?.hostName ?? swarm.launchedByName;
  const isAgent = (id: string) => agentIds.includes(id);
  const shown = searchMessages(messages, query);
  const open = swarm.status !== 'done' && swarm.status !== 'stopped';
  const target = swarm.agents.find((a) => a.agentId === to);
  const attention = open ? needsAttention(messages, steps, agentIds) : [];
  const byId = new Map(messages.map((m) => [m.id, m]));

  /** Answers an agent's message: to that agent, tied to its message. */
  const reply = (m: SwarmMessage) => {
    setReplyTo(m);
    setTo(isAgent(m.fromId) ? m.fromId : null);
    input.current?.focus();
  };

  const send = async () => {
    if (!text.trim() || sending) return;
    setSending(true);
    if (await sendSwarmMessage(swarm, to, text.trim(), replyTo?.id ?? null)) {
      setText('');
      setReplyTo(null);
    }
    setSending(false);
  };

  return (
    <div className="swarm-room">
      <header className="swarm-room-head">
        <button className="btn btn-sm" onClick={() => setState({ roomTab: 'lanes' })}>
          <ArrowLeft size={13} /> Back to session
        </button>
        <span className="swarm-room-sep" />
        <Hexagon size={14} />
        <span className="swarm-room-title">Swarm</span>
        <span className="muted swarm-room-goal">{session.title}</span>
        <span className="spacer" />
        <span className="swarm-room-faces">
          {swarm.agents.map((a) => (
            <Avatar key={a.agentId} name={a.name} size={22} />
          ))}
        </span>
        <label className="swarm-room-search">
          <input
            className="input"
            placeholder="Search Swarm"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <Search size={13} />
        </label>
      </header>

      {attention.length > 0 && (
        <div className="swarm-attention">
          <div className="swarm-attention-head">
            <CircleAlert size={13} /> Needs attention{' '}
            <span className="muted">{attention.length}</span>
          </div>
          {attention.map((a) =>
            a.kind === 'question' ? (
              <div key={a.message.id} className="swarm-attention-item">
                <MessageCircleQuestion size={13} />
                <span className="swarm-attention-text">
                  <b>{a.message.fromName}</b> {a.message.kind === 'blocker' ? 'is stuck' : 'asks'}
                  {a.message.toName ? ` ${a.message.toName}` : ''}: {a.message.text}
                </span>
                <button className="btn btn-sm" onClick={() => reply(a.message)}>
                  Reply
                </button>
              </div>
            ) : (
              <div key={a.step.id} className="swarm-attention-item">
                <CircleAlert size={13} />
                <span className="swarm-attention-text">
                  <b>{a.step.title}</b>{' '}
                  {a.kind === 'approval'
                    ? `needs a yes: ${a.step.approvalReason ?? 'a risky task'}`
                    : a.kind === 'answer'
                      ? (a.step.runDetail ?? 'waits for an answer')
                      : `${a.kind}${a.step.runDetail ? `: ${a.step.runDetail.split('\n')[0]}` : ''}`}
                </span>
                {a.kind === 'approval' && (
                  <>
                    <button
                      className="btn btn-sm"
                      onClick={() => void answerStepApproval(a.step.id, true)}
                    >
                      Approve
                    </button>
                    <button
                      className="btn btn-sm"
                      onClick={() => void answerStepApproval(a.step.id, false)}
                    >
                      Reject
                    </button>
                  </>
                )}
              </div>
            ),
          )}
        </div>
      )}

      <div className="swarm-room-body" ref={body}>
        <div className="swarm-day">
          <span>{dayLabel(swarm.createdAt)}</span>
        </div>
        <div className="swarm-event">
          <Hexagon size={12} />
          Swarm started{swarm.launchedByName ? ' on ' : ''}
          {swarm.launchedByName && <b>{swarm.launchedByName}</b>}:{' '}
          <span className="muted">{swarm.goal}</span>
          <span className="swarm-time">{time(swarm.createdAt)}</span>
        </div>
        {shown.length === 0 && (
          <div className="swarm-room-empty muted">
            {query
              ? 'No message matches.'
              : 'No messages yet. The agents write here when they need each other.'}
          </div>
        )}
        {shown.map((m, i) => {
          const prev = shown[i - 1];
          const newDay = prev && dayLabel(prev.createdAt) !== dayLabel(m.createdAt);
          const status = messageStatus(m, messages, agentIds);
          const host = isAgent(m.fromId) ? hostOf(m.fromId) : null;
          const answers = m.replyTo ? byId.get(m.replyTo) : undefined;
          return (
            <Fragment key={m.id}>
              {newDay && (
                <div className="swarm-day">
                  <span>{dayLabel(m.createdAt)}</span>
                </div>
              )}
              <div className="swarm-line">
                <Avatar name={m.fromName} size={30} />
                <div className="swarm-line-main">
                  <div className="swarm-line-head">
                    <b>{m.fromName}</b>
                    {host && (
                      <span className="swarm-owner" title={`Runs on ${host}`}>
                        {host}
                      </span>
                    )}
                    {KIND_LABEL[m.kind] && (
                      <span className={`swarm-kind ${m.kind}`}>{KIND_LABEL[m.kind]}</span>
                    )}
                    <span className="swarm-time">{time(m.createdAt)}</span>
                    {open && isAgent(m.fromId) && (
                      <button className="swarm-reply" title="Reply" onClick={() => reply(m)}>
                        <CornerUpLeft size={12} />
                      </button>
                    )}
                  </div>
                  {answers && (
                    <div className="swarm-answers muted">
                      <CornerUpLeft size={11} /> {answers.fromName}: {answers.text.slice(0, 120)}
                    </div>
                  )}
                  <div className="swarm-line-text">
                    <span className="swarm-mention">@{m.toName ?? 'all'}</span> {m.text}
                  </div>
                  {status && (
                    <div className={`swarm-status ${status.state}`}>
                      {status.state === 'read' || status.state === 'answered' ? (
                        <CheckCheck size={12} />
                      ) : status.state === 'delivered' ? (
                        <Check size={12} />
                      ) : (
                        <Clock size={12} />
                      )}
                      {status.label}
                    </div>
                  )}
                </div>
              </div>
            </Fragment>
          );
        })}
      </div>

      {open ? (
        <div className="swarm-room-composer">
          <div className="swarm-to">
            <button className={to === null ? 'on' : ''} onClick={() => setTo(null)}>
              @all
            </button>
            {swarm.agents.map((a) => (
              <button
                key={a.agentId}
                className={to === a.agentId ? 'on' : ''}
                onClick={() => setTo(a.agentId)}
              >
                @{a.name}
              </button>
            ))}
          </div>
          {replyTo && (
            <div className="swarm-replying">
              <CornerUpLeft size={12} />
              <span>
                Replying to <b>{replyTo.fromName}</b>: {replyTo.text.slice(0, 120)}
              </span>
              <button className="icon-btn" title="Cancel reply" onClick={() => setReplyTo(null)}>
                <X size={12} />
              </button>
            </div>
          )}
          <div className="swarm-room-input">
            <textarea
              ref={input}
              className="input"
              rows={2}
              placeholder={target ? `Message ${target.name}` : 'Steer all agents'}
              value={text}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  void send();
                }
              }}
            />
            <button
              className="icon-btn send"
              title="Send"
              disabled={!text.trim() || sending}
              onClick={() => void send()}
            >
              <ArrowUp size={15} />
            </button>
          </div>
        </div>
      ) : (
        <div className="swarm-room-closed muted small">
          This swarm is {swarm.status}; its chat is kept for reading.
        </div>
      )}
    </div>
  );
}
