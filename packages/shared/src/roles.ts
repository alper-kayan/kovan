import { z } from 'zod';

/** Workspace roles, lowest to highest. Each role includes everything below it. */
export const ROLES = ['viewer', 'commenter', 'editor', 'owner'] as const;
export const RoleSchema = z.enum(ROLES);
export type Role = z.infer<typeof RoleSchema>;

/** A role in words for the person who gets it: what they can do. */
export const ROLE_WORDS: Record<Role, string> = {
  viewer: 'a viewer: you can watch sessions and what the agents do',
  commenter: 'a commenter: you can watch and leave comments',
  editor: 'an editor: you can run agents and change the code',
  owner: 'an owner: you can also manage people and billing',
};

/** Every action the server authorizes, mapped to the lowest role allowed to do it. */
export const ACTION_MIN_ROLE = {
  // viewer: read everything in the workspace
  'session.view': 'viewer',
  'transcript.view': 'viewer',
  'diff.view': 'viewer',
  'plan.view': 'viewer',
  'memory.view': 'viewer',
  'history.view': 'viewer',

  // commenter: talk and hold work, no agent required
  'comment.create': 'commenter',
  'suggestion.create': 'commenter',
  'work.claim': 'commenter',
  'work.accept': 'commenter',
  'work.handBack': 'commenter',
  'work.markDone': 'commenter',

  // editor: everything agentic
  'session.start': 'editor',
  'session.join': 'editor',
  'session.invite': 'editor',
  'agent.prompt': 'editor',
  'agent.steer': 'editor',
  'agent.takeover': 'editor',
  'agent.spawnSubagent': 'editor',
  'approval.answer': 'editor',
  'plan.manage': 'editor',
  'work.assign': 'editor',
  'memory.edit': 'editor',
  /** The workspace's automatic Git sync switch: shared, whoever works in it. */
  'workspace.gitSync': 'editor',

  // owner: administration
  'workspace.manageMembers': 'owner',
  'workspace.manageRoles': 'owner',
  'workspace.manageSettings': 'owner',
  'workspace.delete': 'owner',
} as const satisfies Record<string, Role>;

export type Action = keyof typeof ACTION_MIN_ROLE;

export function roleRank(role: Role): number {
  return ROLES.indexOf(role);
}

export function hasAtLeast(role: Role, min: Role): boolean {
  return roleRank(role) >= roleRank(min);
}

export function can(role: Role, action: Action): boolean {
  return hasAtLeast(role, ACTION_MIN_ROLE[action]);
}

/**
 * Whether someone may answer for, or give work to, an agent's lane that isn't theirs (the server
 * checks the same): its own person and whoever runs that AI teammate always may; otherwise
 * owners, and every editor too when the workspace allows it.
 */
export function mayActOnLane(input: {
  role: Role | null | undefined;
  userId: string | null | undefined;
  lane: { userId: string; hostId?: string | null | undefined };
  othersAgents: 'owners' | 'editors' | undefined;
  action: 'approval.answer' | 'agent.steer';
}): boolean {
  const { role, userId, lane } = input;
  if (!role || !userId || !can(role, input.action)) return false;
  if (userId === lane.userId || userId === lane.hostId || role === 'owner') return true;
  return (input.othersAgents ?? 'owners') === 'editors';
}
