import { getState } from '../store';
import { updateSettings } from './settings';
import { pushOnboarding } from './team';

export type StepId =
  'verify-email' | 'connect-github' | 'start' | 'notifications' | 'first-session' | 'invite';

export interface Step {
  id: StepId;
  group: 'setup' | 'milestones';
  title: string;
}

export const STEPS: Step[] = [
  { id: 'verify-email', group: 'setup', title: 'Verify your email' },
  { id: 'connect-github', group: 'setup', title: 'Connect GitHub' },
  { id: 'start', group: 'setup', title: 'Start with Kovan' },
  { id: 'notifications', group: 'setup', title: 'Turn on notifications' },
  { id: 'first-session', group: 'milestones', title: 'Start your first session' },
  { id: 'invite', group: 'milestones', title: 'Invite a teammate to your workspace' },
];

export function isDone(id: StepId): boolean {
  return getState().settings.onboarding[id] === true;
}

export function completeStep(id: StepId): void {
  if (isDone(id)) return;
  const onboarding = { ...getState().settings.onboarding, [id]: true };
  void updateSettings({ onboarding });
  pushOnboarding({ [id]: true });
}

/** Steps that follow from the account itself. */
export function completeFromAccount(user: {
  emailVerified: boolean;
  githubLogin: string | null;
}): void {
  if (user.emailVerified) completeStep('verify-email');
  if (user.githubLogin) completeStep('connect-github');
}

export function doneCount(onboarding: Record<string, boolean>, group?: Step['group']): number {
  return STEPS.filter((s) => (!group || s.group === group) && onboarding[s.id]).length;
}
