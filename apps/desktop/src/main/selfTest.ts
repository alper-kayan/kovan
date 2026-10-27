import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export interface SelfTestPaths {
  renderer: string;
  preload: string;
  mcpServer: string;
  hookScript: string;
}

interface Check {
  name: string;
  ok: boolean;
  detail?: string;
}

const within = <T>(promise: Promise<T>, ms: number, what: string): Promise<T> =>
  Promise.race([
    promise,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`${what} timed out`)), ms)),
  ]);

/** A terminal really starts and echoes: the native module and its helper binary both work. */
async function terminalWorks(): Promise<string> {
  const pty = await import('node-pty');
  const windows = process.platform === 'win32';
  const term = pty.spawn(
    windows ? 'cmd.exe' : '/bin/sh',
    windows ? ['/c', 'echo kovan-pty-ok'] : ['-c', 'echo kovan-pty-ok'],
    { cols: 80, rows: 24, cwd: process.cwd(), env: process.env as Record<string, string> },
  );
  let out = '';
  return within(
    new Promise<string>((resolve, reject) => {
      term.onData((data) => (out += data));
      term.onExit(() =>
        out.includes('kovan-pty-ok') ? resolve('echoed') : reject(new Error(`output: ${out}`)),
      );
    }),
    10_000,
    'terminal',
  );
}

/** The MCP server starts under Electron's own Node and answers an initialize request. */
async function mcpAnswers(script: string): Promise<string> {
  const child = spawn(process.execPath, [script], {
    // The bridge is only read when a tool is called; initialize doesn't need a real one.
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      KOVAN_BRIDGE_FILE: join(tmpdir(), 'kovan-self-test-bridge.json'),
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let out = '';
  let err = '';
  try {
    return await within(
      new Promise<string>((resolve, reject) => {
        child.stdout.on('data', (d: Buffer) => {
          out += d.toString();
          const line = out.split('\n').find((l) => l.includes('"result"'));
          if (line) {
            const info = (JSON.parse(line) as { result?: { serverInfo?: { name?: string } } })
              .result?.serverInfo;
            resolve(`answered as ${info?.name ?? 'unknown'}`);
          }
        });
        child.stderr.on('data', (d: Buffer) => (err += d.toString()));
        child.on('error', reject);
        child.on('exit', (code) => reject(new Error(`exited ${code}: ${err.slice(0, 300)}`)));
        child.stdin.write(
          JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'initialize',
            params: {
              protocolVersion: '2025-06-18',
              capabilities: {},
              clientInfo: { name: 'kovan-self-test', version: '0' },
            },
          }) + '\n',
        );
      }),
      10_000,
      'MCP server',
    );
  } finally {
    child.kill();
  }
}

/**
 * The app's page loads in a hidden window: its stylesheet applies and its script runs far enough
 * to call the main process through the preload bridge (the first thing the app does).
 */
async function pageLoads(paths: SelfTestPaths): Promise<string> {
  const { BrowserWindow, ipcMain } = await import('electron');
  const window = new BrowserWindow({
    show: false,
    webPreferences: {
      preload: paths.preload,
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });
  const called = new Promise<void>((resolve) =>
    ipcMain.handle('app:info', () => {
      resolve();
      throw new Error('self-test');
    }),
  );
  try {
    await within(window.loadFile(paths.renderer), 20_000, 'page');
    await within(called, 20_000, 'the page script');
    const styled = (await window.webContents.executeJavaScript(
      'document.styleSheets.length > 0 && typeof window.kovan === "object"',
    )) as boolean;
    if (!styled) throw new Error('the stylesheet or the preload bridge is missing');
    return 'script ran, styles applied';
  } finally {
    ipcMain.removeHandler('app:info');
    window.destroy();
  }
}

/** The updater library loads from inside the archive. */
async function updaterLoads(): Promise<string> {
  const mod = await import('electron-updater');
  const updater = (mod.default ?? mod).autoUpdater;
  if (typeof updater.checkForUpdates !== 'function') throw new Error('autoUpdater is missing');
  return 'loaded';
}

/**
 * Checks, without showing a window, that a packaged build has what it needs at run time: its
 * page renders, a terminal works, the updater loads, and the MCP server and hook script run from
 * disk outside the archive.
 * Run with `--self-test`; prints one JSON line and exits 0 when everything passed.
 */
export async function runSelfTest(
  paths: SelfTestPaths,
  version: string,
  userData: string,
): Promise<boolean> {
  const checks: Check[] = [];
  const check = async (name: string, run: () => Promise<string> | string) => {
    try {
      checks.push({ name, ok: true, detail: await run() });
    } catch (error) {
      checks.push({
        name,
        ok: false,
        detail: error instanceof Error ? error.message : String(error),
      });
    }
  };
  const exists = (path: string) => {
    if (!existsSync(path)) throw new Error(`missing: ${path}`);
    return path;
  };
  await check('renderer', () => exists(paths.renderer));
  await check('preload', () => exists(paths.preload));
  await check('hook script', () => exists(paths.hookScript));
  await check('terminal', terminalWorks);
  await check('mcp server', () => mcpAnswers(exists(paths.mcpServer)));
  await check('updater', updaterLoads);
  await check('page', () => pageLoads(paths));
  const ok = checks.every((c) => c.ok);
  process.stdout.write(
    `KOVAN_SELF_TEST ${JSON.stringify({ ok, version, platform: process.platform, arch: process.arch, packaged: !process.defaultApp, userData, checks })}\n`,
  );
  return ok;
}
