import type {
  Handoff,
  Outcome,
  ServerMessage,
  Session,
  SessionApproval,
  Workspace,
} from '@kovan/shared';
import Constants from 'expo-constants';
import * as Crypto from 'expo-crypto';
import * as SecureStore from 'expo-secure-store';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { AppState } from 'react-native';
import { applyMessage, EMPTY_BOARD, type Board } from './board';
import { Live, type Connection } from './realtime';
import { useSession } from './session';
import { useToast } from './toast';

const DEVICE_KEY = 'kovan.device';

interface LiveState {
  board: Board;
  /** The first load is done (the board may still be empty). */
  loaded: boolean;
  connection: Connection;
  /** Why the board couldn't load, when it couldn't. */
  error: string | null;
  reload(): Promise<void>;
  /** Every live message, for screens that keep more than the board (a session's lanes). */
  listen(listener: (message: ServerMessage) => void): () => void;
  followSession(id: string): () => void;
}

const Context = createContext<LiveState | null>(null);

export function useLive(): LiveState {
  const value = useContext(Context);
  if (!value) throw new Error('useLive outside LiveProvider');
  return value;
}

type Action = { type: 'set'; board: Board } | { type: 'message'; message: ServerMessage };

const reduce = (board: Board, action: Action): Board =>
  action.type === 'set' ? action.board : applyMessage(board, action.message);

async function deviceId(): Promise<string> {
  const saved = await SecureStore.getItemAsync(DEVICE_KEY).catch(() => null);
  if (saved) return saved;
  const id = `mobile-${Crypto.randomUUID()}`;
  await SecureStore.setItemAsync(DEVICE_KEY, id).catch(() => undefined);
  return id;
}

/** The signed-in phone's board, loaded over HTTPS and kept live over one WebSocket. */
export function LiveProvider({ children }: { children: ReactNode }) {
  const { server, token, api, signOut } = useSession();
  const { show } = useToast();
  const [board, dispatch] = useReducer(reduce, EMPTY_BOARD);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [connection, setConnection] = useState<Connection>('connecting');
  const live = useRef<Live | null>(null);
  const listeners = useRef(new Set<(message: ServerMessage) => void>());
  const loading = useRef<Promise<void> | null>(null);
  // Sessions screens follow, kept here so a new socket (sign-in, server change) follows them too.
  const followed = useRef(new Map<string, { count: number; stop: (() => void) | null }>());

  const reload = useCallback(() => {
    // One load at a time; a reconnect during a pull-to-refresh joins it.
    loading.current ??= (async () => {
      try {
        const { workspaces } = await api<{ workspaces: Workspace[] }>('GET', '/api/workspaces');
        const next: Board = { workspaces, sessions: {}, approvals: [], flow: {} };
        await Promise.all(
          workspaces.map(async (w) => {
            const [s, a, f] = await Promise.all([
              api<{ sessions: Session[] }>('GET', `/api/workspaces/${w.id}/sessions`),
              api<{ approvals: SessionApproval[] }>('GET', `/api/workspaces/${w.id}/approvals`),
              api<{ handoffs: Handoff[]; outcomes: Outcome[] }>(
                'GET',
                `/api/workspaces/${w.id}/flow`,
              ),
            ]);
            next.sessions[w.id] = s.sessions.sort((x, y) => y.updatedAt.localeCompare(x.updatedAt));
            next.approvals.push(...a.approvals);
            next.flow[w.id] = f;
          }),
        );
        dispatch({ type: 'set', board: next });
        live.current?.followWorkspaces(workspaces.map((w) => w.id));
        setError(null);
      } catch (e) {
        // Keep what the board last showed; say why it isn't fresh.
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setLoaded(true);
        loading.current = null;
      }
    })();
    return loading.current;
  }, [api]);

  useEffect(() => {
    if (!token) {
      // Signed out: nothing of the last person's board stays.
      dispatch({ type: 'set', board: EMPTY_BOARD });
      setLoaded(false);
      return;
    }
    let stopped = false;
    const socket = new Live({
      server,
      token,
      version: Constants.expoConfig?.version ?? '0',
      onMessage: (message) => {
        dispatch({ type: 'message', message });
        // A new workspace or a changed role: the list and what it may do changed.
        if (message.type === 'membership' && message.role !== null) void reload();
        // How work sent to the desktop went.
        if (message.type === 'desk.done') show(message.message, message.ok ? 'info' : 'error');
        for (const l of listeners.current) l(message);
      },
      onOnline: () => void reload(),
      onConnection: setConnection,
      onUnauthorized: () => void signOut(),
    });
    live.current = socket;
    for (const [id, entry] of followed.current) entry.stop = socket.followSession(id);
    void deviceId().then((machineId) => {
      if (!stopped) socket.start(machineId);
    });
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active') live.current?.wake();
    });
    return () => {
      stopped = true;
      sub.remove();
      socket.stop();
      live.current = null;
      for (const entry of followed.current.values()) entry.stop = null;
    };
  }, [server, token, reload, signOut, show]);

  const listen = useCallback((listener: (message: ServerMessage) => void) => {
    listeners.current.add(listener);
    return () => void listeners.current.delete(listener);
  }, []);

  const followSession = useCallback((id: string) => {
    const entry = followed.current.get(id) ?? { count: 0, stop: null };
    entry.count++;
    // A second screen on a followed session still needs its own snapshot of the lanes.
    if (entry.stop) live.current?.snapshot(id);
    else entry.stop = live.current?.followSession(id) ?? null;
    followed.current.set(id, entry);
    let done = false;
    return () => {
      if (done) return;
      done = true;
      if (--entry.count > 0) return;
      entry.stop?.();
      followed.current.delete(id);
    };
  }, []);

  const value = useMemo<LiveState>(
    () => ({ board, loaded, connection, error, reload, listen, followSession }),
    [board, loaded, connection, error, reload, listen, followSession],
  );
  return <Context.Provider value={value}>{children}</Context.Provider>;
}
