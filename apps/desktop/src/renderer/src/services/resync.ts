import type { ServerMessage } from '@kovan/shared';
import { getState } from '../store';
import { api } from './api';
import { loadComments, loadMemories, loadPlan } from './collab';
import { loadActivity } from './flow';
import { loadSessions } from './sessions';
import { loadAiAgents, loadSwarm } from './swarm';
import { loadSubagents } from './sync';

/**
 * Some of a workspace's changes were missed for good (a long disconnect, or the server
 * restarted): what this app shows of that workspace is read again. Short gaps never get here:
 * the server sends what was missed, in order, when the app follows the workspace again.
 */
async function resync(workspaceId: string): Promise<void> {
  const s = getState();
  const sessions = (s.sessions[workspaceId] ?? []).map((x) => x.id);
  const room = s.room?.session?.workspaceId === workspaceId ? s.room.sessionId : null;
  await Promise.allSettled([
    loadSessions(),
    loadAiAgents(workspaceId),
    loadComments(workspaceId),
    loadMemories(workspaceId),
    ...sessions.filter((id) => s.swarms[id]).map((id) => loadSwarm(id)),
    ...(room ? [loadPlan(room), loadActivity(room), loadSubagents(room)] : []),
  ]);
}

export function initResync(): void {
  api.on('brain:message', (message: ServerMessage) => {
    if (message.type === 'resync') void resync(message.workspaceId);
  });
}
