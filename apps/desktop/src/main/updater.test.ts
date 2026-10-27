import { generateKeyPairSync, sign } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { UpdateState } from '../shared/api.js';
import {
  CHECK_EVERY_MS,
  manifestHashes,
  Updater,
  verifyManifest,
  type UpdateBackend,
} from './updater.js';

function fakeBackend() {
  const listeners = new Map<string, (arg: never) => void>();
  const backend = {
    autoDownload: false,
    autoInstallOnAppQuit: true,
    feed: '',
    setFeedURL(o: { url: string }) {
      backend.feed = o.url;
    },
    checkForUpdates: vi.fn(async () => undefined),
    quitAndInstall: vi.fn(),
    on(event: string, listener: (arg: never) => void) {
      listeners.set(event, listener);
      return backend;
    },
    emit: (event: string, arg: unknown) => listeners.get(event)?.(arg as never),
  };
  return backend as typeof backend & UpdateBackend;
}

function keyPair() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  return {
    publicKey: publicKey.export({ format: 'der', type: 'spki' }).toString('base64'),
    sign: (text: string) => sign(null, Buffer.from(text), privateKey).toString('base64'),
  };
}

const manifest = (version: string, sha: string) =>
  `version: ${version}\nfiles:\n  - url: Kovan-linux-x86_64.AppImage\n    sha512: ${sha}\n    size: 1\npath: Kovan-linux-x86_64.AppImage\nsha512: ${sha}\nreleaseDate: '2026-10-13T00:00:00.000Z'\n`;

function make(
  overrides: Partial<ConstructorParameters<typeof Updater>[0]> = {},
  backend = fakeBackend(),
) {
  const states: UpdateState[] = [];
  const updater = new Updater({
    backend,
    feedUrl: 'https://kovan.test/updates/',
    platform: 'darwin',
    packaged: true,
    currentVersion: '0.1.0',
    publicKey: '',
    onState: (s) => states.push(s),
    ...overrides,
  });
  return { updater, backend, states };
}

const settle = () => new Promise((r) => setTimeout(r, 0));

describe('updater', () => {
  it('stages a found update, then quits, installs and relaunches on request', async () => {
    const before = vi.fn();
    const { updater, backend, states } = make({ beforeInstall: before });
    expect(backend.feed).toBe('https://kovan.test/updates/');
    expect(backend.autoDownload).toBe(true);

    backend.checkForUpdates.mockImplementation(async () => {
      backend.emit('update-available', { version: '0.2.0' });
      return undefined;
    });
    await updater.check();
    backend.emit('download-progress', { percent: 41.6 });
    expect(updater.current).toMatchObject({ status: 'downloading', version: '0.2.0', percent: 42 });

    // Nothing to install until the download is staged.
    expect(await updater.install()).toBe(false);
    expect(backend.quitAndInstall).not.toHaveBeenCalled();

    backend.emit('update-downloaded', { version: '0.2.0' });
    await settle();
    expect(updater.current).toEqual({ status: 'ready', version: '0.2.0', currentVersion: '0.1.0' });

    // Checking again never throws the staged update away.
    await updater.check();
    expect(updater.current.status).toBe('ready');
    expect(backend.checkForUpdates).toHaveBeenCalledTimes(1);

    expect(await updater.install()).toBe(true);
    expect(before).toHaveBeenCalledOnce();
    expect(updater.isInstalling).toBe(true);
    expect(backend.quitAndInstall).toHaveBeenCalledWith(true, true);
    // A second click doesn't run the installer twice.
    expect(await updater.install()).toBe(false);
    expect(states.map((s) => s.status)).toEqual([
      'checking',
      'downloading',
      'downloading',
      'ready',
    ]);
  });

  it('reports being current, and errors in plain words', async () => {
    const { updater, backend } = make();
    await updater.check();
    expect(updater.current.status).toBe('current');
    backend.checkForUpdates.mockRejectedValueOnce(new Error('net::ERR_INTERNET_DISCONNECTED'));
    await updater.check();
    expect(updater.current).toMatchObject({
      status: 'error',
      message: "Can't reach the update server. Kovan will try again later.",
    });
  });

  it('looks at launch, then every ten minutes', async () => {
    vi.useFakeTimers();
    try {
      const { updater, backend } = make();
      updater.setAutomatic(true);
      expect(CHECK_EVERY_MS).toBe(600_000);
      await vi.advanceTimersByTimeAsync(0);
      expect(backend.checkForUpdates).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(CHECK_EVERY_MS - 1);
      expect(backend.checkForUpdates).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(backend.checkForUpdates).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(CHECK_EVERY_MS);
      expect(backend.checkForUpdates).toHaveBeenCalledTimes(3);
      updater.setAutomatic(false);
      await vi.advanceTimersByTimeAsync(CHECK_EVERY_MS * 3);
      expect(backend.checkForUpdates).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does nothing in development builds, or on Linux without an update key', async () => {
    const dev = make({ packaged: false });
    await dev.updater.check();
    dev.updater.setAutomatic(true);
    expect(dev.backend.checkForUpdates).not.toHaveBeenCalled();
    expect(dev.updater.current.status).toBe('unsupported');

    const linux = make({ platform: 'linux' });
    expect(linux.updater.current.status).toBe('unsupported');
    expect(linux.updater.current.message).toContain('update key');
  });

  describe('on Linux', () => {
    const keys = keyPair();
    const good = manifest('0.2.0', 'GOODHASH==');
    const linux = (files: Record<string, string>) => {
      process.env['APPIMAGE'] = '/tmp/Kovan.AppImage';
      return make({
        platform: 'linux',
        publicKey: keys.publicKey,
        fetchText: async (url) => {
          const body = files[url.split('/').pop()!];
          if (body === undefined) throw new Error('404');
          return body;
        },
      });
    };
    const downloaded = {
      version: '0.2.0',
      sha512: 'GOODHASH==',
      files: [{ url: 'x', sha512: 'GOODHASH==' }],
    };

    it('installs an update whose manifest is signed with the update key', async () => {
      const { updater, backend } = linux({
        'latest-linux.yml': good,
        'latest-linux.yml.sig': keys.sign(good),
      });
      expect(backend.autoInstallOnAppQuit).toBe(false);
      backend.emit('update-downloaded', downloaded);
      await settle();
      expect(updater.current.status).toBe('ready');
      expect(backend.autoInstallOnAppQuit).toBe(true);
    });

    it('refuses an unsigned, wrongly signed, mismatched or downgraded update', async () => {
      const other = keyPair();
      const cases: [string, Record<string, string>, object][] = [
        ['no signature file', { 'latest-linux.yml': good }, downloaded],
        [
          'signed by someone else',
          { 'latest-linux.yml': good, 'latest-linux.yml.sig': other.sign(good) },
          downloaded,
        ],
        [
          'manifest changed after signing',
          {
            'latest-linux.yml': good.replace('GOODHASH', 'EVILHASH'),
            'latest-linux.yml.sig': keys.sign(good),
          },
          { ...downloaded, sha512: 'EVILHASH==', files: [] },
        ],
        [
          'a different file than the signed one',
          { 'latest-linux.yml': good, 'latest-linux.yml.sig': keys.sign(good) },
          { version: '0.2.0', sha512: 'EVILHASH==' },
        ],
        [
          'another version than the signed one',
          { 'latest-linux.yml': good, 'latest-linux.yml.sig': keys.sign(good) },
          { ...downloaded, version: '0.3.0' },
        ],
      ];
      for (const [name, files, info] of cases) {
        const { updater, backend } = linux(files);
        backend.emit('update-downloaded', info);
        await settle();
        expect(updater.current.status, name).toBe('error');
        expect(updater.current.message, name).toContain('not installed');
        expect(backend.autoInstallOnAppQuit, name).toBe(false);
        expect(await updater.install(), name).toBe(false);
        expect(backend.quitAndInstall, name).not.toHaveBeenCalled();
      }
    });
  });

  it('checks signatures and reads manifest hashes', () => {
    const keys = keyPair();
    expect(verifyManifest('a', keys.sign('a'), keys.publicKey)).toBe(true);
    expect(verifyManifest('b', keys.sign('a'), keys.publicKey)).toBe(false);
    expect(verifyManifest('a', 'not base64!', keys.publicKey)).toBe(false);
    expect(verifyManifest('a', keys.sign('a'), 'garbage')).toBe(false);
    expect(manifestHashes(manifest('1.0.0', 'abc+/=='))).toEqual(['abc+/==', 'abc+/==']);
  });
});
