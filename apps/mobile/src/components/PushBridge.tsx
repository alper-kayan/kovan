import * as Notifications from 'expo-notifications';
import { router } from 'expo-router';
import * as SecureStore from 'expo-secure-store';
import { useEffect, useRef } from 'react';
import { AppState, Platform } from 'react-native';
import { answerFromNotification, pushData, registerForPush } from '../lib/push';
import { useSession } from '../lib/session';
import { useToast } from '../lib/toast';

const LAST_KEY = 'kovan.pushLastOpened';

/**
 * Wires push into the app: registers this phone once the person is signed in, opens the right
 * session when a notification is tapped, and sends Approve / Deny answered on a notification.
 * A response can arrive before sign-in has loaded (the app was launched by it): it waits.
 */
export function PushBridge() {
  const { status, api } = useSession();
  const { show } = useToast();
  const waiting = useRef<Notifications.NotificationResponse[]>([]);
  // The launching tap can come both as "the last response" and through the listener.
  const seen = useRef(new Set<string>());
  const ready = status === 'signedIn';

  // Register (asking for permission the first time) whenever someone signs in.
  useEffect(() => {
    if (!ready) return;
    void registerForPush(api, true).catch((e: unknown) =>
      console.warn("Couldn't register for notifications:", e),
    );
  }, [ready, api]);

  useEffect(() => {
    const handle = async (response: Notifications.NotificationResponse) => {
      const { identifier, content } = response.notification.request;
      const seenKey = `${identifier}:${response.actionIdentifier}`;
      if (seen.current.has(seenKey)) return;
      seen.current.add(seenKey);
      const data = pushData(content);
      if (!data) return;
      const action = response.actionIdentifier;
      if (action === Notifications.DEFAULT_ACTION_IDENTIFIER) {
        router.push({ pathname: '/session/[id]', params: { id: data.sessionId } });
        return;
      }
      // On Android a press while the app is in the background goes to the background task.
      if (Platform.OS === 'android' && AppState.currentState !== 'active') return;
      try {
        const said = await answerFromNotification(api, identifier, action, data);
        if (said) show(said);
      } catch (e) {
        show(e instanceof Error ? e.message : String(e), 'error');
      }
    };
    const take = (response: Notifications.NotificationResponse) => {
      if (ready) void handle(response);
      else waiting.current.push(response);
    };
    if (ready) for (const r of waiting.current.splice(0)) void handle(r);
    // The tap that launched the app; its id is remembered so a restart doesn't open it again.
    void Notifications.getLastNotificationResponseAsync().then(async (r) => {
      if (!r) return;
      const key = `${r.notification.request.identifier}:${r.actionIdentifier}`;
      if ((await SecureStore.getItemAsync(LAST_KEY).catch(() => null)) === key) return;
      await SecureStore.setItemAsync(LAST_KEY, key).catch(() => undefined);
      take(r);
    });
    const sub = Notifications.addNotificationResponseReceivedListener(take);
    return () => sub.remove();
  }, [ready, api, show]);

  return null;
}
