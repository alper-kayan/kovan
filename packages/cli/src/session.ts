import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { ChatMessage } from '@kovan/model-gateway';

/**
 * Conversations kept on this machine so `kovan -c` can pick one up again.
 *
 * One file per session, readable only by the user: a transcript holds whatever was pasted into it. The system prompt is
 * not saved (it is rebuilt from the folder each time, so a changed KOVAN.md applies on resume).
 */
export interface SessionMeta {
  id: string;
  title: string;
  cwd: string;
  model: string;
  createdAt: string;
  updatedAt: string;
  turns: number;
}

export const SESSIONS_DIR = join(homedir(), '.kovan', 'sessions');

export class SessionStore {
  constructor(private readonly dir: string = SESSIONS_DIR) {}

  create(cwd: string, model: string, now: Date = new Date()): SessionMeta {
    const at = now.toISOString();
    return {
      id: `kv_${randomUUID().replace(/-/g, '').slice(0, 12)}`,
      title: '',
      cwd,
      model,
      createdAt: at,
      updatedAt: at,
      turns: 0,
    };
  }

  private file(id: string) {
    return join(this.dir, `${id.replace(/[^A-Za-z0-9_-]/g, '')}.json`);
  }

  /** `messages` without the system prompt. */
  save(meta: SessionMeta, messages: ChatMessage[]): void {
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    const file = this.file(meta.id);
    writeFileSync(file, JSON.stringify({ meta, messages }), { mode: 0o600 });
    chmodSync(file, 0o600);
  }

  load(id: string): { meta: SessionMeta; messages: ChatMessage[] } | null {
    try {
      const v = JSON.parse(readFileSync(this.file(id), 'utf8')) as {
        meta?: SessionMeta;
        messages?: ChatMessage[];
      };
      return v.meta && Array.isArray(v.messages) ? { meta: v.meta, messages: v.messages } : null;
    } catch {
      return null;
    }
  }

  list(): SessionMeta[] {
    if (!existsSync(this.dir)) return [];
    const out: SessionMeta[] = [];
    for (const f of readdirSync(this.dir)) {
      if (!f.endsWith('.json')) continue;
      const s = this.load(f.slice(0, -5));
      if (s) out.push(s.meta);
    }
    return out.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  latestFor(cwd: string): SessionMeta | null {
    return this.list().find((m) => m.cwd === cwd) ?? null;
  }
}

const textOf = (c: unknown): string =>
  typeof c === 'string'
    ? c
    : Array.isArray(c)
      ? c
          .map((p) =>
            p && typeof p === 'object' && 'text' in p ? String((p as { text: unknown }).text) : '',
          )
          .join('')
      : '';

export interface Digest {
  tool: 'kovan';
  sessionId: string;
  title: string;
  cwd: string;
  createdAt: string;
  updatedAt: string;
  firstPrompt: string;
  lastAnswer: string;
  files: string[];
}

const EDIT_TOOLS = new Set(['edit_file', 'write_file']);

/**
 * What a surrounding tool may remember of a session: what was asked first, how it ended, which files it changed. Read straight off the
 * transcript; nothing is summarised by a model.
 */
export function digestOf(meta: SessionMeta, messages: ChatMessage[]): Digest {
  const firstPrompt =
    messages
      .filter((m) => m.role === 'user')
      .map((m) => textOf(m.content).trim())
      .find(Boolean) ?? '';
  const lastAnswer =
    [...messages]
      .reverse()
      .filter((m) => m.role === 'assistant')
      .map((m) => textOf(m.content).trim())
      .find(Boolean) ?? '';
  const files = new Set<string>();
  for (const m of messages) {
    if (m.role !== 'assistant') continue;
    for (const call of m.tool_calls ?? []) {
      if (!EDIT_TOOLS.has(call.function.name)) continue;
      try {
        const p = (JSON.parse(call.function.arguments) as { path?: unknown }).path;
        if (typeof p === 'string') files.add(p);
      } catch {
        /* an argument string that is not JSON names no file */
      }
    }
  }
  return {
    tool: 'kovan',
    sessionId: meta.id,
    title: meta.title,
    cwd: meta.cwd,
    createdAt: meta.createdAt,
    updatedAt: meta.updatedAt,
    firstPrompt,
    lastAnswer,
    files: [...files],
  };
}
