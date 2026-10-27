import { describe, expect, it } from 'vitest';
import { fuzzyFilter, fuzzyScore } from './fuzzy';

describe('fuzzyScore', () => {
  it('matches subsequences and rejects non-matches', () => {
    expect(fuzzyScore('abc', 'a-b-c')).not.toBeNull();
    expect(fuzzyScore('abd', 'abc')).toBeNull();
    expect(fuzzyScore('', 'anything')).toBe(0);
  });

  it('ranks file-name and word-start matches above scattered ones', () => {
    const files = ['src/components/README.md', 'src/main/index.ts', 'docs/index-notes.md'];
    expect(fuzzyFilter('index', files, (f) => f)[0]).toBe('src/main/index.ts');
    expect(fuzzyFilter('smi', files, (f) => f)[0]).toBe('src/main/index.ts');
  });
});
