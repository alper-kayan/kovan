import { describe, expect, it } from 'vitest';
import type { AgentOption } from './agent.js';
import {
  accountOf,
  claudeLimit,
  codexLimit,
  handoffNote,
  limitLabel,
  limitNow,
  nextOption,
  resetFromMessage,
  type AgentLimit,
} from './limits.js';

const NOW = new Date(2026, 9, 13, 15, 0, 0).getTime();
const at = (h: number, m = 0, day = 13) => new Date(2026, 9, day, h, m, 0).getTime();

describe('claudeLimit', () => {
  it('reads the usage windows Claude Code reports', () => {
    const limit = claudeLimit({
      status: 'allowed',
      resetsAt: 1791841200,
      unifiedWindows: {
        five_hour: { utilization: 0.09, resetsAt: 1791841200 },
        seven_day: { utilization: 0.02, resetsAt: 1792339200 },
      },
    });
    expect(limit.status).toBe('ok');
    expect(limit.windows).toEqual([
      { name: '5-hour', used: 0.09, resetsAt: 1791841200000 },
      { name: 'weekly', used: 0.02, resetsAt: 1792339200000 },
    ]);
    expect(limit.resetsAt).toBeNull();
  });

  it('is near from 85% and full when rejected, with the fullest window’s reset', () => {
    expect(
      claudeLimit({ status: 'allowed', unifiedWindows: { five_hour: { utilization: 0.9 } } })
        .status,
    ).toBe('near');
    const full = claudeLimit({
      status: 'rejected',
      resetsAt: 100,
      unifiedWindows: {
        five_hour: { utilization: 1, resetsAt: 200 },
        seven_day: { utilization: 0.4, resetsAt: 300 },
      },
    });
    expect(full.status).toBe('full');
    expect(full.resetsAt).toBe(200_000);
  });

  it('falls back to the top-level reset when no window is reported', () => {
    expect(claudeLimit({ status: 'rejected', resetsAt: 100 })).toMatchObject({
      status: 'full',
      resetsAt: 100_000,
    });
  });
});

describe('codexLimit', () => {
  it('reads Codex’s primary and secondary windows', () => {
    const limit = codexLimit({
      primary: { used_percent: 12.5, window_minutes: 300, resets_at: 1794502989 },
      secondary: { used_percent: 91, window_minutes: 10080, resets_at: 1794600000 },
      rate_limit_reached_type: null,
    });
    expect(limit.status).toBe('near');
    expect(limit.windows.map((w) => [w.name, w.used])).toEqual([
      ['5-hour', 0.125],
      ['weekly', 0.91],
    ]);
  });

  it('is full when Codex says a limit was reached', () => {
    const limit = codexLimit({
      primary: { used_percent: 100, window_minutes: 43200, resets_at: 1794502989 },
      secondary: null,
      rate_limit_reached_type: 'primary',
    });
    expect(limit).toMatchObject({ status: 'full', resetsAt: 1794502989000 });
    expect(limit.windows[0]!.name).toBe('30-day');
  });
});

describe('limitNow', () => {
  const full: AgentLimit = {
    account: 'claude-code',
    status: 'full',
    windows: [],
    resetsAt: at(19),
    reason: 'limit',
    updatedAt: NOW,
  };

  it('keeps a full limit until its reset time, then opens it', () => {
    expect(limitNow(full, at(18, 59)).status).toBe('full');
    expect(limitNow(full, at(19)).status).toBe('ok');
  });

  it('tries again an hour later when the reset time is unknown', () => {
    const unknown = { ...full, resetsAt: null };
    expect(limitNow(unknown, NOW + 59 * 60_000).status).toBe('full');
    expect(limitNow(unknown, NOW + 61 * 60_000).status).toBe('ok');
  });
});

describe('resetFromMessage', () => {
  it('reads a clock time, today or tomorrow', () => {
    expect(resetFromMessage("You've hit your session limit · resets 7pm", NOW)).toBe(at(19));
    expect(resetFromMessage('5-hour limit reached ∙ resets at 19:30', NOW)).toBe(at(19, 30));
    expect(resetFromMessage('limit reached, resets 9am', NOW)).toBe(at(9, 0, 14));
  });

  it('reads a time span', () => {
    expect(
      resetFromMessage("You've hit your usage limit. Try again in 3 hours 20 minutes.", NOW),
    ).toBe(NOW + 200 * 60_000);
    expect(resetFromMessage('try again in 2 days', NOW)).toBe(NOW + 2 * 86_400_000);
  });

  it('reads an epoch and gives up on anything else', () => {
    expect(resetFromMessage('Claude AI usage limit reached|1791841200', NOW)).toBe(1791841200000);
    expect(resetFromMessage('429 Too Many Requests', NOW)).toBeNull();
  });
});

describe('limitLabel', () => {
  it('says when a full limit opens, and how full the fullest window is', () => {
    expect(
      limitLabel(
        {
          account: 'codex',
          status: 'full',
          windows: [],
          resetsAt: at(19),
          reason: null,
          updatedAt: NOW,
        },
        NOW,
      ),
    ).toMatch(/^Limit reached · opens /);
    expect(
      limitLabel(
        {
          account: 'codex',
          status: 'ok',
          windows: [
            { name: '5-hour', used: 0.42, resetsAt: null },
            { name: 'weekly', used: 0.1, resetsAt: null },
          ],
          resetsAt: null,
          reason: null,
          updatedAt: NOW,
        },
        NOW,
      ),
    ).toBe('42% of 5-hour limit used');
    expect(limitLabel(undefined, NOW)).toBeNull();
  });
});

describe('nextOption', () => {
  const order: AgentOption[] = [
    { harness: 'claude-code', model: 'opus' },
    { harness: 'kovan', model: '@deepinfra/deepseek-ai/DeepSeek-V3' },
    { harness: 'codex', model: 'default' },
    { harness: 'kovan', model: 'kovan/jevrouter' },
  ];

  it('takes the first usable step that isn’t the current one', () => {
    expect(nextOption(order, order[0]!, () => true)).toBe(order[1]);
    expect(nextOption(order, order[0]!, (o) => o.harness !== 'kovan')).toBe(order[2]);
    expect(nextOption(order, order[3]!, () => true)).toBe(order[0]);
    expect(nextOption(order, order[2]!, (o) => o.harness === 'codex')).toBeNull();
  });

  it('skips every step of an account that ran out', () => {
    const full = new Set(['@deepinfra', 'claude-code']);
    expect(nextOption(order, order[1]!, (o) => !full.has(accountOf(o)))).toBe(order[2]);
  });
});

describe('several accounts of one agent', () => {
  const order: AgentOption[] = [
    { harness: 'claude-code', model: 'default' },
    { harness: 'claude-code', model: 'default', account: 'work1234' },
    { harness: 'codex', model: 'default' },
  ];

  it('keeps each account’s limit apart, and moves to the other account when one runs out', () => {
    expect(accountOf(order[0]!)).toBe('claude-code');
    expect(accountOf(order[1]!)).toBe('claude-code#work1234');
    const full = new Set(['claude-code']);
    expect(nextOption(order, order[0]!, (o) => !full.has(accountOf(o)))).toBe(order[1]);
    // The same agent and model on another account is another step.
    expect(nextOption(order, order[1]!, () => true)).toBe(order[0]);
  });
});

describe('accountOf', () => {
  it('names whose usage a step spends', () => {
    expect(accountOf({ harness: 'claude-code', model: 'opus' })).toBe('claude-code');
    expect(accountOf({ harness: 'kovan', model: 'kovan/jevrouter' })).toBe('kovan');
    expect(accountOf({ harness: 'kovan', model: 'deepseek/deepseek-v3' })).toBe('kovan');
    expect(accountOf({ harness: 'kovan', model: '@deepinfra/deepseek-ai/DeepSeek-V3' })).toBe(
      '@deepinfra',
    );
  });
});

describe('handoffNote', () => {
  it('carries the task and forbids repeating cut-off commands', () => {
    const note = handoffNote({
      from: 'Claude Code',
      why: 'its account reached a usage limit',
      lastPrompts: ['Add a health route', 'and test it'],
      lastReply: 'I added the route.',
      touchedFiles: ['src/app.ts'],
      unknownOutcomes: ['git push origin main'],
    });
    expect(note).toContain('taking over this task from Claude Code');
    expect(note).toContain('1. Add a health route\n2. and test it');
    expect(note).toContain('- src/app.ts');
    expect(note).toContain('Do NOT run them again');
    expect(note).toContain('- git push origin main');
  });

  it('still warns about outward commands when none was cut off', () => {
    const note = handoffNote({
      from: 'Codex',
      why: 'x',
      lastPrompts: [],
      lastReply: null,
      touchedFiles: [],
      unknownOutcomes: [],
    });
    expect(note).toContain('Do not re-run commands that reach beyond this machine');
    expect(note).not.toContain('Files it changed');
  });
});
