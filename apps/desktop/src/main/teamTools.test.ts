import { git } from '@kovan/git-engine';
import type { Memory } from '@kovan/shared';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Bindings } from '@kovan/runner';
import type { BrainClient } from './brain.js';
import { TeamTools } from './teamTools.js';

let root: string;
const WS = '11111111-1111-4111-8111-111111111111';

/** Just enough of the Brain for the tools: notes in memory, every call recorded. */
function fakeBrain() {
  const memories: Memory[] = [];
  const calls: { method: string; path: string; body?: unknown }[] = [];
  const brain = {
    status: () => ({ signedIn: true, connection: 'online', user: { id: 'u1' } }),
    presenceOf: () => [],
    async request(method: string, path: string, body?: Record<string, unknown>) {
      calls.push({ method, path, body });
      if (path.endsWith('/memories') && method === 'GET') return { memories };
      if (path.endsWith('/memories') && method === 'POST') {
        const memory = {
          ...body,
          id: `m${memories.length + 1}`,
          workspaceId: WS,
          status: 'active',
          flagReason: null,
          authorId: 'u1',
          authorName: 'alice',
          verified: false,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        } as unknown as Memory;
        memories.push(memory);
        return { memory };
      }
      if (path.endsWith('/flag')) {
        const m = memories.find((x) => path.includes(x.id))!;
        Object.assign(m, { status: 'flagged', flagReason: body?.['reason'] });
        return { memory: m };
      }
      if (path.endsWith('/comments')) return { comments: [] };
      if (path.endsWith('/members'))
        return { members: [{ userId: 'u1', name: 'alice', role: 'owner' }] };
      throw new Error(`unexpected ${method} ${path}`);
    },
  };
  return { brain: brain as unknown as BrainClient, memories, calls };
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'kovan-team-'));
  await git(root, ['init', '-b', 'main']);
  await git(root, ['config', 'user.email', 't@kovan.test']);
  await git(root, ['config', 'user.name', 'T']);
  await writeFile(
    join(root, 'lobby.ts'),
    'export function reserveSlot(seat) {\n  read();\n  write();\n}\n',
  );
  await git(root, ['add', '.']);
  await git(root, ['commit', '-m', 'init']);
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('TeamTools', () => {
  it('pins notes to code, shows them to the next agent and flags them when merged code moves', async () => {
    const { brain, memories } = fakeBrain();
    const bindings = {
      all: async () => ({ [WS]: root }),
      idFor: async (r: string) => (r === root ? WS : null),
    } as unknown as Bindings;
    const team = new TeamTools(brain, bindings);
    const caller = { root, session: null, agent: 'Claude Code · haiku' };

    const saved = await team.call(
      'record_memory',
      { path: 'lobby.ts', line: 1, kind: 'gotcha', text: 'reserveSlot reads before it writes.' },
      caller,
    );
    expect(saved.isError).toBeUndefined();
    expect(memories[0]).toMatchObject({
      path: 'lobby.ts',
      startLine: 1,
      endLine: 3,
      snippet: 'export function reserveSlot(seat) {\n  read();\n  write();',
      byAgent: 'Claude Code · haiku',
    });
    expect(memories[0]!.commit).toMatch(/^[0-9a-f]{40}$/);

    // Another agent's turn sees it.
    const note = await team.turnNote({ root, session: null, agent: 'Kovan · JevRouter' });
    expect(note).toContain('[gotcha] lobby.ts:1-3: reserveSlot reads before it writes.');

    // Uncommitted edits don't flag anything.
    await writeFile(
      join(root, 'lobby.ts'),
      '// header\n\nexport function reserveSlot(seat) {\n  read();\n  write();\n}\n',
    );
    expect(await team.verifyAnchors(root)).toEqual({ flagged: 0, outdated: 0 });

    // Once that lands (a commit or merge), the moved code flags the note.
    await git(root, ['commit', '-am', 'header']);
    expect(await team.verifyAnchors(root)).toEqual({ flagged: 1, outdated: 0 });
    expect(memories[0]).toMatchObject({
      status: 'flagged',
      flagReason: 'The code it points at moved from line 1 to line 3 of lobby.ts.',
    });
    const after = await team.turnNote({ root, session: null, agent: 'Kovan' });
    expect(after).toContain('FLAGGED [gotcha] lobby.ts:1-3');
    expect(after).toContain(`replaces: "${memories[0]!.id}"`);
  });

  it("won't pin a note to a file that isn't there", async () => {
    const { brain } = fakeBrain();
    const team = new TeamTools(brain, {
      all: async () => ({ [WS]: root }),
      idFor: async (r: string) => (r === root ? WS : null),
    } as unknown as Bindings);
    const result = await team.call(
      'record_memory',
      { path: 'nope.ts', kind: 'decision', text: 'x' },
      { root, session: null, agent: 'Kovan' },
    );
    expect(result).toMatchObject({ isError: true });
  });

  it("records a decision's why and reach, and shows disputed notes as disputed", async () => {
    const { brain, memories } = fakeBrain();
    const team = new TeamTools(brain, {
      all: async () => ({ [WS]: root }),
      idFor: async (r: string) => (r === root ? WS : null),
    } as unknown as Bindings);
    const caller = { root, session: null, agent: 'Kovan' };
    await team.call(
      'record_memory',
      {
        path: 'lobby.ts',
        kind: 'decision',
        text: 'Seats are reserved with compare-and-set.',
        why: 'Two players took the same seat under load.',
        consequences: 'No plain writes to seats.',
        affects: ['lobby.ts', 'src/seats'],
      },
      caller,
    );
    expect(memories[0]).toMatchObject({
      rationale: 'Two players took the same seat under load.',
      consequences: 'No plain writes to seats.',
      affects: ['lobby.ts', 'src/seats'],
    });
    // The Brain linked it to a note that may disagree.
    Object.assign(memories[0]!, { conflictsWith: ['m9'] });
    const note = await team.turnNote({ root, session: null, agent: 'Kovan' });
    expect(note).toContain(
      'DISPUTED [decision] lobby.ts: Seats are reserved with compare-and-set. Why: Two players took the same seat under load. What follows: No plain writes to seats. Governs: lobby.ts, src/seats.',
    );
    expect(note).toContain(
      "May disagree with note m9. Both are kept until a person decides; don't pick one silently",
    );
  });

  it("gives a CLI agent's long turn the team's state again, only when it changed", async () => {
    const { brain, memories } = fakeBrain();
    const bindings = {
      all: async () => ({ [WS]: root }),
      idFor: async (r: string) => (r === root ? WS : null),
    } as unknown as Bindings;
    const team = new TeamTools(brain, bindings);
    const caller = { root, session: null, agent: 'Claude Code · haiku' };
    const save = (text: string) =>
      team.call('record_memory', { path: 'lobby.ts', line: 1, kind: 'gotcha', text }, caller);
    const none = async () => [];
    await save('Prices are in cents.');
    let now = 1_000_000;
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
    try {
      const prompt = await team.hook('UserPromptSubmit', { prompt: 'Fix totals' }, caller, none);
      expect(prompt).toContain('Prices are in cents.');
      // Right after: nothing again.
      expect(await team.hook('PostToolUse', {}, caller, none)).toBe('');
      // Later, unchanged: still nothing.
      now += 21_000;
      expect(await team.hook('PostToolUse', {}, caller, none)).toBe('');
      // Later, changed: the new state.
      await save('Totals round half up.');
      now += 21_000;
      const after = JSON.parse(await team.hook('PostToolUse', {}, caller, none)) as {
        hookSpecificOutput: { hookEventName: string; additionalContext: string };
      };
      expect(after.hookSpecificOutput.hookEventName).toBe('PostToolUse');
      expect(after.hookSpecificOutput.additionalContext).toContain('Totals round half up.');
    } finally {
      clock.mockRestore();
    }
    expect(memories).toHaveLength(2);
  });
});
