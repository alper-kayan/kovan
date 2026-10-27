import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

/** Reads JSON from `path`, or returns undefined when the file is missing or unreadable. */
export async function readJson(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch {
    return undefined;
  }
}

let writes = 0;

/** Writes JSON atomically (temp file + rename) so a crash never leaves a half-written file. */
export async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  // A unique temp name per write, so overlapping saves of the same file never share one.
  const tmp = `${path}.${process.pid}.${++writes}.tmp`;
  await writeFile(tmp, JSON.stringify(value, null, 2) + '\n', 'utf8');
  await rename(tmp, path);
}
