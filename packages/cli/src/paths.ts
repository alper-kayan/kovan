import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Where the desktop app keeps its data (Electron's `userData` for the app called "Kovan"). The terminal agent writes its
 * conversations there, in the desktop's own format, so they show in the app's chat list.
 */
export function desktopDataDir(
  env: Record<string, string | undefined> = process.env,
  platform: string = process.platform,
  home: string = homedir(),
): string {
  if (env['KOVAN_DATA_DIR']) return env['KOVAN_DATA_DIR'];
  if (platform === 'darwin') return join(home, 'Library', 'Application Support', 'Kovan');
  if (platform === 'win32')
    return join(env['APPDATA'] ?? join(home, 'AppData', 'Roaming'), 'Kovan');
  return join(env['XDG_CONFIG_HOME'] ?? join(home, '.config'), 'Kovan');
}

/** The terminal agent's own folder: the sign-in, the machine id, the installed bundle. */
export function cliDir(home: string = homedir()): string {
  return join(home, '.kovan');
}
