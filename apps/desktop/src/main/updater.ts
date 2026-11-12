import { createPublicKey, verify } from 'node:crypto';
import type { UpdateState } from '../shared/api.js';

/** The slice of electron-updater this needs; tests pass a fake. */
export interface UpdateBackend {
  autoDownload: boolean;
  autoInstallOnAppQuit: boolean;
  setFeedURL(options: { provider: 'generic'; url: string }): void;
  checkForUpdates(): Promise<unknown>;
  quitAndInstall(isSilent?: boolean, isForceRunAfter?: boolean): void;
  on(event: 'update-available', listener: (info: UpdateInfoLike) => void): unknown;
  on(event: 'update-not-available', listener: (info: UpdateInfoLike) => void): unknown;
  on(event: 'download-progress', listener: (progress: { percent: number }) => void): unknown;
  on(event: 'update-downloaded', listener: (info: UpdateInfoLike) => void): unknown;
  on(event: 'error', listener: (error: Error) => void): unknown;
}

export interface UpdateInfoLike {
  version: string;
  files?: { url: string; sha512: string }[];
  sha512?: string;
}

export interface UpdaterOptions {
  backend: UpdateBackend;
  /** Where update files are served, e.g. https://kovan.alperkayan.dev/updates */
  feedUrl: string;
  platform: NodeJS.Platform;
  packaged: boolean;
  currentVersion: string;
  /** Base64 SPKI Ed25519 key; required on Linux. */
  publicKey: string;
  fetchText?: (url: string) => Promise<string>;
  onState: (state: UpdateState) => void;
  /** Called right before quitting to install, so nothing blocks the quit. */
  beforeInstall?: () => void | Promise<void>;
}

/** How often it looks for a new version, after a first look at launch. */
export const CHECK_EVERY_MS = 600_000;

/** True when `signature` (base64) is the update key's signature over `text`. */
export function verifyManifest(text: string, signature: string, publicKey: string): boolean {
  try {
    const key = createPublicKey({
      key: Buffer.from(publicKey, 'base64'),
      format: 'der',
      type: 'spki',
    });
    return verify(null, Buffer.from(text), key, Buffer.from(signature.trim(), 'base64'));
  } catch {
    return false;
  }
}

/** The sha512 values a manifest (latest-linux.yml) vouches for. */
export function manifestHashes(manifest: string): string[] {
  return [...manifest.matchAll(/^\s*(?:-\s*)?sha512:\s*(\S+)\s*$/gm)].map((m) => m[1]!);
}

const defaultFetchText = async (url: string): Promise<string> => {
  const res = await fetch(url, { signal: AbortSignal.timeout(30_000), cache: 'no-store' });
  if (!res.ok) throw new Error(`${url} answered ${res.status}`);
  return res.text();
};

/**
 * Self-update: check, download in the background (stage), then on the person's click quit,
 * install and relaunch. macOS and Windows verify the publisher's signature themselves. A Linux
 * AppImage has none, so there the downloaded file must match a manifest signed with the update
 * key before it may be installed.
 */
export class Updater {
  private state: UpdateState;
  private timer: NodeJS.Timeout | null = null;
  private enabled = false;
  private checking: Promise<void> | null = null;
  private installing = false;

  constructor(private readonly options: UpdaterOptions) {
    const { backend, platform, packaged, publicKey } = options;
    const reason = !packaged
      ? 'Development builds do not update themselves.'
      : platform === 'linux' && !publicKey
        ? 'This build has no update key, so it cannot verify updates. Download new versions from the website.'
        : platform === 'linux' && !process.env['APPIMAGE']
          ? 'Only the AppImage updates itself.'
          : null;
    this.state = reason
      ? { status: 'unsupported', currentVersion: options.currentVersion, message: reason }
      : { status: 'idle', currentVersion: options.currentVersion };
    if (reason) return;

    backend.autoDownload = true;
    // Linux installs only after its manifest check; the others may install on a normal quit.
    backend.autoInstallOnAppQuit = platform !== 'linux';
    backend.setFeedURL({ provider: 'generic', url: options.feedUrl });
    backend.on('update-available', (info) =>
      this.set({ status: 'downloading', version: info.version, percent: 0 }),
    );
    backend.on('update-not-available', () => this.set({ status: 'current' }));
    backend.on('download-progress', (p) => {
      if (this.state.status === 'downloading')
        this.set({ ...this.state, percent: Math.round(p.percent) });
    });
    backend.on('update-downloaded', (info) => void this.staged(info));
    backend.on('error', (error) => {
      if (!this.installing) this.set({ status: 'error', message: friendly(error) });
    });
  }

  get current(): UpdateState {
    return this.state;
  }

  get supported(): boolean {
    return this.state.status !== 'unsupported';
  }

  /** True once the person asked to install: window close handlers must not hold the quit. */
  get isInstalling(): boolean {
    return this.installing;
  }

  private set(next: Omit<UpdateState, 'currentVersion'> & { status: UpdateState['status'] }): void {
    this.state = { ...next, currentVersion: this.options.currentVersion } as UpdateState;
    this.options.onState(this.state);
  }

  /** Turns the background check on or off (the "update automatically" setting). */
  setAutomatic(on: boolean): void {
    if (!this.supported || on === this.enabled) return;
    this.enabled = on;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (!on) return;
    this.timer = setInterval(() => void this.check(), CHECK_EVERY_MS);
    this.timer.unref();
    void this.check();
  }

  /** Looks for a newer version; a found one downloads on its own. */
  async check(): Promise<UpdateState> {
    if (!this.supported) return this.state;
    // A staged update stays staged; a download in flight is left alone.
    if (this.state.status === 'ready' || this.state.status === 'downloading') return this.state;
    this.checking ??= (async () => {
      this.set({ status: 'checking' });
      try {
        await this.options.backend.checkForUpdates();
        // Some backends resolve without an event when nothing is published.
        if (this.state.status === 'checking') this.set({ status: 'current' });
      } catch (error) {
        this.set({ status: 'error', message: friendly(error) });
      } finally {
        this.checking = null;
      }
    })();
    await this.checking;
    return this.state;
  }

  private async staged(info: UpdateInfoLike): Promise<void> {
    if (this.options.platform === 'linux') {
      const problem = await this.unverified(info);
      if (problem) {
        this.options.backend.autoInstallOnAppQuit = false;
        this.set({ status: 'error', message: problem });
        return;
      }
      this.options.backend.autoInstallOnAppQuit = true;
    }
    this.set({ status: 'ready', version: info.version });
  }

  /** Why a downloaded Linux update can't be trusted, or null when it checks out. */
  private async unverified(info: UpdateInfoLike): Promise<string | null> {
    const fetchText = this.options.fetchText ?? defaultFetchText;
    const base = this.options.feedUrl.replace(/\/$/, '');
    let manifest: string;
    let signature: string;
    try {
      [manifest, signature] = await Promise.all([
        fetchText(`${base}/latest-linux.yml`),
        fetchText(`${base}/latest-linux.yml.sig`),
      ]);
    } catch {
      return "The update's signature could not be downloaded, so it was not installed.";
    }
    if (!verifyManifest(manifest, signature, this.options.publicKey))
      return 'The update is not signed with the Kovan update key, so it was not installed.';
    const vouched = manifestHashes(manifest);
    const downloaded = [info.sha512, ...(info.files ?? []).map((f) => f.sha512)].filter(
      (h): h is string => Boolean(h),
    );
    if (!downloaded.length || !downloaded.every((h) => vouched.includes(h)))
      return 'The downloaded update does not match its signed manifest, so it was not installed.';
    if (!new RegExp(`^version:\\s*${escapeRegExp(info.version)}\\s*$`, 'm').test(manifest))
      return 'The downloaded update does not match its signed manifest, so it was not installed.';
    return null;
  }

  /** Stage → quit → install → relaunch. Only does anything once an update is staged. */
  async install(): Promise<boolean> {
    if (this.state.status !== 'ready' || this.installing) return false;
    this.installing = true;
    try {
      await this.options.beforeInstall?.();
    } catch {
      // Cleanup problems never keep an update from installing.
    }
    // Silent install, and start the new version when it is done.
    this.options.backend.quitAndInstall(true, true);
    return true;
  }

  dispose(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function friendly(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  if (/ENOTFOUND|ECONNREFUSED|ETIMEDOUT|ERR_INTERNET_DISCONNECTED|ERR_NAME_NOT_RESOLVED/.test(text))
    return "Can't reach the update server. Kovan will try again later.";
  if (/code signature|not signed|signature/i.test(text))
    return 'The update did not pass its signature check, so it was not installed.';
  if (/404|Cannot find .*latest/i.test(text)) return 'No update has been published yet.';
  return `Couldn't check for updates (${text.split('\n')[0]!.slice(0, 160)}). Kovan will try again later.`;
}
