import type { LaneEvent } from '@kovan/shared';

/**
 * A lane's transcript as the phone shows it: what the desktop's conversation shows, smaller.
 * Prompts, the agent's words, its actions with their state, one-line notes, and each turn's end.
 */
export type LaneItem =
  | { kind: 'prompt'; key: string; text: string }
  | { kind: 'text'; key: string; text: string }
  | { kind: 'reasoning'; key: string; text: string }
  | {
      kind: 'tool';
      key: string;
      name: string;
      summary: string;
      status: 'running' | 'waiting' | 'ok' | 'failed' | 'denied';
      added: number | null;
      removed: number | null;
    }
  | { kind: 'note'; key: string; tone: 'info' | 'warn'; text: string }
  /** A message to an AI teammate called in with @. */
  | { kind: 'mention'; key: string; name: string; text: string }
  /** That teammate at work, then its answer (one row per call). */
  | {
      kind: 'teammate';
      key: string;
      requestId: string;
      name: string;
      status: 'working' | 'answered' | 'changed' | 'failed' | 'stopped';
      text: string | null;
    }
  | {
      kind: 'end';
      key: string;
      reason: 'done' | 'stopped' | 'error' | 'step_limit';
      error: string | null;
      cost: number;
    };

const str = (v: unknown) => (typeof v === 'string' ? v : '');
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** Folds a lane's events in order; an event of an unknown kind is skipped, not shown raw. */
export function foldLane(events: readonly LaneEvent[]): LaneItem[] {
  const items: LaneItem[] = [];
  const tools = new Map<string, Extract<LaneItem, { kind: 'tool' }>>();
  events.forEach((e, i) => {
    const key = String(i);
    const last = items.at(-1);
    switch (e.type) {
      case 'user':
        items.push({ kind: 'prompt', key, text: str(e['text']) });
        return;
      case 'text':
      case 'reasoning':
        if (last?.kind === e.type) last.text += str(e['text']);
        else items.push({ kind: e.type, key, text: str(e['text']) });
        return;
      case 'tool_start': {
        const item = {
          kind: 'tool' as const,
          key,
          name: str(e['name']),
          summary: str(e['summary']),
          status: 'running' as const,
          added: null,
          removed: null,
        };
        tools.set(str(e['id']), item);
        // A helper agent's steps stay out of the phone's lane, unless one waits for an answer.
        if (!e['parent']) items.push(item);
        return;
      }
      case 'approval': {
        const request = e['request'] as { id?: unknown; tool?: unknown } | undefined;
        let item = tools.get(str(request?.id));
        if (!item) {
          item = {
            kind: 'tool',
            key,
            name: str(request?.tool),
            summary: `Asked ${str(request?.tool)}`,
            status: 'running',
            added: null,
            removed: null,
          };
          tools.set(str(request?.id), item);
        }
        item.status = 'waiting';
        if (!items.includes(item)) items.push(item);
        return;
      }
      case 'approval_resolved': {
        const item = tools.get(str(e['id']));
        if (item) item.status = e['approved'] ? 'running' : 'denied';
        return;
      }
      case 'tool_end': {
        const item = tools.get(str(e['id']));
        if (!item) return;
        if (item.status !== 'denied') item.status = e['ok'] ? 'ok' : 'failed';
        const meta = e['meta'] as { added?: unknown; removed?: unknown } | undefined;
        item.added = num(meta?.added);
        item.removed = num(meta?.removed);
        return;
      }
      case 'steer': {
        const from = str(e['fromName']);
        const delivered = e['status'] === 'delivered';
        items.push({
          kind: 'note',
          key,
          tone: delivered ? 'info' : 'warn',
          text: delivered
            ? `↪ Guidance${from ? ` from ${from}` : ''}: ${str(e['text'])}`
            : `Guidance came back (the turn ended first): ${str(e['text'])}`,
        });
        return;
      }
      case 'outcome_unknown':
        items.push({
          kind: 'note',
          key,
          tone: 'warn',
          text: `Outcome unknown: ${str(e['command'])} was cut off mid-flight.`,
        });
        return;
      case 'limit_hit':
        items.push({
          kind: 'note',
          key,
          tone: 'warn',
          text: `Usage limit hit (${str(e['reason'])}). Awaiting takeover.`,
        });
        return;
      case 'switch':
        items.push({
          kind: 'note',
          key,
          tone: 'info',
          text: `Switched agents: ${str(e['reason'])} → ${str(e['to'])} · ${str(e['model'])}`,
        });
        return;
      case 'auto':
        items.push({
          kind: 'note',
          key,
          tone: 'info',
          text: `Auto → ${str(e['to'])} · ${str(e['model'])}: ${str(e['reason'])}`,
        });
        return;
      case 'mode': {
        const mode = str(e['mode']);
        items.push({
          kind: 'note',
          key,
          tone: mode === 'full' ? 'warn' : 'info',
          text: `Switched to ${mode.charAt(0).toUpperCase()}${mode.slice(1)} permissions`,
        });
        return;
      }
      case 'mention':
        items.push({ kind: 'mention', key, name: str(e['name']), text: str(e['text']) });
        return;
      case 'teammate': {
        const status = (['working', 'answered', 'changed', 'failed', 'stopped'] as const).find(
          (x) => x === e['status'],
        );
        if (!status) return;
        const requestId = str(e['requestId']);
        const text = str(e['text']) || null;
        const row = items.find(
          (x): x is Extract<LaneItem, { kind: 'teammate' }> =>
            x.kind === 'teammate' && x.requestId === requestId,
        );
        if (row) {
          row.status = status;
          row.text = text;
        } else items.push({ kind: 'teammate', key, requestId, name: str(e['name']), status, text });
        return;
      }
      case 'notice':
        items.push({
          kind: 'note',
          key,
          tone: e['tone'] === 'warn' ? 'warn' : 'info',
          text: str(e['text']),
        });
        return;
      case 'turn_end': {
        // A turn that ends with a running tool never finished it.
        for (const t of tools.values()) if (t.status === 'running') t.status = 'failed';
        const reason = e['reason'];
        items.push({
          kind: 'end',
          key,
          reason:
            reason === 'stopped' || reason === 'error' || reason === 'step_limit' ? reason : 'done',
          error: str(e['error']) || null,
          cost: num(e['cost']) ?? 0,
        });
        return;
      }
      default:
        return;
    }
  });
  return items;
}

/**
 * A lane as a teammate called in from the phone reads it: who asked what, what the agent said
 * and did, newest last, cut from the start to a readable size.
 */
export function laneDigest(items: readonly LaneItem[], person: string): string | null {
  const lines = items.flatMap((i) =>
    i.kind === 'prompt'
      ? [`${person}: ${i.text}`]
      : i.kind === 'mention'
        ? [`${person} to @${i.name}: ${i.text}`]
        : i.kind === 'text' && i.text.trim()
          ? [`Agent: ${i.text.trim()}`]
          : i.kind === 'tool'
            ? [`  [${i.name}] ${i.summary}`]
            : i.kind === 'teammate' && i.text
              ? [`${i.name}: ${i.text}`]
              : [],
  );
  if (!lines.length) return null;
  let out = '';
  for (const line of lines.reverse()) {
    const clipped = line.length > 4000 ? `${line.slice(0, 4000)}…` : line;
    if (out.length + clipped.length + 1 > 20_000) return `(earlier messages left out)\n${out}`;
    out = out ? `${clipped}\n${out}` : clipped;
  }
  return out;
}

/**
 * The short label before a tool row's summary: an MCP tool shows its server, a skill or a
 * repository server's start says what kind of row it is.
 */
export function toolLabel(name: string): string {
  if (name === 'use_skill' || name === 'Skill') return 'skill';
  if (name === 'mcp_trust') return 'mcp';
  const mcp = /^mcp__(.+?)__/.exec(name);
  const label = mcp ? mcp[1]!.replace(/^plugin_/, '') : name;
  return label.length > 24 ? `${label.slice(0, 23)}…` : label;
}
