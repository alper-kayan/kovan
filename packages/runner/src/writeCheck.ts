import { stat } from 'node:fs/promises';
import { basename, join } from 'node:path';
import type { Plan, Session } from '@kovan/shared';
import { importGraph, type ImportGraph } from './impact.js';

/** What a live session elsewhere is doing to the code, as the Brain sees it. */
export interface LiveWork {
  sessionId: string;
  title: string;
  /** Who works in it (names). */
  people: string[];
  /** Files changed there and not yet merged. */
  touched: string[];
  /** Files its plan says it will change. */
  planned: string[];
  locks: { path: string; by: string }[];
}

/** The workspace's live sessions other than `own`, as the write check reads them. */
export async function liveWorkOf(
  request: <T>(method: 'GET', path: string) => Promise<T>,
  workspaceId: string,
  own: string | null,
): Promise<LiveWork[]> {
  const { sessions } = await request<{ sessions: Session[] }>(
    'GET',
    `/api/workspaces/${workspaceId}/sessions`,
  );
  const others = sessions.filter((s) => s.id !== own && s.status === 'active');
  return Promise.all(
    others.map(async (s) => {
      const plan = await request<{ plan: Plan }>('GET', `/api/sessions/${s.id}/plan`).catch(
        () => null,
      );
      return {
        sessionId: s.id,
        title: s.title,
        people: s.participants.filter((p) => p.mode === 'join').map((p) => p.name),
        touched: s.touchedFiles,
        planned: (plan?.plan.steps ?? [])
          .filter((st) => st.status !== 'done')
          .flatMap((st) => st.files),
        locks: s.locks.map((l) => ({
          path: l.path,
          by: s.participants.find((p) => p.userId === l.userId)?.name ?? 'a teammate',
        })),
      };
    }),
  );
}

export interface WriteCheckDeps {
  /** The checkout the agent writes in. */
  root: string;
  /** Live sessions other than the agent's own (their files relative to the repository). */
  others(): Promise<LiveWork[]>;
  /** How long the import graph is reused (tests make it short). */
  graphTtlMs?: number;
}

/** Why one write was held: shown to the agent, and the key it is acknowledged under. */
interface Finding {
  key: string;
  text: string;
}

const GRAPH_TTL_MS = 60_000;
const OTHERS_TTL_MS = 5_000;

/**
 * Before an agent writes a file: does that collide with work in another live session? The
 * write is held once, with why, when the file is locked or being changed there, when a file it
 * imports (or that imports it) is being changed there, or when a new file looks like one being
 * added there. Writing it again goes ahead: the agent has been told and chose to. Fails open.
 */
export class WriteCheck {
  private graph: { at: number; value: Promise<ImportGraph> } | null = null;
  private live: { at: number; value: Promise<LiveWork[]> } | null = null;
  private readonly told = new Set<string>();

  constructor(private readonly deps: WriteCheckDeps) {}

  /** A note to hold this write with, or null to go ahead. */
  async check(path: string): Promise<string | null> {
    try {
      const found = await this.findings(path);
      const fresh = found.filter((f) => !this.told.has(f.key));
      if (fresh.length === 0) return null;
      for (const f of fresh) this.told.add(f.key);
      return [
        `Held this write to ${path} once, before it collides with a teammate's work:`,
        ...fresh.map((f) => `- ${f.text}`),
        'Read their change or message them first. If you still need this edit, make it again and it goes ahead.',
      ].join('\n');
    } catch {
      return null;
    }
  }

  private async findings(path: string): Promise<Finding[]> {
    const others = await this.others();
    if (others.length === 0) return [];
    const out: Finding[] = [];
    const who = (w: LiveWork) => w.people.join(', ') || 'a teammate';
    for (const w of others) {
      const lock = w.locks.find((l) => l.path === path);
      if (lock)
        out.push({
          key: `lock:${w.sessionId}:${path}`,
          text: `${path} is locked by ${lock.by} in "${w.title}": do not edit it without asking them.`,
        });
      else if (w.touched.includes(path))
        out.push({
          key: `touched:${w.sessionId}:${path}`,
          text: `${who(w)} ${w.people.length > 1 ? 'are' : 'is'} changing ${path} right now in "${w.title}"; editing it too makes two versions.`,
        });
      else if (w.planned.includes(path))
        out.push({
          key: `planned:${w.sessionId}:${path}`,
          text: `"${w.title}" (${who(w)}) plans to change ${path}.`,
        });
    }
    if (out.length) return out;

    // Its neighbours in the import graph, changed elsewhere: the two changes may not fit.
    const graph = await this.importGraph();
    const near = new Set([
      ...(graph.imports.get(path) ?? []),
      ...(graph.importers.get(path) ?? []),
    ]);
    for (const w of others) {
      const hit = w.touched.find((t) => near.has(t));
      if (hit)
        out.push({
          key: `near:${w.sessionId}:${path}:${hit}`,
          text: `${path} ${graph.imports.get(path)?.has(hit) ? 'imports' : 'is imported by'} ${hit}, which ${who(w)} is changing in "${w.title}": check that the two changes fit.`,
        });
    }

    // A new file shaped like one being added elsewhere: the same work done twice.
    const exists = await stat(join(this.deps.root, path)).then(
      () => true,
      () => false,
    );
    if (!exists) {
      const name = basename(path);
      for (const w of others) {
        const twin = w.touched.find((t) => t !== path && basename(t) === name);
        if (twin && !graph.files.includes(twin))
          out.push({
            key: `twin:${w.sessionId}:${path}:${twin}`,
            text: `${who(w)} is adding ${twin} in "${w.title}"; ${path} may duplicate it.`,
          });
      }
    }
    return out;
  }

  private others(): Promise<LiveWork[]> {
    if (!this.live || Date.now() - this.live.at > OTHERS_TTL_MS)
      this.live = { at: Date.now(), value: this.deps.others() };
    return this.live.value;
  }

  private importGraph(): Promise<ImportGraph> {
    const ttl = this.deps.graphTtlMs ?? GRAPH_TTL_MS;
    if (!this.graph || Date.now() - this.graph.at > ttl)
      this.graph = { at: Date.now(), value: importGraph(this.deps.root) };
    return this.graph.value;
  }
}
