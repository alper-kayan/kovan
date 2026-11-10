import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The model lists the two CLIs keep for themselves, read as they are: Claude Code's `cache/model-catalog` and Codex's `models_cache.json`.
 * They are what each CLI shows in its own model picker (names, one-line descriptions, the effort levels each model takes), so nothing here
 * is typed in by hand and a new model appears as soon as the CLI has seen it.
 */
export interface EngineModel {
  id: string;
  name: string;
  description: string;
  /** Shown first when true; the rest are older or less used models. */
  main: boolean;
  levels: string[] | null;
  defaultLevel: string | null;
}

const strings = (v: unknown): string[] | null =>
  Array.isArray(v) && v.every((x) => typeof x === 'string') ? (v as string[]) : null;

/** Claude Code's models, newest catalog first. Empty when it has not fetched one yet. */
export function claudeCatalog(configDir: string): EngineModel[] {
  const dir = join(configDir, 'cache', 'model-catalog');
  let best: { at: number; models: unknown[] } | null = null;
  try {
    for (const f of readdirSync(dir)) {
      if (!f.endsWith('.json')) continue;
      try {
        const j = JSON.parse(readFileSync(join(dir, f), 'utf8')) as {
          fetchedAt?: number;
          catalog?: { surface?: string; config?: { models?: unknown[] } };
        };
        if (j.catalog?.surface !== 'cc') continue;
        const at = j.fetchedAt ?? 0;
        if (!best || at > best.at) best = { at, models: j.catalog.config?.models ?? [] };
      } catch {
        // an unreadable file is skipped
      }
    }
  } catch {
    return [];
  }
  const out: EngineModel[] = [];
  for (const m of (best?.models ?? []) as Record<string, unknown>[]) {
    if (typeof m['id'] !== 'string' || typeof m['name'] !== 'string') continue;
    const rt = (m['runtime'] ?? {}) as Record<string, unknown>;
    out.push({
      id: m['id'],
      name: m['name'],
      description: typeof m['description'] === 'string' ? m['description'] : '',
      main: m['section'] === 'main',
      levels: strings(rt['effort_levels']),
      defaultLevel: typeof rt['default_effort'] === 'string' ? rt['default_effort'] : null,
    });
  }
  return out;
}

/** Codex's models that its own picker lists (the ones it hides are left out). */
export function codexCatalog(codexHome: string): EngineModel[] {
  try {
    const j = JSON.parse(readFileSync(join(codexHome, 'models_cache.json'), 'utf8')) as {
      models?: Record<string, unknown>[];
    };
    const out: EngineModel[] = [];
    for (const m of j.models ?? []) {
      if (typeof m['slug'] !== 'string' || m['visibility'] === 'hide') continue;
      const levels = Array.isArray(m['supported_reasoning_levels'])
        ? (m['supported_reasoning_levels'] as { effort?: unknown }[])
            .map((l) => l.effort)
            .filter((e): e is string => typeof e === 'string')
        : null;
      out.push({
        id: m['slug'],
        name: typeof m['display_name'] === 'string' ? m['display_name'] : m['slug'],
        description: typeof m['description'] === 'string' ? m['description'] : '',
        main: true,
        levels: levels?.length ? levels : null,
        defaultLevel:
          typeof m['default_reasoning_level'] === 'string' ? m['default_reasoning_level'] : null,
      });
    }
    return out;
  } catch {
    return [];
  }
}
