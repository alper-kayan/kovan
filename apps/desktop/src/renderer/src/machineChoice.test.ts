import type { Machine } from '@kovan/shared';
import { describe, expect, it } from 'vitest';
import { machineOptions, machineWorker, placeForSwarm } from './machineChoice';

const machine = (name: string, over: Partial<Machine> = {}): Machine => ({
  id: `00000000-0000-4000-8000-00000000000${name.length}`,
  name,
  platform: 'linux-arm64',
  slots: 1,
  running: 0,
  agents: [
    { name: 'kovan', version: null, ready: true, works: false },
    { name: 'claude', version: '2.1.302', ready: true, works: true },
  ],
  repos: [{ remote: 'git@github.com:acme/shop.git', path: '/w/shop' }],
  online: true,
  lastSeenAt: '2026-10-17T16:00:00.000Z',
  createdAt: '2026-10-17T12:00:00.000Z',
  keyName: `agentd-${name}`,
  scope: 'organization',
  ...over,
});

describe('where a swarm can run', () => {
  it('offers this computer, auto and each machine, saying why one cannot take the work', () => {
    const options = machineOptions(
      [
        machine('pi', { online: false }),
        machine('mac', { slots: 2, running: 1 }),
        machine('box', { repos: [{ remote: 'github.com/acme/blog', path: '/w/blog' }] }),
        machine('laptop', { running: 1 }),
      ],
      'github.com/acme/shop',
    );
    expect(options.map((o) => [o.label, o.unavailable])).toEqual([
      ['This computer', null],
      ['Auto: least busy machine', null],
      ['mac · 1 of 2 free', null],
      ['pi', 'offline'],
      ['box', "doesn't hold this repository"],
      ['laptop', 'busy'],
    ]);
  });

  it('has no auto without a machine that can take it, and only this computer without machines', () => {
    expect(machineOptions([machine('pi', { online: false })], 'github.com/acme/shop')[1]).toEqual({
      value: 'auto',
      label: 'Auto: least busy machine',
      unavailable: 'no machine can take it now',
    });
    expect(machineOptions([], 'github.com/acme/shop').map((o) => o.value)).toEqual(['here']);
  });

  it('says whose account does the work there', () => {
    expect(machineWorker(machine('pi'))).toBe("Claude Code, on its owner's subscription");
    const kovan = machine('pi', {
      agents: [
        { name: 'kovan', version: null, ready: true, works: true },
        { name: 'claude', version: '2.1.302', ready: true, works: false },
      ],
    });
    expect(machineWorker(kovan)).toBe("Kovan's agent, with that machine's OpenRouter key");
    // An older agentd doesn't say.
    const older = machine('pi', {
      agents: [{ name: 'claude', version: '2.1.302', ready: true, works: false }],
    });
    expect(machineWorker(older)).toBe('the agent set up there');
  });
});

describe('placeForSwarm', () => {
  const repo = 'github.com/acme/shop';
  const pi = machine('pi');

  it('stays on this computer when its own agent is ready and no subscription is preferred', () => {
    expect(placeForSwarm(true, [pi], repo)).toBe('here');
  });

  it('moves to a free subscription machine that holds the repository when this computer has no model', () => {
    expect(placeForSwarm(false, [pi], repo)).toBe(pi.id);
  });

  it('prefers a subscription machine over this computer when the first choice is a subscription', () => {
    expect(placeForSwarm(true, [pi], repo, true)).toBe(pi.id);
    expect(placeForSwarm(true, [], repo, true)).toBe('here');
  });

  it('stays here when no machine can take it: offline, busy, or without the repository', () => {
    expect(placeForSwarm(false, [], repo)).toBe('here');
    expect(placeForSwarm(false, [machine('pi', { online: false })], repo)).toBe('here');
    expect(placeForSwarm(false, [machine('pi', { running: 1 })], repo)).toBe('here');
    expect(placeForSwarm(false, [pi], 'github.com/acme/other')).toBe('here');
    expect(placeForSwarm(false, [pi], null)).toBe('here');
  });

  it('never sends a swarm to a machine whose worker is billed per use or not signed in', () => {
    const paid = machine('mac', {
      agents: [
        { name: 'kovan', version: null, ready: true, works: true },
        { name: 'claude', version: '2.1.302', ready: true, works: false },
      ],
    });
    const loggedOut = machine('lap', {
      agents: [{ name: 'claude', version: '2.1.302', ready: false, works: true }],
    });
    expect(placeForSwarm(false, [paid, loggedOut], repo, true)).toBe('here');
  });

  it('uses a signed-in Claude Code when the machine does not say which agent works', () => {
    const unsaid = machine('studio', {
      agents: [
        { name: 'kovan', version: null, ready: false, works: false },
        { name: 'claude', version: '2.1.302', ready: true, works: false },
      ],
    });
    expect(placeForSwarm(false, [unsaid], repo)).toBe(unsaid.id);
  });

  it('picks the machine with the most free slots, then by name', () => {
    const busy = machine('aaa', { slots: 2, running: 1 });
    const idle = machine('bbbb', { slots: 2, running: 0 });
    expect(placeForSwarm(false, [busy, idle], repo)).toBe(idle.id);
  });
});
