import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startHarness, type Harness } from './test/harness.js';

let h: Harness;
const dir = mkdtempSync(join(tmpdir(), 'kovan-releases-'));

beforeAll(async () => {
  writeFileSync(join(dir, 'Kovan-mac-arm64.dmg'), 'dmg');
  writeFileSync(join(dir, 'latest-mac.yml'), 'version: 0.1.0\n');
  h = await startHarness({ RELEASES_DIR: dir });
});

afterAll(async () => {
  await h.close();
  rmSync(dir, { recursive: true, force: true });
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
});
