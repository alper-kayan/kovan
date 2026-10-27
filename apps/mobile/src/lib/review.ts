import type { Comment, Session, SessionChanges } from '@kovan/shared';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useLive } from './live';
import { upsertComment } from './reviewData';
import { useSession } from './session';

export { laneSpend, onCode, upsertComment } from './reviewData';

export interface Changes {
  /** Each machine's view, newest first; for an ended session, its one final diff. */
  views: SessionChanges[];
  loaded: boolean;
  error: string | null;
}

/**
 * A session's changes as the machines working in it last sent them: re-read whenever one says
 * it has a newer view. An ended session shows its final diff.
 */
export function useChanges(session: Session): Changes & { reload(): Promise<void> } {
  const { api } = useSession();
  const { listen } = useLive();
  const [state, setState] = useState<Changes>({ views: [], loaded: false, error: null });
  const ended = session.status === 'ended';
  const id = session.id;

  const reload = useCallback(async () => {
    try {
      const views = ended
        ? await api<{ diff: string | null }>('GET', `/api/sessions/${id}/diff`).then((r) =>
            r.diff ? [{ userId: '', userName: '', diff: r.diff, commit: null, updatedAt: '' }] : [],
          )
        : (await api<{ changes: SessionChanges[] }>('GET', `/api/sessions/${id}/changes`)).changes;
      setState({ views, loaded: true, error: null });
    } catch (e) {
      setState((s) => ({ ...s, loaded: true, error: e instanceof Error ? e.message : String(e) }));
    }
  }, [api, ended, id]);

  // Views arrive in bursts while agents work: one read covers a burst.
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    void reload();
    const stop = listen((m) => {
      if (m.type !== 'session.changes' || m.sessionId !== id) return;
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => void reload(), 400);
    });
    return () => {
      stop();
      if (timer.current) clearTimeout(timer.current);
    };
  }, [id, listen, reload]);

  return { ...state, reload };
}

/** The session's comments, live: the desktop's and everyone's phones' alike. */
export function useComments(workspaceId: string, sessionId: string) {
  const { api } = useSession();
  const { listen } = useLive();
  const [comments, setComments] = useState<Comment[]>([]);
  useEffect(() => {
    let gone = false;
    void api<{ comments: Comment[] }>(
      'GET',
      `/api/workspaces/${workspaceId}/comments?sessionId=${sessionId}`,
    )
      .then((r) => !gone && setComments(r.comments))
      .catch(() => undefined);
    const stop = listen((m) => {
      if (m.type === 'comment' && m.comment.sessionId === sessionId)
        setComments((list) => upsertComment(list, m.comment));
    });
    return () => {
      gone = true;
      stop();
    };
  }, [api, listen, sessionId, workspaceId]);
  const add = useCallback(
    (comment: Comment) => setComments((list) => upsertComment(list, comment)),
    [],
  );
  return { comments, add };
}
