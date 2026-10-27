import { PUSH_CATEGORY, type PushData, type PushDevice, type PushKind } from '@kovan/shared';
import * as Application from 'expo-application';
import Constants from 'expo-constants';
import * as Notifications from 'expo-notifications';
import * as SecureStore from 'expo-secure-store';
import { Platform } from 'react-native';

const TOKEN_KEY = 'kovan.pushToken';

/** Button ids on a notification: what the person answered right from it. */
export const ACTION = { approve: 'approve', deny: 'deny' } as const;

type Api = <T>(method: 'POST' | 'PATCH', path: string, body?: unknown) => Promise<T>;

/**
 * Android answers from the notification without opening the app (a background task does it,
 * even when the app was closed). iOS opens the app to send it: how iOS runs a closed app's code
 * for a button is not something Expo promises.
 */
const OPENS_APP = Platform.OS === 'ios';

let configured = false;

/**
 * How notifications look and which buttons they carry. Approve and Deny don't open the app: the
 * answer goes from the notification (after unlocking the phone, since it acts for the person).
 */
export async function configureNotifications(): Promise<void> {
  if (configured) return;
  configured = true;
  Notifications.setNotificationHandler({
    handleNotification: async () => ({
      shouldShowBanner: true,
      shouldShowList: true,
      shouldPlaySound: true,
      shouldSetBadge: false,
    }),
  });
  const yesNo = (no: string) => [
    {
      identifier: ACTION.approve,
      buttonTitle: 'Approve',
      options: { opensAppToForeground: OPENS_APP, isAuthenticationRequired: true },
    },
    {
      identifier: ACTION.deny,
      buttonTitle: no,
      options: {
        opensAppToForeground: OPENS_APP,
        isAuthenticationRequired: true,
        isDestructive: true,
      },
    },
  ];
  // One after the other: iOS keeps categories as one set that each call reads and rewrites, so
  // two at once lose one of them (and its notifications show no buttons).
  await Notifications.setNotificationCategoryAsync(PUSH_CATEGORY.approval, yesNo('Deny'));
  await Notifications.setNotificationCategoryAsync(PUSH_CATEGORY.task, yesNo('Reject'));
  if (Platform.OS === 'android') {
    // The server picks the channel: questions ring, updates don't.
    await Notifications.setNotificationChannelAsync('asks', {
      name: 'Approvals',
      description: 'An agent waits for your yes.',
      importance: Notifications.AndroidImportance.HIGH,
    });
    await Notifications.setNotificationChannelAsync('updates', {
      name: 'Updates',
      description: 'Agents finished, work handed to you, swarms.',
      importance: Notifications.AndroidImportance.DEFAULT,
    });
  }
}

export const savedPushToken = () => SecureStore.getItemAsync(TOKEN_KEY).catch(() => null);

export type PushState = 'off' | 'denied' | 'on' | 'unavailable';

/**
 * Asks once for permission, then registers this phone's own APNs or FCM token for the signed-in
 * person. Quietly does nothing where a phone can't get push (a simulator without a token).
 */
export interface PushStatus {
  state: PushState;
  /** This phone as the server has it (what it turned off). */
  device: PushDevice | null;
  /** The server can send pushes at all (its Apple and Google keys are set up). */
  serverReady: boolean;
}

export async function registerForPush(api: Api, ask: boolean): Promise<PushStatus> {
  const none = (state: PushState): PushStatus => ({ state, device: null, serverReady: false });
  await configureNotifications();
  let { status } = await Notifications.getPermissionsAsync();
  if (status !== 'granted' && ask) status = (await Notifications.requestPermissionsAsync()).status;
  if (status !== 'granted') return none(status === 'denied' ? 'denied' : 'off');
  let token: string;
  try {
    token = String((await Notifications.getDevicePushTokenAsync()).data);
  } catch {
    return none('unavailable');
  }
  // A build signed for development talks to Apple's sandbox.
  const sandbox =
    Platform.OS === 'ios' &&
    (await Application.getIosPushNotificationServiceEnvironmentAsync().catch(() => null)) !==
      'production';
  const registered = await api<{ device: PushDevice; enabled: boolean }>(
    'POST',
    '/api/push/devices',
    {
      platform: Platform.OS === 'ios' ? 'ios' : 'android',
      token,
      sandbox,
      appVersion: Constants.expoConfig?.version ?? null,
    },
  );
  await SecureStore.setItemAsync(TOKEN_KEY, token).catch(() => undefined);
  return { state: 'on', device: registered.device, serverReady: registered.enabled };
}

/** Signing out: this phone stops getting the person's notifications. */
export async function unregisterPush(api: Api): Promise<void> {
  const token = await savedPushToken();
  if (!token) return;
  await api('POST', '/api/push/devices/remove', { token }).catch(() => undefined);
  await SecureStore.deleteItemAsync(TOKEN_KEY).catch(() => undefined);
}

export async function setMuted(api: Api, muted: PushKind[]): Promise<PushDevice | null> {
  const token = await savedPushToken();
  if (!token) return null;
  return (await api<{ device: PushDevice }>('PATCH', '/api/push/devices', { token, muted })).device;
}

/** The app's data in a notification, whichever platform delivered it. */
export function pushData(
  content: { data?: unknown; dataString?: unknown } | undefined,
): PushData | null {
  let data = content?.data as Partial<PushData> | string | null | undefined;
  if (typeof data === 'string' || (!data && typeof content?.dataString === 'string')) {
    try {
      data = JSON.parse(typeof data === 'string' ? data : (content!.dataString as string));
    } catch {
      return null;
    }
  }
  return data &&
    typeof data === 'object' &&
    typeof data.sessionId === 'string' &&
    typeof data.kind === 'string'
    ? (data as PushData)
    : null;
}

const HANDLED_KEY = 'kovan.pushHandled';

/**
 * Sends Approve / Deny pressed on a notification, once: the same press can reach both the
 * background task and the app (and comes back as "the last response" after a restart).
 * Returns what to tell the person, or null when there was nothing to do.
 */
export async function answerFromNotification(
  api: Api,
  id: string,
  action: string,
  data: PushData | null,
): Promise<string | null> {
  if (!data || (action !== ACTION.approve && action !== ACTION.deny)) return null;
  const key = `${id}:${action}`;
  if ((await SecureStore.getItemAsync(HANDLED_KEY).catch(() => null)) === key) return null;
  await SecureStore.setItemAsync(HANDLED_KEY, key).catch(() => undefined);
  const yes = action === ACTION.approve;
  if (data.kind === 'approval' && data.laneUserId && data.requestId)
    await api('POST', `/api/sessions/${data.sessionId}/approvals`, {
      laneUserId: data.laneUserId,
      requestId: data.requestId,
      approved: yes,
    });
  else if (data.kind === 'task' && data.stepId)
    await api('POST', `/api/plan-steps/${data.stepId}/approval`, { approve: yes });
  else return null;
  await Notifications.dismissNotificationAsync(id).catch(() => undefined);
  return yes ? 'Approved from the notification.' : 'Denied from the notification.';
}
