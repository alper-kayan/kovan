import { describe, expect, it } from 'vitest';
import { ClientMessageSchema, CreateInviteSchema, normalizeRepoUrl } from './protocol.js';

describe('normalizeRepoUrl', () => {
  it('matches https, ssh and scp-style remotes of the same repo', () => {
    const expected = 'github.com/kovan-dev/kovan';
    expect(normalizeRepoUrl('https://github.com/kovan-dev/kovan.git')).toBe(expected);
    expect(normalizeRepoUrl('git@github.com:kovan-dev/kovan.git')).toBe(expected);
    expect(normalizeRepoUrl('ssh://git@GitHub.com/kovan-dev/kovan')).toBe(expected);
    expect(normalizeRepoUrl('https://github.com/kovan-dev/kovan/')).toBe(expected);
    // The stored form itself, as another system may already have it.
    expect(normalizeRepoUrl('GitHub.com/kovan-dev/kovan')).toBe(expected);
    expect(normalizeRepoUrl(expected)).toBe(expected);
  });

  it('rejects things that are not remotes', () => {
    expect(normalizeRepoUrl('not a url')).toBeNull();
    expect(normalizeRepoUrl('kovan/kovan')).toBeNull();
    expect(normalizeRepoUrl('github.com')).toBeNull();
  });
});

describe('CreateInviteSchema', () => {
  it('needs a GitHub username or an email', () => {
    expect(CreateInviteSchema.safeParse({ role: 'editor' }).success).toBe(false);
    expect(CreateInviteSchema.safeParse({ role: 'editor', githubLogin: 'octo-cat' }).success).toBe(
      true,
    );
    expect(CreateInviteSchema.safeParse({ role: 'editor', githubLogin: '-bad' }).success).toBe(
      false,
    );
  });
});

describe('ClientMessageSchema', () => {
  it('parses known messages and rejects unknown types', () => {
    expect(ClientMessageSchema.safeParse({ type: 'subscribe', workspaceId: 'w1' }).success).toBe(
      true,
    );
    expect(ClientMessageSchema.safeParse({ type: 'shutdown' }).success).toBe(false);
  });
});
