/**
 * The server host's own state, as `deploy/ops-status.py` writes it every few minutes (served by
 * `GET /api/ops/status`), turned into problems the operator should hear about.
 */

export interface HostStatus {
  /** When the host wrote it. */
  at: string;
  disks: { mount: string; usedPct: number; freeGb: number }[];
  memory: { availablePct: number };
  /** Kovan's containers. */
  containers: { name: string; state: string; health: string | null; restarts: number }[];
  /** The newest database backup; null: there is none. */
  backup: { file: string; at: string } | null;
  /** The last weekly restore drill (deploy/restore-drill.sh); null: none ran yet. */
  restore?: {
    at: string;
    ok: boolean;
    detail: string;
    file: string | null;
    sha256: string | null;
  } | null;
}

/** The backups this machine keeps a copy of (deploy/monitor/pull-backups.sh). */
export interface Offsite {
  /** When the newest copy was made; null: there is none. */
  newestAt: number | null;
  /** The SHA-256 of this machine's copy of a backup; null: no copy of that one. */
  sha256Of: (file: string) => string | null;
}

export const LIMITS = {
  diskPct: 85,
  memoryPct: 10,
  /** Restarts within an hour that make a crash loop. */
  restarts: 3,
  backupHours: 26,
  /** The copies off the server (pulled once a day). */
  offsiteHours: 30,
  /** A week and a day: the drill runs weekly. */
  restoreDays: 8,
  /** The host's report older than this: its cron stopped. */
  statusMinutes: 20,
  certDays: 14,
};

export interface Seen {
  /** Each container's restart count an hour ago or less, to tell a crash loop. */
  restarts: Record<string, { count: number; at: number }>;
}

const hours = (ms: number) => Math.round(ms / 3_600_000);

/** What is wrong right now, by a key that stays the same while it stays wrong. */
export function problemsOf(
  status: HostStatus | null,
  certExpiresAt: number | null,
  seen: Seen,
  now: number,
  /** Not given: this machine keeps no copies. */
  offsite?: Offsite,
): Record<string, string> {
  const out: Record<string, string> = {};
  if (offsite?.newestAt === null)
    out['offsite'] = 'There is no copy of the backups off the server.';
  else if (offsite && now - offsite.newestAt > LIMITS.offsiteHours * 3_600_000)
    out['offsite'] =
      `The newest backup copied off the server is ${hours(now - offsite.newestAt)} h old.`;
  if (certExpiresAt !== null && certExpiresAt - now < LIMITS.certDays * 86_400_000)
    out['cert'] =
      certExpiresAt <= now
        ? 'The HTTPS certificate has expired.'
        : `The HTTPS certificate expires in ${Math.max(0, Math.floor((certExpiresAt - now) / 86_400_000))} days.`;
  if (!status) return out;

  const age = now - Date.parse(status.at);
  if (!(age < LIMITS.statusMinutes * 60_000))
    out['status'] =
      `The host's own report is ${Number.isNaN(age) ? 'unreadable' : `${Math.round(age / 60_000)} min old`}: is its cron running?`;
  for (const d of status.disks)
    if (d.usedPct >= LIMITS.diskPct)
      out[`disk:${d.mount}`] = `Disk ${d.mount} is ${d.usedPct}% full (${d.freeGb} GB free).`;
  if (status.memory.availablePct < LIMITS.memoryPct)
    out['memory'] = `Only ${status.memory.availablePct}% of the memory is free.`;

  for (const c of status.containers) {
    const before = seen.restarts[c.name];
    if (!before || now - before.at >= 3_600_000 || c.restarts < before.count)
      seen.restarts[c.name] = { count: c.restarts, at: now };
    const since = c.restarts - (seen.restarts[c.name]?.count ?? c.restarts);
    if (c.state !== 'running') out[`container:${c.name}`] = `${c.name} is ${c.state}.`;
    else if (c.health === 'unhealthy') out[`container:${c.name}`] = `${c.name} is unhealthy.`;
    else if (since >= LIMITS.restarts)
      out[`container:${c.name}`] = `${c.name} restarted ${since} times within the hour.`;
  }
  for (const name of Object.keys(seen.restarts))
    if (!status.containers.some((c) => c.name === name)) delete seen.restarts[name];

  const drill = status.restore;
  if (!drill) out['restore'] = 'No restore drill has run yet.';
  else if (!drill.ok) out['restore'] = `The restore drill failed: ${drill.detail}`;
  else if (now - Date.parse(drill.at) > LIMITS.restoreDays * 86_400_000)
    out['restore'] =
      `The last restore drill was ${Math.floor((now - Date.parse(drill.at)) / 86_400_000)} days ago.`;
  // The drill read the server's file; the copy here must be the same bytes.
  if (offsite && drill?.file && drill.sha256) {
    const copy = offsite.sha256Of(drill.file);
    if (copy !== null && copy !== drill.sha256)
      out['offsite-copy'] = `The copy of ${drill.file} off the server differs from the server's.`;
  }

  if (!status.backup) out['backup'] = 'There is no database backup.';
  else {
    const backupAge = now - Date.parse(status.backup.at);
    if (backupAge > LIMITS.backupHours * 3_600_000)
      out['backup'] = `The newest database backup is ${hours(backupAge)} h old.`;
  }
  return out;
}
