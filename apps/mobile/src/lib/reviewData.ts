import type { Comment, CommentAnchor, LaneEvent } from '@kovan/shared';

/** Whether a comment is pinned to lines of a file (from a diff or the editor). */
export function onCode(
  c: Comment,
): c is Comment & { anchor: Extract<CommentAnchor, { kind: 'file' | 'hunk' }> } {
  return c.anchor.kind === 'file' || c.anchor.kind === 'hunk';
}

/** A comment after one change; replies follow their thread, oldest first. */
export function upsertComment(list: Comment[], comment: Comment): Comment[] {
  const at = list.findIndex((c) => c.id === comment.id);
  if (at === -1) return [...list, comment];
  const next = list.slice();
  next[at] = comment;
  return next;
}

/** What each lane's agent spent in the session (its turns' costs), largest first. */
export function laneSpend(
  lanes: Record<string, LaneEvent[]>,
  people: { userId: string; name: string }[],
): { userId: string; name: string; cost: number }[] {
  const rows = Object.entries(lanes).map(([userId, events]) => ({
    userId,
    name: people.find((p) => p.userId === userId)?.name ?? 'Someone',
    cost: events.reduce(
      (sum, e) => sum + (e.type === 'turn_end' && typeof e['cost'] === 'number' ? e['cost'] : 0),
      0,
    ),
  }));
  return rows.filter((r) => r.cost > 0).sort((a, b) => b.cost - a.cost);
}
