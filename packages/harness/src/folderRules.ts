import { readFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, normalize, relative } from 'node:path';
import { AGENT_FILES } from './prompt.js';

const PER_FILE = 8_000;
const BUDGET = 32_000;

/**
 * Rules a repository keeps in its folders (`src/payments/KOVAN.md`, AGENTS.md, CLAUDE.md):
 * read the first time the agent touches something in that folder or below, and given to the
 * model from then on. The root's own are in the system prompt already.
 */
export class FolderRules {
  /** Folder (relative, "src/payments") → its rules, or null when it has none. */
  private readonly folders = new Map<string, string | null>();

  constructor(private readonly root: string) {}

  /**
   * Reads the rules of the folders around `path` not read yet. Returns the files that had
   * rules (new to the agent), so a write there can wait until the model has seen them.
   */
  async touch(path: string): Promise<string[]> {
    const rel = this.relative(path);
    if (rel === null) return [];
    const found: string[] = [];
    for (const folder of foldersOf(rel)) {
      if (this.folders.has(folder)) continue;
      const parts: string[] = [];
      for (const file of AGENT_FILES) {
        const text = await readFile(join(this.root, folder, file), 'utf8').catch(() => null);
        if (!text?.trim()) continue;
        parts.push(`${folder}/${file}:\n${text.trim().slice(0, PER_FILE)}`);
        found.push(`${folder}/${file}`);
      }
      this.folders.set(folder, parts.length ? parts.join('\n\n') : null);
    }
    return found;
  }

  /** Every folder's rules read so far, for the model (null when there are none). */
  note(): string | null {
    const parts = [...this.folders.values()].filter((t): t is string => t !== null);
    if (parts.length === 0) return null;
    let text = parts.join('\n\n');
    if (text.length > BUDGET) text = `${text.slice(0, BUDGET)}\n…`;
    return `Rules for folders you are working in (they apply to files in that folder and below):\n\n${text}`;
  }

  private relative(path: string): string | null {
    const abs = isAbsolute(path) ? path : join(this.root, path);
    const rel = relative(this.root, normalize(abs)).replace(/\\/g, '/');
    return !rel || rel.startsWith('..') ? null : rel;
  }
}

/** The folders a path lies in, from the top down, without the root itself. */
export function foldersOf(rel: string): string[] {
  const out: string[] = [];
  let dir = dirname(rel);
  while (dir && dir !== '.' && dir !== '/') {
    out.unshift(dir);
    dir = dirname(dir);
  }
  return out;
}
