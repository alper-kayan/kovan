import { openQuestions, type PlanStep, type SwarmMessage } from '@kovan/shared';

/** Where a message stands for the agents it went to, as the swarm's chat shows it. */
export interface MessageStatus {
  state: 'queued' | 'delivered' | 'read' | 'waiting' | 'answered';
  label: string;
}

/**
 * A message's state: queued until an agent's model has it, delivered once it does, read once
 * that model answered after it (the machine running the swarm says each). To everyone: counted
 * over the swarm's other agents. An agent's question to a person waits for their answer.
 */
export function messageStatus(
  m: SwarmMessage,
  all: SwarmMessage[],
  agentIds: string[],
): MessageStatus | null {
  const fromAgent = agentIds.includes(m.fromId);
  if (fromAgent && m.toId && !agentIds.includes(m.toId)) {
    if (m.kind !== 'question' && m.kind !== 'blocker') return null;
    return all.some((x) => x.replyTo === m.id && !agentIds.includes(x.fromId))
      ? { state: 'answered', label: 'Answered' }
      : { state: 'waiting', label: 'Waiting for an answer' };
  }
  const to = m.toId ? [m.toId] : agentIds.filter((id) => id !== m.fromId);
  if (to.length === 0 || !to.every((id) => agentIds.includes(id))) return null;
  const readBy = m.readBy ?? [];
  const read = to.filter((id) => readBy.includes(id));
  const delivered = to.filter((id) => m.deliveredTo.includes(id) || read.includes(id));
  if (read.length === to.length) return { state: 'read', label: 'Read' };
  if (delivered.length === to.length)
    return read.length
      ? { state: 'delivered', label: `Read by ${read.length} of ${to.length}` }
      : { state: 'delivered', label: 'Delivered' };
  if (delivered.length === 0) return { state: 'queued', label: 'Queued' };
  return {
    state: 'delivered',
    label: `Delivered to ${delivered.length} of ${to.length}`,
  };
}

/** Something in a swarm that waits for a person. */
export type Attention =
  | { kind: 'question'; message: SwarmMessage }
  | { kind: 'approval' | 'answer' | 'blocked' | 'failed'; step: PlanStep };

/**
 * What waits for people in a swarm, oldest first: agents' questions and blockers nobody has
 * answered, tasks waiting for a yes or for an answer, and tasks that failed or are blocked.
 */
export function needsAttention(
  messages: SwarmMessage[],
  steps: PlanStep[],
  agentIds: string[],
): Attention[] {
  const isAgent = (id: string) => agentIds.includes(id);
  const asked: Attention[] = openQuestions(messages, agentIds).map((message) => ({
    kind: 'question',
    message,
  }));
  const tasks: Attention[] = steps
    .filter((s) => s.ownerId && isAgent(s.ownerId))
    .flatMap((step): Attention[] => {
      if (step.runState === 'waiting_for_approval')
        return step.approval === 'pending'
          ? [{ kind: 'approval', step }]
          : step.runDetail?.startsWith('Waiting for an answer')
            ? [{ kind: 'answer', step }]
            : [];
      if (step.runState === 'blocked') return [{ kind: 'blocked', step }];
      if (step.runState === 'failed') return [{ kind: 'failed', step }];
      return [];
    });
  // A task waiting for an answer is asked in the chat already: the question stands for it.
  return [...asked, ...tasks.filter((t) => t.kind !== 'answer' || !asked.length)];
}

/** "Today", "Yesterday" or the date, for the chat's day dividers. */
export function dayLabel(iso: string, now = new Date()): string {
  const d = new Date(iso);
  const day = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((day(now) - day(d)) / 86_400_000);
  if (diff === 0) return 'Today';
  if (diff === 1) return 'Yesterday';
  return d.toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' });
}

/** Messages matching a search: in the text, or by who wrote it or whom it was for. */
export function searchMessages(messages: SwarmMessage[], query: string): SwarmMessage[] {
  const q = query.trim().toLowerCase();
  if (!q) return messages;
  return messages.filter((m) =>
    [m.text, m.fromName, m.toName ?? ''].some((s) => s.toLowerCase().includes(q)),
  );
}
