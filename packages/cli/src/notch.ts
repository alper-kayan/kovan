import { createConnection } from 'node:net';
import { statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { AgentEvent } from '@kovan/harness';
import { combineNotches, createHookNotch, hookConfig } from './hook-notch.js';

/**
 * Showing this agent in Coucou's notch (https://github.com/Louis-CFM/coucou, MIT), and answering its approvals from there.
 *
 * Coucou documents a way for any tool to appear next to Claude Code (docs/AGENTS.md): write newline-terminated JSON, in Claude Code's own hook shape, to
 * its Unix socket, tagged with `coucou_agent`. So `kovan` does exactly what Claude Code's hook relay does and nothing in Coucou changes: a pill named
 * "kovan", a live row per tool call ("Edit Invoice.swift"), a card when it asks permission, "finished" when a turn ends.
 *
 * A permission request is the one blocking call: the connection stays open until Coucou answers `{"permissionDecision": "allow" | "always" | "deny" | "ask"}`.
 * It never costs you anything when Coucou is not there: a socket that is missing, refuses, or does not answer in 300 ms is treated as "no notch", and the
 * terminal asks as it always did.
 *
 * `KOVAN_NO_NOTCH=1` turns it off; `KOVAN_NOTCH_SOCKET=<path>` points at a different socket.
 */
export type NotchDecision = 'allow' | 'always' | 'deny' | 'ask';

export interface Notch {
  /** A fire-and-forget event (`SessionStart`, `PreToolUse`...). Never throws, never waits for the notch. */
  event(name: string, fields?: Record<string, unknown>): void;
  /** Asks the notch to approve something and waits for its answer. `null`: no notch, no answer, or the signal fired. */
  permission(fields: Record<string, unknown>, signal?: AbortSignal): Promise<NotchDecision | null>;
  /** Sends what is still waiting to go (the end of the session) before the process exits. */
  flush(): Promise<void>;
}

export const NOOP_NOTCH: Notch = {
  event: () => {},
  permission: async () => null,
  flush: async () => {},
};

const CONNECT_MS = 300;
const DECISION_MS = 118_000;

/** Where Coucou listens: the GitHub build, then the App Store build. */
export function notchSockets(
  env: Record<string, string | undefined>,
  home: string = homedir(),
): string[] {
  if (env['KOVAN_NOTCH_SOCKET']) return [env['KOVAN_NOTCH_SOCKET']];
  return [
    join(home, 'Library', 'Application Support', 'NotchBuddy', 'nb.sock'),
    join(home, 'Library', 'Containers', 'fr.louisraille.Coucou', 'Data', 'nb.sock'),
  ];
}

function liveSocket(paths: string[]): string | null {
  for (const p of paths) {
    try {
      if (statSync(p).isSocket()) return p;
    } catch {
      /* not this one */
    }
  }
  return null;
}

/** Claude Code's tool names, which is what the notch's rows and cards are written for. */
const TOOL_NAMES: Record<string, string> = {
  read_file: 'Read',
  list_dir: 'LS',
  grep: 'Grep',
  write_file: 'Write',
  edit_file: 'Edit',
  run_shell: 'Bash',
};

export function hookTool(
  name: string,
  args: Record<string, unknown>,
): { tool_name: string; tool_input: Record<string, unknown> } {
  const tool_name = TOOL_NAMES[name] ?? name;
  const path = typeof args['path'] === 'string' ? args['path'] : undefined;
  switch (name) {
    case 'read_file':
    case 'write_file':
      return { tool_name, tool_input: { ...(path ? { file_path: path } : {}) } };
    case 'edit_file':
      return { tool_name, tool_input: { ...(path ? { file_path: path } : {}) } };
    case 'list_dir':
      return { tool_name, tool_input: { ...(path ? { path } : {}) } };
    case 'grep':
      return {
        tool_name,
        tool_input: { pattern: args['pattern'] ?? '', ...(path ? { path } : {}) },
      };
    case 'run_shell':
      return { tool_name, tool_input: { command: args['command'] ?? '' } };
    default:
      return { tool_name, tool_input: args };
  }
}

export interface NotchOptions {
  env: Record<string, string | undefined>;
  home?: string;
  /** Read at each send: `/clear` starts a new conversation under the same notch. */
  sessionId: () => string;
  cwd: string;
  /** The conversation's name, shown on the card; read at each send because the first prompt names it. */
  title: () => string;
}

/** Coucou's notch (when it is installed) together with a status hook of your own (when this machine is set up for it, see hook-notch.ts). */
export function createNotch(o: NotchOptions): Notch {
  if (o.env['KOVAN_NO_NOTCH'] === '1') return NOOP_NOTCH;
  const config = hookConfig(o.env, o.home);
  const hook = config
    ? createHookNotch({ config, sessionId: o.sessionId, cwd: o.cwd, title: o.title, env: o.env })
    : NOOP_NOTCH;
  return combineNotches([createCoucouNotch(o), hook]);
}

export function createCoucouNotch(o: NotchOptions): Notch {
  const sockets = notchSockets(o.env, o.home);

  /** What `nb-hook` adds so the notch can jump back to this terminal. */
  const where = (): Record<string, string> => {
    const e = o.env;
    return {
      ...(e['TERM_PROGRAM'] ? { term_program: e['TERM_PROGRAM'] } : {}),
      ...(e['ITERM_SESSION_ID'] ? { iterm_session_id: e['ITERM_SESSION_ID'] } : {}),
      ...(e['TERM_SESSION_ID'] ? { term_session_id: e['TERM_SESSION_ID'] } : {}),
      ...(e['__CFBundleIdentifier'] ? { bundle_id: e['__CFBundleIdentifier'] } : {}),
    };
  };
  const payload = (name: string, fields: Record<string, unknown>) => {
    const title = o.title();
    return {
      hook_event_name: name,
      session_id: o.sessionId(),
      cwd: o.cwd,
      coucou_agent: 'kovan',
      ...(title && title !== 'New chat' ? { session_title: title } : {}),
      ...where(),
      ...fields,
    };
  };

  // Events go out one after another, in order, each on its own short connection like the relay's.
  let chain: Promise<void> = Promise.resolve();
  const send = (line: string) =>
    new Promise<void>((resolve) => {
      const path = liveSocket(sockets);
      if (!path) return resolve();
      const s = createConnection({ path });
      const done = () => {
        s.destroy();
        resolve();
      };
      const timer = setTimeout(done, CONNECT_MS);
      timer.unref();
      s.on('error', done);
      s.on('close', () => {
        clearTimeout(timer);
        resolve();
      });
      s.on('connect', () => {
        clearTimeout(timer);
        s.end(line, () => resolve());
      });
    });

  return {
    event(name, fields = {}) {
      const line = `${JSON.stringify(payload(name, fields))}\n`;
      chain = chain.then(() => send(line)).catch(() => {});
    },

    permission(fields, signal) {
      return new Promise<NotchDecision | null>((resolve) => {
        const path = liveSocket(sockets);
        if (!path || signal?.aborted) return resolve(null);
        const s = createConnection({ path });
        let buf = '';
        let settled = false;
        const finish = (d: NotchDecision | null) => {
          if (settled) return;
          settled = true;
          clearTimeout(connectTimer);
          clearTimeout(waitTimer);
          signal?.removeEventListener('abort', onAbort);
          s.destroy(); // closing is how the notch learns the question is gone
          resolve(d);
        };
        const onAbort = () => finish(null);
        signal?.addEventListener('abort', onAbort, { once: true });
        const connectTimer = setTimeout(() => finish(null), CONNECT_MS);
        const waitTimer = setTimeout(() => finish(null), DECISION_MS);
        connectTimer.unref();
        waitTimer.unref();
        s.on('error', () => finish(null));
        s.on('close', () => finish(null));
        s.on('connect', () => {
          clearTimeout(connectTimer);
          s.write(`${JSON.stringify(payload('PermissionRequest', fields))}\n`);
        });
        s.on('data', (chunk) => {
          buf += chunk.toString('utf8');
          if (!buf.includes('\n')) return;
          try {
            const d = (JSON.parse(buf.split('\n')[0]!) as { permissionDecision?: string })
              .permissionDecision;
            finish(d === 'allow' || d === 'always' || d === 'deny' || d === 'ask' ? d : null);
          } catch {
            finish(null);
          }
        });
      });
    },

    flush: () => chain,
  };
}

/** The hook events one agent event turns into, if any. `tools` remembers what each tool call was, for its end. */
export function notchEventsFor(
  e: AgentEvent,
  tools: Map<string, string>,
  lastText: { value: string },
): { name: string; fields: Record<string, unknown> }[] {
  switch (e.type) {
    case 'turn_start':
      lastText.value = '';
      return [];
    case 'text':
      lastText.value += e.text;
      return [];
    case 'tool_start': {
      tools.set(e.id, e.name);
      return [{ name: 'PreToolUse', fields: hookTool(e.name, e.args) }];
    }
    case 'tool_end': {
      const name = tools.get(e.id) ?? 'tool';
      tools.delete(e.id);
      return [
        {
          name: e.ok ? 'PostToolUse' : 'PostToolUseFailure',
          fields: { tool_name: TOOL_NAMES[name] ?? name },
        },
      ];
    }
    case 'turn_end':
      return e.reason === 'error'
        ? [{ name: 'StopFailure', fields: { error: e.error ?? 'error' } }]
        : [
            {
              name: 'Stop',
              fields: { last_assistant_message: lastText.value.trim().slice(-2000) },
            },
          ];
    default:
      return [];
  }
}
