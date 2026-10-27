import type { Activity, Handoff, Outcome, ServerMessage } from '@kovan/shared';
import type { HttpMethod, OverlapWarning } from '../../../shared/api';
import { getState, notify, reportError, setState, toast, useStore } from '../store';
import { setDraft } from './agent';
import { api } from './api';

function request<T>(method: HttpMethod, path: string, body?: unknown): Promise<T> {
  return (
    body === undefined
      ? api.invoke('brain:request', method, path)
      : api.invoke('brain:request', method, path, body)
  ) as Promise<T>;
}

const upsert = <T extends { id: string }>(list: T[], item: T, keep: boolean): T[] => [
  ...list.filter((x) => x.id !== item.id),
  ...(keep ? [item] : []),
];

export function initFlow(): void {
  api.on('brain:message', handle);
  // Guidance that came back (the turn ended first) goes back into that lane's composer.
  api.on('agent:event', (conversationId, event) => {
    if (event.type !== 'steer' || event.status !== 'returned' || event.fromUserId) return;
    const draft = getState().drafts[conversationId] ?? '';
    setDraft(conversationId, draft ? `${event.text}\n${draft}` : event.text);
    toast('Your guidance came back: the turn ended before the agent got it.');
  });
  let loadedFor = '';
  const reload = (s: ReturnType<typeof getState>) => {
    const key = s.signedIn ? `${s.connection}|${s.teamWorkspaces.map((w) => w.id).join(',')}` : '';
    if (key === loadedFor) return;
    loadedFor = key;
    for (const w of s.teamWorkspaces) void loadAlerts(w.id);
  };
  reload(getState());
  useStore.subscribe(reload);
}

async function loadAlerts(workspaceId: string): Promise<void> {
  const r = await request<{ handoffs: Handoff[]; outcomes: Outcome[] }>(
    'GET',
    `/api/workspaces/${workspaceId}/flow`,
  ).catch(() => null);
  if (r) setState((s) => ({ flow: { ...s.flow, [workspaceId]: r } }));
}

function handle(message: ServerMessage): void {
  const me = getState().user?.id;
  switch (message.type) {
    case 'activity':
      setState((s) => ({
        activity: {
          ...s.activity,
          [message.activity.sessionId]: [
            message.activity,
            ...(s.activity[message.activity.sessionId] ?? []).filter(
              (a) => a.id !== message.activity.id,
            ),
          ].slice(0, 300),
        },
      }));
      return;
    case 'handoff': {
      const h = message.handoff;
      const open = h.status === 'requested' || h.status === 'ready';
      setState((s) => {
        const current = s.flow[message.workspaceId] ?? { handoffs: [], outcomes: [] };
        return {
          flow: {
            ...s.flow,
            [message.workspaceId]: { ...current, handoffs: upsert(current.handoffs, h, open) },
          },
        };
      });
      if (h.kind === 'handoff' && h.status === 'ready' && h.toUserId === me)
        void api.invoke('app:notify', 'Work was handed to you', 'Open Sessions to pick it up.');
      if (h.kind === 'takeover' && h.status === 'requested' && h.fromUserId === me)
        notify({
          kind: 'info',
          title: 'A teammate is taking over your lane',
          message: 'Your agent stops at the next safe checkpoint and hands over its work.',
        });
      return;
    }
    case 'outcome': {
      const o = message.outcome;
      setState((s) => {
        const current = s.flow[message.workspaceId] ?? { handoffs: [], outcomes: [] };
        return {
          flow: {
            ...s.flow,
            [message.workspaceId]: {
              ...current,
              outcomes: upsert(current.outcomes, o, o.status === 'unknown'),
            },
          },
        };
      });
      return;
    }
    default:
      return;
  }
}

export async function loadActivity(sessionId: string): Promise<void> {
  const r = await request<{ activity: Activity[] }>(
    'GET',
    `/api/sessions/${sessionId}/activity`,
  ).catch(() => null);
  if (r) setState((s) => ({ activity: { ...s.activity, [sessionId]: r.activity } }));
}

/** Guidance for a running lane: yours here, a teammate's through the Brain (on their account). */
export async function steer(sessionId: string, laneUserId: string, text: string): Promise<boolean> {
  try {
    const { sent } = await api.invoke('session:steer', sessionId, laneUserId, text);
    if (!sent) toast("Couldn't deliver it: you're offline.", 'error');
    return sent;
  } catch (error) {
    reportError(error);
    return false;
  }
}

/** Takes over a teammate's lane; your agent picks up where theirs stopped. */
export async function takeOverLane(
  sessionId: string,
  laneUserId: string,
  name: string,
): Promise<void> {
  try {
    const r = await api.invoke('session:takeover', sessionId, laneUserId);
    if (r.status === 'requested')
      toast(`Asked to take over. ${name}'s agent stops at a safe checkpoint, then you continue.`);
    else toast(r.resume ?? `You continue ${name}'s work.`);
  } catch (error) {
    reportError(error);
  }
}

export async function acceptHandoff(h: Handoff): Promise<void> {
  try {
    const r = await api.invoke('session:continue', h.id);
    toast(r.resume ?? 'The work is yours now.');
  } catch (error) {
    reportError(error);
  }
}

export async function declineHandoff(h: Handoff): Promise<void> {
  await request('POST', `/api/handoffs/${h.id}/decline`).catch(reportError);
}

export async function handOff(sessionId: string, toUserId: string, name: string): Promise<void> {
  try {
    await api.invoke('session:handoff', sessionId, toUserId);
    toast(`Handed to ${name}. Your agent stopped at a checkpoint and its work was snapshotted.`);
  } catch (error) {
    reportError(error);
  }
}

export async function recordOutcome(
  o: Outcome,
  status: 'succeeded' | 'failed' | 'not_run',
): Promise<void> {
  await request('POST', `/api/outcomes/${o.id}`, { status }).catch(reportError);
}

export async function lockPath(sessionId: string, path: string): Promise<void> {
  await request('POST', `/api/sessions/${sessionId}/locks`, { path }).catch(reportError);
}

export async function unlockPath(sessionId: string, path: string): Promise<void> {
  await request('POST', `/api/sessions/${sessionId}/unlock`, { path }).catch(reportError);
}

/** Before a prompt: does it collide with a teammate's live session? Fails open (no warning). */
export async function overlapFor(text: string): Promise<OverlapWarning[]> {
  const s = getState();
  if (!s.signedIn || s.connection !== 'online') return [];
  const paths = s.tabs.flatMap((t) => (t.kind === 'file' ? [t.path] : []));
  return api.invoke('overlap:check', { text, paths }).catch(() => []);
}

export async function connectAgents(): Promise<void> {
  try {
    const r = await api.invoke('repo:connectAgents');
    notify({
      kind: 'info',
      title: 'Agents connected to this repository',
      message: `${r.written.length} setup file${r.written.length === 1 ? '' : 's'} written and kept local (never committed)${r.skipped.length ? `; left the team's ${r.skipped.join(', ')} as they are` : ''}. A claude you start in the terminal now sees the team, locks and Brain notes.`,
    });
  } catch (error) {
    reportError(error);
  }
}
