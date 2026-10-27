import type { LiveAgent } from '../services/liveAgents';

/** Characters a second the editor types at, so an edit can be followed by eye. */
export const TYPE_RATE = 90;

/** How long typing out `text` takes in the editor. */
export const typingMs = (text: string | null) =>
  text ? Math.min(60_000, (text.length / TYPE_RATE) * 1000) : 0;

/** How often the editor types the next characters. */
export const TICK_MS = 30;

/**
 * The characters shown after one more tick: a steady pace that can be read along with, a bit
 * faster when far behind so a long edit doesn't take minutes.
 */
export function advance(shown: number, length: number): number {
  const left = length - shown;
  if (left <= 0) return length;
  const steady = Math.max(1, Math.round((TYPE_RATE * TICK_MS) / 1000));
  const step = left > 1500 ? Math.ceil(left / 50) : left > 500 ? steady * 2 : steady;
  return Math.min(length, shown + step);
}

/** One edit of an agent, as the editor shows it. */
export interface LiveItem {
  /** Agent key and tool: one per edit, so a second edit doesn't erase the first. */
  id: string;
  agentKey: string;
  toolId: string;
  anchor: string | null;
  text: string | null;
  /** The tool finished (the text is complete). */
  done: boolean;
  /** Finished elsewhere and kept until it arrives in this file. */
  pending: boolean;
}

/** Whether an agent has anything to show in `path`: work there now, or edits on their way. */
export const worksIn = (agent: LiveAgent, path: string | null) =>
  agent.path === path || agent.pending.some((p) => p.path === path);

/** The edits an agent has in flight or on their way in `path`, oldest first. */
export function itemsOf(agent: LiveAgent, path: string | null): LiveItem[] {
  const items: LiveItem[] = agent.pending
    .filter((p) => p.path === path)
    .map((p) => ({
      id: `${agent.key}:${p.toolId}`,
      agentKey: agent.key,
      toolId: p.toolId,
      anchor: p.anchor,
      text: p.text,
      done: true,
      pending: true,
    }));
  const current =
    agent.path === path &&
    agent.phase !== 'reading' &&
    !agent.pending.some((p) => p.toolId === agent.toolId);
  if (current)
    items.push({
      id: `${agent.key}:${agent.toolId}`,
      agentKey: agent.key,
      toolId: agent.toolId,
      anchor: agent.anchor,
      text: agent.text,
      done: agent.phase === 'wrote',
      pending: false,
    });
  return items;
}

/**
 * Where an edit's text is in the file, if it has arrived: found, and either finished or the
 * text it replaces is gone (a local edit can land before its tool_end does).
 */
export function landedAt(content: string, item: LiveItem): number {
  if (!item.text) return -1;
  const at = content.indexOf(item.text);
  if (at < 0) return -1;
  if (item.done) return at;
  return item.anchor !== null && !content.includes(item.anchor) ? at : -1;
}

/**
 * How much of an arrived edit was already there: the start of `text` that matches the file as
 * it was at the same place, cut back to a line start so typing begins on a fresh line.
 */
export function keptPrefix(before: string, at: number, text: string): number {
  const was = before.slice(at);
  let n = 0;
  while (n < text.length && n < was.length && text[n] === was[n]) n++;
  if (n >= text.length) return text.length;
  return text.lastIndexOf('\n', n - 1) + 1;
}
