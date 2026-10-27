import { describe, expect, it } from 'vitest';
import { findCommand, formatAccelerator, matches, resolveKeybindings } from './keybindings.js';

const key = (
  k: string,
  mods: Partial<{ meta: boolean; ctrl: boolean; alt: boolean; shift: boolean }> = {},
) => ({
  key: k,
  metaKey: mods.meta ?? false,
  ctrlKey: mods.ctrl ?? false,
  altKey: mods.alt ?? false,
  shiftKey: mods.shift ?? false,
});

describe('keybindings', () => {
  it('maps Mod to Cmd on macOS and Ctrl elsewhere', () => {
    expect(matches(key('k', { meta: true }), 'Mod+K', true)).toBe(true);
    expect(matches(key('k', { ctrl: true }), 'Mod+K', true)).toBe(false);
    expect(matches(key('k', { ctrl: true }), 'Mod+K', false)).toBe(true);
  });

  it('requires exact modifiers', () => {
    expect(matches(key('K', { meta: true, shift: true }), 'Mod+K', true)).toBe(false);
  });

  it('ignores the shifted form of punctuation', () => {
    expect(matches(key('~', { meta: true, shift: true }), 'Mod+Shift+`', true)).toBe(true);
    expect(matches(key('<', { meta: true, shift: true }), 'Mod+Shift+,', true)).toBe(true);
  });

  it('applies overrides and lets an empty override unbind', () => {
    const bindings = resolveKeybindings({ 'palette.commands': 'Mod+Shift+P', 'file.save': '' });
    expect(bindings['palette.commands']).toBe('Mod+Shift+P');
    expect(bindings['file.save']).toBeUndefined();
    expect(findCommand(key('p', { meta: true, shift: true }), bindings, true)).toBe(
      'palette.commands',
    );
    expect(findCommand(key('s', { meta: true }), bindings, true)).toBeNull();
  });

  it('formats for each platform', () => {
    expect(formatAccelerator('Mod+Shift+P', true)).toBe('⇧⌘P');
    expect(formatAccelerator('Mod+Shift+P', false)).toBe('Ctrl+Shift+P');
  });
});
