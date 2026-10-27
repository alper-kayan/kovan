import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  app: { isPackaged: false, dock: { bounce: vi.fn() } },
  Notification: class {
    static isSupported = () => false;
  },
}));

const { createNotifier } = await import('./notifications.js');

/** Stands in for Electron's Notification; `outcome` is what the OS does on show(). */
class FakeNotification extends EventEmitter {
  static made: FakeNotification[] = [];
  constructor(
    readonly options: { title: string; body: string },
    private readonly outcome: 'show' | 'fail' | 'silent',
  ) {
    super();
    FakeNotification.made.push(this);
  }
  show(): void {
    if (this.outcome === 'show') this.emit('show');
    if (this.outcome === 'fail')
      this.emit('failed', {}, 'The operation couldn’t be completed. (UNErrorDomain error 1.)');
  }
}

function notifier(outcome: 'show' | 'fail' | 'silent', supported = true) {
  const log = vi.fn();
  const notify = createNotifier({
    isSupported: () => supported,
    create: (options) => new FakeNotification(options, outcome),
    hint: 'Turn them on',
    log,
    settleMs: 20,
  });
  return { notify, log };
}

describe('createNotifier', () => {
  it('reports a notification the OS showed, and keeps its click working', async () => {
    const { notify } = notifier('show');
    const onClick = vi.fn();
    expect(await notify('Bob finished', 'Fix login', { onClick })).toEqual({ shown: true });
    FakeNotification.made.at(-1)!.emit('click');
    expect(onClick).toHaveBeenCalledOnce();
  });

  it('reports a refusal with the hint, falls back, and warns once', async () => {
    const { notify, log } = notifier('fail');
    const onBlocked = vi.fn();
    const first = await notify('A', 'a', { onBlocked });
    expect(first).toEqual({
      shown: false,
      error: 'The operation couldn’t be completed. (UNErrorDomain error 1.)',
      hint: 'Turn them on',
    });
    await notify('B', 'b', { onBlocked });
    expect(onBlocked).toHaveBeenCalledTimes(2);
    expect(log).toHaveBeenCalledOnce();
    expect(log.mock.calls[0]![0]).toContain('Turn them on');
  });

  it('assumes it went out when the OS says nothing', async () => {
    const { notify } = notifier('silent');
    expect(await notify('A', 'a')).toEqual({ shown: true });
  });

  it('does not try where notifications are unsupported', async () => {
    const { notify } = notifier('show', false);
    const before = FakeNotification.made.length;
    expect((await notify('A', 'a')).shown).toBe(false);
    expect(FakeNotification.made.length).toBe(before);
  });
});
