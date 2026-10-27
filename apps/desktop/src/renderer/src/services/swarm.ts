import type {
  AgentSpendStats,
  AiAgent,
  Learning,
  ServerMessage,
  Session,
  Swarm,
  SwarmMessage,
  Workspace,
} from '@kovan/shared';
import type { HttpMethod } from '../../../shared/api';
import { getState, reportError, setState, toast } from '../store';
import { api } from './api';
import { openSessionCheckout } from './sessions';

function request<T>(method: HttpMethod, path: string, body?: unknown): Promise<T> {
  return (
    body === undefined
      ? api.invoke('brain:request', method, path)
      : api.invoke('brain:request', method, path, body)
  ) as Promise<T>;
}

const EMPTY = { swarm: null, messages: [] as SwarmMessage[] };

export function initSwarm(): void {
  api.on('brain:message', handle);
}

function handle(message: ServerMessage): void {
  switch (message.type) {
    case 'swarm': {
      const sw = message.swarm;
      setState((s) => ({
        swarms: {
          ...s.swarms,
          [sw.sessionId]: { ...(s.swarms[sw.sessionId] ?? EMPTY), swarm: sw },
        },
      }));
      return;
    }
    case 'swarm.message': {
      const m = message.message;
      setState((s) => {
        const current = s.swarms[message.sessionId] ?? EMPTY;
        // A message comes again when it reaches an agent: replace it.
        const known = current.messages.some((x) => x.id === m.id);
        const messages = known
          ? current.messages.map((x) => (x.id === m.id ? m : x))
          : [...current.messages, m].slice(-200);
        return { swarms: { ...s.swarms, [message.sessionId]: { ...current, messages } } };
      });
      return;
    }
    case 'learning': {
      const l = message.learning;
      setState((s) => {
        const list = (s.learnings[l.workspaceId] ?? []).filter((x) => x.id !== l.id);
        return {
          learnings: {
            ...s.learnings,
            [l.workspaceId]: l.status === 'forgotten' ? list : [l, ...list],
          },
        };
      });
      return;
    }
    case 'members':
      void loadAiAgents(message.workspaceId);
      return;
    default:
      return;
  }
}

// ---------- AI teammates ----------

export async function loadAiAgents(workspaceId: string): Promise<void> {
  const r = await request<{ agents: AiAgent[] }>(
    'GET',
    `/api/workspaces/${workspaceId}/agents`,
  ).catch(() => null);
  if (r) setState((s) => ({ aiAgents: { ...s.aiAgents, [workspaceId]: r.agents } }));
}

export interface AiAgentInput {
  name: string;
  model: string;
  effort: AiAgent['effort'];
  mode: AiAgent['mode'];
  instructions: string;
  /** USD a month (owners set it); null: no limit of its own. */
  monthlyLimit: number | null;
}

export async function createAiAgent(workspaceId: string, input: AiAgentInput): Promise<boolean> {
  try {
    const { agent } = await request<{ agent: AiAgent }>(
      'POST',
      `/api/workspaces/${workspaceId}/agents`,
      input,
    );
    await loadAiAgents(workspaceId);
    toast(`${agent.name} joined the workspace as an AI teammate.`);
    return true;
  } catch (error) {
    reportError(error);
    return false;
  }
}

export async function updateAiAgent(
  agent: AiAgent,
  patch: Partial<AiAgentInput>,
): Promise<boolean> {
  try {
    await request('PATCH', `/api/agents/${agent.id}`, patch);
    await loadAiAgents(agent.workspaceId);
    return true;
  } catch (error) {
    reportError(error);
    return false;
  }
}

export async function retireAiAgent(agent: AiAgent): Promise<void> {
  if (!window.confirm(`Retire ${agent.name}? Its history stays; it takes no more work.`)) return;
  try {
    await request('DELETE', `/api/agents/${agent.id}`);
    await loadAiAgents(agent.workspaceId);
  } catch (error) {
    reportError(error);
  }
}

/** Puts an AI teammate in the session with its own lane, run on this machine. */
export async function addAiToSession(session: Session, agentId: string): Promise<void> {
  try {
    const { session: updated } = await request<{ session: Session }>(
      'POST',
      `/api/sessions/${session.id}/agents`,
      { agentId },
    );
    setState((s) =>
      s.room?.sessionId === session.id ? { room: { ...s.room, session: updated } } : {},
    );
  } catch (error) {
    reportError(error);
  }
}

// ---------- swarms ----------

export async function loadSwarm(sessionId: string): Promise<void> {
  const r = await request<{ swarm: Swarm | null; messages: SwarmMessage[] }>(
    'GET',
    `/api/sessions/${sessionId}/swarm`,
  ).catch(() => null);
  if (r) setState((s) => ({ swarms: { ...s.swarms, [sessionId]: r } }));
}

export interface SwarmSettings {
  goal: string;
  leadAgentId: string | null;
  agentIds: string[];
  budget: number | null;
  /** Most one task may spend; null: no per-task limit. */
  taskBudget: number | null;
  /** Another agent reviews each change before it joins. */
  review: boolean;
  maxParallel: number;
  mode: Swarm['mode'];
}

/** Saves the swarm's settings (before its first agent starts, or while paused). */
export async function saveSwarm(sessionId: string, settings: SwarmSettings): Promise<Swarm | null> {
  try {
    const { swarm } = await request<{ swarm: Swarm }>(
      'PUT',
      `/api/sessions/${sessionId}/swarm`,
      settings,
    );
    setState((s) => ({
      swarms: { ...s.swarms, [sessionId]: { ...(s.swarms[sessionId] ?? EMPTY), swarm } },
    }));
    return swarm;
  } catch (error) {
    reportError(error);
    return null;
  }
}

/**
 * Launches the swarm: on this computer, in the session's own checkout, or on a registered
 * machine (`on`: its id or "auto"). A session already on a machine resumes there.
 */
export async function launchSwarm(
  session: Session,
  swarm: Swarm,
  on: 'here' | 'auto' | (string & {}) = 'here',
): Promise<void> {
  try {
    if (session.machine || on !== 'here') {
      const r = await request<{ swarm: Swarm }>('POST', `/api/swarms/${swarm.id}/launch`, {
        machine: session.machine ? null : on,
      });
      setState((s) => ({
        swarms: {
          ...s.swarms,
          [session.id]: { ...(s.swarms[session.id] ?? EMPTY), swarm: r.swarm },
        },
      }));
      const { session: now } = await request<{ session: Session }>(
        'GET',
        `/api/sessions/${session.id}`,
      ).catch(() => ({ session }));
      toast(
        `The swarm is running on ${now.machine?.name ?? 'the machine'}. Its lanes show up here as its agents start.`,
      );
      return;
    }
    if (!(await openSessionCheckout(session))) return;
    setState({ view: 'session' });
    await api.invoke('swarm:launch', swarm.id);
    toast('The swarm is running on this machine. Its agents bill your provider key.');
  } catch (error) {
    reportError(error);
  }
}

export async function setSwarmStatus(swarm: Swarm, status: 'paused' | 'stopped'): Promise<void> {
  await request('POST', `/api/swarms/${swarm.id}/status`, { status, reason: null }).catch(
    reportError,
  );
}

export async function controlAgent(
  swarm: Swarm,
  action: 'stop' | 'reassign',
  agentId: string,
  toId?: string,
): Promise<void> {
  await request('POST', `/api/swarms/${swarm.id}/control`, {
    action,
    agentId,
    ...(toId ? { toId } : {}),
  }).catch(reportError);
}

export async function sendSwarmMessage(
  swarm: Swarm,
  toId: string | null,
  text: string,
  /** The message it answers. */
  replyTo: string | null = null,
): Promise<boolean> {
  try {
    await request('POST', `/api/swarms/${swarm.id}/messages`, {
      toId,
      text,
      replyTo,
      kind: replyTo ? 'answer' : 'note',
    });
    return true;
  } catch (error) {
    reportError(error);
    return false;
  }
}

// ---------- learning ----------

export async function loadLearnings(workspaceId: string): Promise<void> {
  const r = await request<{ learnings: Learning[] }>(
    'GET',
    `/api/workspaces/${workspaceId}/learnings`,
  ).catch(() => null);
  if (r) setState((s) => ({ learnings: { ...s.learnings, [workspaceId]: r.learnings } }));
}

export async function updateLearning(
  learning: Learning,
  patch: { text?: string; status?: 'accepted' | 'forgotten' },
): Promise<void> {
  await request('PATCH', `/api/learnings/${learning.id}`, patch).catch(reportError);
}

/** The AI teammates of the workspace a session belongs to (loaded on demand). */
export function aiAgentsOf(workspaceId: string): AiAgent[] {
  return getState().aiAgents[workspaceId] ?? [];
}

/** What agents spent in a workspace this month, and what a finished task costs there. */
export async function loadAgentSpend(workspaceId: string): Promise<AgentSpendStats | null> {
  return request<{ stats: AgentSpendStats }>('GET', `/api/workspaces/${workspaceId}/agent-spend`)
    .then((r) => r.stats)
    .catch(() => null);
}

/** Sets (or removes, with null) the workspace's monthly limit for agent swarms. Owners only. */
export async function setAgentMonthlyLimit(
  workspaceId: string,
  agentMonthlyLimit: number | null,
): Promise<boolean> {
  try {
    await request<{ workspace: Workspace }>('PATCH', `/api/workspaces/${workspaceId}`, {
      agentMonthlyLimit,
    });
    toast(agentMonthlyLimit === null ? 'Monthly agent limit removed' : 'Monthly agent limit saved');
    return true;
  } catch (error) {
    reportError(error);
    return false;
  }
}

/** Prices (USD per million tokens) by model, from Kovan's catalog: when the app's own list
 * couldn't load (no key, the provider down), a swarm's estimate still has them. */
let catalogPrices: Promise<Record<string, { input: number; output: number }>> | null = null;

export function loadCatalogPrices(): Promise<Record<string, { input: number; output: number }>> {
  catalogPrices ??= request<{ data?: { id: string; pricing?: Record<string, unknown> }[] }>(
    'GET',
    '/api/catalog/models',
  )
    .then(({ data }) => {
      const out: Record<string, { input: number; output: number }> = {};
      for (const m of data ?? []) {
        const input = Number(m.pricing?.['prompt']);
        const output = Number(m.pricing?.['completion']);
        if (Number.isFinite(input) && Number.isFinite(output) && input >= 0 && output >= 0)
          out[m.id] = { input: input * 1_000_000, output: output * 1_000_000 };
      }
      return out;
    })
    .catch(() => {
      catalogPrices = null;
      return {};
    });
  return catalogPrices;
}
