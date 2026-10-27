import {
  parseCustomModelId,
  sameOption,
  type AgentOption,
  type ExternalHarness,
  type Harness,
} from './agent.js';

export type LimitStatus = 'ok' | 'near' | 'full';

/** One of an account's usage windows (Claude's 5-hour and weekly, Codex's primary and secondary). */
export interface LimitWindow {
  name: string;
  /** 0–1. */
  used: number;
  /** When the window starts over (ms since epoch), if the agent said. */
  resetsAt: number | null;
}

/**
 * Whose usage a turn spends: the Claude or OpenAI account behind an agent CLI, "kovan" for
 * OpenRouter and managed usage, or "@<id>" for a custom provider.
 */
export type LimitAccount = Harness | `@${string}` | `${ExternalHarness}#${string}`;

export function accountOf(option: AgentOption): LimitAccount {
  // Each of the person's Claude or OpenAI accounts has its own limits.
  if (option.harness !== 'kovan')
    return option.account ? `${option.harness}#${option.account}` : option.harness;
  const custom = parseCustomModelId(option.model);
  return custom ? `@${custom.provider}` : 'kovan';
}

/** What Kovan knows about an account's limit on this machine. */
export interface AgentLimit {
  account: LimitAccount;
  status: LimitStatus;
  windows: LimitWindow[];
  /** When a full limit opens again (ms since epoch), if known. */
  resetsAt: number | null;
  /** The agent's own words when it ran out. */
  reason: string | null;
  updatedAt: number;
}

/** From here on an agent counts as close to its limit. */
export const NEAR_LIMIT = 0.85;
/** A full limit with no known reset time is tried again after this long. */
const UNKNOWN_RESET_MS = 60 * 60_000;

const WINDOW_NAMES: Record<string, string> = {
  five_hour: '5-hour',
  seven_day: 'weekly',
  seven_day_opus: 'weekly Opus',
  seven_day_sonnet: 'weekly Sonnet',
};

/** 300 → "5-hour", 10080 → "weekly", 43200 → "30-day". */
function windowName(minutes: number): string {
  if (minutes === 10_080) return 'weekly';
  if (minutes % 1440 === 0) return `${minutes / 1440}-day`;
  if (minutes % 60 === 0) return `${minutes / 60}-hour`;
  return `${minutes}-minute`;
}

const seconds = (value: unknown): number | null =>
  typeof value === 'number' && value > 0 ? value * 1000 : null;

function summarize(
  windows: LimitWindow[],
  rejected: boolean,
  fallbackReset: number | null,
): Pick<AgentLimit, 'status' | 'windows' | 'resetsAt'> {
  const worst = [...windows].sort((a, b) => b.used - a.used)[0];
  const full = rejected || (worst?.used ?? 0) >= 1;
  return {
    status: full ? 'full' : (worst?.used ?? 0) >= NEAR_LIMIT ? 'near' : 'ok',
    windows,
    resetsAt: full ? (worst?.resetsAt ?? fallbackReset) : null,
  };
}

/** Claude Code's `rate_limit_event` (stream-json): `rate_limit_info`. */
export function claudeLimit(
  info: Record<string, unknown>,
): Pick<AgentLimit, 'status' | 'windows' | 'resetsAt'> {
  const unified = (info['unifiedWindows'] ?? {}) as Record<
    string,
    { utilization?: unknown; resetsAt?: unknown } | undefined
  >;
  const windows: LimitWindow[] = Object.entries(unified).flatMap(([key, w]) =>
    typeof w?.utilization === 'number'
      ? [{ name: WINDOW_NAMES[key] ?? key, used: w.utilization, resetsAt: seconds(w.resetsAt) }]
      : [],
  );
  return summarize(windows, info['status'] === 'rejected', seconds(info['resetsAt']));
}

/** Codex's `rate_limits` (from the thread's own session file). */
export function codexLimit(
  limits: Record<string, unknown>,
): Pick<AgentLimit, 'status' | 'windows' | 'resetsAt'> {
  const windows: LimitWindow[] = (['primary', 'secondary'] as const).flatMap((key) => {
    const w = limits[key] as Record<string, unknown> | null | undefined;
    if (!w || typeof w['used_percent'] !== 'number') return [];
    return [
      {
        name: typeof w['window_minutes'] === 'number' ? windowName(w['window_minutes']) : key,
        used: w['used_percent'] / 100,
        resetsAt: seconds(w['resets_at']),
      },
    ];
  });
  return summarize(windows, Boolean(limits['rate_limit_reached_type']), null);
}

/** A limit as it stands now: a full one opens again once its reset time has passed. */
export function limitNow(limit: AgentLimit, now: number): AgentLimit {
  if (limit.status !== 'full') return limit;
  const opens = limit.resetsAt ?? limit.updatedAt + UNKNOWN_RESET_MS;
  if (now < opens) return limit;
  return { ...limit, status: 'ok', windows: [], resetsAt: null, reason: null };
}

/**
 * When an agent's "you ran out" message says it opens again: "resets 7pm", "resets at 19:30",
 * "try again in 3 hours 20 minutes", or Claude's older "…|1791841200".
 */
export function resetFromMessage(message: string, now: number): number | null {
  const epoch = /\|(\d{10})\b/.exec(message);
  if (epoch) return Number(epoch[1]) * 1000;

  const span =
    /(?:try again|resets?|available)\s+in\s+((?:\d+\s*(?:days?|d|hours?|hrs?|h|minutes?|mins?|m)\b[\s,]*(?:and\s+)?)+)/i.exec(
      message,
    );
  if (span) {
    let ms = 0;
    for (const [, n, unit] of span[1]!.matchAll(/(\d+)\s*([a-z]+)/gi)) {
      const u = unit!.toLowerCase();
      ms += Number(n) * (u.startsWith('d') ? 86_400_000 : u.startsWith('h') ? 3_600_000 : 60_000);
    }
    if (ms > 0) return now + ms;
  }

  const clock = /resets?\s+(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b/i.exec(message);
  if (clock) {
    let hour = Number(clock[1]);
    const minute = Number(clock[2] ?? 0);
    const half = clock[3]?.toLowerCase();
    if (half === 'pm' && hour < 12) hour += 12;
    if (half === 'am' && hour === 12) hour = 0;
    if (hour > 23 || minute > 59) return null;
    const at = new Date(now);
    at.setHours(hour, minute, 0, 0);
    // A time already past today means tomorrow.
    if (at.getTime() <= now) at.setDate(at.getDate() + 1);
    return at.getTime();
  }
  return null;
}

/** "19:00", or "Tue 19:00" when it's not today. */
export function resetLabel(resetsAt: number, now: number): string {
  const at = new Date(resetsAt);
  const time = at.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  if (at.toDateString() === new Date(now).toDateString()) return time;
  if (resetsAt - now < 6 * 86_400_000)
    return `${at.toLocaleDateString([], { weekday: 'short' })} ${time}`;
  return at.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

/** One line for menus and settings: "Limit reached · opens 19:00", "88% of 5-hour limit used". */
export function limitLabel(limit: AgentLimit | undefined, now: number): string | null {
  if (!limit) return null;
  const l = limitNow(limit, now);
  if (l.status === 'full')
    return l.resetsAt ? `Limit reached · opens ${resetLabel(l.resetsAt, now)}` : 'Limit reached';
  const worst = [...l.windows].sort((a, b) => b.used - a.used)[0];
  if (!worst) return null;
  const used = `${Math.round(worst.used * 100)}% of ${worst.name} limit used`;
  return l.status === 'near' && worst.resetsAt
    ? `${used} · resets ${resetLabel(worst.resetsAt, now)}`
    : used;
}

/** The first step of the order, other than the current one, that can take a turn now. */
export function nextOption(
  order: AgentOption[],
  current: AgentOption | null,
  usable: (option: AgentOption) => boolean,
): AgentOption | null {
  return order.find((o) => !(current && sameOption(o, current)) && usable(o)) ?? null;
}

export interface HandoffContext {
  from: string;
  why: string;
  lastPrompts: string[];
  lastReply: string | null;
  touchedFiles: string[];
  /** Commands cut off mid-flight: nobody knows whether they happened. */
  unknownOutcomes: string[];
}

/** What the agent taking over is told: the task so far, and what not to repeat. */
export function handoffNote(c: HandoffContext): string {
  const parts = [
    `You are taking over this task from ${c.from}, which stopped mid-way (${c.why}). The files in this checkout are as it left them. Check the current state first (git status, the files below), then continue where it stopped. Don't start over and don't redo finished work.`,
    c.lastPrompts.length
      ? `What the person asked for, oldest first:\n${c.lastPrompts.map((p, i) => `${i + 1}. ${p}`).join('\n')}`
      : '',
    c.lastReply ? `The last thing ${c.from} said:\n${c.lastReply}` : '',
    c.touchedFiles.length
      ? `Files it changed:\n${c.touchedFiles.map((f) => `- ${f}`).join('\n')}`
      : '',
    c.unknownOutcomes.length
      ? `These commands were cut off and nobody knows whether they took effect. Do NOT run them again; tell the person and let them decide:\n${c.unknownOutcomes.map((f) => `- ${f}`).join('\n')}`
      : 'Do not re-run commands that reach beyond this machine (push, deploy, publish, migrations) unless the person asks again.',
  ];
  return parts.filter(Boolean).join('\n\n');
}
