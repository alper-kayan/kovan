import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startHarness, type Harness } from './test/harness.js';

let h: Harness;
const dir = mkdtempSync(join(tmpdir(), 'kovan-releases-'));
const site = mkdtempSync(join(tmpdir(), 'kovan-site-'));

beforeAll(async () => {
  writeFileSync(join(dir, 'Kovan-mac-arm64.dmg'), 'dmg');
  writeFileSync(join(dir, 'latest-mac.yml'), 'version: 0.1.0\n');
  mkdirSync(join(dir, 'cli'));
  writeFileSync(join(dir, 'cli', 'latest.json'), '{"version":"0.4.2"}');
  writeFileSync(join(site, 'install.sh'), '#!/bin/sh\n');
  writeFileSync(join(site, 'install.ps1'), 'Install-Kovan\n');
  h = await startHarness({ RELEASES_DIR: dir, WEB_DIR: site });
});

afterAll(async () => {
  await h.close();
  rmSync(dir, { recursive: true, force: true });
  rmSync(site, { recursive: true, force: true });
});

describe('releases served by the server', () => {
  it('hands out the installers it has and the update feed', async () => {
    const mac = await h.app.inject({ method: 'GET', url: '/download/mac' });
    expect(mac.statusCode).toBe(302);
    expect(mac.headers.location).toBe('/updates/Kovan-mac-arm64.dmg');
    expect((await h.app.inject({ method: 'GET', url: '/updates/Kovan-mac-arm64.dmg' })).body).toBe(
      'dmg',
    );
    const feed = await h.app.inject({ method: 'GET', url: '/updates/latest-mac.yml' });
    expect(feed.statusCode).toBe(200);
    expect(feed.body).toContain('version: 0.1.0');
  });

  it('says a platform is not out yet instead of a dead link', async () => {
    const linux = await h.app.inject({ method: 'GET', url: '/download/linux' });
    expect(linux.statusCode).toBe(404);
    expect(linux.headers['content-type']).toContain('text/html');
    expect(linux.body).toContain('Not available yet');
  });

  it('serves the terminal agent from its own folder, and its install scripts as plain text', async () => {
    const manifest = await h.app.inject({ method: 'GET', url: '/updates/cli/latest.json' });
    expect(manifest.statusCode).toBe(200);
    expect(manifest.body).toContain('0.4.2');
    for (const script of ['/install.sh', '/install.ps1']) {
      const r = await h.app.inject({ method: 'GET', url: script });
      expect(r.statusCode).toBe(200);
      // `irm … | iex` needs text to run; bytes would not be read as a script.
      expect(r.headers['content-type']).toBe('text/plain; charset=utf-8');
    }
  });
});
