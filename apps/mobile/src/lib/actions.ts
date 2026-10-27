import {
  can,
  type Action,
  type DeskAction,
  type Handoff,
  type Mention,
  type Outcome,
  type SessionApproval,
} from '@kovan/shared';
import { useMemo } from 'react';
import type { Board } from './board';
import { useSession } from './session';
import { useToast } from './toast';

/** Whether this person's role in a workspace allows an action (the server checks again). */
export function allowed(board: Board, workspaceId: string, action: Action): boolean {
  const role = board.workspaces.find((w) => w.id === workspaceId)?.role;
  return Boolean(role && can(role, action));
}

/**
 * What the phone can do, each a request the server checks by role. Each says how it went in a
 * toast and resolves to whether it worked. Work only a desktop can do goes to the person's own
 * desktop; its result arrives later (see LiveProvider).
 */
export function useActions() {
  const { api } = useSession();
  const { show } = useToast();
  return useMemo(() => {
    const run = async (work: () => Promise<unknown>, done?: string): Promise<boolean> => {
      try {
        await work();
        if (done) show(done);
        return true;
      } catch (e) {
        show(e instanceof Error ? e.message : String(e), 'error');
        return false;
      }
    };
    return {
      answerApproval: (a: SessionApproval, approved: boolean) =>
        run(
          () =>
            api('POST', `/api/sessions/${a.sessionId}/approvals`, {
              laneUserId: a.laneUserId,
              requestId: a.requestId,
              approved,
            }),
          approved ? 'Approved. The agent goes on.' : 'Denied. The agent skips it.',
        ),
      answerTask: (stepId: string, approve: boolean) =>
        run(
          () => api('POST', `/api/plan-steps/${stepId}/approval`, { approve }),
          approve ? 'Approved: an agent can start it.' : 'Rejected: no agent will start it.',
        ),
      steer: (
        sessionId: string,
        laneUserId: string,
        text: string,
        done = 'Sent. The agent gets it at its next step.',
      ) => run(() => api('POST', `/api/sessions/${sessionId}/steer`, { laneUserId, text }), done),
      recordOutcome: (o: Outcome, status: 'succeeded' | 'failed' | 'not_run') =>
        run(() => api('POST', `/api/outcomes/${o.id}`, { status }), 'Recorded.'),
      declineHandoff: (h: Handoff) =>
        run(() => api('POST', `/api/handoffs/${h.id}/decline`), 'Declined.'),
      setSwarmStatus: (swarmId: string, status: 'paused' | 'stopped') =>
        run(
          () => api('POST', `/api/swarms/${swarmId}/status`, { status, reason: null }),
          status === 'paused'
            ? 'Paused. Running tasks stop at their next step.'
            : 'Stopped. Its agents stop at their next step.',
        ),
      stopAgent: (swarmId: string, agentId: string, name: string) =>
        run(
          () => api('POST', `/api/swarms/${swarmId}/control`, { action: 'stop', agentId }),
          `Asked ${name} to stop.`,
        ),
      desk: (action: DeskAction) =>
        run(
          () => api('POST', '/api/desk', { action }),
          // A swarm may start on the workspace's machine instead; the answer says where.
          action.kind === 'launch' || action.kind === 'resume'
            ? 'Starting…'
            : 'Sent to your desktop…',
        ),
      /** Calls an AI teammate in with @: it reads the conversation and answers in it. */
      mention: (sessionId: string, name: string, mention: Mention) =>
        run(
          () => api('POST', `/api/sessions/${sessionId}/mention`, mention),
          `Sent to ${name}. Its answer comes back here.`,
        ),
      /** Your own agent: a new turn on your desktop, or guidance when it is working. */
      prompt: (sessionId: string, text: string) =>
        run(
          () => api('POST', '/api/desk', { action: { kind: 'prompt', sessionId, text } }),
          'Sent to your desktop…',
        ),
      /** An AI teammate gets a lane in the session, run by your desktop on your key. */
      addTeammate: (sessionId: string, agentId: string, name: string) =>
        run(
          () => api('POST', `/api/sessions/${sessionId}/agents`, { agentId }),
          `${name} joined. Message it below; your desktop runs it.`,
        ),
    };
  }, [api, show]);
}
