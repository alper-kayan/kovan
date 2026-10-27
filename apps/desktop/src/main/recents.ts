import { join } from 'node:path';
import type { RecentWorkspace } from '../shared/api.js';
import { readJson, writeJson } from '@kovan/runner';

const MAX_RECENTS = 15;

export class RecentWorkspaces {
  private readonly file: string;

  constructor(userDataDir: string) {
    this.file = join(userDataDir, 'recent-workspaces.json');
  }

  async list(): Promise<RecentWorkspace[]> {
    const raw = await readJson(this.file);
    if (!Array.isArray(raw)) return [];
    return raw.filter(
      (r): r is RecentWorkspace =>
        typeof r?.root === 'string' &&
        typeof r?.name === 'string' &&
        typeof r?.openedAt === 'number',
    );
  }

  async add(root: string, name: string): Promise<void> {
    const rest = (await this.list()).filter((r) => r.root !== root);
    await writeJson(
      this.file,
      [{ root, name, openedAt: Date.now() }, ...rest].slice(0, MAX_RECENTS),
    );
  }

  async forget(root: string): Promise<RecentWorkspace[]> {
    const next = (await this.list()).filter((r) => r.root !== root);
    await writeJson(this.file, next);
    return next;
  }
}
