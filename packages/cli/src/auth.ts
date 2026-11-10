import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Provider } from './config.js';
import { cliDir } from './paths.js';

/**
 * Signing in to a Kovan account, the way the desktop app does: the terminal starts a sign-in with the hash of a secret only it knows, the
 * browser finishes it (so there is no password here), and the terminal collects the token by polling with the secret.
 *
 * The token lives in `~/.kovan/auth.json`, readable only by the user. The desktop keeps its own in the system keychain; a terminal program has
 * no keychain to ask, so this is a file, and `kovan logout` removes it (and the server forgets the session).
 */
export const DEFAULT_SERVER = 'https://kovan.alperkayan.dev';

export interface Auth {
  server: string;
  token: string;
  machineId: string;
  user: { id: string; name: string } | null;
  at: string;
}

export class LoginError extends Error {}

export class AuthStore {
  constructor(private readonly dir: string = cliDir()) {}

  private get file() {
    return join(this.dir, 'auth.json');
  }

  load(): Auth | null {
    try {
      const a = JSON.parse(readFileSync(this.file, 'utf8')) as Auth;
      return a && typeof a.token === 'string' && a.token && typeof a.server === 'string' ? a : null;
    } catch {
      return null;
    }
  }

  save(a: Auth): void {
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    writeFileSync(this.file, JSON.stringify(a, null, 2), { mode: 0o600 });
    chmodSync(this.file, 0o600); // an existing file keeps its old mode otherwise
  }

  clear(): boolean {
    const had = this.load() !== null;
    rmSync(this.file, { force: true });
    return had;
  }

  /** This machine's name to the server, made once. */
  machineId(): string {
    const file = join(this.dir, 'machine-id');
    try {
      const id = readFileSync(file, 'utf8').trim();
      if (id) return id;
    } catch {
      /* first time */
    }
    const id = randomUUID();
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    writeFileSync(file, id, { mode: 0o600 });
    return id;
  }
}

export interface LoginDeps {
  server: string;
  machineId: string;
  fetchImpl: typeof fetch;
  open: (url: string) => void;
  out: (s: string) => void;
  sleep: (ms: number) => Promise<void>;
  pollMs?: number;
}

export async function login(d: LoginDeps): Promise<Auth> {
  const server = d.server.replace(/\/$/, '');
  const secret = randomBytes(32).toString('base64url');
  const secretHash = createHash('sha256').update(secret).digest('base64url');

  let start: Response;
  try {
    start = await d.fetchImpl(`${server}/auth/desktop/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ secretHash, intent: 'login', machineId: d.machineId }),
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    throw new LoginError(`Kovan sunucusuna ulaşılamadı: ${server}`);
  }
  if (!start.ok) throw new LoginError(`giriş başlatılamadı (HTTP ${start.status})`);
  const { loginId, url, expiresInSeconds } = (await start.json()) as {
    loginId: string;
    url: string;
    expiresInSeconds: number;
  };

  d.out(`Tarayıcıda girişi onayla:\n  ${url}`);
  try {
    d.open(url);
  } catch {
    /* the address is printed; he can open it himself */
  }

  const deadline = Date.now() + expiresInSeconds * 1000;
  while (Date.now() < deadline) {
    await d.sleep(d.pollMs ?? 2000);
    let result: {
      status: string;
      token?: string | null;
      user?: { id: string; name: string } | null;
      error?: string;
    };
    try {
      const res = await d.fetchImpl(`${server}/auth/desktop/poll`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ loginId, secret }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) throw new LoginError('giriş süresi doldu, tekrar dene');
      result = (await res.json()) as typeof result;
    } catch (error) {
      if (error instanceof LoginError) throw error;
      continue; // a blip while waiting; keep polling
    }
    if (result.status === 'pending') continue;
    if (result.status === 'failed') throw new LoginError(result.error ?? 'giriş başarısız');
    if (result.status === 'complete' && result.token)
      return {
        server,
        token: result.token,
        machineId: d.machineId,
        user: result.user ? { id: result.user.id, name: result.user.name } : null,
        at: new Date().toISOString(),
      };
    throw new LoginError('sunucu beklenmeyen bir yanıt verdi');
  }
  throw new LoginError('giriş süresi doldu, tekrar dene');
}

/** Who this token is, or why it no longer is anyone. */
export async function whoami(
  auth: Auth,
  fetchImpl: typeof fetch,
): Promise<{ id: string; name: string; email?: string }> {
  let res: Response;
  try {
    res = await fetchImpl(`${auth.server}/api/me`, {
      headers: { Authorization: `Bearer ${auth.token}` },
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    throw new LoginError(`Kovan sunucusuna ulaşılamadı: ${auth.server}`);
  }
  if (res.status === 401) throw new LoginError("oturum geçersiz: 'kovan login' ile yeniden gir");
  if (!res.ok) throw new LoginError(`kimlik okunamadı (HTTP ${res.status})`);
  return ((await res.json()) as { user: { id: string; name: string; email?: string } }).user;
}

/** Ending the session on the server too, so a copied token stops working. Best effort: the local file goes either way. */
export async function logout(auth: Auth, fetchImpl: typeof fetch): Promise<void> {
  try {
    await fetchImpl(`${auth.server}/auth/logout`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${auth.token}` },
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    /* offline: the token is dropped here regardless */
  }
}

/**
 * Kovan's managed model usage: the server's OpenAI-compatible endpoint, signed in with the session token. It is billed to the account
 * (provider cost + 5%), so the screen says so, and it is only used when nothing of his own is configured.
 */
export function managedProvider(auth: Auth, model?: string | null): Provider {
  return {
    baseUrl: `${auth.server.replace(/\/$/, '')}/api/inference/v1`,
    apiKey: auth.token,
    model: model ?? 'openrouter/auto',
    dialect: 'openrouter',
    label: 'Kovan hesabı (yönetilen kullanım, hesabına yazılır)',
    managed: true,
  };
}
