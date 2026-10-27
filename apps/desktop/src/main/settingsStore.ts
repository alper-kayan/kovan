import { join } from 'node:path';
import { migrateSettings, parseSettings, type Settings } from '../shared/settings.js';
import { readJson, writeJson } from '@kovan/runner';

export class SettingsStore {
  private current: Settings | null = null;
  private readonly listeners = new Set<(settings: Settings) => void>();
  private readonly file: string;

  constructor(userDataDir: string) {
    this.file = join(userDataDir, 'settings.json');
  }

  async get(): Promise<Settings> {
    this.current ??= parseSettings(migrateSettings(await readJson(this.file)));
    return this.current;
  }

  async update(patch: Partial<Settings>): Promise<Settings> {
    const next = parseSettings({ ...(await this.get()), ...patch });
    this.current = next;
    await writeJson(this.file, next);
    for (const listener of this.listeners) listener(next);
    return next;
  }

  onChange(listener: (settings: Settings) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}
