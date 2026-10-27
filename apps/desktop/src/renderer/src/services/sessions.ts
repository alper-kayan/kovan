import {
  can,
  MAX_SESSION_AGENTS,
  type LaneEvent,
  type ServerMessage,
  type Session,
  type SessionApproval,
  type Workspace,
} from '@kovan/shared';
import type { HttpMethod } from '../../../shared/api';
import { HARNESS_NAMES, type Harness } from '../../../shared/agent';
import {
  activeTeamWorkspace,
  getState,
  notify,
  reportError,
  setState,
  showView,
  toast,
  useStore,
  type Room,
} from '../store';
import { api } from './api';
import { completeStep } from './onboarding';
import { loadPlan } from './collab';
import { loadActivity } from './flow';
import { openTeamWorkspace, reloadMembers } from './team';
import { attachSync, loadSubagents } from './sync';
import { loadAiAgents, loadSwarm } from './swarm';
import { openWorkspace } from './workspace';

function request<T>(method: HttpMethod, path: string, body?: unknown): Promise<T> {
  return (
    body === undefined
      ? api.invoke('brain:request', method, path)
      : api.invoke('brain:request', method, path, body)
  ) as Promise<T>;
}

const me = () => getState().user?.id ?? null;
const workspaceOf = (id: string): Workspace | undefined =>
  getState().teamWorkspaces.find((w) => w.id === id);

export function nameOf(session: Session | null, userId: string): string {
  return session?.participants.find((p) => p.userId === userId)?.name ?? 'Someone';
}

/** Tells the person, only when they're looking elsewhere (the OS decides how). */
function backgroundNotify(title: string, body: string): void {
  void api.invoke('app:notify', title, body);
}

// ---------- loading ----------

export function initSessions(): void {
  api.on('brain:message', handleMessage);
  let loadedFor = '';
  // Whenever the set of shared workspaces (or the connection) changes, reload the board.
  const reload = (s: ReturnType<typeof getState>) => {
    const key = s.signedIn ? `${s.connection}|${s.teamWorkspaces.map((w) => w.id).join(',')}` : '';
    if (key === loadedFor) return;
    loadedFor = key;
    void loadSessions();
  };
  reload(getState());
  useStore.subscribe(reload);
  useStore.subscribe(followForEditor);
}

/**
 * While a workspace is open, follow its live sessions this person is in, so teammates'
 * agents show in the editor (carets, typing) even with the room closed.
 */
const editorFollows = new Set<string>();
function followForEditor(s: ReturnType<typeof getState>): void {
  const ws = activeTeamWorkspace(s);
  const me = s.user?.id;
  const want = new Set(
    ws && me && s.connection === 'online'
      ? (s.sessions[ws.id] ?? [])
          .filter((x) => x.status === 'active' && x.participants.some((p) => p.userId === me))
          .map((x) => x.id)
      : [],
  );
  for (const id of want)
    if (!editorFollows.has(id)) {
      editorFollows.add(id);
      void api.invoke('session:follow', id);
    }
  for (const id of [...editorFollows])
    if (!want.has(id)) {
      editorFollows.delete(id);
      void api.invoke('session:unfollow', id);
    }
}

export async function loadSessions(): Promise<void> {
  const s = getState();
  if (!s.signedIn) {
    setState({ sessions: {}, approvals: [], history: {} });
    return;
  }
  const sessions: Record<string, Session[]> = {};
  const approvals: SessionApproval[] = [];
  await Promise.all(
    s.teamWorkspaces.map(async (w) => {
      try {
        sessions[w.id] = (
          await request<{ sessions: Session[] }>('GET', `/api/workspaces/${w.id}/sessions`)
        ).sessions;
        approvals.push(
          ...(
            await request<{ approvals: SessionApproval[] }>(
              'GET',
              `/api/workspaces/${w.id}/approvals`,
            )
          ).approvals,
        );
      } catch {
        // Offline: keep what the board last showed (fail open). Lost access is announced
        // separately and reloads the team.
        const known = getState().sessions[w.id];
        if (known) sessions[w.id] = known;
        approvals.push(
          ...getState().approvals.filter((a) => known?.some((x) => x.id === a.sessionId)),
        );
      }
    }),
  );
  setState({ sessions, approvals });
}

export async function loadHistory(): Promise<void> {
  const history: Record<string, Session[]> = {};
  await Promise.all(
    getState().teamWorkspaces.map(async (w) => {
      try {
        history[w.id] = (
          await request<{ sessions: Session[] }>(
            'GET',
            `/api/workspaces/${w.id}/sessions?status=ended`,
          )
        ).sessions;
      } catch {
        // Leave it out.
      }
    }),
  );
  setState({ history });
}

// ---------- realtime ----------

function upsert(list: Session[] | undefined, session: Session): Session[] {
  const rest = (list ?? []).filter((x) => x.id !== session.id);
  return session.status === 'active' ? [session, ...rest] : rest;
}

function patchRoom(patch: Partial<Room> | ((room: Room) => Partial<Room>)): void {
  const room = getState().room;
  if (!room) return;
  setState({ room: { ...room, ...(typeof patch === 'function' ? patch(room) : patch) } });
}

function handleMessage(message: ServerMessage): void {
  switch (message.type) {
    case 'session': {
      const session = message.session;
      const before = getState().sessions[session.workspaceId]?.find((x) => x.id === session.id);
      noticeChanges(before, session);
      setState((s) => ({
        sessions: {
          ...s.sessions,
          [session.workspaceId]: upsert(s.sessions[session.workspaceId], session),
        },
        ...(session.status === 'ended' && s.history[session.workspaceId]
          ? {
              history: {
                ...s.history,
                [session.workspaceId]: [
                  session,
                  ...s.history[session.workspaceId]!.filter((x) => x.id !== session.id),
                ],
              },
            }
          : {}),
      }));
      if (getState().room?.sessionId === session.id) patchRoom({ session });
      return;
    }
    case 'approval': {
      const a = message.approval;
      const key = (x: SessionApproval) => `${x.sessionId}:${x.laneUserId}:${x.requestId}`;
      setState((s) => ({
        approvals:
          a.status === 'pending'
            ? [...s.approvals.filter((x) => key(x) !== key(a)), a]
            : s.approvals.filter((x) => key(x) !== key(a)),
      }));
      const ws = Object.values(getState().sessions)
        .flat()
        .find((x) => x.id === a.sessionId);
      const role = ws ? workspaceOf(ws.workspaceId)?.role : undefined;
      if (a.status === 'pending' && a.laneUserId !== me() && role && can(role, 'approval.answer'))
        backgroundNotify(
          `${nameOf(ws ?? null, a.laneUserId)}'s agent needs approval`,
          `${a.title} ${a.detail.split('\n')[0]!.slice(0, 100)}`,
        );
      return;
    }
    case 'session.snapshot': {
      if (getState().room?.sessionId !== message.session.id) return;
      const lanes: Record<string, LaneEvent[]> = {};
      for (const lane of message.lanes) lanes[lane.userId] = lane.events;
      patchRoom({ session: message.session, lanes });
      return;
    }
    case 'lane.events': {
      if (getState().room?.sessionId !== message.sessionId) return;
      const kept = message.events.filter((e) => e.type !== 'tool_progress');
      if (kept.length === 0) return;
      patchRoom((room) => ({
        lanes: {
          ...room.lanes,
          [message.userId]: [...(room.lanes[message.userId] ?? []), ...kept],
        },
      }));
      return;
    }
    default:
      return;
  }
}

/** "Bob's agent finished" for sessions this person is in, while they look elsewhere. */
function noticeChanges(before: Session | undefined, after: Session): void {
  const self = me();
  if (!before || !self || !after.participants.some((p) => p.userId === self)) return;
  for (const p of after.participants) {
    if (p.userId === self) continue;
    const was = before.participants.find((x) => x.userId === p.userId)?.state;
    if (was && was !== 'idle' && p.state === 'idle')
      backgroundNotify(`${p.name}'s agent finished`, after.title);
  }
}

// ---------- the room ----------

let followed: string | null = null;

export async function openSession(sessionId: string): Promise<void> {
  const known = Object.values({ ...getState().sessions, ...getState().history })
    .flat()
    .find((x) => x.id === sessionId);
  if (followed && followed !== sessionId) void api.invoke('session:unfollow', followed);
  setState({
    room: {
      sessionId,
      session: known ?? null,
      lanes: {},
      blocker: null,
      joining: false,
      diff: null,
    },
  });
  showView('session');
  try {
    const session =
      known ?? (await request<{ session: Session }>('GET', `/api/sessions/${sessionId}`)).session;
    patchRoom({ session });
    if (session.status === 'ended') {
      void loadPlan(sessionId);
      // History: the stored transcript and the final diff, no live stream.
      followed = null;
      const [{ lanes }, { diff }] = await Promise.all([
        request<{ lanes: { userId: string; events: LaneEvent[] }[] }>(
          'GET',
          `/api/sessions/${sessionId}/transcript`,
        ),
        request<{ diff: string | null }>('GET', `/api/sessions/${sessionId}/diff`),
      ]);
      patchRoom({ lanes: Object.fromEntries(lanes.map((l) => [l.userId, l.events])), diff });
      return;
    }
    void loadPlan(sessionId);
    void loadActivity(sessionId);
    void loadSubagents(sessionId);
    void loadSwarm(sessionId);
    void loadAiAgents(session.workspaceId);
    void reloadMembers(session.workspaceId);
    if (followed !== sessionId) {
      followed = sessionId;
      await api.invoke('session:follow', sessionId);
    }
    await attachLane(session);
  } catch (error) {
    reportError(error);
  }
}

export function closeSession(): void {
  if (followed) void api.invoke('session:unfollow', followed);
  followed = null;
  setState({ room: null });
}

const checkoutInput = (session: Session) => ({
  id: session.id,
  workspaceId: session.workspaceId,
  title: session.title,
  branch: session.branch,
});

/** The session's checkout on this machine (the main one, or its own worktree), if it has one. */
export async function sessionCheckout(session: Session): Promise<string | null> {
  return api.invoke('session:checkoutOf', checkoutInput(session)).catch(() => null);
}

/** Opens the session's checkout in this window, making its worktree when needed. */
export async function openSessionCheckout(session: Session): Promise<boolean> {
  const { root, created } = await api.invoke('session:checkout', checkoutInput(session));
  if (getState().workspace?.root !== root) await openWorkspace(root);
  if (getState().workspace?.root !== root) return false; // they kept their unsaved work
  if (created)
    toast(`"${session.title}" has its own worktree, so your main checkout stays as it is.`);
  return true;
}

/** When this person has a lane here and its checkout is open, show their own conversation. */
async function attachLane(session: Session): Promise<void> {
  const self = me();
  const mine = session.participants.find((p) => p.userId === self && p.mode === 'join');
  if (!mine) return;
  const root = await sessionCheckout(session);
  if (!root || getState().workspace?.root !== root) return;
  const conversation = await api.invoke('session:lane', {
    id: session.id,
    workspaceId: session.workspaceId,
    title: session.title,
  });
  setState({ conversation });
  await attachSync(session);
}

/** The first reason this person can't take a lane here, from what the app already knows. */
function localBlocker(session: Session): string | null {
  const s = getState();
  if (!s.signedIn) return 'Sign in to join shared sessions.';
  if (s.connection !== 'online') return "You're offline; joining needs the Kovan server.";
  const role = workspaceOf(session.workspaceId)?.role;
  if (!role || !can(role, 'session.join'))
    return `Your role (${role ?? 'none'}) can watch this session but not run an agent in it. An owner can make you an editor.`;
  const seats = session.participants.filter((p) => p.mode === 'join' && p.userId !== me()).length;
  if (seats >= MAX_SESSION_AGENTS)
    return `This session is full: ${MAX_SESSION_AGENTS} agents are already working in it. You can watch.`;
  if (session.status !== 'active') return 'This session has ended.';
  return null;
}

/** Takes a lane: background checks first, then one clear reason if something is in the way. */
export async function joinSession(session: Session): Promise<boolean> {
  const local = localBlocker(session);
  if (local) {
    patchRoom({ blocker: { ok: false, reason: local, fix: null } });
    return false;
  }
  patchRoom({ joining: true, blocker: null });
  try {
    const bound = getState().bindings[session.workspaceId];
    if (bound) {
      // Its own worktree unless the main checkout is on the session's branch already.
      const opened = await openSessionCheckout(session);
      showView('session');
      if (!opened) return false;
    }
    const harness: Harness = getState().settings.agentHarness;
    const check = await api.invoke('session:precheck', {
      sessionId: session.id,
      workspaceId: session.workspaceId,
      branch: session.branch,
      harness,
    });
    if (!check.ok) {
      patchRoom({ blocker: check });
      return false;
    }
    const s = getState().settings;
    const { session: joined } = await request<{ session: Session }>(
      'POST',
      `/api/sessions/${session.id}/join`,
      {
        mode: 'join',
        harness,
        model: harness === 'kovan' ? s.agentModel : 'default',
      },
    );
    patchRoom({ session: joined });
    await attachLane(joined);
    return true;
  } catch (error) {
    reportError(error);
    return false;
  } finally {
    patchRoom({ joining: false });
  }
}

/** Runs the fix a join blocker offers, then tries again. */
export async function fixBlocker(session: Session): Promise<void> {
  const blocker = getState().room?.blocker;
  if (!blocker) return;
  try {
    if (blocker.fix === 'branch' || blocker.fix === 'checkout') {
      await openSessionCheckout(session);
      showView('session');
    } else if (blocker.fix === 'setup') {
      const ws = workspaceOf(session.workspaceId);
      if (ws) await openTeamWorkspace(ws);
      if (getState().view === 'setup') return;
      showView('session');
    } else if (blocker.fix === 'provider') {
      setState({ settingsSection: 'providers' });
      showView('settings');
      return;
    }
  } catch (error) {
    reportError(error);
    return;
  }
  await joinSession(session);
}

export async function watchSession(session: Session): Promise<void> {
  try {
    const { session: watched } = await request<{ session: Session }>(
      'POST',
      `/api/sessions/${session.id}/join`,
      { mode: 'watch' },
    );
    patchRoom({ session: watched });
  } catch (error) {
    reportError(error);
  }
}

export async function leaveSession(session: Session): Promise<void> {
  const lane = getState().conversation;
  if (lane?.session?.id === session.id && lane.running) await api.invoke('agent:stop', lane.id);
  try {
    const { session: left } = await request<{ session: Session }>(
      'POST',
      `/api/sessions/${session.id}/leave`,
    );
    patchRoom({ session: left });
    if (lane?.session?.id === session.id) setState({ conversation: null });
  } catch (error) {
    reportError(error);
  }
}

export async function endSession(session: Session): Promise<void> {
  if (!confirm(`End "${session.title}"? It moves to History with its transcript and final diff.`))
    return;
  try {
    const lane = getState().conversation;
    if (lane?.session?.id === session.id && lane.running) await api.invoke('agent:stop', lane.id);
    // The final diff comes from this machine's checkout of the session branch.
    const ws = workspaceOf(session.workspaceId);
    const root = await sessionCheckout(session);
    const local =
      ws && root && getState().workspace?.root === root
        ? await api.invoke('session:finalDiff', ws.defaultBranch).catch(() => null)
        : null;
    const { session: ended } = await request<{ session: Session }>(
      'POST',
      `/api/sessions/${session.id}/end`,
      { diff: local },
    );
    if (followed === ended.id) {
      void api.invoke('session:unfollow', ended.id);
      followed = null;
    }
    patchRoom({ session: ended, diff: local });
    toast('Session ended. It is in History now.');
  } catch (error) {
    reportError(error);
  }
}

export interface NewSessionInput {
  workspace: Workspace;
  title: string;
  /** null: work on the branch checked out now. */
  newBranch: string | null;
}

/** Starts a session in a shared workspace and takes the first lane in it. */
export async function startSession(input: NewSessionInput): Promise<boolean> {
  const s = getState();
  const bound = s.bindings[input.workspace.id];
  if (!bound) {
    toast(`Set up ${input.workspace.name} on this machine first.`, 'error');
    await openTeamWorkspace(input.workspace);
    return false;
  }
  try {
    // A new branch gets its own worktree when the session is joined; the main checkout's own
    // branch is used as it is.
    let branch = input.newBranch;
    if (!branch) {
      if (s.workspace?.root !== bound) await openTeamWorkspace(input.workspace);
      branch = await api.invoke('session:currentBranch');
    }
    const { session } = await request<{ session: Session }>(
      'POST',
      `/api/workspaces/${input.workspace.id}/sessions`,
      { title: input.title, branch },
    );
    completeStep('first-session');
    await openSession(session.id);
    await joinSession(session);
    return true;
  } catch (error) {
    reportError(error);
    return false;
  }
}

/**
 * Answers an approval card in any lane. Your own lane's goes through your agent (and the Brain);
 * a teammate's goes to the Brain, which tells their machine. First answer wins.
 */
export async function answerTeamApproval(
  sessionId: string,
  laneUserId: string,
  requestId: string,
  approved: boolean,
): Promise<void> {
  const lane = getState().conversation;
  try {
    if (laneUserId === me() && lane?.session?.id === sessionId) {
      await api.invoke('agent:approve', lane.id, requestId, approved);
      return;
    }
    await request('POST', `/api/sessions/${sessionId}/approvals`, {
      laneUserId,
      requestId,
      approved,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/already answered/i.test(message)) toast('Someone already answered this one.');
    else reportError(error);
  }
}

/** "claude · codex": who runs the agents in a session. */
export function harnessLine(session: Session): string {
  const names = new Set(
    session.participants
      .filter((p) => p.mode === 'join' && p.harness)
      .map((p) => HARNESS_NAMES[p.harness as Harness] ?? p.harness!),
  );
  return [...names].join(' · ');
}

export function sessionState(
  session: Session,
): 'running' | 'waiting' | 'awaiting' | 'idle' | 'ended' {
  if (session.status === 'ended') return 'ended';
  if (session.participants.some((p) => p.state === 'awaiting')) return 'awaiting';
  if (session.pendingApprovals > 0) return 'waiting';
  if (session.running.length > 0) return 'running';
  return 'idle';
}

export function openNewSession(): void {
  if (!getState().signedIn) {
    notify({
      kind: 'info',
      title: 'Sessions are shared',
      message: 'Sign in and add a shared workspace to start a session with your team.',
    });
    return;
  }
  setState({ newSessionOpen: true });
}
