import { describe, expect, it } from 'vitest';
import { editProgress, partialStringField } from './partial.js';

describe('partialStringField', () => {
  it('reads a string that is still being written, escapes included', () => {
    expect(
      partialStringField('{"path":"a.ts","new_string":"const x = 1;\\nco', 'new_string'),
    ).toEqual({
      value: 'const x = 1;\nco',
      complete: false,
    });
    expect(partialStringField('{"path":"a.ts"', 'path')).toEqual({ value: 'a.ts', complete: true });
    expect(partialStringField('{"text":"say \\"hi\\" \\u00e7', 'text')).toEqual({
      value: 'say "hi" ç',
      complete: false,
    });
    // An escape cut in half waits for its second character.
    expect(partialStringField('{"text":"a\\', 'text')).toEqual({ value: 'a', complete: false });
    expect(partialStringField('{"path":"a', 'new_string')).toBeNull();
  });
});

describe('editProgress', () => {
  it("follows an edit as the model writes it, for Kovan's and Claude Code's tools", () => {
    const kovan =
      '{"path":"src/join.ts","old_string":"const RESERVE","new_string":"const RESERVE_TI';
    expect(editProgress(kovan)).toEqual({
      path: 'src/join.ts',
      anchor: 'const RESERVE',
      text: 'const RESERVE_TI',
    });
    const claude = '{"file_path":"/repo/a.ts","content":"export const a';
    expect(editProgress(claude)).toEqual({
      path: '/repo/a.ts',
      anchor: null,
      text: 'export const a',
    });
    expect(editProgress('{"command":"ls"}')).toBeNull();
  });
});
