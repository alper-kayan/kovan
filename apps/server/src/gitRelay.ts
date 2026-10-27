import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { eq } from 'drizzle-orm';
import { Readable } from 'node:stream';
import { z } from 'zod';
import { requireUser } from './auth/guard.js';
import { authorize } from './authz.js';
import type { AppContext } from './context.js';
import { workspaces } from './db/schema.js';
import { badRequest, conflict, forbidden, HttpError } from './errors.js';

const Ws = z.object({ id: z.string().uuid() });
/** Git hosts the relay reaches (a workspace's repository must be on one of them). */
const HOSTS = new Set(['github.com', 'gitlab.com', 'bitbucket.org']);
const GIT_BODIES = [
  'application/x-git-upload-pack-request',
  'application/x-git-receive-pack-request',
];
const ZERO = '0'.repeat(40);

/** One command of a push: what a ref was and what it should become. */
export interface PushCommand {
  old: string;
  new: string;
  ref: string;
}

/**
 * The commands at the start of a receive-pack request (pkt-lines up to the first flush), and the
 * bytes read to find them. Null while the flush hasn't arrived yet.
 */
export function pushCommands(head: Buffer): PushCommand[] | null {
  const out: PushCommand[] = [];
  let at = 0;
  for (;;) {
    if (head.length < at + 4) return null;
    const len = parseInt(head.subarray(at, at + 4).toString('ascii'), 16);
    if (Number.isNaN(len)) throw badRequest('Not a git push');
    if (len === 0) return out;
    if (len < 4 || head.length < at + len) return null;
    const line = head
      .subarray(at + 4, at + len)
      .toString('utf8')
      .split('\0')[0]!
      .trim();
    const [old, next, ref] = line.split(' ');
    if (old && next && ref) out.push({ old, new: next, ref });
    at += len;
  }
}

/**
 * What the relay refuses in a push: the workspace's default branch (people merge there, agents
 * don't) and deleting branches Kovan didn't make. A reason, or null to let it through.
 */
export function pushProblem(commands: PushCommand[], defaultBranch: string): string | null {
  for (const c of commands) {
    if (c.ref === `refs/heads/${defaultBranch}`)
      return `Kovan doesn't push to ${defaultBranch} for you: open a pull request instead.`;
    if (
      c.new === ZERO &&
      !c.ref.startsWith('refs/heads/kovan/') &&
      !c.ref.startsWith('refs/kovan/')
    )
      return `Kovan only deletes branches it made (kovan/…); ${c.ref} stays.`;
  }
  return null;
}

/**
 * Git through the Kovan server: a machine (agentd) fetches and pushes the workspace's repository
 * with its Kovan key, and the server reaches the git host with the workspace's own access token,
 * so no machine needs a GitHub key. Smart HTTP is relayed as it is; pushes are checked first.
 */
export function registerGitRelay(app: FastifyInstance, ctx: AppContext): void {
  const { db } = ctx;
  // Pack data is passed through as a stream, never parsed or held whole.
  app.addContentTypeParser(GIT_BODIES, (_req, payload, done) => done(null, payload));

  const workspaceOf = async (id: string) => {
    const [row] = await db.select().from(workspaces).where(eq(workspaces.id, id));
    if (!row) throw new HttpError(404, 'not_found', 'Workspace not found');
    return row;
  };

  /** The repository's smart-HTTP base on its host, and the token to reach it with. */
  const upstream = async (
    id: string,
  ): Promise<{ base: string; token: string; defaultBranch: string }> => {
    const ws = await workspaceOf(id);
    if (!ws.repoUrl) throw conflict('This workspace has no repository.');
    if (!ws.gitTokenEnc)
      throw conflict(
        'This workspace has no git access set up: an owner adds it in Settings → Workspaces → Integrations.',
      );
    const override = ctx.config.KOVAN_GIT_UPSTREAM;
    if (!override && !HOSTS.has(ws.repoUrl.split('/')[0]!.toLowerCase()))
      throw conflict(`Kovan relays git to GitHub, GitLab and Bitbucket, not ${ws.repoUrl}.`);
    return {
      base: override
        ? `${override.replace(/\/$/, '')}/${ws.repoUrl}.git`
        : `https://${ws.repoUrl}.git`,
      token: ctx.enc.decrypt(ws.gitTokenEnc),
      defaultBranch: ws.defaultBranch,
    };
  };

  const relay = async (
    reply: FastifyReply,
    url: string,
    token: string,
    init: { method: 'GET' | 'POST'; contentType?: string; encoding?: string; body?: Readable },
  ) => {
    const res = await fetch(url, {
      method: init.method,
      headers: {
        authorization: `Basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}`,
        'user-agent': 'git/2 (kovan-relay)',
        ...(init.contentType ? { 'content-type': init.contentType } : {}),
        ...(init.encoding ? { 'content-encoding': init.encoding } : {}),
        accept: '*/*',
      },
      ...(init.body
        ? { body: Readable.toWeb(init.body) as unknown as ReadableStream, duplex: 'half' as const }
        : {}),
      redirect: 'error',
    } as RequestInit);
    if (res.status === 401 || res.status === 403)
      throw new HttpError(
        502,
        'git_access_refused',
        "The git host refused the workspace's access token: an owner updates it in Settings.",
      );
    reply.code(res.status);
    const type = res.headers.get('content-type');
    if (type) reply.header('content-type', type);
    reply.header('cache-control', 'no-cache');
    return reply.send(res.body ? Readable.fromWeb(res.body as never) : '');
  };

  app.get('/api/workspaces/:id/git/info/refs', async (req, reply) => {
    const user = await requireUser(ctx, req);
    const { id } = Ws.parse(req.params);
    const { service } = z
      .object({ service: z.enum(['git-upload-pack', 'git-receive-pack']) })
      .parse(req.query);
    await authorize(
      db,
      id,
      user.id,
      service === 'git-receive-pack' ? 'session.start' : 'session.view',
    );
    const up = await upstream(id);
    return relay(reply, `${up.base}/info/refs?service=${service}`, up.token, { method: 'GET' });
  });

  app.post('/api/workspaces/:id/git/git-upload-pack', async (req, reply) => {
    const user = await requireUser(ctx, req);
    const { id } = Ws.parse(req.params);
    await authorize(db, id, user.id, 'session.view');
    const up = await upstream(id);
    return relay(reply, `${up.base}/git-upload-pack`, up.token, {
      method: 'POST',
      contentType: 'application/x-git-upload-pack-request',
      ...encodingOf(req),
      body: req.body as Readable,
    });
  });

  app.post('/api/workspaces/:id/git/git-receive-pack', async (req, reply) => {
    const user = await requireUser(ctx, req);
    const { id } = Ws.parse(req.params);
    await authorize(db, id, user.id, 'session.start');
    const up = await upstream(id);
    if (encodingOf(req).encoding) throw badRequest('Compressed pushes are not relayed.');
    // Read up to the end of the push commands, check them, then pass everything through.
    // One iterator for the whole body: leaving a for-await loop early would close the stream.
    const chunks = (req.body as Readable)[Symbol.asyncIterator]() as AsyncIterator<Buffer>;
    let head = Buffer.alloc(0);
    let commands: PushCommand[] | null = null;
    for (;;) {
      const next = await chunks.next();
      if (next.done) break;
      head = Buffer.concat([head, next.value]);
      commands = pushCommands(head);
      if (commands || head.length > 1024 * 1024) break;
    }
    if (!commands) throw badRequest('Not a git push');
    const problem = pushProblem(commands, up.defaultBranch);
    if (problem) throw forbidden(problem);
    async function* rest() {
      yield head;
      for (;;) {
        const next = await chunks.next();
        if (next.done) return;
        yield next.value;
      }
    }
    return relay(reply, `${up.base}/git-receive-pack`, up.token, {
      method: 'POST',
      contentType: 'application/x-git-receive-pack-request',
      body: Readable.from(rest()),
    });
  });

  // ---------- the workspace's access token (owners) ----------

  app.get('/api/workspaces/:id/git-access', async (req) => {
    const user = await requireUser(ctx, req);
    const { id } = Ws.parse(req.params);
    await authorize(db, id, user.id, 'session.view');
    const ws = await workspaceOf(id);
    return {
      access: {
        configured: Boolean(ws.gitTokenEnc),
        setAt: ws.gitTokenAt?.toISOString() ?? null,
        relayUrl: `${ctx.config.PUBLIC_URL}/api/workspaces/${id}/git`,
      },
    };
  });

  app.put('/api/workspaces/:id/git-access', async (req) => {
    const user = await requireUser(ctx, req);
    const { id } = Ws.parse(req.params);
    await authorize(db, id, user.id, 'workspace.manageSettings');
    const { token } = z
      .object({ token: z.string().trim().min(8).max(500).nullable() })
      .parse(req.body);
    if (token) {
      // Checked against the repository before it is kept.
      await db
        .update(workspaces)
        .set({ gitTokenEnc: ctx.enc.encrypt(token), gitTokenAt: new Date() })
        .where(eq(workspaces.id, id));
      const up = await upstream(id);
      const res = await fetch(`${up.base}/info/refs?service=git-upload-pack`, {
        headers: {
          authorization: `Basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}`,
        },
        redirect: 'error',
      }).catch(() => null);
      if (!res?.ok) {
        await db
          .update(workspaces)
          .set({ gitTokenEnc: null, gitTokenAt: null })
          .where(eq(workspaces.id, id));
        throw badRequest(
          `The git host didn't accept this token for the repository (${res?.status ?? 'unreachable'}).`,
        );
      }
    } else
      await db
        .update(workspaces)
        .set({ gitTokenEnc: null, gitTokenAt: null })
        .where(eq(workspaces.id, id));
    await ctx.audit.record({
      workspaceId: id,
      actor: user,
      action: token ? 'git_access.set' : 'git_access.cleared',
      req,
    });
    return { ok: true };
  });
}

function encodingOf(req: FastifyRequest): { encoding?: string } {
  const e = req.headers['content-encoding'];
  return typeof e === 'string' && e ? { encoding: e } : {};
}
