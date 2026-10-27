import { describe, expect, it } from 'vitest';
import { parseBlocks } from './markdown';

describe('parseBlocks', () => {
  it('splits code fences, headings, lists and paragraphs', () => {
    expect(
      parseBlocks(
        '# Plan\n\n1. Read\n2. Edit\n\n```ts\nconst a = 1;\n```\nDone, see `src/a.ts:3`.',
      ),
    ).toEqual([
      { kind: 'heading', level: 1, text: 'Plan' },
      { kind: 'list', ordered: true, items: ['Read', 'Edit'] },
      { kind: 'code', lang: 'ts', text: 'const a = 1;' },
      { kind: 'paragraph', text: 'Done, see `src/a.ts:3`.' },
    ]);
  });

  it('keeps an unterminated fence as code', () => {
    expect(parseBlocks('```\nstreaming…')).toEqual([
      { kind: 'code', lang: '', text: 'streaming…' },
    ]);
  });
});
