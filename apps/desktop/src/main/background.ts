import { spawn } from 'node:child_process';
import { mkdir, open, readFile, rm, writeFile } from 'node:fs/promises';
import { hostname } from 'node:os';
import { join } from 'node:path';
import type { Org } from '@kovan/shared';
import type { BackgroundStatus } from '../shared/api.js';

/** What the background agents need from the app. */
export interface BackgroundDeps {
  /** The app's data folder (userData). */
  dataDir: string;
  /** The bundled agentd and the MCP bridge its Claude Code runs start (out/main/*.js). */
  agentdScript: string;
  mcpScript: string;
  /** The Electron binary, run as Node for agentd. */
  execPath: string;
  serverUrl: string;
  request<T>(method: string, path: string, body?: unknown): Promise<T>;
  /** The checkouts opened on this computer (workspace id → folder). */
  checkouts(): Promise<Record<string, string>>;
  pathEnv(): Promise<string>;
  /** The OS keychain (Electron's safeStorage). */
  encrypt(text: string): Buffer;
  decrypt(data: Buffer): string;
  log(line: string): void;
}

interface Stored {
  orgId: string;
  keyId: string;
  /** The machine key, encrypted by the OS keychain (base64). */
  key: string;
  pid: number | null;
  name: string;
}

/**
 * Background agents: this computer's own agentd, started by the app as a process of its own
 * (Electron run as Node, detached), so swarms sent to it keep going after the app quits. It is
 * a machine of the organization (its key is made here and kept in the keychain), offers the
 * checkouts opened here, and does its work with Claude Code on the person's subscription.
 */
export class BackgroundAgents {
  constructor(private readonly deps: BackgroundDeps) {}

  private get file(): string {
    return join(this.deps.dataDir, 'background-agents.json');
  }

  private async stored(): Promise<Stored | null> {
    return readFile(this.file, 'utf8')
      .then((t) => JSON.parse(t) as Stored)
      .catch(() => null);
  }

  private async save(s: Stored | null): Promise<void> {
    if (s) await writeFile(this.file, JSON.stringify(s), { mode: 0o600 });
    else await rm(this.file, { force: true });
  }

  private alive(pid: number | null): boolean {
    if (!pid) return false;
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }

  async status(): Promise<BackgroundStatus> {
    const s = await this.stored();
    if (!s) return { enabled: false, running: false, name: null, log: null };
    return {
      enabled: true,
      running: this.alive(s.pid),
      name: s.name,
      log: join(this.deps.dataDir, 'agentd', 'agentd.log'),
    };
  }

  /** Turns them on: a machine key for the organization, then agentd. */
  async enable(): Promise<BackgroundStatus> {
    if (!(await this.stored())) {
      const { orgs } = await this.deps.request<{ orgs: Org[] }>('GET', '/api/me');
      const org = orgs.find((o) => o.role === 'owner');
      if (!org)
        throw new Error(
          'Background agents need an organization you own (they run as its machine).',
        );
      const name = `${hostname().split('.')[0]} (background)`;
      const { key, token } = await this.deps.request<{ key: { id: string }; token: string }>(
        'POST',
        `/api/orgs/${org.id}/api-keys`,
        { name, scopes: ['machine'] },
      );
      await this.save({
        orgId: org.id,
        keyId: key.id,
        key: this.deps.encrypt(token).toString('base64'),
        pid: null,
        name,
      });
    }
    await this.start();
    return this.status();
  }

  /** Turns them off: agentd pauses what it runs and stops; its key is revoked. */
  async disable(): Promise<BackgroundStatus> {
    const s = await this.stored();
    if (s) {
      if (this.alive(s.pid)) process.kill(s.pid!, 'SIGTERM');
      await this.deps
        .request('DELETE', `/api/orgs/${s.orgId}/api-keys/${s.keyId}`)
        .catch((e: unknown) => this.deps.log(`Background agents: key not revoked: ${String(e)}`));
      await this.save(null);
    }
    return this.status();
  }

  /** At launch (and after turning them on): agentd runs unless it already does. */
  async start(): Promise<void> {
    const s = await this.stored();
    if (!s || this.alive(s.pid)) return;
    const repos = Object.values(await this.deps.checkouts());
    if (repos.length === 0) {
      this.deps.log('Background agents: no checkout opened on this computer yet.');
      return;
    }
    const dir = join(this.deps.dataDir, 'agentd');
    await mkdir(dir, { recursive: true });
    const out = await open(join(dir, 'agentd.log'), 'a', 0o600);
    // Not the app's own environment: no key or token of the app reaches agentd's agents.
    const env: Record<string, string> = {
      ELECTRON_RUN_AS_NODE: '1',
      PATH: await this.deps.pathEnv(),
      HOME: process.env['HOME'] ?? '',
      USER: process.env['USER'] ?? '',
      LANG: process.env['LANG'] ?? 'en_US.UTF-8',
      KOVAN_SERVER_URL: this.deps.serverUrl,
      KOVAN_API_KEY: this.deps.decrypt(Buffer.from(s.key, 'base64')),
      KOVAN_REPOS: repos.join(','),
      KOVAN_MACHINE_NAME: s.name,
      KOVAN_DATA_DIR: dir,
      KOVAN_CLAUDE_MCP_ENTRY: this.deps.mcpScript,
    };
    const child = spawn(this.deps.execPath, [this.deps.agentdScript], {
      detached: true,
      stdio: ['ignore', out.fd, out.fd],
      env,
    });
    child.unref();
    await out.close();
    await this.save({ ...s, pid: child.pid ?? null });
    this.deps.log(
      `Background agents: agentd started (${child.pid}) with ${repos.length} checkout(s).`,
    );
  }
}
