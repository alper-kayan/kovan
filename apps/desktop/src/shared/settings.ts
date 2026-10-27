import { z } from 'zod';

export const SettingsSchema = z.object({
  theme: z.enum(['system', 'dark', 'light']).default('dark'),
  editorFontFamily: z.string().default("'Lilex Variable', 'SF Mono', Menlo, Consolas, monospace"),
  editorFontSize: z.number().int().min(8).max(40).default(13),
  editorTabSize: z.number().int().min(1).max(8).default(2),
  editorWordWrap: z.boolean().default(false),
  editorMinimap: z.boolean().default(true),
  terminalFontSize: z.number().int().min(8).max(40).default(13),
  /** Overrides of default keybindings: command id -> accelerator such as "Mod+Shift+P". */
  keybindings: z.record(z.string(), z.string()).default({}),
  /** Getting-started steps the person has completed, by step id. */
  onboarding: z.record(z.string(), z.boolean()).default({}),
  /** Ids of notices (banners, corner cards) the person dismissed. */
  dismissedNotices: z.array(z.string()).default([]),
  /** The person chose to use the app without an account for now. */
  signInSkipped: z.boolean().default(false),
  /** Defaults for new agent conversations. */
  agentModel: z.string().default('anthropic/claude-sonnet-5'),
  agentEffort: z
    .enum(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'])
    .nullable()
    .default(null),
  agentMode: z.enum(['plan', 'request', 'allow', 'full']).default('request'),
  agentHarness: z.enum(['kovan', 'claude-code', 'codex']).default('kovan'),
  /** New conversations let JevRouter pick the agent (Claude Code, Codex or Kovan). */
  agentAuto: z.boolean().default(true),
  /** When an agent's account runs out, continue the conversation with the next one. */
  agentFailover: z.boolean().default(true),
  /**
   * The person's order of agents and models, first to last: what Auto prefers and where a
   * conversation goes when an account runs out. The same agent can appear with several models.
   */
  agentOrder: z
    .array(
      z.object({
        harness: z.enum(['kovan', 'claude-code', 'codex']),
        model: z.string().min(1).max(200),
        /** One of the person's other Claude or OpenAI accounts; missing: the CLI's own sign-in. */
        account: z.string().min(1).max(64).optional(),
      }),
    )
    .max(24)
    .default([
      { harness: 'claude-code', model: 'default' },
      { harness: 'codex', model: 'default' },
      { harness: 'kovan', model: 'kovan/jevrouter' },
    ]),
  /** Ask before a switch moves the conversation from a subscription to pay-per-use models. */
  agentFailoverAskPaid: z.boolean().default(true),
  /** Repositories ("owner/name") where agents create GitHub issues without asking first. */
  issueNoAsk: z.array(z.string().max(200)).max(200).default([]),
  /**
   * Who Kovan's agent bills: "own" your OpenRouter key, "managed" Kovan's managed usage
   * (provider cost × 1.05), "auto" your key when you have one, else managed usage.
   */
  modelBilling: z.enum(['auto', 'own', 'managed']).default('auto'),
  /** Skills turned off, by name: listed in Settings, not given to Kovan's agents. */
  skillsOff: z.array(z.string().max(64)).max(500).default([]),
  /** Kovan's agents also use the person's Claude Code skills (~/.claude/skills, read only). */
  claudeSkills: z.boolean().default(false),
  /** MCP tools (`mcp__server__tool`) the person chose to always allow: they run without asking. */
  mcpAlwaysAllow: z.array(z.string().max(64)).max(500).default([]),
  /** Look for new versions and download them in the background. */
  autoUpdate: z.boolean().default(true),
  /** Bumped when stored defaults change; see migrateSettings. */
  settingsVersion: z.number().int().default(2),
});

export type Settings = z.infer<typeof SettingsSchema>;

/**
 * A partial update. Built from the field types without their defaults: `.partial()` on the main
 * schema would fill every missing key with its default and silently reset other settings.
 */
export const SettingsPatchSchema = z
  .object(
    Object.fromEntries(
      Object.entries(SettingsSchema.shape).map(([key, field]) => [
        key,
        (field instanceof z.ZodDefault ? field.unwrap() : field).optional(),
      ]),
    ),
  )
  .strict() as unknown as z.ZodType<Partial<Settings>>;

export const DEFAULT_SETTINGS: Settings = SettingsSchema.parse({});

const V1_DEFAULTS = {
  theme: 'system',
  editorFontFamily: "'SF Mono', Menlo, Monaco, 'Cascadia Code', Consolas, 'Courier New', monospace",
};

/**
 * Version 1 wrote every default to disk, so its old defaults look like choices. Drop the ones
 * that still equal the old defaults so the new defaults (dark theme, Lilex) apply.
 */
export function migrateSettings(raw: unknown): unknown {
  if (typeof raw !== 'object' || raw === null) return raw;
  const input = { ...(raw as Record<string, unknown>) };
  if (input['settingsVersion'] === undefined) {
    for (const [key, oldDefault] of Object.entries(V1_DEFAULTS)) {
      if (input[key] === oldDefault) delete input[key];
    }
    input['settingsVersion'] = 2;
  }
  // The order used to name agents only ("agentChain"); each one keeps its place.
  if (input['agentOrder'] === undefined && Array.isArray(input['agentChain']))
    input['agentOrder'] = input['agentChain'].map((harness: unknown) => ({
      harness,
      model: harness === 'kovan' ? 'kovan/jevrouter' : 'default',
    }));
  delete input['agentChain'];
  return input;
}

/** Parses stored settings, dropping invalid fields back to their defaults instead of failing. */
export function parseSettings(raw: unknown): Settings {
  const full = SettingsSchema.safeParse(raw);
  if (full.success) return full.data;
  const input = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {};
  const out: Record<string, unknown> = {};
  for (const [key, field] of Object.entries(SettingsSchema.shape)) {
    const parsed = field.safeParse(input[key]);
    out[key] = parsed.success ? parsed.data : DEFAULT_SETTINGS[key as keyof Settings];
  }
  return out as Settings;
}
