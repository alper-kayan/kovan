import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { loadConfig } from './config.js';
import { findRepos } from './detect.js';
import { unattended, unattendedMode } from './run.js';
import { launchdPlist, systemdUnit } from './units.js';

const sh = promisify(execFile);

let dir: string;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'agentd-'));
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('configuration', () => {
  const env = {
    KOVAN_SERVER_URL: 'https://kovan.example.com/',
    KOVAN_API_KEY: 'kv_live_abc',
    KOVAN_REPOS: '/srv/shop, /srv/blog',
    KOVAN_MACHINE_NAME: 'pi',
    KOVAN_SLOTS: '1',
  };
  it('reads the environment', () => {
    expect(loadConfig(env)).toMatchObject({
      serverUrl: 'https://kovan.example.com',
      name: 'pi',
      slots: 1,
      repoPaths: ['/srv/shop', '/srv/blog'],
      openRouterKey: null,
      pushWhenDone: false,
    });
    expect(loadConfig({ ...env, KOVAN_REPOS: '', KOVAN_WORKSPACE_ROOT: '/srv' }).repoPaths).toEqual(
      ['/srv/*'],
    );
  });
  it('says what is missing or wrong', () => {
    expect(() => loadConfig({ ...env, KOVAN_API_KEY: '' })).toThrow(/KOVAN_API_KEY/);
    expect(() => loadConfig({ ...env, KOVAN_API_KEY: 'a-session-token' })).toThrow(/machine scope/);
    expect(() => loadConfig({ ...env, KOVAN_SLOTS: '0' })).toThrow(/KOVAN_SLOTS/);
    expect(() => loadConfig({ ...env, KOVAN_REPOS: '' })).toThrow(/KOVAN_REPOS/);
  });
});

describe('checkouts it offers', () => {
  it('finds the repositories with a remote, named or inside a folder', async () => {
    const root = join(dir, 'work');
    for (const name of ['shop', 'blog', 'plain']) {
      await mkdir(join(root, name), { recursive: true });
      if (name === 'plain') continue;
      await sh('git', ['init', '-q', join(root, name)]);
      await sh('git', [
        '-C',
        join(root, name),
        'remote',
        'add',
        'origin',
        `git@github.com:acme/${name}.git`,
      ]);
    }
    await writeFile(join(root, 'notes.txt'), 'x');
    const all = await findRepos([`${root}/*`]);
    expect(all.map((r) => r.remote).sort()).toEqual([
      'git@github.com:acme/blog.git',
      'git@github.com:acme/shop.git',
    ]);
    expect(
      await findRepos([join(root, 'shop'), join(root, 'plain'), join(root, 'missing')]),
    ).toEqual([{ remote: 'git@github.com:acme/shop.git', path: join(root, 'shop') }]);
  });
});

describe('asking nobody', () => {
  it('runs allowed checks itself and leaves the rest to the run (which says no)', async () => {
    const no = vi.fn(async () => false);
    const approve = unattended({ approve: no });
    const ask = (kind: string, detail: string) =>
      approve({ id: '1', tool: 'run_shell', kind, title: 'Run this?', detail } as never);
    expect(await ask('command', 'pnpm test')).toBe(true);
    expect(await ask('command', 'git push origin main')).toBe(false);
    expect(await ask('command', 'pnpm test && git push')).toBe(false);
    expect(await ask('external', 'pnpm test')).toBe(false);
    expect(no).toHaveBeenCalledTimes(3);
  });

  it('never runs Full, where nothing would be asked and the policy skipped', () => {
    expect(unattendedMode('full')).toBe('allow');
    expect(unattendedMode('allow')).toBe('allow');
    expect(unattendedMode('plan')).toBe('plan');
    expect(unattendedMode('request')).toBe('request');
  });
});

describe('service files', () => {
  it('restart it, stop it politely and keep its secrets out of the unit', () => {
    const unit = systemdUnit({
      node: '/usr/bin/node',
      script: '/opt/agentd/index.js',
      user: 'kovan',
      envFile: '/etc/kovan-agentd.env',
    });
    expect(unit).toContain('ExecStart=/usr/bin/node /opt/agentd/index.js');
    expect(unit).toContain('Restart=always');
    expect(unit).toContain('KillSignal=SIGTERM');
    expect(unit).toContain('EnvironmentFile=/etc/kovan-agentd.env');
    const plist = launchdPlist({
      node: '/opt/homebrew/bin/node',
      script: '/opt/agentd/index.js',
      env: { KOVAN_SERVER_URL: 'https://x', KOVAN_REPOS: '/a&b' },
      logDir: '/tmp',
    });
    expect(plist).toContain('<key>KeepAlive</key>');
    expect(plist).toContain('<string>/a&amp;b</string>');
  });
});
