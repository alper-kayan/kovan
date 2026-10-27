import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, type Settings } from '../shared/settings.js';
import { SkillLibrary } from './skills.js';

let base: string;
beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), 'kovan-skill-lib-'));
});
afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

async function skill(dir: string, name: string, description: string) {
  await mkdir(join(dir, name), { recursive: true });
  await writeFile(
    join(dir, name, 'SKILL.md'),
    `---\nname: ${name}\ndescription: ${description}\n---\nBody`,
  );
}

describe('SkillLibrary', () => {
  it("reads Claude Code's skills only when the person chose them, and never writes there", async () => {
    const home = join(base, 'home');
    const claude = join(home, '.claude', 'skills');
    await skill(claude, 'from-claude', 'Claude one');
    const repo = join(base, 'repo');
    await skill(join(repo, '.kovan', 'skills'), 'release-notes', 'Notes');
    let settings: Settings = { ...DEFAULT_SETTINGS };
    const lib = new SkillLibrary(join(base, 'userData'), async () => settings, home);

    const before = await lib.listing(repo);
    expect(before.skills.map((s) => [s.name, s.source, s.path])).toEqual([
      ['release-notes', 'repo', '.kovan/skills/release-notes'],
    ]);
    settings = { ...settings, claudeSkills: true, skillsOff: ['release-notes'] };
    const after = await lib.listing(repo);
    expect(after.skills.map((s) => [s.name, s.enabled])).toEqual([
      ['release-notes', false],
      ['from-claude', true],
    ]);
    expect(after.skills[1]!.path).toBe(join(claude, 'from-claude'));
    expect(await readdir(join(home, '.claude'))).toEqual(['skills']);
    expect(await readdir(claude)).toEqual(['from-claude']);

    // Without a workspace only the person's own are listed.
    expect((await lib.listing(null)).skills.map((s) => s.name)).toEqual(['from-claude']);
    expect(await lib.ensureUserDir()).toBe(join(base, 'userData', 'skills'));
  });
});
