import { z } from 'zod';

// ---------- Phase 16: push notifications to the phone ----------

/** What a notification is about; a phone can turn each kind off. */
export const PushKindSchema = z.enum([
  'approval',
  'task',
  'finished',
  'handoff',
  'swarm',
  'limit',
  'message',
  'mention',
  'team',
]);
export type PushKind = z.infer<typeof PushKindSchema>;

/** The kinds as the phone's settings list them. */
export const PUSH_KINDS: { kind: PushKind; label: string; detail: string }[] = [
  { kind: 'approval', label: 'Approvals', detail: 'Your agent waits for a yes before acting.' },
  { kind: 'task', label: 'Task approvals', detail: 'A swarm task you launched needs a yes.' },
  { kind: 'finished', label: 'Agent finished', detail: 'Your agent finished its turn.' },
  { kind: 'handoff', label: 'Handed to you', detail: 'A teammate gave you their work.' },
  { kind: 'swarm', label: 'Swarms', detail: 'A swarm you launched finished, stopped or paused.' },
  { kind: 'limit', label: 'Usage limits', detail: 'An agent in your session ran out and waits.' },
  { kind: 'message', label: 'Agent messages', detail: 'An agent of a swarm wrote to you.' },
  { kind: 'mention', label: 'Mentions', detail: 'Someone called you by name in a comment.' },
  {
    kind: 'team',
    label: "Your team's questions",
    detail: "A teammate's agent or a swarm task waits for a yes that you can give too.",
  },
];

/** Kinds a phone starts with turned off: the person turns them on. */
export const PUSH_OFF_BY_DEFAULT: PushKind[] = ['team'];

export const RegisterDeviceSchema = z.object({
  platform: z.enum(['ios', 'android']),
  /** The platform's own token: an APNs device token or an FCM registration token. */
  token: z.string().min(8).max(4096),
  /** iOS development builds talk to Apple's sandbox host. */
  sandbox: z.boolean().default(false),
  appVersion: z.string().max(50).nullable().default(null),
});

export const UpdateDeviceSchema = z.object({ muted: z.array(PushKindSchema).max(20) });

export interface PushDevice {
  platform: 'ios' | 'android';
  muted: PushKind[];
  createdAt: string;
}

/**
 * What a notification carries for the app: enough to open the right screen, and for an
 * approval or a task, to answer it from the notification.
 */
export interface PushData {
  kind: PushKind;
  sessionId: string;
  laneUserId?: string;
  requestId?: string;
  stepId?: string;
}

/** Notification categories with buttons (identifiers without ':' or '-', for iOS). */
export const PUSH_CATEGORY = { approval: 'approval', task: 'task' } as const;
