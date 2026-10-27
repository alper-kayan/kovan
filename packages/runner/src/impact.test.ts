import { git } from '@kovan/git-engine';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { changeImpact, impactLine } from './impact.js';

let repo: string;

beforeEach(async () => {
  repo = await mkdtemp(join(tmpdir(), 'kovan-impact-'));
  await git(repo, ['init', '-q', '-b', 'main']);
  const files: Record<string, string> = {
    'src/stats.ts': 'export const mean = (xs: number[]) => 0;\n',
    'src/summary.ts':
      "import { mean } from './stats.js';\nexport const summary = () => mean([]);\n",
    'src/routes.ts':
      "import { summary } from './summary';\napp.get('/summary', () => summary());\n",
    'src/app.ts':
      "import './routes';\nimport { x } from '@app/x';\nimport { y } from './missing';\n",
    'test/stats.test.ts': "import { mean } from '../src/stats';\n",
    'test/summary.test.ts': "import { summary } from '../src/summary.js';\n",
    'test/names.test.ts': "it('stats are fine', () => {});\n",
    'lib/thing.py': 'def thing(): pass\n',
    'tests/test_thing.py': 'from lib.thing import thing\n',
  };
  for (const [path, text] of Object.entries(files)) {
    await mkdir(join(repo, dirname(path)), { recursive: true });
    await writeFile(join(repo, path), text);
  }
});
afterEach(() => rm(repo, { recursive: true, force: true }));

describe('changeImpact', () => {
  it('follows imports for real and says how sure each link is', async () => {
    const impact = await changeImpact(repo, ['src/stats.ts']);
    const by = Object.fromEntries(impact.links.map((l) => [l.path, [l.kind, l.certainty]]));
    expect(by).toEqual({
      'src/summary.ts': ['module', 'imports'],
      'test/stats.test.ts': ['test', 'imports'],
      'src/routes.ts': ['api', 'imports_indirectly'],
      'test/summary.test.ts': ['test', 'imports_indirectly'],
      'src/app.ts': ['module', 'imports_indirectly'],
      'test/names.test.ts': ['test', 'mentions'],
    });
    expect(impact.links.find((l) => l.path === 'src/routes.ts')!.via).toEqual([
      'src/stats.ts',
      'src/summary.ts',
      'src/routes.ts',
    ]);
    // It says what it can't see.
    expect(impact.notes).toContain("1 relative import couldn't be resolved.");
    expect(impact.notes).toContain(
      'Package imports and path aliases (like @app/x) are not followed.',
    );
    expect(impactLine(impact)).toBe(
      '2 tests import it · 1 test only mentions it · 2 modules depend on it · 1 API route',
    );
  });

  it('links other languages by name only, and says so', async () => {
    const impact = await changeImpact(repo, ['lib/thing.py']);
    expect(impact.links).toEqual([
      {
        path: 'tests/test_thing.py',
        kind: 'test',
        certainty: 'mentions',
        via: ['lib/thing.py', 'tests/test_thing.py'],
      },
    ]);
    expect(impact.notes[0]).toBe(
      'Only JavaScript and TypeScript imports are followed; other files are linked by name.',
    );
  });

  it('reaches nothing from a file nobody uses', async () => {
    await writeFile(join(repo, 'src/alone.ts'), 'export const z = 1;\n');
    const impact = await changeImpact(repo, ['src/alone.ts']);
    expect(impact.links).toEqual([]);
    expect(impactLine(impact)).toBeNull();
  });
});
