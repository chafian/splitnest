// Windows notifications for agent events (see renderer/features/notifications/agent-notifier.ts
// for when the page asks). Main writes every word itself: the title from the event kind and the
// agent's identity, the second line from the workspace and tab names in the saved state, and the
// agent's own session title and message only when the user allows details. Nothing the page
// sends becomes notification text unchecked, and notification content is never logged.
//
// One notification per tab (a newer one replaces it). More than BURST.count within
// BURST.windowMs become one summary. A click restores and focuses the window and shows that tab.
// Every notification is closed when SplitNest quits: Windows keeps them in Notification Center,
// and a click on a leftover one would start SplitNest without its context.
import { isNeedsKind, kindEnabled, noticeAgentLabel, noticeBody, noticeTitle, parseAgentNotice, plainText, type NoticeDelivery, type NoticeKind, type NoticeTarget } from '../shared/notifications';
import type { AppSettings } from '../shared/types';
import { isId } from '../shared/validation';

export interface NativeNotification {
  show(): void;
  close(): void;
  on(event: 'show' | 'click', listener: () => void): unknown;
  on(event: 'failed', listener: (event: unknown, error: string) => void): unknown;
}

export interface NotifyWindow {
  isFocused(): boolean;
  isMinimized(): boolean;
  isVisible(): boolean;
  restore(): void;
  show(): void;
  focus(): void;
  flashFrame(on: boolean): void;
}

export interface NotificationDeps {
  create(options: { title: string; body: string; silent: boolean; id: string; groupId: string }): NativeNotification;
  supported(): boolean;
  window(): NotifyWindow | null;
  settings(): AppSettings;
  /** Names from the saved state; null when the workspace or tab doesn't exist there. */
  names(workspaceId: string, tabId: string): { workspace: string; tab: string | null } | null;
  /** Tell the page what to show after a click. */
  activate(target: NoticeTarget): void;
  /** Taskbar button overlay: an agent needs you. */
  badge(on: boolean): void;
  now(): number;
  log(message: string): void;
  /**
   * Prefix of every Windows notification id (the toast tag), e.g. "k3f9a2-". Empty normally; a
   * packaged notification check passes a run token so its diagnostics can pick out exactly the
   * notifications it caused by tag, without reading any other notification (see
   * tests/windows/notifications.ps1).
   */
  idPrefix?: string;
}

/** Accepted run tokens for `--tw-notify-id=` (short: Windows limits a toast tag's length). */
export function notifyIdPrefix(arg: string | undefined): string {
  return arg !== undefined && /^[a-z0-9]{4,8}$/.test(arg) ? `${arg}-` : '';
}

export const BURST = { count: 3, windowMs: 10_000 } as const;
const TEST_TIMEOUT_MS = 5000;

interface Live {
  /** Null while it is part of the summary. */
  n: NativeNotification | null;
  kind: NoticeKind;
  target: { workspaceId: string; tabId: string };
  workspace: string;
}

export class NotificationService {
  private readonly live = new Map<string, Live>();
  private summary: NativeNotification | null = null;
  private testNotice: NativeNotification | null = null;
  private recent: number[] = [];
  private seq = 0;
  private disposed = false;

  constructor(private readonly deps: NotificationDeps) {}

  /** The page's request for an agent event (see AppApi.notifyAgent). */
  notify(raw: unknown): NoticeDelivery {
    if (this.disposed) return 'off';
    const notice = parseAgentNotice(raw, isId);
    if (!notice) return 'invalid';
    const s = this.deps.settings();
    if (!kindEnabled(notice.kind, s)) return 'off';
    const names = this.deps.names(notice.workspaceId, notice.tabId);
    if (!names) return 'invalid';
    const win = this.deps.window();
    // Focused after all (the page's view of focus can lag): the page shows its own notice.
    if (!s.notifyWindows || !this.deps.supported() || (win && win.isFocused() && win.isVisible() && !win.isMinimized())) return 'in-app';
    const label = noticeAgentLabel(notice.agent, notice.app);
    const title = noticeTitle(notice.kind, label);
    const body = noticeBody({ workspace: names.workspace, tabName: names.tab, label, details: s.notifyDetails && notice.details, session: notice.session, message: notice.message });
    const { tabId } = notice;
    this.close(tabId);
    const entry: Live = { n: null, kind: notice.kind, target: { workspaceId: notice.workspaceId, tabId }, workspace: names.workspace };
    const now = this.deps.now();
    this.recent = this.recent.filter((t) => now - t < BURST.windowMs);
    // Rate-limited: combined with the other notifications that are still up (if there are none,
    // this one is shown on its own).
    if (this.recent.length >= BURST.count && this.live.size > 0) {
      this.live.set(tabId, entry);
      this.showSummary(s);
    } else {
      this.recent.push(now);
      entry.n = this.native({ title, body, silent: !s.notifySound }, () => this.activate(tabId), () => this.close(tabId));
      this.live.set(tabId, entry);
    }
    if (isNeedsKind(notice.kind) && s.notifyFlash && win && !win.isFocused()) win.flashFrame(true);
    this.updateBadge();
    return 'shown';
  }

  /** The user has seen these tabs, or their agents moved on. Ids from the page; none = all. */
  withdraw(raw?: unknown): void {
    if (raw === undefined || raw === null) {
      for (const id of [...this.live.keys()]) this.close(id);
      return;
    }
    if (!Array.isArray(raw)) return;
    for (const id of raw.slice(0, 256)) if (isId(id)) this.close(id);
  }

  /** The window came to the front: stop flashing (the badge stays until the tabs are seen). */
  windowFocused(): void {
    this.deps.window()?.flashFrame(false);
  }

  /** Settings › Notifications: a test notification, whatever the window state and settings. */
  test(): Promise<{ ok: boolean; detail: string }> {
    if (this.disposed) return Promise.resolve({ ok: false, detail: 'SplitNest is closing.' });
    if (!this.deps.supported()) return Promise.resolve({ ok: false, detail: 'Windows notifications are not available on this system.' });
    return new Promise((resolve) => {
      let done = false;
      const finish = (r: { ok: boolean; detail: string }) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve(r);
      };
      const timer = setTimeout(() => finish({ ok: false, detail: 'Windows did not answer within 5 seconds.' }), TEST_TIMEOUT_MS);
      this.testNotice?.close();
      const n = this.deps.create({ title: 'SplitNest notifications are on', body: 'Click this to come back to Settings › Notifications.', silent: !this.deps.settings().notifySound, id: `${this.deps.idPrefix ?? ''}t${++this.seq}`, groupId: 'test' });
      n.on('show', () =>
        finish({
          ok: true,
          detail: 'Windows accepted the notification. If no banner appeared, check Do Not Disturb and the notification settings for SplitNest in Windows Settings.',
        }),
      );
      n.on('failed', (_e, error) => finish({ ok: false, detail: `Windows refused it: ${plainText(String(error), 200) ?? 'no reason given'}.` }));
      n.on('click', () => {
        this.bringToFront();
        this.deps.activate({ settings: 'notifications' });
        if (this.testNotice === n) this.testNotice = null;
      });
      this.testNotice = n;
      n.show();
    });
  }

  /** SplitNest is quitting: remove everything it put in Notification Center. */
  dispose(): void {
    this.disposed = true;
    for (const id of [...this.live.keys()]) this.close(id);
    this.summary?.close();
    this.summary = null;
    this.testNotice?.close();
    this.testNotice = null;
    this.deps.badge(false);
  }

  /** Test diagnostics (count of tabs with a notification, and whether a summary is up). */
  get state(): { tabs: number; summary: boolean } {
    return { tabs: this.live.size, summary: this.summary !== null };
  }

  private native(text: { title: string; body: string; silent: boolean }, onClick: () => void, onFail: () => void): NativeNotification {
    const n = this.deps.create({ ...text, id: `${this.deps.idPrefix ?? ''}n${++this.seq}`, groupId: 'agents' });
    n.on('click', onClick);
    n.on('failed', () => {
      this.deps.log('a Windows notification could not be shown');
      onFail();
    });
    n.show();
    return n;
  }

  private showSummary(s: AppSettings): void {
    const count = this.live.size;
    const workspaces = [...new Set([...this.live.values()].map((e) => e.workspace))];
    const first = this.summary === null;
    this.summary?.close();
    this.summary = this.native(
      { title: `${count} agent notifications`, body: plainText(workspaces.join(' · '), 120) ?? 'SplitNest', silent: !s.notifySound || !first },
      () => {
        const latest = [...this.live.keys()].at(-1);
        if (latest) this.activate(latest);
        else this.bringToFront();
      },
      () => {
        this.summary = null;
      },
    );
  }

  private activate(tabId: string): void {
    const entry = this.live.get(tabId);
    this.bringToFront();
    if (entry) this.deps.activate(entry.target);
    this.close(tabId);
  }

  private bringToFront(): void {
    const win = this.deps.window();
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
    win.flashFrame(false);
  }

  private close(tabId: string): void {
    const entry = this.live.get(tabId);
    if (!entry) return;
    this.live.delete(tabId);
    entry.n?.close();
    if (entry.n === null && this.summary && ![...this.live.values()].some((e) => e.n === null)) {
      this.summary.close();
      this.summary = null;
    }
    this.updateBadge();
  }

  private updateBadge(): void {
    this.deps.badge([...this.live.values()].some((e) => isNeedsKind(e.kind)));
  }
}

/**
 * How long after Windows first registers SplitNest a notification is shown again (see
 * `showAgainOnceRegistered`). Measured on Windows 11 build 26300: docs/TESTING.md.
 */
export const REGISTRATION_RESHOW_MS = 3000;

export interface RegistrationRetryDeps {
  create(options: NotificationOptions): NativeNotification;
  /** Windows already knows SplitNest as a notification sender (its Start menu shortcut exists). */
  registered(): boolean;
  now(): number;
  setTimer(fn: () => void, ms: number): unknown;
  clearTimer(handle: unknown): void;
  delayMs?: number;
}

type NotificationOptions = Parameters<NotificationDeps['create']>[0];

/**
 * Works around Windows not displaying the notification that registers an app.
 *
 * Electron registers SplitNest with Windows (Start menu shortcut and activator) while it shows
 * the first notification. Windows accepts that notification (it is in the app's notification
 * history) but shows no banner and nothing in Notification Center; the next one is displayed
 * normally (measured twice, docs/TESTING.md). So a notification shown while SplitNest is not
 * registered yet, or within `delayMs` after that, is shown a second time once the delay has
 * passed: same id, so it replaces the invisible one. Later notifications are untouched.
 */
export function showAgainOnceRegistered(deps: RegistrationRetryDeps): NotificationDeps['create'] {
  const delay = deps.delayMs ?? REGISTRATION_RESHOW_MS;
  /** While set: Windows registered SplitNest moments ago and may not display notifications yet. */
  let settledAt: number | null = null;
  return (options) => {
    const handlers: [string, (...a: never[]) => void][] = [];
    let current: NativeNotification | null = null;
    let closed = false;
    let timer: unknown = null;
    const make = () => {
      const n = deps.create(options);
      for (const [event, listener] of handlers) (n.on as (e: string, l: (...a: never[]) => void) => unknown)(event, listener);
      return n;
    };
    return {
      show() {
        const now = deps.now();
        if (settledAt === null && !deps.registered()) settledAt = now + delay;
        current = make();
        current.show();
        if (settledAt === null || now >= settledAt) return;
        timer = deps.setTimer(() => {
          timer = null;
          if (closed) return;
          current?.close();
          current = make();
          current.show();
        }, settledAt - now);
      },
      close() {
        closed = true;
        if (timer !== null) deps.clearTimer(timer);
        timer = null;
        current?.close();
      },
      on(event: string, listener: (...a: never[]) => void) {
        handlers.push([event, listener]);
        return this;
      },
    } as NativeNotification;
  };
}
