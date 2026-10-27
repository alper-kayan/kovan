import type { ApprovalRequest, IssueEdits, Tool } from '@kovan/harness';
import { redactText } from '@kovan/shared';
import { slugOf, type GithubClient, type GithubRepo, type IssueRef } from './github.js';

/** How the issue tool raises its card in a conversation and learns the answer. */
export interface IssueCard {
  (
    conversationId: string,
    card: { name: string; summary: string; request: Omit<ApprovalRequest, 'id'> },
  ): Promise<{
    approved: boolean;
    edits: IssueEdits | null;
    /** Closes the card's row with what happened. */
    finish(ok: boolean, output: string): void;
  } | null>;
}

export interface IssueDeps {
  github: Pick<GithubClient, 'reposOf' | 'similarIssues' | 'createIssue' | 'commentOnIssue'>;
  /** The person's other workspaces on this machine (their repositories are candidates too). */
  otherRoots(root: string): Promise<string[]>;
  card: IssueCard;
  /** Repositories ("owner/name") where issues are created without asking. */
  noAsk(): Promise<string[]>;
  rememberNoAsk(repo: string): Promise<void>;
}

interface Candidate {
  slug: string;
  repo: GithubRepo;
  /** A checkout with a remote for it, whose git credentials are used. */
  root: string;
}

export const ISSUE_TOOL = {
  name: 'create_issue',
  description:
    "Open a GitHub issue (or comment on an existing one) for something that should be tracked rather than fixed now: a bug you found outside the task, follow-up work, a question for maintainers. The person sees the issue and approves or edits it before anything is sent. Write a specific title and a body with what happens, what was expected and where in the code. Don't use it for the task you are doing, or to report progress.",
  parameters: {
    type: 'object',
    properties: {
      title: { type: 'string', description: 'Short and specific' },
      body: {
        type: 'string',
        description: 'Markdown. What, where (files, lines), how to reproduce',
      },
      repo: {
        type: 'string',
        description:
          'owner/name of the repository the problem belongs to. Leave out for the repository you are working in.',
      },
      labels: { type: 'array', items: { type: 'string' } },
      comment_on: {
        type: 'number',
        description: 'Number of an open issue to add this as a comment to, instead of a new issue',
      },
    },
    required: ['title', 'body'],
    additionalProperties: false,
  },
} as const;

const text = (value: unknown, max: number): string =>
  typeof value === 'string' ? value.trim().slice(0, max) : '';

/**
 * Creates GitHub issues for agents, with the person's own GitHub credentials (the ones git
 * uses) and their say-so: a card shows the repository, title and body, editable, before
 * anything leaves the machine. Only repositories the person has open as workspaces can be
 * targeted, and secrets are redacted from the text.
 */
export class IssueTool {
  constructor(private readonly deps: IssueDeps) {}

  /** The repositories an issue may go to: this checkout's remotes, then other workspaces'. */
  async candidates(root: string): Promise<Candidate[]> {
    const out: Candidate[] = [];
    for (const r of [root, ...(await this.deps.otherRoots(root).catch(() => [] as string[]))]) {
      const repos = await this.deps.github.reposOf(r).catch(() => [] as GithubRepo[]);
      for (const repo of repos) {
        const slug = slugOf(repo);
        if (!out.some((c) => c.slug === slug)) out.push({ slug, repo, root: r });
      }
    }
    return out;
  }

  async run(
    args: Record<string, unknown>,
    where: { root: string; conversationId: string | null },
  ): Promise<{ text: string; isError?: boolean }> {
    const fail = (message: string) => ({ text: message, isError: true });
    if (!where.conversationId)
      return fail(
        "Issues are created from a conversation in Kovan, where the person can review them. Tell the person what you'd file instead.",
      );
    const title = redactText(text(args['title'], 240));
    const body = redactText(text(args['body'], 60_000));
    if (!title || !body) return fail('Give a title and a body.');
    const labels = Array.isArray(args['labels'])
      ? args['labels']
          .flatMap((l) => (typeof l === 'string' && l.trim() ? [l.trim()] : []))
          .slice(0, 10)
      : [];
    const commentOn =
      typeof args['comment_on'] === 'number' && Number.isInteger(args['comment_on'])
        ? args['comment_on']
        : null;

    const candidates = await this.candidates(where.root);
    if (candidates.length === 0)
      return fail(
        "This checkout has no GitHub remote, so there is nowhere to open the issue. Tell the person what you'd file instead.",
      );
    const asked = text(args['repo'], 200)
      .toLowerCase()
      .replace(/^https?:\/\/[^/]+\//, '')
      .replace(/\.git$/, '');
    const target = asked ? candidates.find((c) => c.slug === asked) : candidates[0];
    if (!target)
      return fail(
        `${asked} isn't one of the person's workspaces. Issues can go to: ${candidates.map((c) => c.slug).join(', ')}.`,
      );

    const similar =
      commentOn === null
        ? await this.deps.github.similarIssues(target.root, target.repo, title).catch(() => [])
        : [];
    const noAsk = (await this.deps.noAsk()).includes(target.slug);

    let final: IssueEdits = {
      repo: target.slug,
      title,
      body,
      labels,
      commentOn,
      dontAsk: false,
    };
    let finish: (ok: boolean, output: string) => void = () => undefined;
    // A look-alike issue always goes past the person, even where they said not to ask.
    if (!noAsk || similar.length > 0) {
      const card = await this.deps.card(where.conversationId, {
        name: ISSUE_TOOL.name,
        summary:
          commentOn === null
            ? `Drafted an issue for ${target.slug}`
            : `Drafted a comment on ${target.slug}#${commentOn}`,
        request: {
          tool: ISSUE_TOOL.name,
          kind: 'command',
          title:
            commentOn === null
              ? `Open this issue in ${target.slug}?`
              : `Comment on ${target.slug}#${commentOn}?`,
          detail: `${title}\n\n${body}`,
          issue: {
            repo: target.slug,
            repos: candidates.map((c) => c.slug),
            title,
            body,
            labels,
            similar,
          },
        },
      });
      if (!card) return fail('That conversation is no longer open in Kovan.');
      finish = card.finish;
      if (!card.approved) {
        finish(false, 'Not created.');
        return {
          text: "The person declined, so no issue was created. Don't try again unless they ask.",
        };
      }
      if (card.edits) final = this.checked(card.edits, final);
    }

    const to = candidates.find((c) => c.slug === final.repo);
    if (!to) {
      finish(false, 'Not created.');
      return fail(`${final.repo} isn't one of the person's workspaces.`);
    }
    try {
      let done: string;
      if (final.commentOn !== null) {
        const comment = await this.deps.github.commentOnIssue(
          to.root,
          to.repo,
          final.commentOn,
          `${final.title}\n\n${final.body}`,
        );
        done = `Commented on ${to.slug}#${final.commentOn}: ${comment.url}`;
      } else {
        const issue: IssueRef = await this.deps.github.createIssue(to.root, to.repo, {
          title: final.title,
          body: final.body,
          labels: final.labels,
        });
        done = `Created ${to.slug}#${issue.number}: ${issue.url}`;
      }
      if (final.dontAsk) await this.deps.rememberNoAsk(to.slug);
      finish(true, done);
      return { text: done };
    } catch (error) {
      const message = (error as Error).message;
      finish(false, message);
      return fail(message);
    }
  }

  /**
   * An issue the person starts themselves, from a comment or an agent's reply: where it can go
   * and open issues that look the same, in the first of those repositories.
   */
  async draft(root: string, title: string): Promise<{ repos: string[]; similar: IssueRef[] }> {
    const candidates = await this.candidates(root);
    const first = candidates[0];
    const words = redactText(text(title, 240));
    return {
      repos: candidates.map((c) => c.slug),
      similar:
        first && words
          ? await this.deps.github.similarIssues(first.root, first.repo, words).catch(() => [])
          : [],
    };
  }

  /** Look-alikes in another of the person's repositories (the draft's repository changed). */
  async similarIn(root: string, slug: string, title: string): Promise<IssueRef[]> {
    const to = (await this.candidates(root)).find((c) => c.slug === slug);
    const words = redactText(text(title, 240));
    if (!to || !words) return [];
    return this.deps.github.similarIssues(to.root, to.repo, words).catch(() => []);
  }

  /** Sends the person's issue (or comment on an open one), checked like an agent's. */
  async file(root: string, edits: IssueEdits): Promise<{ url: string; text: string }> {
    const final = this.checked(edits, {
      repo: '',
      title: '',
      body: '',
      labels: [],
      commentOn: null,
      dontAsk: false,
    });
    if (!final.title || !final.body) throw new Error('Give a title and a body.');
    const to = (await this.candidates(root)).find((c) => c.slug === final.repo);
    if (!to) throw new Error(`${final.repo} isn't one of your workspaces' repositories.`);
    if (final.commentOn !== null) {
      const comment = await this.deps.github.commentOnIssue(
        to.root,
        to.repo,
        final.commentOn,
        `${final.title}\n\n${final.body}`,
      );
      return { url: comment.url, text: `Commented on ${to.slug}#${final.commentOn}` };
    }
    const issue = await this.deps.github.createIssue(to.root, to.repo, {
      title: final.title,
      body: final.body,
      labels: final.labels,
    });
    return { url: issue.url, text: `Created ${to.slug}#${issue.number}` };
  }

  /** The person's edits, bounded and redacted like the agent's draft. */
  private checked(edits: IssueEdits, draft: IssueEdits): IssueEdits {
    return {
      repo: text(edits.repo, 200).toLowerCase() || draft.repo,
      title: redactText(text(edits.title, 240)) || draft.title,
      body: redactText(text(edits.body, 60_000)) || draft.body,
      labels: Array.isArray(edits.labels)
        ? edits.labels
            .flatMap((l) => (typeof l === 'string' && l.trim() ? [l.trim()] : []))
            .slice(0, 10)
        : draft.labels,
      commentOn:
        typeof edits.commentOn === 'number' && Number.isInteger(edits.commentOn)
          ? edits.commentOn
          : null,
      dontAsk: edits.dontAsk === true,
    };
  }

  /** The same tool for Kovan's own agent (Claude Code and Codex get it over MCP). */
  harnessTool(where: () => { root: string; conversationId: string }): Tool {
    return {
      spec: { ...ISSUE_TOOL },
      // The harness doesn't gate it: the tool raises its own card.
      kind: 'team',
      describe: (args) => `Filed an issue: ${text(args['title'], 80)}`,
      run: async (args) => {
        const result = await this.run(args, where());
        return { ok: !result.isError, output: result.text };
      },
    };
  }
}
