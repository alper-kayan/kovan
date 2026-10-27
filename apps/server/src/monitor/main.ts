// The outside monitor's process (bundled to one file by `pnpm --filter @kovan/server
// build:monitor`; installed as in deploy/README.md, "Outside monitor"). Settings come from the
// environment:
//   KOVAN_URL, OPS_TOKEN, APNS_KEY_FILE, APNS_KEY_ID, APNS_TEAM_ID, [APNS_TOPIC],
//   [STATE_FILE], [INTERVAL_SECONDS], [FAIL_AFTER], [BACKUPS_DIR]
// `--test` sends one notification to the operator's phones and exits.
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { connect } from 'node:tls';
import { Apns } from '../push/apns.js';
import type { Offsite } from './host.js';
import { freshState, tick, type Alert, type Device, type MonitorState } from './monitor.js';

const env = (name: string, fallback?: string) => {
  const value = process.env[name] ?? fallback;
  if (!value) {
    console.error(`${name} is not set`);
    process.exit(1);
  }
  return value;
};

const url = env('KOVAN_URL').replace(/\/$/, '');
const opsToken = env('OPS_TOKEN');
const stateFile = env('STATE_FILE', 'monitor-state.json');
const interval = Number(env('INTERVAL_SECONDS', '60')) * 1000;
const failAfter = Number(env('FAIL_AFTER', '3'));
const apns = new Apns({
  key: readFileSync(env('APNS_KEY_FILE'), 'utf8'),
  keyId: env('APNS_KEY_ID'),
  teamId: env('APNS_TEAM_ID'),
  topic: env('APNS_TOPIC', 'dev.alperkayan.kovan'),
});
const log = (line: string) => console.log(line);

// The backups pulled here (deploy/monitor/pull-backups.sh).
const backupsDir = process.env['BACKUPS_DIR'];
const isBackup = (name: string) => /^kovan-[\w-]+\.dump\.enc$/.test(name);
const offsite = backupsDir
  ? (): Offsite => {
      let newestAt: number | null = null;
      try {
        for (const name of readdirSync(backupsDir))
          if (isBackup(name))
            newestAt = Math.max(newestAt ?? 0, statSync(join(backupsDir, name)).mtimeMs);
      } catch {
        // No folder yet: no copies.
      }
      return {
        newestAt,
        sha256Of: (file) => {
          if (!isBackup(file)) return null;
          try {
            return createHash('sha256')
              .update(readFileSync(join(backupsDir, file)))
              .digest('hex');
          } catch {
            return null;
          }
        },
      };
    }
  : undefined;

/** When the HTTPS certificate the server presents runs out. */
const certExpiry = (host: string) =>
  new Promise<number>((resolve, reject) => {
    const socket = connect({ host, port: 443, servername: host, timeout: 10_000 }, () => {
      const cert = socket.getPeerCertificate();
      socket.end();
      if (!cert.valid_to) reject(new Error('no certificate'));
      else resolve(Date.parse(cert.valid_to));
    });
    socket.on('timeout', () => socket.destroy(new Error('timed out')));
    socket.on('error', reject);
  });

function load(): MonitorState {
  try {
    return { ...freshState(), ...(JSON.parse(readFileSync(stateFile, 'utf8')) as MonitorState) };
  } catch {
    return freshState();
  }
}
function save(state: MonitorState) {
  writeFileSync(`${stateFile}.tmp`, JSON.stringify(state), { mode: 0o600 });
  renameSync(`${stateFile}.tmp`, stateFile);
}

async function send(devices: Device[], alert: Alert): Promise<string[]> {
  const gone: string[] = [];
  for (const device of devices) {
    const result = await apns.send(device.token, device.sandbox, {
      payload: {
        aps: { alert, sound: 'default', 'thread-id': 'kovan-monitor' },
        kind: 'monitor',
      },
      collapseId: 'kovan-monitor',
      ttl: 6 * 3600,
    });
    if (!result.ok) {
      log(`Apple refused a phone: ${result.reason}`);
      if (result.gone) gone.push(device.token);
    }
  }
  return gone;
}

// The APNs connection doesn't hold the process open (the server's sender unrefs it), so while a
// send waits for Apple nothing would: this does.
const alive = setInterval(() => {}, 1 << 30);

let state = load();
if (process.argv.includes('--test')) {
  // Phones from the server when it answers, else the ones kept from before.
  state = await tick(state, { url, opsToken, failAfter, send, log, refreshEveryMs: 0 });
  save(state);
  await send(
    state.devices.filter((d) => d.platform === 'ios'),
    { title: 'Kovan monitor', body: `Watching ${new URL(url).host}. You'll hear from it here.` },
  );
  log(`Sent a test to ${state.devices.filter((d) => d.platform === 'ios').length} phone(s)`);
  apns.close();
  clearInterval(alive);
} else {
  log(`Watching ${url} every ${interval / 1000} s`);
  for (;;) {
    try {
      state = await tick(state, {
        url,
        opsToken,
        failAfter,
        send,
        log,
        certExpiry,
        ...(offsite ? { offsite } : {}),
      });
      save(state);
    } catch (error) {
      log(`Round failed: ${(error as Error).message}`);
    }
    await new Promise((r) => setTimeout(r, interval));
  }
}
