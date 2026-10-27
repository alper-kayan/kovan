import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { relayEnv } from './gitRelay.js';

const run = promisify(execFile);
let dir: string;
let relay: string;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'kovan-relayenv-'));
  // Stands in for Kovan's relay: a repository at another address.
  relay = join(dir, 'relay.git');
  const seed = join(dir, 'seed');
  await run('git', ['init', '-q', '--bare', '-b', 'main', relay]);
  await run('git', ['init', '-q', '-b', 'main', seed]);
  await writeFile(join(seed, 'a.txt'), 'a\n');
  await run('git', ['-C', seed, 'add', '.']);
  await run('git', ['-C', seed, '-c', 'user.email=a@b', '-c', 'user.name=a', 'commit', '-qm', 'a']);
  await run('git', ['-C', seed, 'push', '-q', relay, 'main']);
});
afterAll(() => rm(dir, { recursive: true, force: true }));

describe('git through Kovan on a machine', () => {
  it("sends the checkout's remote to the relay with the machine's key, writing no file", async () => {
    const env = relayEnv([{ remote: 'git@github.com:acme/shop.git', relay }], 'kv_live_machine', {
      GIT_CONFIG_COUNT: '1',
    });
    // After what was there already, the key once per relay, then each remote.
    expect(env).toEqual({
      GIT_CONFIG_COUNT: '3',
      GIT_CONFIG_KEY_1: `http.${relay}.extraHeader`,
      GIT_CONFIG_VALUE_1: 'Authorization: Bearer kv_live_machine',
      GIT_CONFIG_KEY_2: `url.${relay}.insteadOf`,
      GIT_CONFIG_VALUE_2: 'git@github.com:acme/shop.git',
    });
    const { stdout } = await run('git', ['ls-remote', 'git@github.com:acme/shop.git'], {
      env: {
        ...process.env,
        ...relayEnv([{ remote: 'git@github.com:acme/shop.git', relay }], 'kv_live_machine', {}),
      },
    });
    expect(stdout).toContain('refs/heads/main');
  });
});
