import type { ServerMessage } from '@kovan/shared';
import type { ConversationEvent } from '../../../shared/agent';
import { personColor } from '../components/ui';
import { getState, setState } from '../store';
import { typingMs } from '../components/liveTyping';
import { api } from './api';

/** An edit the agent finished that this checkout may not have yet (a swarm worker's, or a
 * teammate's): shown until it arrives in the file, so it doesn't vanish when the tool ends. */
export interface PendingEdit {
  toolId: string;
  /** Repo-relative: the agent may have moved on to another file since. */
  path: string;
  anchor: string | null;
  text: string;
  at: number;
}

/** Where an agent is working right now, for carets and typing in the editor and tab badges. */
export interface LiveAgent {
  key: string;
  name: string;
  /** The shared session it works in (null: this window's own agent, in this checkout). */
  sessionId: string | null;
  sessionTitle: string | null;
  /** "alice · agent" */
  label: string;
  color: string;
  mine: boolean;
  /** Repo-relative. */
  path: string;
  /** reading: looking at lines; typing: writing an edit; wrote: the edit just landed. */
  phase: 'reading' | 'typing' | 'wrote';
  line: number | null;
  /** The text the edit replaces, once known. */
  anchor: string | null;
  /** The new text, as far as it has been written. */
  text: string | null;
  toolId: string;
  at: number;
  /** Finished edits not yet seen in the file, oldest first. */
  pending: PendingEdit[];
}

/**
 * How long a finished edit may wait to arrive here (checks, review and sync come first). Long: all agents' work shows in the
 * one file, so an edit made in another copy stays there until it lands.
 */
const PENDING_MS = 30 * 60_000;

const READ_TOOLS = new Set(['read_file', 'Read']);
const EDIT_TOOLS = new Set([
  'edit_file',
  'write_file',
  'Edit',
  'MultiEdit',
  'Write',
  'apply_patch',
]);
const LINGER_MS = 6000;

const timers = new Map<string, ReturnType<typeof setTimeout>>();

function put(agent: LiveAgent): void {
  setState((s) => ({ liveAgents: { ...s.liveAgents, [agent.key]: agent } }));
}

function dropLater(key: string, ms: number, toolId?: string): void {
  clearTimeout(timers.get(key));
  timers.set(
    key,
    setTimeout(() => {
      const current = getState().liveAgents[key];
      if (!current || (toolId && current.toolId !== toolId)) return;
      // Finished edits still on their way stay; only what it was doing goes.
      const pending = current.pending.filter((p) => Date.now() - p.at < PENDING_MS);
      if (pending.length) {
        put({ ...current, phase: 'wrote', text: null, anchor: null, pending });
        dropLater(key, PENDING_MS - (Date.now() - pending[0]!.at));
        return;
      }
      setState((s) => {
        const next = { ...s.liveAgents };
        delete next[key];
        return { liveAgents: next };
      });
    }, ms),
  );
}

/**
 * Repo-relative, whatever the agent used (Claude Code gives absolute paths). A path in another copy of the repository (a
 * session's or a swarm worker's worktree under Kovan's data, `…/worktrees/<repo>-<hash>[/sub-<id>]/…`) is the same file here.
 */
export function relativePath(path: unknown, root = getState().workspace?.root): string | null {
  if (typeof path !== 'string' || !path) return null;
  if (root && path.startsWith(`${root}/`)) return path.slice(root.length + 1);
  const copy = /[\\/]worktrees[\\/][^\\/]+[\\/](?:sub-[0-9a-f]+[\\/])?(.+)$/.exec(path);
  if (copy) return copy[1]!.replace(/\\/g, '/');
  return path.startsWith('/') ? null : path.replace(/^\.\//, '');
}

/** Notes that an agent changed (or wrote out) a file, for the file tree: one mark per agent per file, the newest. */
function mark(agent: LiveAgent, path: string, text: string | null): void {
  setState((s) => {
    const marks = (s.agentFiles[path] ?? []).filter((m) => m.key !== agent.key);
    return {
      agentFiles: {
        ...s.agentFiles,
        [path]: [
          ...marks,
          {
            key: agent.key,
            name: agent.name,
            color: agent.color,
            mine: agent.mine,
            sessionTitle: agent.sessionTitle,
            at: Date.now(),
            text,
          },
        ],
      },
    };
  });
}

function firstString(args: Record<string, unknown>, keys: string[]): string | null {
  for (const k of keys) if (typeof args[k] === 'string') return args[k];
  return null;
}

/** Folds one agent event into what that agent is doing. */
export function observe(
  who: {
    key: string;
    name: string;
    mine: boolean;
    sessionId?: string | null;
    sessionTitle?: string | null;
  },
  event: ConversationEvent,
): void {
  const current = getState().liveAgents[who.key];
  const base = {
    key: who.key,
    name: who.name,
    label: `${who.name} · agent`,
    color: personColor(who.name),
    mine: who.mine,
    sessionId: who.sessionId ?? null,
    sessionTitle: who.sessionTitle ?? null,
    at: Date.now(),
    pending: (current?.pending ?? []).filter((p) => Date.now() - p.at < PENDING_MS),
  };
  switch (event.type) {
    case 'tool_progress': {
      const path = relativePath(event.path) ?? (current?.toolId === event.id ? current.path : null);
      if (!path) return;
      clearTimeout(timers.get(who.key));
      put({
        ...base,
        path,
        phase: 'typing',
        line: null,
        anchor: event.anchor,
        text: event.text,
        toolId: event.id,
      });
      return;
    }
    case 'tool_start': {
      const args = event.args ?? {};
      if (READ_TOOLS.has(event.name)) {
        const path = relativePath(firstString(args, ['path', 'file_path']));
        if (!path) return;
        const offset = args['offset'] ?? args['start_line'];
        put({
          ...base,
          path,
          phase: 'reading',
          line: typeof offset === 'number' && offset > 0 ? offset : 1,
          anchor: null,
          text: null,
          toolId: event.id,
        });
        dropLater(who.key, LINGER_MS, event.id);
        return;
      }
      if (!EDIT_TOOLS.has(event.name)) return;
      const changes = Array.isArray(args['changes'])
        ? (args['changes'] as { path?: unknown }[])
        : [];
      const path = relativePath(firstString(args, ['path', 'file_path']) ?? changes[0]?.path);
      if (!path) return;
      clearTimeout(timers.get(who.key));
      const edits = Array.isArray(args['edits'])
        ? (args['edits'] as Record<string, unknown>[])
        : [];
      put({
        ...base,
        path,
        phase: 'typing',
        line: null,
        anchor: firstString(args, ['old_string']) ?? firstString(edits[0] ?? {}, ['old_string']),
        // The whole edit is known now; the editor still types it out.
        text:
          firstString(args, ['new_string', 'content']) ??
          firstString(edits[0] ?? {}, ['new_string']) ??
          (current?.toolId === event.id ? current.text : null),
        toolId: event.id,
      });
      return;
    }
    case 'tool_end': {
      if (!current || current.toolId !== event.id) return;
      if (current.phase === 'typing' && event.ok) {
        // A whole file written out (no text replaced) is kept with the mark: a new file opens from it.
        mark(current, current.path, current.anchor === null ? current.text : null);
        // In this checkout the edit is in the file now. Elsewhere (a swarm worker's own copy, a
        // teammate's machine) it arrives later: keep it until it does.
        const elsewhere = current.sessionId !== null && current.text;
        put({
          ...current,
          phase: 'wrote',
          at: Date.now(),
          pending: elsewhere
            ? [
                ...current.pending,
                {
                  toolId: current.toolId,
                  path: current.path,
                  anchor: current.anchor,
                  text: current.text!,
                  at: Date.now(),
                },
              ]
            : current.pending,
        });
        dropLater(who.key, elsewhere ? PENDING_MS : LINGER_MS + typingMs(current.text), event.id);
        return;
      }
      if (!event.ok && current.pending.length === 0) dropLater(who.key, 500, event.id);
      else if (!event.ok) put({ ...current, phase: 'wrote', text: null, anchor: null });
      return;
    }
    case 'turn_end':
      if (current)
        dropLater(
          who.key,
          current.pending.length ? PENDING_MS : Math.max(2500, typingMs(current.text) + LINGER_MS),
        );
      return;
    default:
      return;
  }
}

/** Forgets a finished edit once the editor has seen it arrive (and shown it for a while). */
export function settle(key: string, toolId: string): void {
  const current = getState().liveAgents[key];
  if (!current?.pending.some((p) => p.toolId === toolId)) return;
  const pending = current.pending.filter((p) => p.toolId !== toolId);
  if (pending.length === 0 && current.phase === 'wrote' && current.toolId === toolId) {
    setState((s) => {
      const next = { ...s.liveAgents };
      delete next[key];
      return { liveAgents: next };
    });
    return;
  }
  put({ ...current, pending });
}

/**
 * Whether this window's editor shows an agent's work: its own agents always; a session's
 * agents only when that session's checkout on this machine is the one open.
 */
export function showsHere(
  agent: LiveAgent,
  root: string | null | undefined,
  roots: Record<string, string | null>,
): boolean {
  if (agent.sessionId === null) return true;
  return Boolean(root) && roots[agent.sessionId] === root;
}

/** Looks up (once) where a session's checkout is on this machine. */
function resolveRoot(session: {
  id: string;
  workspaceId: string;
  title: string;
  branch: string | null;
}): void {
  if (session.id in getState().liveRoots) return;
  setState((s) => ({ liveRoots: { ...s.liveRoots, [session.id]: null } }));
  void api
    .invoke('session:checkoutOf', {
      id: session.id,
      workspaceId: session.workspaceId,
      title: session.title,
      branch: session.branch,
    })
    .catch(() => null)
    .then((root) => setState((s) => ({ liveRoots: { ...s.liveRoots, [session.id]: root } })));
}

export function isLiveEvent(event: { type: string }): boolean {
  return event.type === 'tool_progress';
}

export function initLiveAgents(): void {
  // This window's own agents.
  api.on('agent:event', (conversationId, event) => {
    const s = getState();
    observe(
      {
        key: `me:${conversationId}`,
        name: s.user?.name ?? s.appInfo?.userName ?? 'you',
        mine: true,
      },
      event,
    );
  });
  // Teammates' agents, from the sessions this machine follows.
  api.on('brain:message', (message: ServerMessage) => {
    if (message.type !== 'lane.events' || message.userId === getState().user?.id) return;
    const session = Object.values(getState().sessions)
      .flat()
      .find((x) => x.id === message.sessionId);
    const name = session?.participants.find((p) => p.userId === message.userId)?.name ?? 'teammate';
    if (session) resolveRoot(session);
    for (const event of message.events)
      observe(
        {
          key: `${message.userId}`,
          name,
          mine: false,
          sessionId: message.sessionId,
          sessionTitle: session?.title ?? null,
        },
        event as unknown as ConversationEvent,
      );
  });
}
