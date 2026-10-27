import { git } from '@kovan/git-engine';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bodyClosing, GithubClient, parseGithubRemote } from './github.js';

describe('GitHub remotes', () => {
  it('reads owner and repo from https and ssh URLs', () => {
    expect(parseGithubRemote('https://github.com/acme/lobby.git')).toEqual({
      host: 'github.com',
      owner: 'acme',
      repo: 'lobby',
    });
    expect(parseGithubRemote('git@github.com:acme/lobby.git')).toMatchObject({ repo: 'lobby' });
    expect(parseGithubRemote('https://x-access-token:abc@github.com/acme/lobby')).toMatchObject({
      owner: 'acme',
    });
    expect(parseGithubRemote('/tmp/remote.git')).toBeNull();
  });
});

describe('pull requests', () => {
  let server: Server;
  let base: string;
  let dir: string;
  const seen: { method: string; url: string; auth: string; body: string }[] = [];
  let merged = false;

  beforeAll(async () => {
    server = createServer((req, res) => {
      let body = '';
      req.on('data', (c: Buffer) => (body += c.toString()));
      req.on('end', () => {
        seen.push({
          method: req.method!,
          url: req.url!,
          auth: req.headers.authorization ?? '',
          body,
        });
        res.setHeader('content-type', 'application/json');
        if (req.method === 'POST' && seen.filter((s) => s.method === 'POST').length === 1) {
          res.statusCode = 201;
          res.end(JSON.stringify({ html_url: 'https://github.com/acme/lobby/pull/7', number: 7 }));
        } else if (req.method === 'POST') {
          res.statusCode = 422;
          res.end(
            JSON.stringify({
              message: 'Validation Failed',
              errors: [{ message: 'A pull request already exists for acme:kovan/seats.' }],
            }),
          );
        } else if (req.url?.startsWith('/repos/acme/lobby/pulls?')) {
          res.end(
            JSON.stringify([{ html_url: 'https://github.com/acme/lobby/pull/7', number: 7 }]),
          );
        } else {
          res.end(JSON.stringify({ state: merged ? 'closed' : 'open', merged }));
        }
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    dir = await mkdtemp(join(tmpdir(), 'kovan-gh-'));
    await git(dir, ['init', '-q']);
    await git(dir, ['remote', 'add', 'origin', 'https://github.com/acme/lobby.git']);
  });
  afterAll(async () => {
    server.close();
    await rm(dir, { recursive: true, force: true });
  });

  it('opens the PR with the person token, finds it again, and sees it merged', async () => {
    const gh = new GithubClient({ apiBase: base, envToken: 'tok' });
    const input = { title: 'Seats', body: 'From Kovan', head: 'kovan/seats', base: 'main' };
    expect(await gh.createPr(dir, input)).toEqual({
      url: 'https://github.com/acme/lobby/pull/7',
      number: 7,
      state: 'open',
    });
    expect(seen[0]).toMatchObject({
      method: 'POST',
      url: '/repos/acme/lobby/pulls',
      auth: 'Bearer tok',
    });
    expect(JSON.parse(seen[0]!.body)).toEqual(input);
    // Asked again: the open one is found instead of failing.
    expect((await gh.createPr(dir, input)).number).toBe(7);

    expect(await gh.prState(dir, 7)).toBe('open');
    merged = true;
    expect(await gh.prState(dir, 7)).toBe('merged');
  });
});

describe('closing the session issue', () => {
  const issue = { number: 12, url: 'https://github.com/acme/shop/issues/12' };
  it('adds a closing line unless the body already closes the issue', () => {
    expect(bodyClosing('Adds totals.', issue)).toBe('Adds totals.\n\nCloses acme/shop#12');
    expect(bodyClosing('', issue)).toBe('Closes acme/shop#12');
    expect(bodyClosing('Fixes #12 by adding totals.', issue)).toBe('Fixes #12 by adding totals.');
    expect(bodyClosing('resolves acme/shop#12', issue)).toBe('resolves acme/shop#12');
    // #120 is another issue.
    expect(bodyClosing('Closes #120', issue)).toBe('Closes #120\n\nCloses acme/shop#12');
    expect(bodyClosing('Body', { number: 3, url: null })).toBe('Body\n\nCloses #3');
    expect(bodyClosing('Body', null)).toBe('Body');
  });
});
