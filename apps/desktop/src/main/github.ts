import { getRemoteUrl, git } from '@kovan/git-engine';
import type { SessionPr } from '@kovan/shared';
import { pushRemote } from '@kovan/runner';

export interface GithubRepo {
  host: string;
  owner: string;
  repo: string;
}

/** owner/repo from an https or ssh GitHub remote URL; null for anything else. */
export function parseGithubRemote(url: string): GithubRepo | null {
  const m =
    /^(?:https?:\/\/(?:[^@/]+@)?|ssh:\/\/git@|git@)([^/:]+)[/:]([^/]+)\/([^/]+?)(?:\.git)?\/?$/.exec(
      url.trim(),
    );
  if (!m) return null;
  return { host: m[1]!.toLowerCase(), owner: m[2]!, repo: m[3]! };
}

export interface GithubDeps {
  /** API base (tests point it at a fake server). */
  apiBase?: string | undefined;
  /** A token from the environment; otherwise git's own credential helper is asked. */
  envToken?: string | null | undefined;
  fetch?: typeof fetch | undefined;
}

/**
 * Pull requests through the GitHub API with the person's own GitHub credentials: the token git
 * already uses for the remote (its credential helper), or GITHUB_TOKEN. Kovan stores none.
 */
export class GithubClient {
  constructor(private readonly deps: GithubDeps = {}) {}

  private api(repo: GithubRepo): string {
    if (this.deps.apiBase) return this.deps.apiBase.replace(/\/$/, '');
    return repo.host === 'github.com' ? 'https://api.github.com' : `https://${repo.host}/api/v3`;
  }

  async repoOf(root: string): Promise<GithubRepo> {
    const remote = (await pushRemote(root)) ?? 'origin';
    const url = await getRemoteUrl(root, remote);
    const repo = url ? parseGithubRemote(url) : null;
    if (!repo) throw new Error(`The ${remote} remote isn't a GitHub repository.`);
    return repo;
  }

  private async token(root: string, repo: GithubRepo): Promise<string> {
    if (this.deps.envToken) return this.deps.envToken;
    const out = await git(root, ['-c', 'credential.interactive=never', 'credential', 'fill'], {
      input: `protocol=https\nhost=${repo.host}\n\n`,
      timeoutMs: 15_000,
    }).catch(() => '');
    const token = /^password=(.+)$/m.exec(out)?.[1]?.trim();
    if (!token)
      throw new Error(
        `No GitHub credentials for ${repo.host}: sign in to GitHub with git (or set GITHUB_TOKEN) and try again.`,
      );
    return token;
  }

  private async call<T>(
    root: string,
    repo: GithubRepo,
    method: 'GET' | 'POST',
    path: string,
    body?: unknown,
  ): Promise<{ status: number; data: T }> {
    const res = await (this.deps.fetch ?? fetch)(`${this.api(repo)}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${await this.token(root, repo)}`,
        accept: 'application/vnd.github+json',
        'x-github-api-version': '2022-11-28',
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(30_000),
    });
    const data = (await res.json().catch(() => ({}))) as T;
    return { status: res.status, data };
  }

  /** Opens the session's pull request, or finds the one already open for its branch. */
  async createPr(
    root: string,
    input: { title: string; body: string; head: string; base: string },
  ): Promise<SessionPr> {
    const repo = await this.repoOf(root);
    const r = await this.call<{
      html_url?: string;
      number?: number;
      message?: string;
      errors?: { message?: string }[];
    }>(root, repo, 'POST', `/repos/${repo.owner}/${repo.repo}/pulls`, input);
    if (r.status === 201 && r.data.html_url && r.data.number)
      return { url: r.data.html_url, number: r.data.number, state: 'open' };
    const why = [r.data.message, ...(r.data.errors ?? []).map((e) => e.message)]
      .filter(Boolean)
      .join(': ');
    if (r.status === 422 && /already exists/i.test(why)) {
      const open = await this.call<{ html_url: string; number: number }[]>(
        root,
        repo,
        'GET',
        `/repos/${repo.owner}/${repo.repo}/pulls?state=open&head=${encodeURIComponent(`${repo.owner}:${input.head}`)}`,
      );
      const pr = Array.isArray(open.data) ? open.data[0] : undefined;
      if (pr) return { url: pr.html_url, number: pr.number, state: 'open' };
    }
    throw new Error(
      `GitHub didn't open the pull request (${r.status}): ${why || 'no reason given'}`,
    );
  }

  async prState(root: string, number: number): Promise<SessionPr['state']> {
    const repo = await this.repoOf(root);
    const r = await this.call<{ state?: string; merged?: boolean; merged_at?: string | null }>(
      root,
      repo,
      'GET',
      `/repos/${repo.owner}/${repo.repo}/pulls/${number}`,
    );
    if (r.status !== 200)
      throw new Error(
        `GitHub didn't let Kovan read pull request #${number} (HTTP ${r.status}): check that your GitHub account can open ${repo.owner}/${repo.repo}.`,
      );
    if (r.data.merged || r.data.merged_at) return 'merged';
    return r.data.state === 'closed' ? 'closed' : 'open';
  }

  /** Every GitHub repository this checkout has a remote for, the push remote first. */
  async reposOf(root: string): Promise<GithubRepo[]> {
    const push = (await pushRemote(root).catch(() => null)) ?? 'origin';
    const names = (await git(root, ['remote']).catch(() => ''))
      .split('\n')
      .map((n) => n.trim())
      .filter(Boolean)
      .sort((a, b) => Number(b === push) - Number(a === push));
    const out: GithubRepo[] = [];
    for (const name of names) {
      const url = await getRemoteUrl(root, name);
      const repo = url ? parseGithubRemote(url) : null;
      if (repo && !out.some((r) => slugOf(r) === slugOf(repo))) out.push(repo);
    }
    return out;
  }

  /** Open issues whose title shares words with this one, best match first. */
  async similarIssues(root: string, repo: GithubRepo, title: string): Promise<IssueRef[]> {
    const words = title
      .replace(/[^\p{L}\p{N} ]+/gu, ' ')
      .split(/\s+/)
      .filter((w) => w.length > 2)
      .slice(0, 8)
      .join(' ');
    if (!words) return [];
    const q = `${words} repo:${repo.owner}/${repo.repo} is:issue is:open in:title`;
    const r = await this.call<{
      items?: { number: number; title: string; html_url: string }[];
    }>(root, repo, 'GET', `/search/issues?per_page=5&q=${encodeURIComponent(q)}`);
    // Search is a courtesy: a failure must not stop the issue.
    if (r.status !== 200 || !Array.isArray(r.data.items)) return [];
    return r.data.items.map((i) => ({ number: i.number, title: i.title, url: i.html_url }));
  }

  async createIssue(
    root: string,
    repo: GithubRepo,
    input: { title: string; body: string; labels: string[] },
  ): Promise<IssueRef> {
    const r = await this.call<{
      html_url?: string;
      number?: number;
      title?: string;
      message?: string;
    }>(root, repo, 'POST', `/repos/${repo.owner}/${repo.repo}/issues`, {
      title: input.title,
      body: input.body,
      ...(input.labels.length ? { labels: input.labels } : {}),
    });
    if (r.status === 201 && r.data.html_url && r.data.number)
      return { number: r.data.number, title: r.data.title ?? input.title, url: r.data.html_url };
    throw new Error(
      `GitHub didn't create the issue (${r.status}): ${r.data.message ?? 'no reason given'}`,
    );
  }

  async commentOnIssue(
    root: string,
    repo: GithubRepo,
    number: number,
    body: string,
  ): Promise<{ url: string }> {
    const r = await this.call<{ html_url?: string; message?: string }>(
      root,
      repo,
      'POST',
      `/repos/${repo.owner}/${repo.repo}/issues/${number}/comments`,
      { body },
    );
    if (r.status === 201 && r.data.html_url) return { url: r.data.html_url };
    throw new Error(
      `GitHub didn't add the comment (${r.status}): ${r.data.message ?? 'no reason given'}`,
    );
  }
}

export interface IssueRef {
  number: number;
  title: string;
  url: string;
}

/** "owner/name", as people write a repository. */
export function slugOf(repo: GithubRepo): string {
  return `${repo.owner}/${repo.repo}`.toLowerCase();
}

/**
 * A pull request body that closes the session's issue when it merges: "Closes owner/repo#12"
 * is added unless the body already closes it.
 */
export function bodyClosing(body: string, issue: { number: number; url: string | null } | null) {
  if (!issue) return body;
  const repo = /github\.com\/([^/]+)\/([^/]+)\/issues\/\d+/.exec(issue.url ?? '');
  const ref = repo ? `${repo[1]}/${repo[2]}#${issue.number}` : `#${issue.number}`;
  const closes = new RegExp(
    `\\b(close[sd]?|fix(e[sd])?|resolve[sd]?)\\s+(\\S+/\\S+)?#${issue.number}\\b`,
    'i',
  );
  if (closes.test(body)) return body;
  return `${body.trim()}\n\nCloses ${ref}`.trim();
}
