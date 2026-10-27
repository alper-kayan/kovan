import { generateKeyPairSync, randomUUID, sign, verify } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startHarness, type Harness } from './test/harness.js';

// The layout apps/mobile/scripts/updates.mjs writes, made here by hand.
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const signed = (body: string) =>
  `sig="${sign('sha256', Buffer.from(body), privateKey).toString('base64')}", keyid="main"`;

let dir: string;
let h: Harness;
const ios = () => join(dir, '0.1.0', 'ios');

function entry(name: string, file: 'manifest.json' | 'directive.json', body: string) {
  mkdirSync(join(ios(), name, 'assets'), { recursive: true });
  writeFileSync(join(ios(), name, file), body);
  writeFileSync(join(ios(), name, 'signature'), signed(body));
}
const point = (name: string) => writeFileSync(join(ios(), 'current'), `${name}\n`);

const ask = (headers: Record<string, string> = {}) =>
  fetch(`${h.baseUrl}/api/mobile/updates/manifest`, {
    headers: {
      'expo-protocol-version': '1',
      'expo-platform': 'ios',
      'expo-runtime-version': '0.1.0',
      accept: 'application/expo+json;q=0.9, application/json;q=0.8, multipart/mixed',
      'expo-expect-signature': 'sig, keyid="main", alg="rsa-v1_5-sha256"',
      ...headers,
    },
  });

/** The parts of a multipart answer: name, signature header and body. */
async function parts(res: Response) {
  const boundary = /boundary=([^;]+)/.exec(res.headers.get('content-type') ?? '')![1]!;
  const text = await res.text();
  return text
    .split(`--${boundary}`)
    .slice(1, -1)
    .map((raw) => {
      const [head, ...body] = raw.replace(/^\r\n/, '').split('\r\n\r\n');
      return {
        name: /name="([^"]+)"/.exec(head!)?.[1],
        signature: /expo-signature: (.*)/.exec(head!)?.[1],
        body: body.join('\r\n\r\n').replace(/\r\n$/, ''),
      };
    });
}

const checks = (signature: string | undefined, body: string) =>
  verify(
    'sha256',
    Buffer.from(body),
    publicKey,
    Buffer.from(/sig="([^"]+)"/.exec(signature ?? '')![1]!, 'base64'),
  );

const manifest = {
  id: randomUUID(),
  createdAt: new Date().toISOString(),
  runtimeVersion: '0.1.0',
  launchAsset: {
    hash: 'x',
    key: 'k',
    contentType: 'application/javascript',
    url: 'http://kovan.test/api/mobile/updates/assets/0.1.0/ios/20261025-090000-aaaaaaaa/bundle.hbc',
  },
  assets: [],
  metadata: {},
  extra: {},
};

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'kovan-updates-'));
  h = await startHarness({ MOBILE_UPDATES_DIR: dir });
});
afterAll(async () => {
  await h.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('over-the-air updates for the phone app', () => {
  it('answers with nothing until something is published, and refuses what it cannot serve', async () => {
    const none = await ask();
    expect(none.status).toBe(204);
    expect(none.headers.get('expo-protocol-version')).toBe('1');
    expect(none.headers.get('expo-sfv-version')).toBe('0');
    expect(none.headers.get('cache-control')).toBe('private, max-age=0');
    expect((await ask({ 'expo-platform': 'web' })).status).toBe(400);
    expect((await ask({ 'expo-runtime-version': '../etc' })).status).toBe(400);
    expect((await ask({ 'expo-protocol-version': '0' })).status).toBe(406);
  });

  it("hands out the published manifest with the publisher's signature", async () => {
    const body = JSON.stringify(manifest);
    entry('20261025-090000-aaaaaaaa', 'manifest.json', body);
    const bundle = Buffer.from('var x = 1;'.repeat(200));
    writeFileSync(join(ios(), '20261025-090000-aaaaaaaa', 'assets', 'bundle.hbc'), bundle);
    writeFileSync(
      join(ios(), '20261025-090000-aaaaaaaa', 'assets', 'bundle.hbc.gz'),
      gzipSync(bundle),
    );
    point('20261025-090000-aaaaaaaa');

    const res = await ask({ 'expo-current-update-id': randomUUID() });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/^multipart\/mixed; boundary=/);
    const [m, ext] = await parts(res);
    expect(m!.name).toBe('manifest');
    // Byte for byte what was signed: the phone checks the signature over this body.
    expect(m!.body).toBe(body);
    expect(checks(m!.signature, m!.body)).toBe(true);
    expect(ext!.name).toBe('extensions');
    expect(JSON.parse(ext!.body)).toEqual({ assetRequestHeaders: {} });

    // Its files: compressed when the phone takes it, never changing, nothing outside the folder.
    const asset = `${h.baseUrl}/api/mobile/updates/assets/0.1.0/ios/20261025-090000-aaaaaaaa`;
    const gz = await fetch(`${asset}/bundle.hbc`, { headers: { 'accept-encoding': 'gzip' } });
    expect(gz.status).toBe(200);
    expect(gz.headers.get('content-encoding')).toBe('gzip');
    expect(gz.headers.get('content-type')).toBe('application/javascript');
    expect(gz.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
    expect(Buffer.from(await gz.arrayBuffer()).equals(bundle)).toBe(true);
    const plain = await fetch(`${asset}/bundle.hbc`, {
      headers: { 'accept-encoding': 'identity' },
    });
    expect(plain.headers.get('content-encoding')).toBeNull();
    expect(Number(plain.headers.get('content-length'))).toBe(bundle.length);
    expect((await fetch(`${asset}/missing.png`)).status).toBe(404);
    expect((await fetch(`${asset}/..%2F..%2Fcurrent`)).status).toBe(404);
  });

  it('says there is nothing new to a phone that already runs it', async () => {
    // Without the signed answer on disk: an empty one.
    expect((await ask({ 'expo-current-update-id': manifest.id })).status).toBe(204);
    const nothing = JSON.stringify({ type: 'noUpdateAvailable' });
    writeFileSync(join(dir, 'no-update.json'), nothing);
    writeFileSync(join(dir, 'no-update.sig'), signed(nothing));
    const res = await ask({ 'expo-current-update-id': manifest.id.toUpperCase() });
    const [d] = await parts(res);
    expect(d!.name).toBe('directive');
    expect(JSON.parse(d!.body)).toEqual({ type: 'noUpdateAvailable' });
    expect(checks(d!.signature, d!.body)).toBe(true);
  });

  it("rolls phones back to the build's own code, once", async () => {
    const directive = JSON.stringify({
      type: 'rollBackToEmbedded',
      parameters: { commitTime: new Date().toISOString() },
    });
    entry('20261025-100000-bbbbbbbb', 'directive.json', directive);
    point('20261025-100000-bbbbbbbb');
    const embedded = randomUUID();
    const back = await parts(
      await ask({ 'expo-current-update-id': manifest.id, 'expo-embedded-update-id': embedded }),
    );
    expect(back[0]!.name).toBe('directive');
    expect(back[0]!.body).toBe(directive);
    expect(checks(back[0]!.signature, back[0]!.body)).toBe(true);
    // Already on the build's own code.
    const done = await parts(
      await ask({ 'expo-current-update-id': embedded, 'expo-embedded-update-id': embedded }),
    );
    expect(JSON.parse(done[0]!.body)).toEqual({ type: 'noUpdateAvailable' });
  });

  it('keeps Android apart from iOS', async () => {
    expect((await ask({ 'expo-platform': 'android' })).status).toBe(204);
  });
});
