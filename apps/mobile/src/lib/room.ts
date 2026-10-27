import type {
  Activity,
  LaneEvent,
  Plan,
  ServerMessage,
  Session,
  Swarm,
  SwarmMessage,
} from '@kovan/shared';
import { useCallback, useEffect, useState } from 'react';
import { useLive } from './live';
import { useSession } from './session';

export interface Room {
  session: Session | null;
  /** Each lane's events, by whose lane it is. */
  lanes: Record<string, LaneEvent[]>;
  plan: Plan | null;
  swarm: Swarm | null;
  messages: SwarmMessage[];
  /** Newest first, as the server keeps it. */
  activity: Activity[];
  error: string | null;
}

const EMPTY: Room = {
  session: null,
  lanes: {},
  plan: null,
  swarm: null,
  messages: [],
  activity: [],
  error: null,
};

/** A room after one live message; anything about another session leaves it as it was. */
export function applyRoomMessage(room: Room, id: string, message: ServerMessage): Room {
  switch (message.type) {
    case 'session':
      return message.session.id === id ? { ...room, session: message.session } : room;
    case 'session.snapshot': {
      if (message.session.id !== id) return room;
      const lanes: Record<string, LaneEvent[]> = {};
      for (const lane of message.lanes) lanes[lane.userId] = lane.events;
      return { ...room, session: message.session, lanes };
    }
    case 'lane.events': {
      if (message.sessionId !== id) return room;
      // Live typing is for editors; the transcript keeps the finished edit.
      const kept = message.events.filter((e) => e.type !== 'tool_progress');
      if (kept.length === 0) return room;
      return {
        ...room,
        lanes: {
          ...room.lanes,
          [message.userId]: [...(room.lanes[message.userId] ?? []), ...kept],
        },
      };
    }
    case 'plan':
      return message.plan.sessionId === id ? { ...room, plan: message.plan } : room;
    case 'swarm': {
      if (message.swarm.sessionId !== id) return room;
      // A new swarm in the session starts its own chat.
      const same = room.swarm?.id === message.swarm.id;
      return { ...room, swarm: message.swarm, messages: same ? room.messages : [] };
    }
    case 'swarm.message':
      if (
        message.sessionId !== id ||
        message.message.swarmId !== room.swarm?.id ||
        room.messages.some((m) => m.id === message.message.id)
      )
        return room;
      return { ...room, messages: [...room.messages, message.message] };
    case 'activity':
      if (message.activity.sessionId !== id) return room;
      if (room.activity.some((a) => a.id === message.activity.id)) return room;
      return { ...room, activity: [message.activity, ...room.activity] };
    default:
      return room;
  }
}

/**
 * One session as the phone follows it: the server's snapshot of every lane and then each new
 * event, plus its plan, swarm and activity. An ended session is read once from its transcript.
 */
export function useRoom(id: string): Room & { reload(): Promise<void> } {
  const { api } = useSession();
  const { board, listen, followSession } = useLive();
  // The board's card to start from; live messages keep it current after that.
  const [room, setRoom] = useState<Room>(() => ({
    ...EMPTY,
    session:
      Object.values(board.sessions)
        .flat()
        .find((s) => s.id === id) ?? null,
  }));

  const reload = useCallback(async () => {
    try {
      const { session } = await api<{ session: Session }>('GET', `/api/sessions/${id}`);
      const [plan, swarm, activity, transcript] = await Promise.all([
        api<{ plan: Plan }>('GET', `/api/sessions/${id}/plan`),
        api<{ swarm: Swarm | null; messages: SwarmMessage[] }>('GET', `/api/sessions/${id}/swarm`),
        api<{ activity: Activity[] }>('GET', `/api/sessions/${id}/activity`),
        session.status === 'ended'
          ? api<{ lanes: { userId: string; events: LaneEvent[] }[] }>(
              'GET',
              `/api/sessions/${id}/transcript`,
            )
          : null,
      ]);
      setRoom((r) => ({
        ...r,
        session,
        plan: plan.plan,
        swarm: swarm.swarm,
        messages: swarm.messages,
        activity: activity.activity,
        lanes: transcript
          ? Object.fromEntries(transcript.lanes.map((l) => [l.userId, l.events]))
          : r.lanes,
        error: null,
      }));
    } catch (e) {
      setRoom((r) => ({ ...r, error: e instanceof Error ? e.message : String(e) }));
    }
  }, [api, id]);

  useEffect(() => {
    // Listen before following, so the snapshot the server answers with isn't missed.
    const stop = listen((message) => {
      setRoom((r) => applyRoomMessage(r, id, message));
      // Back from offline: the snapshot comes again by itself, the rest is read again.
      if (message.type === 'welcome') void reload();
    });
    const unfollow = followSession(id);
    void reload();
    return () => {
      unfollow();
      stop();
    };
  }, [id, listen, followSession, reload]);

  return { ...room, reload };
}
