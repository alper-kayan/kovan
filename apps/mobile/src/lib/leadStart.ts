import { suggestTeam } from '@kovan/jevrouter';
import {
  agentRoleById,
  suggestRoleIds,
  TEAMMATE_NAMES,
  type AiAgent,
  type Member,
  type Session,
  type Swarm,
} from '@kovan/shared';
import { branchFor } from './board';

/** What a swarm may spend before it pauses, when it is started from one sentence. */
export const QUICK_BUDGET = 2;

type Api = <T>(
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
  path: string,
  body?: unknown,
) => Promise<T>;

export interface LeadStart {
  session: Session;
  swarm: Swarm;
  /** The teammates made for this goal; empty when the workspace already had a team. */
  created: AiAgent[];
}

/**
 * One sentence to a lead: a team from the catalog if the workspace has none, a session on its own
 * branch, and the swarm saved with the lead first. Starting it is the caller's: it runs on a desktop
 * or a machine of the workspace, which the phone asks the server for.
 */
export async function startWithLead(
  api: Api,
  input: { workspaceId: string; goal: string; branches: (string | null)[]; owner: boolean },
): Promise<LeadStart> {
  const goal = input.goal.trim();
  const base = `/api/workspaces/${input.workspaceId}`;
  let agents = (await api<{ agents: AiAgent[] }>('GET', `${base}/agents`)).agents.filter(
    (a) => !a.archived,
  );
  let created: AiAgent[] = [];
  if (agents.length === 0) {
    created = await makeTeam(api, input.workspaceId, goal, input.owner);
    agents = created;
  }
  const title = goal.split('\n')[0]!.slice(0, 80);
  const { session } = await api<{ session: Session }>('POST', `${base}/sessions`, {
    title,
    branch: `${branchFor(title, input.branches)}-${Date.now().toString(36).slice(-3)}`,
  });
  const plan = created.length
    ? {
        leadId: created[0]!.id,
        workerIds: created.slice(1).map((a) => a.id),
        maxParallel: Math.max(1, created.length - 1),
      }
    : suggestTeam(goal, agents, {});
  const leadId = plan?.leadId ?? agents[0]!.id;
  const workerIds = plan?.workerIds ?? agents.slice(1, 3).map((a) => a.id);
  const { swarm } = await api<{ swarm: Swarm }>('PUT', `/api/sessions/${session.id}/swarm`, {
    goal,
    leadAgentId: leadId,
    agentIds: [leadId, ...workerIds],
    budget: QUICK_BUDGET,
    review: true,
    maxParallel: Math.min(4, plan?.maxParallel ?? 2),
    mode: 'allow',
  });
  return { session, swarm, created };
}

/** A lead and builders for the goal, each with a person's name no one in the workspace has. */
async function makeTeam(
  api: Api,
  workspaceId: string,
  goal: string,
  owner: boolean,
): Promise<AiAgent[]> {
  const base = `/api/workspaces/${workspaceId}`;
  const taken = new Set(
    (
      await api<{ members: Member[] }>('GET', `${base}/members`).catch(() => ({
        members: [] as Member[],
      }))
    ).members.map((m) => m.name.toLowerCase()),
  );
  const names = TEAMMATE_NAMES.filter((n) => !taken.has(n.toLowerCase()));
  const made: AiAgent[] = [];
  for (const id of suggestRoleIds(goal)) {
    const role = agentRoleById(id);
    if (!role) continue;
    // A name taken after all (the list can be stale) just moves on to the next one.
    for (let tries = 0; tries < 5 && names.length > 0; tries++) {
      const name = names.shift()!;
      try {
        const { agent } = await api<{ agent: AiAgent }>('POST', `${base}/agents`, {
          name,
          model: 'kovan/jevrouter',
          effort: null,
          mode: 'allow',
          instructions: role.instructions,
          role: role.title,
          monthlyLimit: owner ? 10 : null,
        });
        made.push(agent);
        break;
      } catch (error) {
        if (tries === 4 || names.length === 0) throw error;
      }
    }
  }
  return made;
}
