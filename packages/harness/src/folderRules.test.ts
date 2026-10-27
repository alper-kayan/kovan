import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FolderRules, foldersOf } from './folderRules.js';

let root: string;
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'kovan-rules-'));
  await mkdir(join(root, 'src/pay/cards'), { recursive: true });
  await writeFile(join(root, 'src/pay/KOVAN.md'), 'Cents only.\n');
  await writeFile(join(root, 'src/pay/cards/AGENTS.md'), 'Never log card numbers.\n');
});
afterAll(() => rm(root, { recursive: true, force: true }));

describe("folders' own rules", () => {
  it('lists the folders around a path, without the root', () => {
    expect(foldersOf('src/pay/cards/visa.ts')).toEqual(['src', 'src/pay', 'src/pay/cards']);
    expect(foldersOf('README.md')).toEqual([]);
  });

  it('reads each folder once, from the top down, and only inside the checkout', async () => {
    const rules = new FolderRules(root);
    expect(await rules.touch('src/pay/cards/visa.ts')).toEqual([
      'src/pay/KOVAN.md',
      'src/pay/cards/AGENTS.md',
    ]);
    expect(await rules.touch(join(root, 'src/pay/total.ts'))).toEqual([]);
    expect(await rules.touch('../outside/x.ts')).toEqual([]);
    const note = rules.note()!;
    expect(note.indexOf('Cents only.')).toBeLessThan(note.indexOf('Never log card numbers.'));
  });
});
