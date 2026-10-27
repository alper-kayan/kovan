import { open, readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

const TAIL_BYTES = 256 * 1024;

/** The newest day folders under ~/.codex/sessions (YYYY/MM/DD), newest first. */
async function recentDays(sessions: string, max: number): Promise<string[]> {
  const desc = async (dir: string) =>
    (await readdir(dir).catch(() => [] as string[]))
      .filter((n) => /^\d+$/.test(n))
      .sort()
      .reverse();
  const out: string[] = [];
  for (const year of await desc(sessions))
    for (const month of await desc(join(sessions, year)))
      for (const day of await desc(join(sessions, year, month))) {
        out.push(join(sessions, year, month, day));
        if (out.length >= max) return out;
      }
  return out;
}

/**
 * The last `rate_limits` Codex recorded for a thread. `codex exec --json` doesn't print them, but
 * Codex writes them to the thread's own session file; Kovan only reads the file of a thread it
 * started, and never writes there.
 */
export async function readCodexRateLimits(
  threadId: string,
  home = process.env['CODEX_HOME'] || join(homedir(), '.codex'),
): Promise<Record<string, unknown> | null> {
  if (!/^[0-9a-f-]{8,64}$/i.test(threadId)) return null;
  for (const dir of await recentDays(join(home, 'sessions'), 14)) {
    const name = (await readdir(dir).catch(() => [] as string[])).find((n) =>
      n.endsWith(`${threadId}.jsonl`),
    );
    if (!name) continue;
    const file = await open(join(dir, name), 'r').catch(() => null);
    if (!file) return null;
    try {
      const { size } = await file.stat();
      const length = Math.min(size, TAIL_BYTES);
      const buffer = Buffer.alloc(length);
      await file.read(buffer, 0, length, size - length);
      const lines = buffer.toString('utf8').split('\n').reverse();
      for (const line of lines) {
        if (!line.includes('"rate_limits"')) continue;
        try {
          const found = findRateLimits(JSON.parse(line));
          if (found) return found;
        } catch {
          // The first line of the tail may be cut off.
        }
      }
      return null;
    } finally {
      await file.close();
    }
  }
  return null;
}

function findRateLimits(value: unknown, depth = 0): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || depth > 4) return null;
  const record = value as Record<string, unknown>;
  const direct = record['rate_limits'];
  if (direct && typeof direct === 'object') return direct as Record<string, unknown>;
  for (const child of Object.values(record)) {
    const found = findRateLimits(child, depth + 1);
    if (found) return found;
  }
  return null;
}
