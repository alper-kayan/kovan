import { describe, expect, it } from 'vitest';
import type { Org } from '@kovan/shared';
import { currentOrg } from './currentOrg';

const org = (id: string, role: 'owner' | 'member'): Org =>
  ({ id, name: id, role }) as unknown as Org;

describe('which organization shows', () => {
  it('lands an invited teammate where the work is, not in an empty team of their own', () => {
    const orgs = [org('ece-team', 'owner'), org('selin-team', 'member')];
    expect(
      currentOrg({ orgs, currentOrgId: null, teamWorkspaces: [{ orgId: 'selin-team' }] })?.id,
    ).toBe('selin-team');
  });

  it('keeps the person’s own team when it has work, and always the one they picked', () => {
    const orgs = [org('mine', 'owner'), org('theirs', 'member')];
    const both = [{ orgId: 'mine' }, { orgId: 'theirs' }];
    expect(currentOrg({ orgs, currentOrgId: null, teamWorkspaces: both })?.id).toBe('mine');
    expect(currentOrg({ orgs, currentOrgId: 'theirs', teamWorkspaces: [] })?.id).toBe('theirs');
    expect(currentOrg({ orgs, currentOrgId: null, teamWorkspaces: [] })?.id).toBe('mine');
  });
});
