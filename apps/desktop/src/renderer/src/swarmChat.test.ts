import type { PlanStep, SwarmMessage } from '@kovan/shared';
import { describe, expect, it } from 'vitest';
import { dayLabel, messageStatus, needsAttention, searchMessages } from './swarmChat';

const IRIS = 'a0000000-0000-4000-8000-000000000001';
const OWEN = 'a0000000-0000-4000-8000-000000000002';
const MAYA = 'a0000000-0000-4000-8000-000000000003';
const PERSON = 'b0000000-0000-4000-8000-000000000001';
const AGENTS = [IRIS, OWEN, MAYA];
const NAMES: Record<string, string> = { [IRIS]: 'Iris', [OWEN]: 'Owen', [MAYA]: 'Maya' };

let n = 0;
const msg = (
  fromId: string,
  toId: string | null,
  text: string,
  deliveredTo: string[] = [],
): SwarmMessage => ({
  id: `m${++n}`,
  swarmId: 's1',
  fromId,
  fromName: NAMES[fromId] ?? 'Alper',
  toId,
  toName: toId ? (NAMES[toId] ?? null) : null,
  kind: 'note',
  replyTo: null,
  text,
  deliveredTo,
  readBy: [],
  createdAt: `2026-10-17T11:${String(40 + n).padStart(2, '0')}:00.000Z`,
});

describe('the swarm chat', () => {
  it("shows a message queued, delivered once the agent's model has it, read once it answered after", () => {
    const ask = msg(IRIS, OWEN, 'Can you review the CAS change?');
    expect(messageStatus(ask, [ask], AGENTS)?.label).toBe('Queued');
    const handed = { ...ask, deliveredTo: [OWEN] };
    expect(messageStatus(handed, [handed], AGENTS)?.label).toBe('Delivered');
    // Writing something else isn't reading it: the machine running the swarm says so.
    const other = msg(OWEN, IRIS, 'On it.');
    expect(messageStatus(handed, [handed, other], AGENTS)?.label).toBe('Delivered');
    const read = { ...handed, readBy: [OWEN] };
    expect(messageStatus(read, [read], AGENTS)?.label).toBe('Read');
  });

  it("shows an agent's question to a person waiting until they answer", () => {
    const q = { ...msg(IRIS, PERSON, 'Blue or green?'), kind: 'question' as const };
    expect(messageStatus(q, [q], AGENTS)).toEqual({
      state: 'waiting',
      label: 'Waiting for an answer',
    });
    const a = { ...msg(PERSON, IRIS, 'Blue'), replyTo: q.id };
    expect(messageStatus(q, [q, a], AGENTS)?.label).toBe('Answered');
    // A note to a person has no state.
    expect(messageStatus(msg(IRIS, PERSON, 'FYI'), [], AGENTS)).toBeNull();
  });

  it('lists what waits for people: open questions, approvals, failed and blocked tasks', () => {
    const q = { ...msg(MAYA, null, 'Which DB?'), kind: 'blocker' as const };
    const step = (id: string, runState: PlanStep['runState'], extra: Partial<PlanStep> = {}) =>
      ({
        id,
        title: id,
        ownerId: OWEN,
        runState,
        approval: null,
        runDetail: null,
        ...extra,
      }) as PlanStep;
    const items = needsAttention(
      [q],
      [
        step('migrate', 'waiting_for_approval', { approval: 'pending' }),
        step('paint', 'waiting_for_approval', { runDetail: 'Waiting for an answer: colour?' }),
        step('lint', 'failed'),
        step('docs', 'blocked'),
        step('done', 'done'),
        step('mine', 'failed', { ownerId: PERSON }),
      ],
      AGENTS,
    );
    expect(
      items.map((i) => (i.kind === 'question' ? `q:${i.message.text}` : `${i.kind}:${i.step.id}`)),
    ).toEqual(['q:Which DB?', 'approval:migrate', 'failed:lint', 'blocked:docs']);
    // Answered: no longer waiting.
    const a = { ...msg(PERSON, MAYA, 'Postgres'), replyTo: q.id };
    expect(needsAttention([q, a], [], AGENTS)).toEqual([]);
  });

  it('counts a message to everyone over the other agents', () => {
    const all = msg(PERSON, null, 'Keep the API stable', [IRIS]);
    expect(messageStatus(all, [all], AGENTS)).toEqual({
      state: 'delivered',
      label: 'Delivered to 1 of 3',
    });
    const fromIris = msg(IRIS, null, 'Heads up', [OWEN, MAYA]);
    expect(messageStatus(fromIris, [fromIris], AGENTS)?.label).toBe('Delivered');
  });

  it('labels days and finds messages by text or name', () => {
    const now = new Date('2026-10-17T18:00:00');
    expect(dayLabel('2026-10-17T09:00:00', now)).toBe('Today');
    expect(dayLabel('2026-10-16T23:00:00', now)).toBe('Yesterday');
    const a = msg(IRIS, OWEN, 'retry path');
    const b = msg(MAYA, null, 'lobby id');
    expect(searchMessages([a, b], 'owen')).toEqual([a]);
    expect(searchMessages([a, b], 'LOBBY')).toEqual([b]);
    expect(searchMessages([a, b], ' ')).toEqual([a, b]);
  });
});
