import {
  normalizeRepoUrl,
  type Machine,
  type MachineHeartbeatSchema,
  type RegisterMachineSchema,
} from '@kovan/shared';
import { and, eq, inArray, lt, or, sql } from 'drizzle-orm';
import type { z } from 'zod';
import type { Db } from './db/client.js';
import { apiKeys, machines, sessions, swarms, workspaces } from './db/schema.js';
import { conflict, forbidden, notFound } from './errors.js';
import { inScope, isOrg, orgOfWorkspace, orgWorkspaceIds, type Scope } from './scope.js';

/** A machine reports every 30 seconds; three missed reports and it counts as offline. */
export const ONLINE_MS = 90_000;

type MachineRow = typeof machines.$inferSelect;
type Register = z.infer<typeof RegisterMachineSchema>;
type Heartbeat = z.infer<typeof MachineHeartbeatSchema>;

const repoKey = (remote: string) => normalizeRepoUrl(remote) ?? remote.trim();

/**
 * Machines that run agents unattended (agentd). Each belongs to the member that registered it
 * (its API key), reports what it has (agents, checkouts, slots) and when it was last heard
 * from. Work can be sent to one, or to the least busy one holding the repository.
 */
export class Machines {
  constructor(private readonly db: Db) {}

  /** Registers a machine, or updates it when this member registered it before. */
  async register(scope: Scope, userId: string, input: Register): Promise<Machine> {
    const values = {
      platform: input.platform,
      slots: input.slots,
      agents: input.agents,
      repos: input.repos.map((r) => ({ remote: repoKey(r.remote), path: r.path })),
      lastSeenAt: new Date(),
    };
    const [existing] = await this.db
      .select()
      .from(machines)
      .where(and(inScope(machines, scope), eq(machines.name, input.name)));
    if (existing && existing.userId !== userId)
      throw conflict(`Another machine is already called "${input.name}" here.`);
    const [row] = existing
      ? await this.db.update(machines).set(values).where(eq(machines.id, existing.id)).returning()
      : await this.db
          .insert(machines)
          .values({
            ...(isOrg(scope) ? { orgId: scope.orgId } : { workspaceId: scope.workspaceId }),
            userId,
            name: input.name,
            ...values,
          })
          .returning();
    return (await this.toMachines([row!]))[0]!;
  }

  /** The machine's report: it is alive, and what it has now. */
  async heartbeat(machineId: string, userId: string, input: Heartbeat): Promise<Machine> {
    const row = await this.own(machineId, userId);
    const [updated] = await this.db
      .update(machines)
      .set({
        lastSeenAt: new Date(),
        ...(input.slots !== undefined ? { slots: input.slots } : {}),
        ...(input.agents !== undefined ? { agents: input.agents } : {}),
        ...(input.repos !== undefined
          ? { repos: input.repos.map((r) => ({ remote: repoKey(r.remote), path: r.path })) }
          : {}),
      })
      .where(eq(machines.id, row.id))
      .returning();
    return (await this.toMachines([updated!]))[0]!;
  }

  /** The machines a workspace can send work to: its own and its organization's. */
  async list(workspaceId: string): Promise<Machine[]> {
    const orgId = await orgOfWorkspace(this.db, workspaceId);
    const rows = await this.db
      .select()
      .from(machines)
      .where(
        orgId
          ? or(eq(machines.workspaceId, workspaceId), eq(machines.orgId, orgId))
          : eq(machines.workspaceId, workspaceId),
      )
      .orderBy(machines.name);
    return this.toMachines(rows);
  }

  /** An organization's machines, and those of each of its workspaces. */
  async listOrg(orgId: string): Promise<Machine[]> {
    const ids = await orgWorkspaceIds(this.db, orgId);
    const rows = await this.db
      .select()
      .from(machines)
      .where(
        ids.length
          ? or(eq(machines.orgId, orgId), inArray(machines.workspaceId, ids))
          : eq(machines.orgId, orgId),
      )
      .orderBy(machines.name);
    return this.toMachines(rows);
  }

  async remove(scope: Scope, machineId: string): Promise<MachineRow> {
    const [row] = await this.db
      .delete(machines)
      .where(and(eq(machines.id, machineId), inScope(machines, scope)))
      .returning();
    if (!row) throw notFound('Machine not found');
    return row;
  }

  /**
   * Where new work in this workspace runs. A machine by id must be in the workspace, online
   * and have a free slot; "auto" takes the least busy online machine that holds the
   * workspace's repository (any machine when the workspace has no remote).
   */
  async choose(workspaceId: string, choice: string): Promise<string> {
    const list = await this.list(workspaceId);
    if (choice !== 'auto') {
      const m = list.find((x) => x.id === choice);
      if (!m) throw notFound('Machine not found');
      if (!m.online) throw conflict(`${m.name} is offline.`);
      if (m.running >= m.slots)
        throw conflict(`${m.name} is busy (${m.running} of ${m.slots} slots in use).`);
      return m.id;
    }
    const [ws] = await this.db
      .select({ repoUrl: workspaces.repoUrl })
      .from(workspaces)
      .where(eq(workspaces.id, workspaceId));
    const repo = ws?.repoUrl ?? null;
    const holding = list.filter((m) => !repo || m.repos.some((r) => r.remote === repo));
    const free = holding.filter((m) => m.online && m.running < m.slots);
    if (free.length === 0)
      throw conflict(
        holding.length === 0
          ? `No registered machine holds ${repo ?? 'this repository'}.`
          : holding.some((m) => m.online)
            ? 'Every machine that holds the repository is busy.'
            : 'No machine that holds the repository is online.',
      );
    free.sort(
      (a, b) =>
        a.running / a.slots - b.running / b.slots ||
        Date.parse(b.lastSeenAt) - Date.parse(a.lastSeenAt),
    );
    return free[0]!.id;
  }

  /** The swarms running on a machine's sessions: the work it should be doing now. */
  async work(machineId: string): Promise<{ swarmId: string; sessionId: string }[]> {
    return this.db
      .select({ swarmId: swarms.id, sessionId: swarms.sessionId })
      .from(swarms)
      .innerJoin(sessions, eq(sessions.id, swarms.sessionId))
      .where(
        and(
          eq(sessions.machineId, machineId),
          eq(sessions.status, 'active'),
          eq(swarms.status, 'running'),
        ),
      );
  }

  /**
   * Running swarms on machines that stopped reporting: their work can't be going on, so it
   * must not look as if it were (or as if it finished).
   */
  async lost(): Promise<{ swarmId: string; sessionId: string; machine: string }[]> {
    return this.db
      .select({ swarmId: swarms.id, sessionId: swarms.sessionId, machine: machines.name })
      .from(swarms)
      .innerJoin(sessions, eq(sessions.id, swarms.sessionId))
      .innerJoin(machines, eq(machines.id, sessions.machineId))
      .where(
        and(
          eq(swarms.status, 'running'),
          lt(machines.lastSeenAt, new Date(Date.now() - ONLINE_MS)),
        ),
      );
  }

  /** The member a machine reports as (its API key's), or null when it was removed. */
  async nameOf(machineId: string): Promise<string | null> {
    const [row] = await this.db
      .select({ name: machines.name })
      .from(machines)
      .where(eq(machines.id, machineId));
    return row?.name ?? null;
  }

  async userOf(machineId: string): Promise<string | null> {
    const [row] = await this.db
      .select({ userId: machines.userId })
      .from(machines)
      .where(eq(machines.id, machineId));
    return row?.userId ?? null;
  }

  /** The machine running a session says where its checkout is. */
  async setCheckout(sessionId: string, userId: string, path: string): Promise<void> {
    const [row] = await this.db
      .select({ machineId: sessions.machineId })
      .from(sessions)
      .where(eq(sessions.id, sessionId));
    if (!row) throw notFound('Session not found');
    if (!row.machineId) throw conflict('This session is not running on a registered machine.');
    await this.own(row.machineId, userId);
    await this.db
      .update(sessions)
      .set({ worktreePath: path, updatedAt: new Date() })
      .where(eq(sessions.id, sessionId));
  }

  private async own(machineId: string, userId: string): Promise<MachineRow> {
    const [row] = /^[0-9a-f-]{36}$/i.test(machineId)
      ? await this.db.select().from(machines).where(eq(machines.id, machineId))
      : [];
    if (!row) throw notFound('Machine not found: it may have been removed.');
    if (row.userId !== userId) throw forbidden('Only the machine itself reports for it.');
    return row;
  }

  private async toMachines(rows: MachineRow[]): Promise<Machine[]> {
    if (rows.length === 0) return [];
    const ids = rows.map((r) => r.id);
    const busy = await this.db
      .select({ machineId: sessions.machineId, n: sql<number>`count(*)::int` })
      .from(sessions)
      .where(
        and(
          inArray(sessions.machineId, ids),
          eq(sessions.status, 'active'),
          // A slot is taken by work about to start or under way: a session with no swarm yet
          // (sent here, its swarm still to come) or one whose swarm is a draft or running. A
          // done, stopped or paused swarm leaves the machine free, even while its session
          // stays open for review.
          sql`(not exists (select 1 from ${swarms} where ${swarms.sessionId} = ${sessions.id})
            or exists (select 1 from ${swarms} where ${swarms.sessionId} = ${sessions.id}
              and ${swarms.status} in ('draft', 'running')))`,
        ),
      )
      .groupBy(sessions.machineId);
    const keys = await this.db
      .select({ userId: apiKeys.userId, name: apiKeys.name })
      .from(apiKeys)
      .where(
        inArray(
          apiKeys.userId,
          rows.map((r) => r.userId),
        ),
      );
    const now = Date.now();
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      platform: r.platform,
      slots: r.slots,
      running: busy.find((b) => b.machineId === r.id)?.n ?? 0,
      // Older agentd versions don't say which agent works.
      agents: r.agents.map((a) => ({ ...a, works: a.works ?? false })),
      repos: r.repos,
      online: now - r.lastSeenAt.getTime() < ONLINE_MS,
      lastSeenAt: r.lastSeenAt.toISOString(),
      createdAt: r.createdAt.toISOString(),
      keyName: keys.find((k) => k.userId === r.userId)?.name ?? null,
      scope: r.orgId ? 'organization' : 'workspace',
    }));
  }
}
