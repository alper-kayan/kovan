import { beforeAll, describe, expect, it } from 'vitest';
import type { ConversationEvent } from '../../../shared/agent';
import type * as LiveAgents from '../services/liveAgents';
import type * as Store from '../store';

// The renderer's modules reach for the preload bridge as they load: a stand-in, as the window would have.
const g = globalThis as unknown as { window?: unknown };
g.window ??= { kovan: { on: () => () => {}, invoke: async () => null } };

let live: typeof LiveAgents;
let store: typeof Store;

beforeAll(async () => {
  store = await import('../store');
  live = await import('../services/liveAgents');
  store.setState({
    workspace: { root: '/repo/shop', name: 'shop', isRepo: true },
  } as Partial<ReturnType<typeof store.getState>>);
});

const edit = (
  id: string,
  path: string,
  oldText: string | null,
  newText: string,
): ConversationEvent[] => [
  {
    type: 'tool_start',
    id,
    name: oldText === null ? 'write_file' : 'edit_file',
    summary: `Edited ${path}`,
    args:
      oldText === null
        ? { path, content: newText }
        : { path, old_string: oldText, new_string: newText },
  } as ConversationEvent,
  { type: 'tool_end', id, ok: true, output: '' } as ConversationEvent,
];

describe('all agents in one tree and one file', () => {
  it('maps a path in another copy of the repository (a session or swarm worktree) to the same file here', () => {
    expect(live.relativePath('/repo/shop/src/cart.js')).toBe('src/cart.js');
    expect(
      live.relativePath(
        '/Users/a/Library/Application Support/Kovan/worktrees/shop-1a2b3c4d/src/cart.js',
      ),
    ).toBe('src/cart.js');
    expect(
      live.relativePath(
        '/Users/a/Library/Application Support/Kovan/worktrees/shop-1a2b3c4d/sub-0f1e2d3c/test/cart.test.js',
      ),
    ).toBe('test/cart.test.js');
    expect(
      live.relativePath(
        'C:\\Users\\a\\AppData\\Roaming\\Kovan\\worktrees\\shop-1a2b3c4d\\src\\money.js',
      ),
    ).toBe('src/money.js');
    expect(live.relativePath('/somewhere/else/x.js')).toBeNull();
    expect(live.relativePath('./src/a.js')).toBe('src/a.js');
  });

  it('marks the files each agent changed or wrote, and keeps a new file’s text to open it from', () => {
    const wren = {
      key: 'wren',
      name: 'Wren',
      mine: false,
      sessionId: 's1',
      sessionTitle: 'Free shipping',
    };
    const moss = {
      key: 'moss',
      name: 'Moss',
      mine: false,
      sessionId: 's1',
      sessionTitle: 'Free shipping',
    };
    for (const e of edit('t1', 'src/cart.js', 'return total;', 'return total + shipping;'))
      live.observe(wren, e);
    for (const e of edit('t2', 'src/shipping.js', null, 'export const FREE_FROM = 5000;\n'))
      live.observe(wren, e);
    for (const e of edit(
      't3',
      '/x/Kovan/worktrees/shop-1a2b3c4d/sub-0f1e2d3c/src/cart.js',
      'let total = 0;',
      'let total = 1;',
    ))
      live.observe(moss, e);

    const files = store.getState().agentFiles;
    expect(files['src/cart.js']!.map((m) => m.name)).toEqual(['Wren', 'Moss']);
    expect(files['src/cart.js']!.every((m) => m.text === null)).toBe(true); // edits, not whole files
    expect(files['src/shipping.js']).toEqual([
      expect.objectContaining({
        name: 'Wren',
        sessionTitle: 'Free shipping',
        text: 'export const FREE_FROM = 5000;\n',
      }),
    ]);
  });

  it('keeps an edit made in another copy waiting in the file until it arrives, instead of a few minutes', () => {
    const iris = { key: 'iris', name: 'Iris', mine: false, sessionId: 's2', sessionTitle: 'Tax' };
    for (const e of edit('t9', 'src/money.js', 'round(x)', 'Math.round(x)')) live.observe(iris, e);
    const agent = store.getState().liveAgents['iris']!;
    expect(agent.pending).toEqual([
      expect.objectContaining({ path: 'src/money.js', text: 'Math.round(x)' }),
    ]);
  });
});
