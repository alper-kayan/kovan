import { getState } from '../store';
import { updateSettings } from './settings';
import { pushOnboarding } from './team';

export type StepId =
  'start' | 'ai' | 'verify-email' | 'connect-github' | 'notifications' | 'first-session' | 'invite';

export interface Step {
  id: StepId;
  group: 'setup' | 'milestones';
  title: string;
}

/** In the order that gets someone working soonest: a folder, an AI that runs, then the rest. */
export const STEPS: Step[] = [
  { id: 'start', group: 'setup', title: 'Open a project folder' },
  { id: 'ai', group: 'setup', title: 'Get an AI agent ready' },
  { id: 'verify-email', group: 'setup', title: 'Verify your email' },
  { id: 'connect-github', group: 'setup', title: 'Connect GitHub' },
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

/** The guide opens by itself once, the first time someone gets past the sign-in screen. */
export const INTRODUCED = 'introduced';
