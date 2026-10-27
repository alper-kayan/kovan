import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SETTINGS,
  migrateSettings,
  parseSettings,
  SettingsPatchSchema,
} from './settings.js';

describe('parseSettings', () => {
  it('fills defaults for missing input', () => {
    expect(parseSettings(undefined)).toEqual(DEFAULT_SETTINGS);
  });

  it('keeps valid fields and resets only the invalid ones', () => {
    const parsed = parseSettings({ editorFontSize: 16, theme: 'purple', editorMinimap: false });
    expect(parsed.editorFontSize).toBe(16);
    expect(parsed.editorMinimap).toBe(false);
    expect(parsed.theme).toBe(DEFAULT_SETTINGS.theme);
  });
});

describe('migrateSettings', () => {
  it('replaces v1 defaults that were written to disk, keeping real choices', () => {
    const v1 = {
      theme: 'system',
      editorFontFamily:
        "'SF Mono', Menlo, Monaco, 'Cascadia Code', Consolas, 'Courier New', monospace",
      editorFontSize: 15,
    };
    const parsed = parseSettings(migrateSettings(v1));
    expect(parsed.theme).toBe('dark');
    expect(parsed.editorFontFamily).toContain('Lilex');
    expect(parsed.editorFontSize).toBe(15);
  });

  it('leaves current-version settings alone', () => {
    const current = { theme: 'system', settingsVersion: 2 };
    expect(parseSettings(migrateSettings(current)).theme).toBe('system');
  });
});

describe('SettingsPatchSchema', () => {
  it('keeps a patch partial instead of filling in defaults', () => {
    expect(SettingsPatchSchema.parse({ theme: 'light' })).toEqual({ theme: 'light' });
  });

  it('validates the fields it carries and rejects unknown ones', () => {
    expect(SettingsPatchSchema.safeParse({ editorFontSize: 99 }).success).toBe(false);
    expect(SettingsPatchSchema.safeParse({ surprise: true }).success).toBe(false);
  });
});

describe('agent order', () => {
  it('turns the old agent chain into steps with default models', () => {
    const parsed = parseSettings(migrateSettings({ agentChain: ['codex', 'kovan'] }));
    expect(parsed.agentOrder).toEqual([
      { harness: 'codex', model: 'default' },
      { harness: 'kovan', model: 'kovan/jevrouter' },
    ]);
  });

  it('keeps an order that ranks one agent with several models', () => {
    const agentOrder = [
      { harness: 'claude-code', model: 'opus' },
      { harness: 'kovan', model: '@deepinfra/deepseek-ai/DeepSeek-V3' },
      { harness: 'claude-code', model: 'sonnet' },
    ];
    expect(parseSettings(migrateSettings({ agentOrder })).agentOrder).toEqual(agentOrder);
  });
});
