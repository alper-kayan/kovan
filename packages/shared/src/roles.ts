import { z } from 'zod';

/** Workspace roles, lowest to highest. Each role includes everything below it. */
export const ROLES = ['viewer', 'commenter', 'editor', 'owner'] as const;
export const RoleSchema = z.enum(ROLES);
export type Role = z.infer<typeof RoleSchema>;

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
