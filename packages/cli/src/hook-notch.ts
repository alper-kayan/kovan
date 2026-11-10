import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { NOOP_NOTCH, type Notch, type NotchDecision } from './notch.js';

/**
 * `kovan` reporting to a status server of your own, over plain HTTP: a session at work shows as a job running, and a permission
 * question becomes a row of the server's pending list, so a notch, a phone app or a chat bot reading from it can show it and any of them
 * can answer. The terminal asks as well and the first answer wins.
 *
 * The server needs three calls under its base address (all carry the token):
 *   POST   /api/kovan/live                   { session, cwd, title, event: start|working|idle|end, doing, lines[] }
 *   POST   /api/kovan/approval               { session, tool, title, detail }  →  { id }
 *   GET    /api/kovan/approval?id=&wait=<s>  →  { status: pending|allow|always|deny }   (long poll)
 *   DELETE /api/kovan/approval?id=           the terminal answered first: withdraw the question
 *
 * Only a one-line summary leaves the terminal (what tool, on which file or command, in which folder), to the address you set in
 * `KOVAN_HOOK_URL` and `KOVAN_HOOK_TOKEN` (or `~/.kovan/hook.env`, the same two names as `NAME=value` lines). The token goes in the
 * `Authorization: Bearer` header, or in the header named by `KOVAN_HOOK_TOKEN_HEADER`. Nothing is sent when this is not set up, and
 * KOVAN_NO_NOTCH=1 turns it off.
 */
export interface HookConfig {
  url: string;
  token: string;
  /** The header the token goes in; `Authorization: Bearer <token>` when none is named. */
  tokenHeader: string | null;
}

export function hookConfig(
  env: Record<string, string | undefined>,
  home: string = homedir(),
): HookConfig | null {
  let url = env['KOVAN_HOOK_URL'];
  let token = env['KOVAN_HOOK_TOKEN'];
  let header = env['KOVAN_HOOK_TOKEN_HEADER'];
  if (!url || !token) {
    try {
      for (const line of readFileSync(join(home, '.kovan', 'hook.env'), 'utf8').split('\n')) {
        const m =
          /^\s*(?:export\s+)?(KOVAN_HOOK_URL|KOVAN_HOOK_TOKEN|KOVAN_HOOK_TOKEN_HEADER)=(.*)$/.exec(
            line,
          );
        if (!m) continue;
        const v = m[2]!.trim().replace(/^["']|["']$/g, '');
        if (m[1] === 'KOVAN_HOOK_URL') url ||= v;
        else if (m[1] === 'KOVAN_HOOK_TOKEN') token ||= v;
        else header ||= v;
      }
    } catch {
      return null;
    }
  }
  return url && token ? { url: url.replace(/\/+$/, ''), token, tokenHeader: header || null } : null;
}

export interface HookNotchOptions {
  config: HookConfig;
  sessionId: () => string;
  cwd: string;
  title: () => string;
  fetchImpl?: typeof fetch;
  /** How long to ask about one question before giving up on this surface. */
  decisionMs?: number;
  pollSeconds?: number;
}

const short = (v: unknown, n: number) =>
  String(v ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, n);

/** What a tool call is, in a few words for a glance surface. */
export function doingOf(name: string, fields: Record<string, unknown>): string {
  const t = (fields['tool_name'] as string | undefined) ?? name;
  const input = (fields['tool_input'] ?? {}) as Record<string, unknown>;
  const what = input['file_path'] ?? input['command'] ?? input['pattern'] ?? input['path'] ?? '';
  return short(`${t} ${String(what).split('/').slice(-2).join('/')}`, 100);
}

export function createHookNotch(o: HookNotchOptions): Notch {
  const f = o.fetchImpl ?? fetch;
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    ...(o.config.tokenHeader
      ? { [o.config.tokenHeader]: o.config.token }
      : { authorization: `Bearer ${o.config.token}` }),
  };
  const call = (path: string, init: RequestInit = {}, ms = 4000) =>
    f(`${o.config.url}${path}`, {
      ...init,
      headers: { ...headers, ...(init.headers ?? {}) },
      signal: init.signal ?? AbortSignal.timeout(ms),
    });

  // Reports go one at a time, and only the newest of a burst matters: a "working" that is already stale is not worth a request.
  let chain: Promise<void> = Promise.resolve();
  let pending: Record<string, unknown> | null = null;
  /** What the terminal showed since the last request, in order: the notch's terminal view. */
  let lines: string[] = [];
  const flushPending = () => {
    const body = pending ? { ...pending, lines } : null;
    pending = null;
    lines = [];
    if (!body) return;
    chain = chain
      .then(() =>
        call('/api/kovan/live', { method: 'POST', body: JSON.stringify(body) }).then(() => {}),
      )
      .catch(() => {});
  };
  const report = (event: 'start' | 'working' | 'idle' | 'end', doing = '', line = '') => {
    if (line) lines.push(line);
    pending = {
      session: o.sessionId(),
      cwd: o.cwd,
      title: o.title() === 'New chat' ? '' : o.title(),
      event,
      doing,
    };
    // A lifecycle change goes out now; the stream of "working" is coalesced to at most one request per ~700 ms.
    if (event !== 'working') flushPending();
    else if (!timer) {
      timer = setTimeout(() => {
        timer = null;
        flushPending();
      }, 700);
      timer.unref();
    }
  };
  let timer: ReturnType<typeof setTimeout> | null = null;

  return {
    event(name, fields = {}) {
      switch (name) {
        case 'SessionStart':
          return report('start');
        case 'UserPromptSubmit':
          return report('working', 'thinking', `› ${short(fields['prompt'], 160)}`);
        case 'PreToolUse': {
          const d = doingOf(name, fields);
          return report('working', d, `▸ ${d}`);
        }
        case 'PostToolUseFailure':
          return report('working', '', `✗ ${short(fields['tool_name'], 40)} failed`);
        case 'Stop': {
          const said = short(fields['last_assistant_message'], 200);
          return report('idle', '', said ? `✔ ${said}` : '✔ done');
        }
        case 'StopFailure':
          return report('idle', '', `✗ ${short(fields['error'], 160)}`);
        case 'SessionEnd':
          return report('end');
      }
    },

    async permission(fields, signal) {
      if (signal?.aborted) return null;
      const input = (fields['tool_input'] ?? {}) as Record<string, unknown>;
      const title = doingOf('', fields) || 'permission';
      let id: string;
      try {
        const res = await call('/api/kovan/approval', {
          method: 'POST',
          body: JSON.stringify({
            session: o.sessionId(),
            tool: short(fields['tool_name'], 60),
            title,
            detail: short(
              input['command'] ?? input['description'] ?? input['file_path'] ?? '',
              600,
            ),
          }),
        });
        if (!res.ok) return null;
        id = ((await res.json()) as { id?: string }).id ?? '';
        if (!id) return null;
      } catch {
        return null;
      }
      const until = Date.now() + (o.decisionMs ?? 118_000);
      const close = () =>
        void call(`/api/kovan/approval?id=${id}`, { method: 'DELETE' }, 3000).catch(() => {});
      try {
        while (Date.now() < until && !signal?.aborted) {
          const res = await call(
            `/api/kovan/approval?id=${id}&wait=${o.pollSeconds ?? 20}`,
            signal ? { signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]) } : {},
            30_000,
          );
          if (!res.ok) break;
          const status = ((await res.json()) as { status?: string }).status;
          if (status === 'allow' || status === 'always' || status === 'deny')
            return status as NotchDecision;
          if (status !== 'pending') break;
        }
      } catch {
        // aborted, or the server went away: the terminal is still asking
      }
      // The terminal answered first (or nobody did): close the question so the phone stops offering it.
      close();
      return null;
    },

    flush: async () => {
      flushPending();
      await chain;
    },
  };
}

/** Several notches as one: every event goes to all; a question goes to all and the first real answer wins (the others are withdrawn). */
export function combineNotches(list: Notch[]): Notch {
  const live = list.filter((n) => n !== NOOP_NOTCH);
  if (live.length === 0) return NOOP_NOTCH;
  if (live.length === 1) return live[0]!;
  return {
    event: (name, fields) => live.forEach((n) => n.event(name, fields)),
    permission(fields, signal) {
      if (signal?.aborted) return Promise.resolve(null);
      const ac = new AbortController();
      const onAbort = () => ac.abort();
      signal?.addEventListener('abort', onAbort, { once: true });
      return new Promise<NotchDecision | null>((resolve) => {
        let left = live.length;
        let done = false;
        for (const n of live)
          void n.permission(fields, ac.signal).then((d) => {
            if (done) return;
            if (d && d !== 'ask') {
              done = true;
              ac.abort();
              signal?.removeEventListener('abort', onAbort);
              resolve(d);
            } else if (--left === 0) {
              done = true;
              signal?.removeEventListener('abort', onAbort);
              resolve(d ?? null);
            }
          });
      });
    },
    flush: async () => {
      await Promise.all(live.map((n) => n.flush()));
    },
  };
}
