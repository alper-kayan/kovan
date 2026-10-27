import { HARNESS_NAMES, type ExternalHarness } from '../../../shared/agent';
import { getState, notify, reportError, setState, showView } from '../store';
import { api } from './api';

type Sink = (data: string) => void;

/** Recent output per terminal, replayed when a view (re)attaches. Bounded per terminal. */
const MAX_REPLAY_CHARS = 256 * 1024;
const sinks = new Map<number, Sink>();
const replay = new Map<number, string>();

api.on('terminal:data', (id, data) => {
  const buffered = (replay.get(id) ?? '') + data;
  replay.set(id, buffered.length > MAX_REPLAY_CHARS ? buffered.slice(-MAX_REPLAY_CHARS) : buffered);
  sinks.get(id)?.(data);
});

api.on('terminal:exit', (id) => {
  setState((s) => ({
    terminals: s.terminals.map((t) => (t.id === id ? { ...t, exited: true } : t)),
  }));
});

export function attachTerminal(id: number, sink: Sink): () => void {
  sinks.set(id, sink);
  const buffered = replay.get(id);
  if (buffered) sink(buffered);
  return () => {
    if (sinks.get(id) === sink) sinks.delete(id);
  };
}

/** Sign-ins being started, so a second click doesn't open a second login (and browser page). */
const signingIn = new Set<string>();

/** Opens a shell, or an agent CLI's own TUI (Claude Code, Codex) wired to Kovan. */
export async function newTerminal(
  agent?: ExternalHarness,
  as?: { account?: string; login?: boolean; title?: string },
): Promise<void> {
  const signIn = agent && as?.login ? `${agent}#${as.account ?? ''}` : null;
  if (signIn) {
    const open = getState().terminals.find((t) => t.signIn === signIn && !t.exited);
    if (signingIn.has(signIn) || open) {
      if (open) showSignIn(open.id);
      return;
    }
    signingIn.add(signIn);
  }
  try {
    const id = await api.invoke('terminal:create', {
      cols: 80,
      rows: 24,
      ...(agent ? { agent } : {}),
      ...(as?.account ? { account: as.account } : {}),
      ...(as?.login ? { login: true } : {}),
    });
    setState((s) => ({
      terminals: [
        ...s.terminals,
        {
          id,
          title: as?.title ?? (agent ? HARNESS_NAMES[agent] : `Terminal ${s.terminals.length + 1}`),
          exited: false,
          ...(signIn ? { signIn } : {}),
        },
      ],
      activeTerminal: id,
      terminalOpen: true,
    }));
    if (signIn) showSignIn(id);
  } catch (error) {
    reportError(error);
  } finally {
    if (signIn) signingIn.delete(signIn);
  }
}

/**
 * Brings a sign-in terminal into view: terminals live in the editor, so it goes there when a
 * folder is open. Without one, the CLI's browser page is where it is finished.
 */
function showSignIn(id: number): void {
  setState({ activeTerminal: id, terminalOpen: true });
  if (getState().workspace) showView('workspace');
  else
    notify({
      kind: 'info',
      message: 'Finish signing in on the page that opened in your browser.',
    });
}

export async function closeTerminal(id: number): Promise<void> {
  await api.invoke('terminal:kill', id).catch(() => undefined);
  sinks.delete(id);
  replay.delete(id);
  setState((s) => {
    const terminals = s.terminals.filter((t) => t.id !== id);
    return {
      terminals,
      activeTerminal: s.activeTerminal === id ? (terminals.at(-1)?.id ?? null) : s.activeTerminal,
      terminalOpen: terminals.length > 0 && s.terminalOpen,
    };
  });
}

export async function toggleTerminal(): Promise<void> {
  const { terminalOpen, terminals } = getState();
  if (terminalOpen) {
    setState({ terminalOpen: false });
    return;
  }
  if (terminals.length === 0) await newTerminal();
  else setState({ terminalOpen: true });
}

/** Clears terminal tabs after main killed the processes (e.g. a new workspace was opened). */
export function resetTerminals(): void {
  sinks.clear();
  replay.clear();
  setState({ terminals: [], activeTerminal: null, terminalOpen: false });
}
