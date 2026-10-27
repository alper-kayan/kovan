import { git } from '@kovan/git-engine';

/** Diff text sent to the model at most; the stat line list always goes in full. */
const MAX_DIFF = 24_000;

export interface CommitContext {
  /** Staged changes, or every change when nothing is staged. */
  scope: 'staged' | 'all';
  stat: string;
  diff: string;
  /** The diff was longer and cut. */
  cut: boolean;
  untracked: string[];
  recent: string[];
}

/** What a commit message is written from: the changes, and how this repository words commits. */
export async function commitContext(root: string): Promise<CommitContext | null> {
  const run = (args: string[]) => git(root, args).catch(() => '');
  let scope: CommitContext['scope'] = 'staged';
  let stat = (await run(['diff', '--cached', '--stat'])).trim();
  let diff = await run(['diff', '--cached', '--no-color', '-U2']);
  let untracked: string[] = [];
  if (!stat) {
    scope = 'all';
    stat = (await run(['diff', 'HEAD', '--stat'])).trim();
    diff = await run(['diff', 'HEAD', '--no-color', '-U2']);
    untracked = (await run(['ls-files', '--others', '--exclude-standard']))
      .split('\n')
      .filter(Boolean)
      .slice(0, 50);
  }
  if (!stat && untracked.length === 0) return null;
  const recent = (await run(['log', '-12', '--format=%s']))
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);
  return {
    scope,
    stat,
    diff: diff.slice(0, MAX_DIFF),
    cut: diff.length > MAX_DIFF,
    untracked,
    recent,
  };
}

export const COMMIT_SYSTEM = [
  'You write git commit messages for the changes you are shown.',
  'Write a subject line of at most 72 characters in the imperative mood ("Add", "Fix", not "Added"), with no trailing period.',
  'If the change needs explaining, add a blank line and a short body (wrapped at 72 characters) that says what changed and why; skip the body for small, obvious changes.',
  "Follow the repository's own style from its recent subjects (language, prefixes such as feat: or a scope, capitalisation) when there is a clear one.",
  'Describe what the change does, not the files it touches. Never invent details that are not in the diff.',
  'Reply with the commit message only: no quotes, no code fences, no preamble.',
].join('\n');

export function commitPrompt(c: CommitContext): string {
  return [
    c.recent.length ? `Recent commit subjects:\n${c.recent.map((s) => `- ${s}`).join('\n')}` : '',
    `Changes (${c.scope === 'staged' ? 'staged for this commit' : 'everything not yet committed'}):\n${c.stat}`,
    c.untracked.length ? `New files:\n${c.untracked.join('\n')}` : '',
    `Diff${c.cut ? ' (cut short; the stat above lists every file)' : ''}:\n${c.diff}`,
  ]
    .filter(Boolean)
    .join('\n\n');
}

/** The model's reply as a commit message: fences, quotes and a "Commit message:" lead removed. */
export function cleanMessage(text: string): string {
  let t = text.trim();
  t = t.replace(/^```[a-z]*\n?/i, '').replace(/\n?```$/, '');
  t = t.replace(/^(commit message|message)\s*:\s*/i, '');
  t = t.trim();
  if (/^["'`].*["'`]$/s.test(t) && !t.includes('\n')) t = t.slice(1, -1).trim();
  // A body is separated from the subject by exactly one blank line.
  const [subject = '', ...rest] = t.split('\n');
  const body = rest.join('\n').trim();
  return body ? `${subject.trim()}\n\n${body}` : subject.trim();
}
