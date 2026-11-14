import { suggestTeam } from '@kovan/jevrouter';
import type { AiAgent } from '@kovan/shared';
import { t } from '../i18n';
import { activeTeamWorkspace, getState, setState, toast } from '../store';
import { sendPrompt } from './agent';
import { startSession } from './sessions';
import { createDefaultTeam, launchSwarm, saveSwarm } from './swarm';
import { workspaceMode } from './team';

/** What a swarm may spend before it pauses, when it is started from one sentence. */
const QUICK_BUDGET = 2;

/** Whether a goal typed on the start screen can go to a lead and a team: an account and a shared folder. */
export function canStartTeam(): boolean {
  const s = getState();
  const ws = activeTeamWorkspace(s);
  return s.signedIn && ws !== null && (ws.role === 'owner' || ws.role === 'editor');
}

/** "kovan/" and the goal's first words, with a short tail so two goals never share a branch. */
function branchFor(goal: string): string {
  const slug = goal
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 36)
    .replace(/-$/g, '');
  return `kovan/${slug || 'task'}-${Date.now().toString(36).slice(-4)}`;
}

/**
 * The start screen's one box. With an account and a shared folder the goal goes to a lead: a
 * session is opened for it, a team is set up if the workspace has none, the lead splits the goal
 * and starts its agents, and their lanes show up in the session as they begin. Otherwise the
 * goal is simply your agent's first message.
 */
export async function startFromGoal(goal: string): Promise<'swarm' | 'chat' | null> {
  const text = goal.trim();
  if (!text) return null;
  if (!canStartTeam()) {
    setState({ agentOpen: true });
    return (await sendPrompt(text, [])) ? 'chat' : null;
  }
  const ws = activeTeamWorkspace(getState())!;
  let agents = getState().aiAgents[ws.id] ?? [];
  let created: AiAgent[] = [];
  if (agents.length === 0) {
    created = await createDefaultTeam(ws.id, text);
    agents = getState().aiAgents[ws.id] ?? [];
  }
  if (agents.length === 0) return null;
  const title = text.split('\n')[0]!.slice(0, 80);
  if (!(await startSession({ workspace: ws, title, newBranch: branchFor(text), join: false })))
    return null;
  const session = getState().room?.session;
  if (!session) return null;
  // A team made for this goal: its lead first, the rest build. An existing team is sorted by the planner.
  const plan = created.length
    ? {
        leadId: created[0]!.id,
        workerIds: created.slice(1).map((a) => a.id),
        maxParallel: Math.max(1, created.length - 1),
      }
    : suggestTeam(text, agents, workspaceMode(ws) === 'solo' ? { maxWorkers: 2 } : {});
  const leadId = plan?.leadId ?? agents[0]!.id;
  const workerIds = plan?.workerIds ?? agents.slice(1, 3).map((a) => a.id);
  const saved = await saveSwarm(session.id, {
    goal: text,
    leadAgentId: leadId,
    agentIds: [leadId, ...workerIds],
    budget: QUICK_BUDGET,
    taskBudget: null,
    review: true,
    maxParallel: Math.min(4, plan?.maxParallel ?? 2),
    mode: 'allow',
  });
  if (!saved) return null;
  await launchSwarm(session, saved, 'here');
  toast(
    t(
      'The lead is splitting your goal. Its agents show up as lanes here as they start (budget ${budget}).',
      {
        budget: QUICK_BUDGET,
      },
    ),
  );
  return 'swarm';
}
