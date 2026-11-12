// showAgainOnceRegistered (src/main/notifications.ts): Windows doesn't display the notification
// that registers SplitNest, so that one (and any within the delay) is shown a second time.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { REGISTRATION_RESHOW_MS, showAgainOnceRegistered, type NativeNotification } from '../../src/main/notifications';

class Fake implements NativeNotification {
  shown = 0;
  closed = false;
  readonly handlers = new Map<string, (() => void)[]>();
  constructor(readonly id: string) {}
  show() {
    this.shown++;
  }
  close() {
    this.closed = true;
  }
  on(event: string, listener: (...a: never[]) => void) {
    this.handlers.set(event, [...(this.handlers.get(event) ?? []), listener as () => void]);
    return this;
  }
}

function setup(registeredAtStart: boolean) {
  const made: Fake[] = [];
  const env = { registered: registeredAtStart };
  const create = showAgainOnceRegistered({
    create: (o) => {
      const n = new Fake(o.id);
      made.push(n);
      env.registered = true; // Electron registers SplitNest while it shows a notification
      return n;
    },
    registered: () => env.registered,
    now: () => Date.now(),
    setTimer: (fn, ms) => setTimeout(fn, ms),
    clearTimer: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
  });
  const notify = (id: string) => create({ title: 't', body: 'b', silent: false, id, groupId: 'agents' });
  return { made, notify };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('showing a notification again once Windows has registered SplitNest', () => {
  it('already registered: shown once, nothing else happens', async () => {
    const { made, notify } = setup(true);
    notify('n1').show();
    await vi.advanceTimersByTimeAsync(REGISTRATION_RESHOW_MS * 3);
    expect(made.map((n) => [n.id, n.shown, n.closed])).toEqual([['n1', 1, false]]);
  });

  it('the notification that registers SplitNest is shown again after the delay, with the same id and handlers', async () => {
    const { made, notify } = setup(false);
    const clicks: string[] = [];
    const n = notify('n1');
    n.on('click', () => clicks.push('click'));
    n.show();
    expect(made).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(REGISTRATION_RESHOW_MS - 1);
    expect(made).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(made.map((x) => [x.id, x.shown, x.closed])).toEqual([
      ['n1', 1, true], // the one Windows never displayed is withdrawn
      ['n1', 1, false],
    ]);
    made[1]!.handlers.get('click')![0]!();
    expect(clicks).toEqual(['click']);
  });

  it('another notification inside the delay is shown again at the same moment; later ones are not', async () => {
    const { made, notify } = setup(false);
    notify('n1').show();
    await vi.advanceTimersByTimeAsync(1000);
    notify('n2').show();
    await vi.advanceTimersByTimeAsync(REGISTRATION_RESHOW_MS - 1000);
    expect(made.map((x) => x.id)).toEqual(['n1', 'n2', 'n1', 'n2']);
    notify('n3').show();
    await vi.advanceTimersByTimeAsync(REGISTRATION_RESHOW_MS * 2);
    expect(made.map((x) => x.id)).toEqual(['n1', 'n2', 'n1', 'n2', 'n3']);
  });

  it('a notification closed before the delay (the agent moved on) is not shown again', async () => {
    const { made, notify } = setup(false);
    const n = notify('n1');
    n.show();
    n.close();
    await vi.advanceTimersByTimeAsync(REGISTRATION_RESHOW_MS * 2);
    expect(made.map((x) => [x.shown, x.closed])).toEqual([[1, true]]);
  });

  it('closing after the second showing closes the one that is up', async () => {
    const { made, notify } = setup(false);
    const n = notify('n1');
    n.show();
    await vi.advanceTimersByTimeAsync(REGISTRATION_RESHOW_MS);
    n.close();
    expect(made[1]!.closed).toBe(true);
  });
});
