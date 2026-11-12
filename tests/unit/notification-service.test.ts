import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BURST, NotificationService, notifyIdPrefix, type NativeNotification } from '../../src/main/notifications';
import type { NoticeTarget } from '../../src/shared/notifications';
import { DEFAULT_SETTINGS, type AppSettings } from '../../src/shared/types';

class FakeNotification implements NativeNotification {
  shown = false;
  closed = false;
  private readonly handlers = new Map<string, ((...a: unknown[]) => void)[]>();
  constructor(readonly options: { title: string; body: string; silent: boolean; id: string; groupId: string }) {}
  show() {
    this.shown = true;
  }
  close() {
    this.closed = true;
  }
  on(event: string, listener: (...a: never[]) => void) {
    this.handlers.set(event, [...(this.handlers.get(event) ?? []), listener as (...a: unknown[]) => void]);
    return this;
  }
  emit(event: string, ...args: unknown[]) {
    for (const h of this.handlers.get(event) ?? []) h(...args);
  }
}

function setup(over: Partial<AppSettings> = {}, idPrefix?: string) {
  const created: FakeNotification[] = [];
  const activated: NoticeTarget[] = [];
  const badge: boolean[] = [];
  const win = { focused: false, minimized: true, visible: true, flashes: [] as boolean[], restored: 0, focusCalls: 0 };
  const settings = { ...DEFAULT_SETTINGS, ...over };
  const service = new NotificationService({
    create: (o) => {
      const n = new FakeNotification(o);
      created.push(n);
      return n;
    },
    supported: () => true,
    window: () => ({
      isFocused: () => win.focused,
      isMinimized: () => win.minimized,
      isVisible: () => win.visible,
      restore: () => {
        win.restored++;
        win.minimized = false;
      },
      show: () => undefined,
      focus: () => {
        win.focusCalls++;
        win.focused = true;
      },
      flashFrame: (on) => win.flashes.push(on),
    }),
    settings: () => settings,
    names: (w, t) => (w === 'w1' && ['t1', 't2', 't3', 't4', 't5'].includes(t) ? { workspace: 'car-rental', tab: t === 't1' ? 'Backend' : null } : null),
    activate: (target) => activated.push(target),
    badge: (on) => badge.push(on),
    now: () => Date.now(),
    log: () => undefined,
    idPrefix,
  });
  return { service, created, activated, badge, win, settings };
}

const notice = (tabId: string, kind = 'permission', extra: Record<string, unknown> = {}) => ({
  workspaceId: 'w1',
  tabId,
  kind,
  agent: 'claude',
  app: 'claude-code',
  details: true,
  session: 'Refactor auth: my secret prompt',
  message: 'approve Write: C:\\Users\\me\\x.txt',
  ...extra,
});

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('NotificationService', () => {
  it("writes the text itself: SplitNest's title; workspace and the user's tab name, else the agent; no session or message by default", () => {
    const { service, created } = setup();
    expect(service.notify(notice('t1'))).toBe('shown');
    expect(service.notify(notice('t2', 'done', { agent: 'codex', app: 'codex' }))).toBe('shown');
    expect(created.map((n) => [n.options.title, n.options.body])).toEqual([
      ['Claude Code needs permission', 'car-rental · Backend'],
      ['Codex finished', 'car-rental · Codex'],
    ]);
    expect(created.every((n) => n.shown && n.options.silent === false)).toBe(true);
  });

  it('with details allowed: the session title (when the tab has no name of its own) and the message', () => {
    const { service, created } = setup({ notifyDetails: true });
    service.notify(notice('t2'));
    expect(created[0]!.options.body).toBe('car-rental · Refactor auth: my secret prompt\napprove Write: C:\\Users\\me\\x.txt');
  });

  it("details need both the saved setting and the page's current choice (turning it off applies at once)", () => {
    const { service, created } = setup({ notifyDetails: true });
    service.notify(notice('t2', 'permission', { details: false }));
    expect(created[0]!.options.body).toBe('car-rental · Claude Code');
  });

  it('refuses malformed requests, unknown workspaces or tabs, and kinds that are turned off', () => {
    const { service, created } = setup({ notifyFinished: false });
    expect(service.notify({ ...notice('t1'), kind: 'urgent' })).toBe('invalid');
    expect(service.notify({ ...notice('t1'), workspaceId: 'nope' })).toBe('invalid');
    expect(service.notify(notice('t9'))).toBe('invalid');
    expect(service.notify(notice('t1', 'done'))).toBe('off');
    expect(created).toHaveLength(0);
  });

  it('focused window, or Windows notifications off: the page shows its own notice', () => {
    const a = setup();
    a.win.focused = true;
    a.win.minimized = false;
    expect(a.service.notify(notice('t1'))).toBe('in-app');
    const b = setup({ notifyWindows: false });
    expect(b.service.notify(notice('t1'))).toBe('in-app');
    expect([...a.created, ...b.created]).toHaveLength(0);
  });

  it('a click restores the minimized window, focuses it, and shows exactly that tab', () => {
    const { service, created, activated, win } = setup();
    service.notify(notice('t1'));
    service.notify(notice('t2'));
    created[1]!.emit('click');
    expect(win.restored).toBe(1);
    expect(win.focusCalls).toBe(1);
    expect(activated).toEqual([{ workspaceId: 'w1', tabId: 't2' }]);
    expect(service.state.tabs).toBe(1);
  });

  it('one notification per tab: a newer one replaces it; withdrawing closes it (removes it from Notification Center)', () => {
    const { service, created } = setup();
    service.notify(notice('t1'));
    service.notify(notice('t1', 'question'));
    expect(created[0]!.closed).toBe(true);
    service.withdraw(['t1', '../bad', 42]);
    expect(created[1]!.closed).toBe(true);
    expect(service.state.tabs).toBe(0);
  });

  it(`more than ${BURST.count} within ${BURST.windowMs / 1000} s become one summary; its click shows the latest tab`, () => {
    const { service, created, activated, win } = setup();
    for (const t of ['t1', 't2', 't3', 't4', 't5']) service.notify(notice(t));
    expect(created.map((n) => n.options.title)).toEqual([
      'Claude Code needs permission',
      'Claude Code needs permission',
      'Claude Code needs permission',
      '4 agent notifications',
      '5 agent notifications',
    ]);
    expect(created[3]!.closed).toBe(true); // the summary is replaced, not stacked
    expect(created[4]!.options.silent).toBe(true); // an updated summary does not sound again
    created[4]!.emit('click');
    expect(activated.at(-1)).toEqual({ workspaceId: 'w1', tabId: 't5' });
    win.focused = false; // back in the background
    vi.advanceTimersByTime(BURST.windowMs);
    service.notify(notice('t5', 'done'));
    expect(created.at(-1)!.options.title).toBe('Claude Code finished');
  });

  it('past the rate limit with no other notification up: shown on its own, not as a summary of one', () => {
    const { service, created } = setup();
    for (const t of ['t1', 't2', 't3']) service.notify(notice(t));
    service.withdraw();
    service.notify(notice('t4', 'done'));
    expect(created.at(-1)!.options.title).toBe('Claude Code finished');
  });

  it('flash and badge for "needs you" in the background; focus stops the flash; seeing the tabs clears the badge', () => {
    const { service, badge, win } = setup();
    service.notify(notice('t1'));
    service.notify(notice('t2', 'done'));
    expect(win.flashes).toEqual([true]);
    expect(badge.at(-1)).toBe(true);
    service.windowFocused();
    expect(win.flashes.at(-1)).toBe(false);
    service.withdraw(['t1']);
    expect(badge.at(-1)).toBe(false); // only a "finished" is left
    const quiet = setup({ notifyFlash: false, notifySound: false });
    quiet.service.notify(notice('t1'));
    expect(quiet.win.flashes).toEqual([]);
    expect(quiet.created[0]!.options.silent).toBe(true);
  });

  it('Windows refusing a notification drops it', () => {
    const { service, created } = setup();
    service.notify(notice('t1'));
    created[0]!.emit('failed', {}, 'denied');
    expect(service.state.tabs).toBe(0);
  });

  it('quitting closes every notification, so none is left in Notification Center', () => {
    const { service, created, badge } = setup();
    service.notify(notice('t1'));
    service.notify(notice('t2'));
    void service.test();
    service.dispose();
    expect(created.every((n) => n.closed)).toBe(true);
    expect(badge.at(-1)).toBe(false);
    expect(service.notify(notice('t3'))).toBe('off');
  });

  describe('test notification', () => {
    it('reports what Windows said; a click opens Settings › Notifications', async () => {
      const { service, created, activated } = setup();
      const shown = service.test();
      created[0]!.emit('show');
      await expect(shown).resolves.toMatchObject({ ok: true });
      created[0]!.emit('click');
      expect(activated).toEqual([{ settings: 'notifications' }]);
      const refused = service.test();
      created[1]!.emit('failed', {}, 'Notifications are turned off\u001b[2J');
      await expect(refused).resolves.toEqual({ ok: false, detail: 'Windows refused it: Notifications are turned off [2J.' });
      const silent = service.test();
      vi.advanceTimersByTime(5000);
      await expect(silent).resolves.toMatchObject({ ok: false });
    });
  });

  it('tags every notification with the run token a packaged check passes, and only a well-formed one', async () => {
    expect(notifyIdPrefix(undefined)).toBe('');
    expect(notifyIdPrefix('k3f9a2')).toBe('k3f9a2-');
    for (const bad of ['', 'abc', 'toolongtoken', 'K3F9A2', 'k3f9-2', 'k3f9a2\n']) expect(notifyIdPrefix(bad)).toBe('');
    const plain = setup();
    plain.service.notify(notice('t1'));
    expect(plain.created[0]!.options).toMatchObject({ id: 'n1', groupId: 'agents' });
    const run = setup({}, notifyIdPrefix('k3f9a2'));
    run.service.notify(notice('t1'));
    run.service.notify(notice('t2', 'done'));
    void run.service.test();
    expect(run.created.map((n) => [n.options.id, n.options.groupId])).toEqual([
      ['k3f9a2-n1', 'agents'],
      ['k3f9a2-n2', 'agents'],
      ['k3f9a2-t3', 'test'],
    ]);
  });
});
