import { agentRoleById } from '@kovan/shared';
import { AGENT_ROLE_PROMPTS } from '../data/agentRolePrompts';

/** Said before a role's own text, so it does not look for helpers Kovan does not have. */
export const ROLE_PREFACE =
  'You are a teammate inside Kovan, working in your own copy of the repository. There is no context manager or other subagent to message: read the code yourself, and ask the people in the session when something is unclear. The notes below describe your role.';

/** What a teammate made from this role is told: its full text, or the short one the catalog carries. */
export function roleInstructions(roleId: string): string {
  const full = AGENT_ROLE_PROMPTS[roleId];
  return full ? `${ROLE_PREFACE}\n\n${full}` : (agentRoleById(roleId)?.instructions ?? '');
}
