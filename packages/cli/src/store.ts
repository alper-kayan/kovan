import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AgentEvent, PermissionMode } from '@kovan/harness';
import type { ChatMessage, Effort } from '@kovan/model-gateway';
import { desktopDataDir } from './paths.js';

/**
 * Conversations, kept exactly where and how the Kovan desktop app keeps its own
 * (`<userData>/conversations/<sha1(root)[:16]>/<id>.json`), so a chat opened in the terminal is in the app's chat list for that folder,
 * with its transcript, and the app can open it and carry on. Nothing about this is private to the CLI: the format is the app's.
 *
 * A conversation is the folder it was held in (`root`, the repository's top), what was said (`events`, for the screen) and the model's own history
 * (`messages`, so the next turn continues). Titles come from the first prompt.
 */
export type ConversationEvent =
  AgentEvent | { type: 'user'; text: string; attachments: string[]; at: number };

export interface StoredConversation {
  id: string;
  title: string;
  updatedAt: number;
  cost: number;
  root: string;
  messages: ChatMessage[];
  events: ConversationEvent[];
  /** The desktop knows "claude-code" and "codex" too; the terminal agent is Kovan's own. */
  harness: 'kovan';
  auto: false;
  model: string;
  effort: Effort | null;
  mode: PermissionMode;
}

export interface ConversationSummary {
  id: string;
  title: string;
  updatedAt: number;
  cost: number;
  root: string;
  harness: string;
}

export function conversationsDirFor(dataDir: string, root: string): string {
  return join(dataDir, 'conversations', createHash('sha1').update(root).digest('hex').slice(0, 16));
}

/** What the screen does not need kept: a half-typed edit is replaced by the finished one. */
const KEEP = (e: ConversationEvent): boolean => e.type !== 'tool_progress';
export const keepEvent = KEEP;

export class ConversationStore {
  constructor(private readonly dataDir: string = desktopDataDir()) {}

  create(
    root: string,
    config: { model: string; effort: Effort | null; mode: PermissionMode },
    now: Date = new Date(),
  ): StoredConversation {
    return {
      id: randomUUID(),
      title: 'New chat',
      updatedAt: now.getTime(),
      cost: 0,
      root,
      messages: [],
      events: [],
      harness: 'kovan',
      auto: false,
      ...config,
    };
  }

  /** Written whole and moved into place, so the app never reads half a file. */
  save(c: StoredConversation): void {
    const dir = conversationsDirFor(this.dataDir, c.root);
    mkdirSync(dir, { recursive: true });
    const file = join(dir, `${c.id}.json`);
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify({ ...c, events: c.events.filter(KEEP) }), { mode: 0o600 });
    renameSync(tmp, file);
  }

  private read(file: string): StoredConversation | null {
    try {
      const c = JSON.parse(readFileSync(file, 'utf8')) as StoredConversation;
      return c && typeof c.id === 'string' && Array.isArray(c.messages) && Array.isArray(c.events)
        ? c
        : null;
    } catch {
      return null;
    }
  }

  load(root: string, id: string): StoredConversation | null {
    return this.read(
      join(conversationsDirFor(this.dataDir, root), `${id.replace(/[^A-Za-z0-9-]/g, '')}.json`),
    );
  }

  /** By id alone, in whichever folder it was held. */
  loadById(id: string): StoredConversation | null {
    const clean = id.replace(/[^A-Za-z0-9-]/g, '');
    for (const dir of this.dirs()) {
      const c = this.read(join(dir, `${clean}.json`));
      if (c) return c;
    }
    return null;
  }

  private dirs(): string[] {
    const base = join(this.dataDir, 'conversations');
    try {
      return readdirSync(base).map((d) => join(base, d));
    } catch {
      return [];
    }
  }

  /** Newest first, for one folder or for all of them. */
  list(root?: string): ConversationSummary[] {
    const dirs = root ? [conversationsDirFor(this.dataDir, root)] : this.dirs();
    const out: ConversationSummary[] = [];
    for (const dir of dirs) {
      let names: string[];
      try {
        names = readdirSync(dir);
      } catch {
        continue;
      }
      for (const name of names.filter((n) => n.endsWith('.json'))) {
        const c = this.read(join(dir, name));
        if (c)
          out.push({
            id: c.id,
            title: c.title,
            updatedAt: c.updatedAt,
            cost: c.cost,
            root: c.root,
            harness: c.harness ?? 'kovan',
          });
      }
    }
    return out.sort((a, b) => b.updatedAt - a.updatedAt);
  }

  /**
   * A conversation of Kovan's own agent by what you call it: its id (or at least its first four characters), its name, or a word of
   * its name. This folder's come first, then the newest. A word that fits several is not guessed: they come back as candidates.
   */
  find(
    query: string,
    root: string,
  ): { match: ConversationSummary | null; candidates: ConversationSummary[] } {
    const q = query.trim().toLowerCase();
    if (!q) return { match: null, candidates: [] };
    const here = (c: ConversationSummary) => (c.root === root ? 0 : 1);
    const all = this.list()
      .filter((c) => c.harness === 'kovan')
      .sort((a, b) => here(a) - here(b) || b.updatedAt - a.updatedAt);
    const exact = all.find((c) => c.id.toLowerCase() === q || c.title.toLowerCase() === q);
    if (exact) return { match: exact, candidates: [] };
    const byId = q.length >= 4 ? all.filter((c) => c.id.toLowerCase().startsWith(q)) : [];
    if (byId.length === 1) return { match: byId[0]!, candidates: [] };
    const byWord = all.filter((c) => c.title.toLowerCase().includes(q));
    if (byWord.length === 1 && byId.length === 0) return { match: byWord[0]!, candidates: [] };
    return { match: null, candidates: byId.length ? byId : byWord };
  }

  /** The newest conversation of Kovan's own agent in this folder: Claude Code's and Codex's are not ours to continue. */
  latestFor(root: string): ConversationSummary | null {
    return this.list(root).find((c) => c.harness === 'kovan') ?? null;
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
 * What a surrounding tool may remember of a conversation: what was asked first, how it ended, which files it changed. Read straight off the
 * transcript; nothing is summarised by a model.
 */
export function digestOf(c: StoredConversation): Digest {
  const firstUser = c.events.find(
    (e): e is Extract<ConversationEvent, { type: 'user' }> => e.type === 'user',
  );
  const firstPrompt =
    firstUser?.text.trim() ||
    c.messages
      .filter((m) => m.role === 'user')
      .map((m) => textOf(m.content).trim())
      .find(Boolean) ||
    '';
  const lastAnswer =
    [...c.messages]
      .reverse()
      .filter((m) => m.role === 'assistant')
      .map((m) => textOf(m.content).trim())
      .find(Boolean) ?? '';
  const files = new Set<string>();
  for (const m of c.messages) {
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
    sessionId: c.id,
    title: c.title === 'New chat' ? '' : c.title,
    cwd: c.root,
    createdAt: new Date(firstUser?.at ?? c.updatedAt).toISOString(),
    updatedAt: new Date(c.updatedAt).toISOString(),
    firstPrompt,
    lastAnswer,
    files: [...files],
  };
}
