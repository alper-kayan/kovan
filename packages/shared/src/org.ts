import { z } from 'zod';

/** Transcripts are kept this long unless the org says otherwise. */
export const DEFAULT_RETENTION_DAYS = 90;
export const MAX_RETENTION_DAYS = 3650;

export const OrgSettingsSchema = z.object({
  id: z.string(),
  name: z.string(),
  role: z.enum(['owner', 'member']),
  /** How long session transcripts are kept before they are deleted for good. */
  transcriptRetentionDays: z.number().int(),
});
export type OrgSettings = z.infer<typeof OrgSettingsSchema>;

export const UpdateOrgSchema = z
  .object({
    name: z.string().trim().min(1).max(80),
    transcriptRetentionDays: z.number().int().min(1).max(MAX_RETENTION_DAYS),
  })
  .partial();
export type UpdateOrg = z.infer<typeof UpdateOrgSchema>;

/** One line of an org's audit log. */
export const AuditEntrySchema = z.object({
  id: z.string(),
  workspaceId: z.string().nullable(),
  actorId: z.string().nullable(),
  actorName: z.string(),
  /** Dotted name: "member.role_changed", "org.retention_changed"… */
  action: z.string(),
  target: z.string().nullable(),
  meta: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])).nullable(),
  createdAt: z.string(),
});
export type AuditEntry = z.infer<typeof AuditEntrySchema>;

const AUDIT_LABELS: Record<string, string> = {
  'auth.signed_in': 'signed in',
  'auth.signed_out': 'signed out',
  'org.created': 'created the organization',
  'org.renamed': 'renamed the organization',
  'org.retention_changed': 'changed transcript retention',
  'workspace.created': 'created workspace',
  'workspace.updated': 'changed settings of workspace',
  'workspace.deleted': 'deleted workspace',
  'member.added': 'added',
  'member.role_changed': 'changed the role of',
  'member.removed': 'removed',
  'member.left': 'left workspace',
  'invite.created': 'invited',
  'invite.revoked': 'revoked the invite for',
  'invite.accepted': 'joined with an invite link:',
  'agent.created': 'added AI teammate',
  'agent.updated': 'changed AI teammate',
  'agent.deleted': 'removed AI teammate',
  'api_key.created': 'created API key',
  'api_key.revoked': 'revoked API key',
  'webhook.created': 'added webhook',
  'webhook.deleted': 'removed webhook',
  'machine.removed': 'removed machine',
  'billing.settings_changed': 'changed their Kovan billing limit',
  'billing.card_setup_started': 'started adding a card',
  'billing.payment_retried': 'retried a payment',
  'billing.team_settings_changed': 'changed team billing',
  'billing.team_turned_off': 'turned team billing off',
};

/** The action in words, for the log: "changed the role of". Unknown actions read as their name. */
export const auditLabel = (action: string): string => AUDIT_LABELS[action] ?? action;
