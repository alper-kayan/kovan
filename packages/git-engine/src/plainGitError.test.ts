import { describe, expect, it } from 'vitest';
import { plainGitError } from './git.js';

describe('a failed git command in words', () => {
  it('says what went wrong and keeps git’s own line', () => {
    const push = plainGitError(
      ['push', 'origin', 'main'],
      "fatal: '/nonexistent/remote.git' does not appear to be a git repository\nfatal: Could not read from remote repository.",
    );
    expect(push).toMatch(/^Git found no repository at that address/);
    expect(push).toContain('Your commits are still saved on this computer.');
    expect(push).toContain(
      "(git said: '/nonexistent/remote.git' does not appear to be a git repository)",
    );
    expect(
      plainGitError(['fetch'], 'fatal: unable to access x: Could not resolve host: github.com'),
    ).toMatch(/couldn't reach the server/);
    expect(plainGitError(['push'], 'ERROR: Permission to a/b.git denied to ece.')).toMatch(
      /isn't allowed to push to this repository/,
    );
    expect(plainGitError(['status'], 'fatal: something odd')).toBe(
      'git status failed: fatal: something odd',
    );
  });
});
