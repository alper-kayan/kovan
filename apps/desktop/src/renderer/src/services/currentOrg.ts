import type { Org } from '@kovan/shared';

/**
 * The organization the sidebar and Sessions show: the one picked; else the person's own, unless
 * that one is empty and they were invited into another (an invited teammate lands where the work
 * is, not in a team of their own with nothing in it).
 */
export function currentOrg(s: {
  orgs: Org[];
  currentOrgId: string | null;
  teamWorkspaces?: readonly { orgId: string }[];
}): Org | null {
  const picked = s.orgs.find((o) => o.id === s.currentOrgId);
  if (picked) return picked;
  const own = s.orgs.find((o) => o.role === 'owner');
  const busy = new Set((s.teamWorkspaces ?? []).map((w) => w.orgId));
  if (own && !busy.has(own.id)) {
    const invited = s.orgs.find((o) => o.id !== own.id && busy.has(o.id));
    if (invited) return invited;
  }
  return own ?? s.orgs[0] ?? null;
}
