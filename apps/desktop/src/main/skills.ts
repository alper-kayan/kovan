import { discoverSkills, skillPath, type SkillSet } from '@kovan/harness';
import { mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { SkillListing } from '../shared/api.js';
import type { Settings } from '../shared/settings.js';

/**
 * The skills Kovan's agents use: the workspace's (`.kovan/skills`, `.claude/skills`), the
 * person's own (`userData/skills`) and, when they chose it in Settings, their Claude Code
 * skills (`~/.claude/skills`, only ever read).
 */
export class SkillLibrary {
  readonly userDir: string;
  readonly claudeDir: string;

  constructor(
    userData: string,
    private readonly settings: () => Promise<Settings>,
    home = homedir(),
    /** The skill folders of the plugins on in a workspace. */
    private readonly plugins?: (root: string | null) => Promise<{ name: string; dir: string }[]>,
  ) {
    this.userDir = join(userData, 'skills');
    this.claudeDir = join(home, '.claude', 'skills');
  }

  /** What an agent working in `root` gets; read fresh each turn. */
  async forRoot(root: string | null): Promise<SkillSet> {
    const settings = await this.settings();
    return discoverSkills({
      root,
      userDir: this.userDir,
      claudeDir: settings.claudeSkills ? this.claudeDir : null,
      plugins: (await this.plugins?.(root).catch(() => [])) ?? [],
      off: settings.skillsOff,
    });
  }

  async listing(root: string | null): Promise<SkillListing> {
    const { skills, warnings } = await this.forRoot(root);
    return {
      skills: skills.map((s) => ({
        name: s.name,
        description: s.description,
        source: s.source,
        plugin: s.plugin ?? null,
        path: root ? skillPath(s, root) : s.dir,
        enabled: s.enabled,
      })),
      warnings,
      userDir: this.userDir,
      root,
    };
  }

  async ensureUserDir(): Promise<string> {
    await mkdir(this.userDir, { recursive: true });
    return this.userDir;
  }
}
