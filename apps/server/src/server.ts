import { API_KEY_PREFIX, ApiKeys } from './apikeys.js';
import { WorkspaceEvents } from './events/service.js';
import { Machines } from './machines.js';
import { Idempotency } from './idempotency.js';
import { githubProvider, googleProvider } from './auth/providers.js';
import { authenticate } from './auth/sessions.js';
import { buildApp } from './app.js';
import { AuditLog } from './audit.js';
import { getRole } from './authz.js';
import type { Config } from './config.js';
import type { AppContext } from './context.js';
import { Encryptor } from './crypto.js';
import { createDb, runMigrations } from './db/client.js';
import { OutboxMailer, SmtpMailer, type Mailer } from './mail.js';
import { DeskService } from './desk/service.js';
import { pushSenders } from './push/senders.js';
import { PushService } from './push/service.js';
import { Hub } from './realtime/hub.js';
import { CollabService } from './collab/service.js';
import { FlowService } from './sessions/flow.js';
import { SubagentService } from './sessions/subagents.js';
import { SwarmService } from './swarm/service.js';
import { BillingService } from './billing/service.js';
import { StripeClient } from './billing/stripe.js';
import { SessionService } from './sessions/service.js';
import { AppleSignIn } from './auth/apple.js';

export interface StartOptions {
  mailer?: Mailer;
  providers?: AppContext['providers'];
  logger?: boolean;
}

/** Wires config into a running context: database, migrations, mail, providers and the hub. */
export async function createContext(config: Config, options: StartOptions = {}) {
  const { db, sql } = createDb(config.DATABASE_URL);
  await runMigrations(db);
  if (!config.ENCRYPTION_KEYS && config.NODE_ENV === 'development')
    console.warn(
      'ENCRYPTION_KEYS is not set: using a throwaway key. Stored transcripts and tokens become unreadable after a restart. See .env.example.',
    );
  const enc = config.ENCRYPTION_KEYS
    ? new Encryptor(config.ENCRYPTION_KEYS)
    : Encryptor.ephemeral();
  const mailer =
    options.mailer ??
    (config.SMTP_URL
      ? new SmtpMailer(config.SMTP_URL, config.MAIL_FROM)
      : new OutboxMailer(options.logger ? console.log : undefined));
  const providers: AppContext['providers'] = options.providers ?? {
    ...(config.githubEnabled
      ? { github: githubProvider(config.GITHUB_CLIENT_ID, config.GITHUB_CLIENT_SECRET) }
      : {}),
    ...(config.googleEnabled
      ? { google: googleProvider(config.GOOGLE_CLIENT_ID, config.GOOGLE_CLIENT_SECRET) }
      : {}),
  };
  const apiKeys = new ApiKeys(db);
  const hub = new Hub({
    // People sign in; a machine (agentd) connects with its `machine` API key.
    authenticate: async (token) => {
      if (!token.startsWith(API_KEY_PREFIX)) return authenticate(db, token);
      const key = await apiKeys.authenticate(token);
      return key?.scopes.includes('machine') ? key.user : null;
    },
    roleOf: (workspaceId, userId) => getRole(db, workspaceId, userId),
    log: (message) => console.warn(message),
  });
  const sessions = new SessionService(db, enc, hub, (m) => console.warn(m));
  const flow = new FlowService(db, enc, hub, sessions);
  const subagents = new SubagentService(db, hub, sessions);
  const swarm = new SwarmService(db, enc, hub, sessions);
  const desk = new DeskService(db, hub, sessions);
  const senders = pushSenders(config, (m) => console.warn(m));
  const push = new PushService(
    db,
    hub,
    senders,
    (id) => sessions.nameOf(id),
    (m) => console.warn(m),
  );
  sessions.push = push;
  flow.push = push;
  swarm.push = push;
  const billing = new BillingService(
    db,
    config,
    config.STRIPE_SECRET_KEY
      ? new StripeClient(config.STRIPE_SECRET_KEY, config.STRIPE_API_BASE)
      : null,
  );
  billing.start();
  const audit = new AuditLog(db, (m) => console.warn(m));
  const auditSweep = setInterval(() => void audit.sweep().catch(() => {}), 86_400_000);
  auditSweep.unref();
  void audit.sweep().catch(() => {});
  const events = new WorkspaceEvents(db, enc, config.KOVAN_WEBHOOK_ALLOW, undefined, (m) =>
    console.warn(m),
  );
  sessions.events = events;
  swarm.events = events;
  events.start();
  const eventSweep = setInterval(() => void events.sweep().catch(() => {}), 6 * 3_600_000);
  eventSweep.unref();
  const machines = new Machines(db);
  desk.launchOnMachine = async (swarmId, userId) => {
    const { swarm: launched } = await swarm.launch(swarmId, userId, 'auto');
    const session = await sessions.row(launched.sessionId);
    return (session.machineId && (await machines.nameOf(session.machineId))) || 'a machine';
  };
  swarm.chooseMachine = (workspaceId, choice) => machines.choose(workspaceId, choice);
  swarm.machineUser = (machineId) => machines.userOf(machineId);
  // Work on a machine that went quiet is paused, not left looking busy (or done).
  const lostCheck = setInterval(
    () =>
      void machines
        .lost()
        .then((lost) =>
          Promise.all(lost.map((l) => swarm.machineLost(l.swarmId, l.sessionId, l.machine))),
        )
        .then(() => swarm.sweepLaunchers())
        .catch(() => {}),
    30_000,
  );
  lostCheck.unref();
  const idempotency = new Idempotency(db);
  const idempotencySweep = setInterval(() => void idempotency.sweep().catch(() => {}), 3_600_000);
  idempotencySweep.unref();
  hub.attachSessions({
    snapshot: (...a) => sessions.snapshot(...a),
    laneEvents: (...a) => sessions.laneEvents(...a),
    answer: (...a) => sessions.answer(...a),
    steer: (...a) => flow.steer(...a),
  });
  sessions.start();
  const collab = new CollabService(db, hub, sessions);
  swarm.planChanged = (sessionId) => collab.changed(sessionId);
  collab.push = push;
  const ctx: AppContext = {
    config,
    db,
    enc,
    mailer,
    providers,
    hub,
    sessions,
    collab,
    flow,
    subagents,
    swarm,
    desk,
    push,
    billing,
    audit,
    idempotency,
    apiKeys,
    apple: new AppleSignIn(config),
    events,
    machines,
  };
  const app = await buildApp(ctx, { logger: options.logger ?? false });
  const close = async () => {
    billing.close();
    desk.close();
    senders.apns?.close();
    clearInterval(auditSweep);
    clearInterval(idempotencySweep);
    clearInterval(eventSweep);
    clearInterval(lostCheck);
    events.close();
    await sessions.close();
    hub.close();
    await app.close();
    await sql.end({ timeout: 5 });
  };
  return { ctx, app, close };
}
