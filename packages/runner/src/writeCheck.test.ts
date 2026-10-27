import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WriteCheck, type LiveWork } from './writeCheck.js';

let root: string;
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'kovan-writecheck-'));
  execFileSync('git', ['init', '-q'], { cwd: root });
  await mkdir(join(root, 'src'));
  await writeFile(
    join(root, 'src/cart.ts'),
    "import { price } from './price.js';\nexport const total = price;\n",
  );
  await writeFile(join(root, 'src/price.ts'), 'export const price = 1;\n');
  await writeFile(join(root, 'src/other.ts'), 'export const other = 1;\n');
});
afterAll(() => rm(root, { recursive: true, force: true }));

const owen = (over: Partial<LiveWork>): LiveWork => ({
  sessionId: 's2',
  title: 'Prices in cents',
  people: ['Owen'],
  touched: [],
  planned: [],
  locks: [],
  ...over,
});

describe('a write held before it collides with a teammate', () => {
  it('holds a file being changed elsewhere once, then lets it through', async () => {
    const check = new WriteCheck({
      root,
      others: async () => [owen({ touched: ['src/price.ts'] })],
    });
    const held = await check.check('src/price.ts');
    expect(held).toContain('Owen is changing src/price.ts right now in "Prices in cents"');
    expect(held).toContain('make it again and it goes ahead');
    // Told once: writing it again goes ahead.
    expect(await check.check('src/price.ts')).toBeNull();
    // An unrelated file is never held.
    expect(await check.check('src/other.ts')).toBeNull();
  });

  it('holds a file whose import is being changed elsewhere', async () => {
    const check = new WriteCheck({
      root,
      others: async () => [owen({ touched: ['src/price.ts'] })],
    });
    expect(await check.check('src/cart.ts')).toContain(
      'src/cart.ts imports src/price.ts, which Owen is changing',
    );
  });

  it('holds locked files, planned ones and new files that look like one being added', async () => {
    const check = new WriteCheck({
      root,
      others: async () => [
        owen({ locks: [{ path: 'src/other.ts', by: 'Owen' }] }),
        owen({ sessionId: 's3', title: 'Checkout', people: ['Maya'], planned: ['src/cart.ts'] }),
        owen({ sessionId: 's4', title: 'Coupons', people: ['Leo'], touched: ['lib/coupon.ts'] }),
      ],
    });
    expect(await check.check('src/other.ts')).toContain('locked by Owen');
    expect(await check.check('src/cart.ts')).toContain(
      '"Checkout" (Maya) plans to change src/cart.ts',
    );
    expect(await check.check('src/coupon.ts')).toContain(
      'Leo is adding lib/coupon.ts in "Coupons"; src/coupon.ts may duplicate it',
    );
  });

  it('goes ahead when it cannot tell', async () => {
    const check = new WriteCheck({
      root,
      others: async () => {
        throw new Error('offline');
      },
    });
    expect(await check.check('src/price.ts')).toBeNull();
  });
});
