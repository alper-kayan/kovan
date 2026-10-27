import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Config } from '../config.js';
import { Apns } from './apns.js';
import { Fcm, type ServiceAccount } from './fcm.js';

/**
 * Apple's and Google's senders from the configured key files. A missing or unreadable key turns
 * that platform off with one line in the log; the server runs either way.
 */
export function pushSenders(
  config: Config,
  log: (message: string) => void,
): { apns: Apns | null; fcm: Fcm | null } {
  let apns: Apns | null = null;
  let fcm: Fcm | null = null;
  if (config.APNS_KEY_FILE && config.APNS_KEY_ID && config.APNS_TEAM_ID) {
    try {
      apns = new Apns({
        key: readFileSync(resolve(config.APNS_KEY_FILE), 'utf8'),
        keyId: config.APNS_KEY_ID,
        teamId: config.APNS_TEAM_ID,
        topic: config.APNS_TOPIC,
        production: config.APNS_PRODUCTION_HOST,
        sandbox: config.APNS_SANDBOX_HOST,
      });
    } catch (error) {
      log(`push: the APNs key can't be read (${(error as Error).message}); no iOS push`);
    }
  }
  if (config.FCM_KEY_FILE) {
    try {
      const account = JSON.parse(
        readFileSync(resolve(config.FCM_KEY_FILE), 'utf8'),
      ) as ServiceAccount;
      if (!account.project_id || !account.client_email || !account.private_key)
        throw new Error('not a service account key');
      fcm = new Fcm({ account, api: config.FCM_API });
    } catch (error) {
      log(`push: the Firebase key can't be read (${(error as Error).message}); no Android push`);
    }
  }
  return { apns, fcm };
}
