export type Platform = 'mac' | 'windows-x64' | 'windows-arm64' | 'linux';

export const PLATFORM_LABEL: Record<Platform, string> = {
  mac: 'macOS',
  'windows-x64': 'Windows',
  'windows-arm64': 'Windows on ARM',
  linux: 'Linux',
};

interface UserAgentData {
  platform?: string;
  mobile?: boolean;
  getHighEntropyValues?: (hints: string[]) => Promise<{ architecture?: string }>;
}

/** The desktop build that fits this visitor, or null on phones and anything we don't ship for. */
export async function detectPlatform(): Promise<Platform | null> {
  const data = (navigator as Navigator & { userAgentData?: UserAgentData }).userAgentData;
  const ua = navigator.userAgent;
  if (data?.mobile || /Android|iPhone|iPad|iPod/i.test(ua)) return null;
  // iPadOS calls itself a Mac; a Mac has no touch points.
  if (/Mac/i.test(ua) && navigator.maxTouchPoints > 1) return null;

  const name = `${data?.platform ?? ''} ${ua}`;
  if (/Mac/i.test(name)) return 'mac';
  if (/Win/i.test(name)) {
    try {
      const hints = await data?.getHighEntropyValues?.(['architecture']);
      if (hints?.architecture === 'arm') return 'windows-arm64';
    } catch {
      // Not every browser answers; x64 runs everywhere.
    }
    return /ARM64|aarch64/i.test(ua) ? 'windows-arm64' : 'windows-x64';
  }
  if (/Linux|X11|CrOS/i.test(name)) return 'linux';
  return null;
}
