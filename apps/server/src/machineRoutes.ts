import { MachineHeartbeatSchema, RegisterMachineSchema } from '@kovan/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireUser } from './auth/guard.js';
import { authorize } from './authz.js';
import type { AppContext } from './context.js';

const Ws = z.object({ id: z.string().uuid() });

export function registerMachineRoutes(app: FastifyInstance, ctx: AppContext): void {
  const { machines, db, audit, sessions } = ctx;

  app.get('/api/workspaces/:id/machines', async (req) => {
    const user = await requireUser(ctx, req);
    const { id } = Ws.parse(req.params);
    await authorize(db, id, user.id, 'session.view');
    return { machines: await machines.list(id) };
  });

  // agentd, with a `machine` API key: register (again on every start) and report in.
  app.post('/api/workspaces/:id/machines', async (req) => {
    const user = await requireUser(ctx, req);
    const { id } = Ws.parse(req.params);
    await authorize(db, id, user.id, 'session.join');
    const machine = await machines.register(
      { workspaceId: id },
      user.id,
      RegisterMachineSchema.parse(req.body),
    );
    return { machine, work: await machines.work(machine.id) };
  });
  app.post('/api/machines/:id/heartbeat', async (req) => {
    const user = await requireUser(ctx, req);
    const { id } = z.object({ id: z.string() }).parse(req.params);
    const machine = await machines.heartbeat(
      id,
      user.id,
      MachineHeartbeatSchema.parse(req.body ?? {}),
    );
    // What it should be running: it starts what it isn't yet.
    return { machine, work: await machines.work(machine.id) };
  });
  app.put('/api/sessions/:id/checkout', async (req) => {
    const user = await requireUser(ctx, req);
    const { id } = z.object({ id: z.string() }).parse(req.params);
    const { path } = z.object({ path: z.string().min(1).max(500) }).parse(req.body);
    await sessions.visible(id, user.id);
    await machines.setCheckout(id, user.id, path);
    return { session: await sessions.announce(id) };
  });

  app.delete('/api/workspaces/:id/machines/:machineId', async (req) => {
    const user = await requireUser(ctx, req);
    const { id, machineId } = z
      .object({ id: z.string().uuid(), machineId: z.string().uuid() })
      .parse(req.params);
    await authorize(db, id, user.id, 'workspace.manageSettings');
    const gone = await machines.remove({ workspaceId: id }, machineId);
    await audit.record({
      workspaceId: id,
      actor: user,
      action: 'machine.removed',
      target: gone.name,
      req,
    });
    return { ok: true };
  });
}
