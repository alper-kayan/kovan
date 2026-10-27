import type { Comment } from '@kovan/shared';
import { setState } from '../store';

/** A title from the first line of some text: no markdown marks, at most 80 characters. */
export function titleFrom(text: string): string {
  const line =
    text
      .split('\n')
      .map((l) =>
        l
          .replace(/^\s*(#+|[-*>]|\d+\.)\s*/, '')
          // Bold and code marks; underscores stay (they are in names like mcp__fake__echo).
          .replace(/[*`]/g, '')
          .trim(),
      )
      .find(Boolean) ?? '';
  return line.length > 80 ? `${line.slice(0, 79).trimEnd()}…` : line;
}

/** An agent's reply, as an issue to edit before it goes anywhere. */
export function issueFromReply(text: string, sessionTitle: string | null): void {
  setState({
    issueDraft: {
      title: titleFrom(text),
      body: `${text.trim()}\n\n---\n_From an agent's reply${sessionTitle ? ` in “${sessionTitle}”` : ''}, in Kovan._`,
    },
  });
}

/** A comment (and where it points), as an issue to edit before it goes anywhere. */
export function issueFromComment(comment: Comment): void {
  const a = comment.anchor;
  const where =
    a.kind === 'file' || a.kind === 'hunk'
      ? `\n\n\`${a.path}:${a.startLine}${a.endLine !== a.startLine ? `-${a.endLine}` : ''}\``
      : a.kind === 'transcript'
        ? `\n\n> ${a.excerpt.replace(/\n/g, '\n> ')}`
        : '';
  const proposal = comment.proposal !== null ? `\n\n\`\`\`\n${comment.proposal}\n\`\`\`` : '';
  setState({
    issueDraft: {
      title: titleFrom(comment.body),
      body: `${comment.body.trim()}${where}${proposal}\n\n---\n_From ${comment.authorName}'s comment in Kovan._`,
    },
  });
}
