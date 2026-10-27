import { describe, expect, it, vi } from 'vitest';

vi.mock('expo-updates', () => ({}));
vi.mock('react-native', () => ({ AppState: {} }));

const { onReturn, CHECK_EVERY_MS, SWITCH_AFTER_AWAY_MS } = await import('./updates');

describe('coming back to the app', () => {
  const now = 10 * CHECK_EVERY_MS;
  it('asks for an update when the last check is old', () => {
    expect(
      onReturn({ now, lastCheck: now - CHECK_EVERY_MS, awaySince: now - 1000, pending: false }),
    ).toBe('check');
    expect(onReturn({ now, lastCheck: now - 60_000, awaySince: now - 1000, pending: false })).toBe(
      'nothing',
    );
  });
  it('switches to a downloaded update only after being away a while', () => {
    expect(
      onReturn({ now, lastCheck: 0, awaySince: now - SWITCH_AFTER_AWAY_MS, pending: true }),
    ).toBe('switch');
    // Back from a quick look at another app: the banner offers it instead.
    expect(onReturn({ now, lastCheck: 0, awaySince: now - 30_000, pending: true })).toBe('nothing');
  });
});
