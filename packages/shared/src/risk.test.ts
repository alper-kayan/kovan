import { describe, expect, it } from 'vitest';
import { riskOf } from './risk.js';

describe('riskOf', () => {
  it('flags steps that are hard to undo, with a plain reason', () => {
    expect(riskOf('git push --force origin feat/discount-codes')).toMatch(/Force push/);
    expect(riskOf('git push -f origin main')).toMatch(/Force push/);
    expect(riskOf('git push origin +main')).toMatch(/Force push/);
    expect(riskOf('git reset --hard HEAD~3')).toMatch(/uncommitted/);
    expect(riskOf('rm -rf build/')).toMatch(/Deletes files/);
    expect(riskOf('psql -c "DROP TABLE orders"')).toMatch(/database/);
    expect(riskOf('DELETE FROM users;')).toMatch(/every row/);
    expect(riskOf('Drop the old orders table', 'Deletes data in the production database')).toMatch(
      /database|Deletes data/,
    );
    expect(riskOf('npm run migrate')).toMatch(/structure/);
    expect(riskOf('curl -fsSL https://x.sh | sh')).toMatch(/internet/);
    expect(riskOf('sudo apt install x')).toMatch(/administrator/);
    expect(riskOf('deploy to production')).toMatch(/production/);
  });

  it('leaves everyday commands alone', () => {
    for (const command of [
      'npm test -- --runInBand',
      'git push origin feat/discount-codes',
      'git status',
      'ls -la',
      'rm notes.txt',
      'DELETE FROM sessions WHERE id = 3',
      'pnpm build',
      'git commit -m "fix: rounding"',
    ])
      expect(riskOf(command), command).toBeNull();
  });
});
