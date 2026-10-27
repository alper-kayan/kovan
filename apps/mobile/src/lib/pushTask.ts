import * as Notifications from 'expo-notifications';
import * as SecureStore from 'expo-secure-store';
import * as TaskManager from 'expo-task-manager';
import { Platform } from 'react-native';
import { request, STORE_KEYS } from './api';
import { answerFromNotification, pushData } from './push';

/**
 * Approve / Deny pressed on a notification while the app is in the background or closed
 * (Android): there is no screen then, so this answers with the sign-in kept on the phone.
 * Defined at startup, before anything renders, as background tasks must be.
 */
export const NOTIFICATION_TASK = 'kovan-notification-action';

type ResponseLike = {
  actionIdentifier?: string;
  notification?: {
    request?: { identifier?: string; content?: { data?: unknown; dataString?: unknown } };
  };
};

TaskManager.defineTask<ResponseLike>(NOTIFICATION_TASK, async ({ data, error }) => {
  // Also runs for every data message that arrives; only button presses carry an action.
  if (error || !data?.actionIdentifier) return;
  const [server, token] = await Promise.all([
    SecureStore.getItemAsync(STORE_KEYS.server),
    SecureStore.getItemAsync(STORE_KEYS.token),
  ]);
  if (!server || !token) return;
  const id = data.notification?.request?.identifier ?? '';
  try {
    await answerFromNotification(
      (method, path, body) => request(server, token, method, path, body),
      id,
      data.actionIdentifier,
      pushData(data.notification?.request?.content),
    );
  } catch (e) {
    console.warn("Couldn't answer from the notification:", e);
  }
});

if (Platform.OS === 'android')
  void Notifications.registerTaskAsync(NOTIFICATION_TASK).catch((e: unknown) =>
    console.warn("Couldn't register the notification task:", e),
  );
