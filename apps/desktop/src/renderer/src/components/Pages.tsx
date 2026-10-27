import type { Participant, Session, Swarm, SwarmMessage } from '@kovan/shared';
import { Bot, ChevronsUpDown, FolderGit2, Hexagon, Minus, Plus } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { HARNESS_NAMES, type Harness } from '../../../shared/agent';
import { loadSessions, openSession } from '../services/sessions';
import { loadSwarm } from '../services/swarm';
import { useStore } from '../store';
import { PageHeader } from './PageHeader';

const MIN_ZOOM = 0.25;
const MAX_ZOOM = 2;
const GRID = 24;

const COL = { repo: 40, session: 300, agent: 560, swarm: 860 };
const W = { repo: 210, session: 220, agent: 250, swarm: 260 };
const AGENT_H = 52;
const GAP = 12;
const SESSION_H = 44;
const REPO_H = 40;
const BLOCK_GAP = 36;

interface AgentNode {
  key: string;
  participant: Participant;
  task: string | null;
  y: number;
}
interface SessionNode {
  session: Session;
  y: number;
  agents: AgentNode[];
  swarm: { swarm: Swarm; messages: SwarmMessage[]; y: number; h: number } | null;
}
interface RepoNode {
  id: string;
  name: string;
  y: number;
  sessions: SessionNode[];
}

const NO_SESSIONS: Session[] = [];

/** Lays repositories, their live sessions and the agents in them out in columns. */
function layout(
  repos: { id: string; name: string; sessions: Session[] }[],
  swarms: Record<string, { swarm: Swarm | null; messages: SwarmMessage[] }>,
): RepoNode[] {
  let y = 40;
  const out: RepoNode[] = [];
  for (const repo of repos) {
    if (repo.sessions.length === 0) continue;
    const start = y;
    const sessions: SessionNode[] = [];
    for (const session of repo.sessions) {
      const sw = swarms[session.id]?.swarm ?? null;
      const lanes = session.participants.filter((p) => p.mode === 'join');
      const top = y;
      const agents = lanes.map((p, i) => ({
        key: `${session.id}:${p.userId}`,
        participant: p,
        task: sw?.agents.find((a) => a.agentId === p.userId)?.task ?? null,
        y: top + i * (AGENT_H + GAP),
      }));
      const height = Math.max(SESSION_H, agents.length * (AGENT_H + GAP) - GAP);
      const swarmAgents = agents.filter((a) =>
        sw?.agents.some((x) => x.agentId === a.participant.userId),
      );
      const swarm =
        sw && swarmAgents.length
          ? {
              swarm: sw,
              messages: swarms[session.id]?.messages ?? [],
              y: (swarmAgents[0]!.y + swarmAgents.at(-1)!.y + AGENT_H) / 2 - 50,
              h: 100,
            }
          : null;
      sessions.push({ session, y: top + height / 2 - SESSION_H / 2, agents, swarm });
      y += height + BLOCK_GAP;
    }
    const end = y - BLOCK_GAP;
    out.push({ id: repo.id, name: repo.name, y: (start + end) / 2 - REPO_H / 2, sessions });
    y += BLOCK_GAP;
  }
  return out;
}

/** A curve from the right edge of one block to the left edge of the next. */
const link = (x1: number, y1: number, x2: number, y2: number) => {
  const mid = (x1 + x2) / 2;
  return `M${x1} ${y1} C${mid} ${y1} ${mid} ${y2} ${x2} ${y2}`;
};

function agentModel(p: Participant): string {
  const harness = p.harness ? (HARNESS_NAMES[p.harness as Harness] ?? p.harness) : 'Agent';
  return `${harness} · ${(p.model ?? 'default').split('/').pop()}`;
}

export function AgentsPage() {
  const signedIn = useStore((s) => s.signedIn);
  const workspaces = useStore((s) => s.teamWorkspaces);
  const sessions = useStore((s) => s.sessions);
  const swarms = useStore((s) => s.swarms);
  const [filter, setFilter] = useState('all');
  const [zoom, setZoom] = useState(1);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const drag = useRef<{ x: number; y: number; ox: number; oy: number } | null>(null);

  useEffect(() => {
    if (signedIn) void loadSessions();
  }, [signedIn]);
  // Swarm chats for the sessions that have one.
  const withSwarm = useMemo(
    () =>
      Object.values(sessions)
        .flat()
        .filter((s) => s.swarm)
        .map((s) => s.id)
        .join(','),
    [sessions],
  );
  useEffect(() => {
    for (const id of withSwarm.split(',').filter(Boolean)) void loadSwarm(id);
  }, [withSwarm]);

  const repos = useMemo(
    () =>
      layout(
        workspaces
          .filter((w) => filter === 'all' || w.id === filter)
          .map((w) => ({ id: w.id, name: w.name, sessions: sessions[w.id] ?? NO_SESSIONS })),
        swarms,
      ),
    [workspaces, sessions, swarms, filter],
  );

  const clampZoom = (z: number) =>
    Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, Math.round(z * 100) / 100));
  const size = GRID * zoom;

  return (
    <section className="page">
      <PageHeader title="Agents">
        <label className="filter" style={{ minWidth: 160, justifyContent: 'space-between' }}>
          <select
            className="filter-select"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          >
            <option value="all">All repos ({workspaces.length})</option>
            {workspaces.map((w) => (
              <option key={w.id} value={w.id}>
                {w.name}
              </option>
            ))}
          </select>
          <ChevronsUpDown size={12} />
        </label>
      </PageHeader>
      <div className="page-rule" />
      <div
        className="canvas"
        style={{
          backgroundSize: `${size}px ${size}px`,
          backgroundPosition: `${offset.x}px ${offset.y}px`,
        }}
        onPointerDown={(e) => {
          if ((e.target as Element).closest('.node')) return;
          drag.current = { x: e.clientX, y: e.clientY, ox: offset.x, oy: offset.y };
          (e.target as Element).setPointerCapture(e.pointerId);
        }}
        onPointerMove={(e) => {
          const d = drag.current;
          if (d) setOffset({ x: d.ox + e.clientX - d.x, y: d.oy + e.clientY - d.y });
        }}
        onPointerUp={() => (drag.current = null)}
        onWheel={(e) => {
          if (e.metaKey || e.ctrlKey) setZoom((z) => clampZoom(z * (e.deltaY < 0 ? 1.1 : 0.9)));
          else setOffset((o) => ({ x: o.x - e.deltaX, y: o.y - e.deltaY }));
        }}
      >
        {repos.length === 0 && (
          <div className="canvas-hint">
            {workspaces.length === 0
              ? 'Add a workspace to see its sessions and agents.'
              : 'No live sessions. Start one to see its agents here.'}
          </div>
        )}
        <div
          className="graph-plane"
          style={{ transform: `translate(${offset.x}px, ${offset.y}px) scale(${zoom})` }}
        >
          <svg className="graph-links" width={1200} height={4000}>
            {repos.flatMap((r) =>
              r.sessions.flatMap((s) => [
                <path
                  key={`r${s.session.id}`}
                  d={link(COL.repo + W.repo, r.y + REPO_H / 2, COL.session, s.y + SESSION_H / 2)}
                />,
                ...s.agents.map((a) => (
                  <path
                    key={`s${a.key}`}
                    className={a.participant.state === 'running' ? 'active' : ''}
                    d={link(
                      COL.session + W.session,
                      s.y + SESSION_H / 2,
                      COL.agent,
                      a.y + AGENT_H / 2,
                    )}
                  />
                )),
                ...(s.swarm
                  ? s.agents
                      .filter((a) =>
                        s.swarm!.swarm.agents.some((x) => x.agentId === a.participant.userId),
                      )
                      .map((a) => (
                        <path
                          key={`w${a.key}`}
                          className="swarm"
                          d={link(
                            COL.agent + W.agent,
                            a.y + AGENT_H / 2,
                            COL.swarm,
                            s.swarm!.y + s.swarm!.h / 2,
                          )}
                        />
                      ))
                  : []),
              ]),
            )}
          </svg>
          {repos.map((r) => (
            <div key={r.id}>
              <div className="node node-repo" style={{ left: COL.repo, top: r.y, width: W.repo }}>
                <FolderGit2 size={13} />
                <div>
                  <div className="node-kicker">REPOSITORY</div>
                  <div className="node-title mono">{r.name}</div>
                </div>
              </div>
              {r.sessions.map((s) => (
                <div key={s.session.id}>
                  <button
                    className="node node-session"
                    style={{ left: COL.session, top: s.y, width: W.session }}
                    onClick={() => void openSession(s.session.id)}
                  >
                    <div className="node-kicker">
                      SESSION
                      {s.session.swarm && (
                        <span className="node-swarm-tag">
                          <Hexagon size={9} /> Swarm
                        </span>
                      )}
                    </div>
                    <div className="node-title">{s.session.title}</div>
                  </button>
                  {s.agents.map((a) => {
                    const p = a.participant;
                    const active = p.state === 'running' || p.state === 'waiting';
                    return (
                      <div
                        key={a.key}
                        className={`node node-agent ${active ? 'active' : ''}`}
                        style={{ left: COL.agent, top: a.y, width: W.agent, height: AGENT_H }}
                        onClick={() => void openSession(s.session.id)}
                      >
                        <div className="node-agent-head">
                          {p.kind === 'agent' ? <Bot size={12} className="node-ai" /> : null}
                          <b>{p.name}</b>
                          {p.kind === 'agent' && <span className="ai-badge">AI</span>}
                          <span className="mono muted node-model">{agentModel(p)}</span>
                          <span className={`node-state ${active ? 'on' : ''}`}>
                            ● {active ? 'Active' : p.state === 'awaiting' ? 'Awaiting' : 'Idle'}
                          </span>
                        </div>
                        <div className="node-text">
                          {a.task ??
                            (p.kind === 'agent' && p.hostName
                              ? `Runs on ${p.hostName}'s machine`
                              : p.state === 'waiting'
                                ? 'Needs approval'
                                : '')}
                        </div>
                      </div>
                    );
                  })}
                  {s.swarm && (
                    <div
                      className="node node-swarm"
                      style={{ left: COL.swarm, top: s.swarm.y, width: W.swarm }}
                      onClick={() => void openSession(s.session.id)}
                    >
                      <div className="node-swarm-head">
                        <Hexagon size={10} /> SWARM ·{' '}
                        {s.swarm.swarm.status === 'running'
                          ? 'LIVE'
                          : s.swarm.swarm.status.toUpperCase()}
                      </div>
                      {s.swarm.messages.slice(-3).map((m) => (
                        <div key={m.id} className="node-swarm-msg">
                          <b>{m.fromName}</b> → {m.toName ?? 'all'} {m.text}
                        </div>
                      ))}
                      {s.swarm.messages.length === 0 && (
                        <div className="node-swarm-msg muted">{s.swarm.swarm.goal}</div>
                      )}
                      <div className="node-swarm-foot">Click to open the swarm chat</div>
                    </div>
                  )}
                </div>
              ))}
            </div>
          ))}
        </div>
        <div className="zoom" onPointerDown={(e) => e.stopPropagation()}>
          <button
            className="icon-btn"
            title="Zoom out"
            onClick={() => setZoom((z) => clampZoom(z - 0.1))}
          >
            <Minus size={13} />
          </button>
          <span className="level">{Math.round(zoom * 100)}%</span>
          <button
            className="icon-btn"
            title="Zoom in"
            onClick={() => setZoom((z) => clampZoom(z + 0.1))}
          >
            <Plus size={13} />
          </button>
          <button
            className="btn btn-ghost btn-sm"
            onClick={() => {
              setZoom(1);
              setOffset({ x: 0, y: 0 });
            }}
          >
            Fit
          </button>
        </div>
        <div className="canvas-tips">Drag to pan · ⌘ scroll to zoom · click a block to open it</div>
      </div>
    </section>
  );
}
