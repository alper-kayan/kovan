import type { IssueEdits } from '@kovan/harness';
import { describe, expect, it, vi } from 'vitest';
import { GithubClient, type GithubRepo } from './github.js';
import { IssueTool, type IssueCard, type IssueDeps } from './issues.js';

const repo = (owner: string, name: string): GithubRepo => ({
  host: 'github.com',
  owner,
  repo: name,
});

function setup(over: Partial<IssueDeps> = {}, answer?: { approved: boolean; edits?: IssueEdits }) {
  const created: unknown[] = [];
  const comments: unknown[] = [];
  const finished: [boolean, string][] = [];
  const remembered: string[] = [];
  const cards: Parameters<IssueCard>[1][] = [];
  const github: IssueDeps['github'] = {
    reposOf: async (root) =>
      root === '/work/app' ? [repo('Acme', 'app'), repo('upstream', 'app')] : [repo('acme', 'api')],
    similarIssues: async () => [],
    createIssue: async (_root, r, input) => {
      created.push({ repo: `${r.owner}/${r.repo}`, ...input });
      return {
        number: 7,
        title: input.title,
        url: `https://github.com/${r.owner}/${r.repo}/issues/7`,
      };
    },
    commentOnIssue: async (_root, r, number, body) => {
      comments.push({ repo: `${r.owner}/${r.repo}`, number, body });
      return { url: `https://github.com/${r.owner}/${r.repo}/issues/${number}#c1` };
    },
  };
  const tool = new IssueTool({
    github,
    otherRoots: async () => ['/work/api'],
    card: async (_conversation, card) => {
      cards.push(card);
      return {
        approved: answer?.approved ?? true,
        edits: answer?.edits ?? null,
        finish: (ok, output) => finished.push([ok, output]),
      };
    },
    noAsk: async () => [],
    rememberNoAsk: async (r) => void remembered.push(r),
    ...over,
  });
  const run = (args: Record<string, unknown>, conversationId: string | null = 'c1') =>
    tool.run(args, { root: '/work/app', conversationId });
  return { tool, run, created, comments, finished, remembered, cards };
}

const draft = { title: 'Crash on empty input', body: 'parse() throws when the file is empty.' };

describe("a person's own issue", () => {
  const edits = (over: Partial<IssueEdits> = {}): IssueEdits => ({
    repo: 'acme/app',
    title: 'Totals are off by a cent',
    body: 'From a comment: rounding happens twice.',
    labels: ['bug'],
    commentOn: null,
    dontAsk: false,
    ...over,
  });

  it('offers the repositories and the look-alikes in the first one', async () => {
    const asked: string[] = [];
    const t = setup({
      github: {
        ...setup().tool['deps'].github,
        similarIssues: async (_root, r, title) => {
          asked.push(`${r.owner}/${r.repo}: ${title}`);
          return [{ number: 3, title: 'Totals rounding', url: 'u' }];
        },
      },
    });
    const draft = await t.tool.draft('/work/app', 'Totals are off');
    expect(draft).toEqual({
      repos: ['acme/app', 'upstream/app', 'acme/api'],
      similar: [{ number: 3, title: 'Totals rounding', url: 'u' }],
    });
    expect(await t.tool.similarIn('/work/app', 'acme/api', 'Totals are off')).toHaveLength(1);
    expect(await t.tool.similarIn('/work/app', 'someone/else', 'Totals')).toEqual([]);
    expect(asked).toEqual(['Acme/app: Totals are off', 'acme/api: Totals are off']);
  });

  it('creates it, or comments on an open one, with secrets masked', async () => {
    const t = setup();
    const made = await t.tool.file(
      '/work/app',
      edits({ body: 'Fails with key sk-or-v1-0123456789abcdef0123456789abcdef in .env' }),
    );
    expect(made).toEqual({
      url: 'https://github.com/Acme/app/issues/7',
      text: 'Created acme/app#7',
    });
    expect(JSON.stringify(t.created)).not.toContain('sk-or-v1-0123456789abcdef');
    const commented = await t.tool.file('/work/app', edits({ commentOn: 3 }));
    expect(commented.text).toBe('Commented on acme/app#3');
    expect(t.comments).toHaveLength(1);
  });

  it("refuses a repository that isn't one of the workspaces, or an empty text", async () => {
    const t = setup();
    await expect(t.tool.file('/work/app', edits({ repo: 'someone/else' }))).rejects.toThrow(
      "isn't one of your workspaces",
    );
    await expect(t.tool.file('/work/app', edits({ title: '   ' }))).rejects.toThrow(
      'Give a title and a body',
    );
    expect(t.created).toEqual([]);
  });
});

describe('IssueTool', () => {
  it('offers this checkout’s repositories first, then other workspaces’', async () => {
    const { tool } = setup();
    expect((await tool.candidates('/work/app')).map((c) => c.slug)).toEqual([
      'acme/app',
      'upstream/app',
      'acme/api',
    ]);
  });

  it('shows the draft on a card and creates it once approved', async () => {
    const t = setup();
    const result = await t.run({ ...draft, labels: ['bug'] });
    expect(t.cards[0]!.request.issue).toMatchObject({
      repo: 'acme/app',
      repos: ['acme/app', 'upstream/app', 'acme/api'],
      title: draft.title,
    });
    expect(t.created).toEqual([{ repo: 'Acme/app', ...draft, labels: ['bug'] }]);
    expect(result.text).toContain('https://github.com/Acme/app/issues/7');
    expect(t.finished).toEqual([[true, expect.stringContaining('Created acme/app#7')]]);
  });

  it('creates nothing when the person declines', async () => {
    const t = setup({}, { approved: false });
    const result = await t.run(draft);
    expect(t.created).toEqual([]);
    expect(result.text).toContain('declined');
    expect(t.finished).toEqual([[false, 'Not created.']]);
  });

  it('uses what the person changed on the card, and remembers "don’t ask"', async () => {
    const t = setup(
      {},
      {
        approved: true,
        edits: {
          repo: 'acme/api',
          title: 'Better title',
          body: 'Better body',
          labels: ['api'],
          commentOn: null,
          dontAsk: true,
        },
      },
    );
    await t.run(draft);
    expect(t.created).toMatchObject([{ repo: 'acme/api', title: 'Better title', labels: ['api'] }]);
    expect(t.remembered).toEqual(['acme/api']);
  });

  it('comments on an existing issue when the person picks one', async () => {
    const t = setup(
      {
        github: {
          ...setup().tool['deps'].github,
          similarIssues: async () => [{ number: 3, title: 'Crash on empty', url: 'u' }],
        },
      },
      {
        approved: true,
        edits: { repo: 'acme/app', ...draft, labels: [], commentOn: 3, dontAsk: false },
      },
    );
    await t.run(draft);
    expect(t.cards[0]!.request.issue!.similar).toHaveLength(1);
  });

  it('refuses a repository that isn’t one of the person’s workspaces', async () => {
    const t = setup();
    const result = await t.run({ ...draft, repo: 'someone/else' });
    expect(result.isError).toBe(true);
    expect(result.text).toContain('acme/app, upstream/app, acme/api');
    expect(t.cards).toEqual([]);
    // Nor can the card's answer point anywhere else.
    const edited = setup(
      {},
      {
        approved: true,
        edits: { repo: 'someone/else', ...draft, labels: [], commentOn: null, dontAsk: false },
      },
    );
    expect((await edited.run(draft)).isError).toBe(true);
    expect(edited.created).toEqual([]);
  });

  it('redacts secrets from the draft and from the person’s edits', async () => {
    const t = setup(
      {},
      {
        approved: true,
        edits: {
          repo: 'acme/app',
          title: 'x',
          body: 'token ghp_abcdefghijklmnopqrstuvwxyz0123456789',
          labels: [],
          commentOn: null,
          dontAsk: false,
        },
      },
    );
    await t.run({ title: 'Leak', body: 'OPENAI_API_KEY=sk-proj-abcdefghijklmnopqrstuvwx fails' });
    expect(t.cards[0]!.request.issue!.body).not.toContain('sk-proj-');
    expect(JSON.stringify(t.created)).not.toContain('ghp_');
  });

  it('skips the card where the person said not to ask, unless a look-alike exists', async () => {
    const quiet = setup({ noAsk: async () => ['acme/app'] });
    await quiet.run(draft);
    expect(quiet.cards).toEqual([]);
    expect(quiet.created).toHaveLength(1);

    const base = setup().tool['deps'].github;
    const alike = setup({
      noAsk: async () => ['acme/app'],
      github: { ...base, similarIssues: async () => [{ number: 3, title: 'Crash', url: 'u' }] },
    });
    await alike.run(draft);
    expect(alike.cards).toHaveLength(1);
  });

  it('needs a conversation to show the card in', async () => {
    const t = setup();
    expect((await t.run(draft, null)).isError).toBe(true);
    expect(t.created).toEqual([]);
  });
});

describe('GithubClient issues', () => {
  it('creates an issue and reports GitHub’s refusal', async () => {
    const calls: { url: string; method: string; body: unknown }[] = [];
    const fetchStub = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({
        url: String(url),
        method: init?.method ?? 'GET',
        body: init?.body ? JSON.parse(String(init.body)) : null,
      });
      if (String(url).includes('/search/issues'))
        return new Response(
          JSON.stringify({ items: [{ number: 3, title: 'Crash', html_url: 'u3' }] }),
          { status: 200 },
        );
      if (String(url).endsWith('/repos/acme/app/issues'))
        return new Response(JSON.stringify({ number: 9, title: 'T', html_url: 'u9' }), {
          status: 201,
        });
      return new Response(JSON.stringify({ message: 'Issues are disabled' }), { status: 410 });
    });
    const client = new GithubClient({
      apiBase: 'http://gh.test',
      envToken: 't',
      fetch: fetchStub as unknown as typeof fetch,
    });
    const r = repo('acme', 'app');
    expect(await client.similarIssues('/x', r, 'Crash on empty input!')).toEqual([
      { number: 3, title: 'Crash', url: 'u3' },
    ]);
    expect(decodeURIComponent(calls[0]!.url)).toContain(
      'Crash empty input repo:acme/app is:issue is:open in:title',
    );
    expect(await client.createIssue('/x', r, { title: 'T', body: 'B', labels: [] })).toMatchObject({
      number: 9,
      url: 'u9',
    });
    expect(calls[1]!.body).toEqual({ title: 'T', body: 'B' });
    await expect(
      client.createIssue('/x', repo('acme', 'off'), { title: 'T', body: 'B', labels: [] }),
    ).rejects.toThrow('Issues are disabled');
  });
});
