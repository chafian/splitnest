// Decides when an agent's state change becomes a notification, and where it goes. No DOM and no
// timers of its own (both injected), so every rule is unit tested.
//
// Events (from what the agent itself reports; estimated "may need you" only if enabled):
// - needs you (permission / question / sign-in / unspecified): when it starts waiting, or the
//   reason changes. The same report repeated notifies once. When the agent moves on, its notice
//   is withdrawn.
// - finished: the agent reported `done`. Real runs (Claude Code 2.1.316, Codex 0.166.0) report
//   `done` at the end of a turn; Codex replaces it with `idle` within a second, so the event is
//   latched when `done` arrives, not read later. It is held for DONE_SETTLE_MS and dropped if the
//   agent starts working (or waits for you) again in that time. `working → idle` alone is never
//   "finished": Codex does exactly that while it starts up.
// - error: the agent reported `error`.
//
// Where: nothing while the user is looking at that tab (window focused, tab on screen). With the
// window focused but another tab, workspace or Settings shown: an in-app notice. With the window
// in the background or minimized: a Windows notification, but only for an agent whose identity is
// confirmed (see AgentView.confirmed); an unconfirmed "needs you" waits for confirmation, other
// unconfirmed events fall back to the in-app notice.
//
// Inbox: the same events, kept as a list of what is still waiting for the user, whatever became
// of the notice (shown, dismissed, suppressed because the tab was on screen).
// - needs you: listed from the moment the agent waits until it moves on or exits. Looking at the
//   tab doesn't remove it: the agent is still blocked.
// - finished / error: listed until the user looks at the tab, or the agent works again.
// Order: needs you first, then errors, then finished; within each, the longest-waiting first.
import { isNeedsKind, kindEnabled, type NoticeKind } from '../../../shared/notifications';
import type { AppSettings } from '../../../shared/types';
import type { AgentView } from '../terminal/agent-status';

export const DONE_SETTLE_MS = 1500;

export type NotifySettings = Pick<AppSettings, 'notifyNeedsYou' | 'notifyFinished' | 'notifyErrors' | 'notifyEstimated' | 'notifyWindows'>;

export interface AgentEvent {
  tabId: string;
  workspaceId: string;
  kind: NoticeKind;
  /** The agent's view when the event happened. */
  view: AgentView;
}

export type Where = 'in-app' | 'windows';

/** One agent waiting for the user (see "Inbox" above). */
export interface InboxItem {
  tabId: string;
  workspaceId: string;
  kind: NoticeKind;
  /** When it started waiting (ms since epoch). */
  since: number;
  /** The agent's view when the event happened. */
  view: AgentView;
}

const inboxRank = (kind: NoticeKind): number => (isNeedsKind(kind) ? 0 : kind === 'error' ? 1 : 2);

/** Needs you, then errors, then finished; the longest-waiting first within each. */
export function sortInbox(items: readonly InboxItem[]): InboxItem[] {
  return [...items].sort((a, b) => inboxRank(a.kind) - inboxRank(b.kind) || a.since - b.since || a.tabId.localeCompare(b.tabId));
}

/**
 * The item the "next agent" shortcut opens: the first in order, or, when the tab on screen is
 * itself in the list, the one after it (wrapping), so repeated presses walk through all of them.
 * Null when nothing else is waiting.
 */
export function nextInboxItem(items: readonly InboxItem[], onScreenTabId: string | null): InboxItem | null {
  const sorted = sortInbox(items);
  const at = onScreenTabId === null ? -1 : sorted.findIndex((i) => i.tabId === onScreenTabId);
  if (at === -1) return sorted[0] ?? null;
  return sorted.length > 1 ? sorted[(at + 1) % sorted.length]! : null;
}

export interface NotifierDeps {
  settings(): NotifySettings;
  /** The window is focused and this tab is on screen. */
  looking(tabId: string): boolean;
  /** SplitNest's window is focused (and not minimized). */
  windowFocused(): boolean;
  deliver(event: AgentEvent, where: Where): void;
  /** Remove this tab's notices (in-app and Windows). */
  withdraw(tabId: string): void;
  setTimer(fn: () => void, ms: number): unknown;
  clearTimer(handle: unknown): void;
  /** Clock for inbox items (default Date.now). */
  now?(): number;
  /** The inbox list changed. */
  inboxChanged?(): void;
}

/** The event a view stands for, or null (working, idle). */
export function noticeKindOf(v: AgentView): NoticeKind | null {
  if (v.state === 'needs-action') return v.source === 'heuristic' ? 'maybe' : (v.kind ?? 'needs-you');
  if (v.state === 'done') return 'done';
  if (v.state === 'error') return 'error';
  return null;
}

interface TabState {
  workspaceId: string;
  view: AgentView | null;
  /** The "needs you" reason already handled (notified, suppressed, or seen); null when not waiting. */
  needsHandled: NoticeKind | null;
  doneTimer: unknown;
  /** The kind of this tab's notice that is up (in-app or Windows), or null. */
  live: NoticeKind | null;
  /** This tab's inbox item, or null. */
  pending: InboxItem | null;
}

export class AgentNotifier {
  private readonly tabs = new Map<string, TabState>();

  constructor(private readonly deps: NotifierDeps) {}

  /** The tab's current agent view (null: no agent, or the tab is gone). */
  update(tabId: string, workspaceId: string, view: AgentView | null): void {
    let t = this.tabs.get(tabId);
    if (!t) {
      if (!view) return;
      t = { workspaceId, view: null, needsHandled: null, doneTimer: null, live: null, pending: null };
      this.tabs.set(tabId, t);
    }
    const prev = t.view;
    t.view = view;
    t.workspaceId = workspaceId;
    if (!view) {
      // The agent exited. It no longer waits for anything, but a "finished" (pending or shown) or
      // an error stays until the user looks at the tab: an agent that finishes and exits at once
      // (Claude Code's `clear` came 1 s after `done` in a real run) has still finished.
      t.needsHandled = null;
      if (t.live !== null && isNeedsKind(t.live)) this.withdraw(tabId, t);
      if (t.pending && isNeedsKind(t.pending.kind)) this.setPending(tabId, t, null);
      this.dropIfIdle(tabId, t);
      return;
    }
    const kind = noticeKindOf(view);
    const prevKind = prev ? noticeKindOf(prev) : null;
    // Working (or waiting) again within the settle time: it did not finish after all.
    if (t.doneTimer !== null && (view.state === 'working' || view.state === 'needs-action')) this.cancelDone(t);
    if (kind !== null && isNeedsKind(kind)) {
      // Blocked on the user: in the inbox whether or not a notice goes out (and while they look).
      if (t.pending?.kind !== kind && kindEnabled(kind, this.deps.settings())) this.setPending(tabId, t, kind, view);
      if (t.needsHandled !== kind && this.fire(tabId, t, kind, view)) t.needsHandled = kind;
      return;
    }
    // Not waiting any more; and an agent that works again has not "finished" or "failed" any longer.
    if (t.pending && (isNeedsKind(t.pending.kind) || view.state === 'working')) this.setPending(tabId, t, null);
    if (t.needsHandled !== null) {
      // It no longer waits for the user (answered elsewhere, or it moved on): withdraw.
      t.needsHandled = null;
      this.withdraw(tabId, t);
    }
    if (kind === 'done' && prevKind !== 'done') {
      this.cancelDone(t);
      const at = view;
      t.doneTimer = this.deps.setTimer(() => {
        t.doneTimer = null;
        if (this.tabs.get(tabId) !== t) return;
        this.note(tabId, t, 'done', at);
        this.fire(tabId, t, 'done', at);
        this.dropIfIdle(tabId, t);
      }, DONE_SETTLE_MS);
    } else if (kind === 'error' && prevKind !== 'error') {
      this.note(tabId, t, 'error', view);
      this.fire(tabId, t, 'error', view);
    }
  }

  /** Tabs that no longer exist (closed, or their workspace removed): everything about them goes. */
  retain(tabIds: ReadonlySet<string>): void {
    for (const [id, t] of [...this.tabs]) {
      if (tabIds.has(id)) continue;
      this.cancelDone(t);
      this.withdraw(id, t);
      this.tabs.delete(id);
      if (t.pending) this.deps.inboxChanged?.();
    }
  }

  /** What is waiting for the user, in inbox order. */
  inbox(): InboxItem[] {
    return sortInbox([...this.tabs.values()].flatMap((t) => (t.pending ? [t.pending] : [])));
  }

  /** The user may be looking at tabs now (focus came back, a tab or workspace was selected). */
  reviewSeen(): void {
    for (const [id, t] of [...this.tabs]) {
      const looking = this.deps.looking(id);
      if (t.live !== null && looking) this.withdraw(id, t);
      // Seen: a finished turn or an error leaves the inbox. A blocked agent stays (it is still blocked).
      if (looking && t.pending && !isNeedsKind(t.pending.kind)) this.setPending(id, t, null);
      this.dropIfIdle(id, t);
    }
  }

  /** The user dismissed or followed this tab's notice. */
  dismissed(tabId: string): void {
    const t = this.tabs.get(tabId);
    if (!t) return;
    t.live = null;
    this.dropIfIdle(tabId, t);
  }

  dispose(): void {
    for (const t of this.tabs.values()) this.cancelDone(t);
    this.tabs.clear();
  }

  /** A finished turn or an error enters the inbox unless the user is looking at it right now. */
  private note(tabId: string, t: TabState, kind: NoticeKind, view: AgentView): void {
    if (kindEnabled(kind, this.deps.settings()) && !this.deps.looking(tabId)) this.setPending(tabId, t, kind, view);
  }

  private setPending(tabId: string, t: TabState, kind: NoticeKind | null, view?: AgentView): void {
    if (kind === null && t.pending === null) return;
    t.pending = kind === null || !view ? null : { tabId, workspaceId: t.workspaceId, kind, since: (this.deps.now ?? Date.now)(), view };
    this.deps.inboxChanged?.();
  }

  /** Returns false only when a "needs you" event must wait (unconfirmed agent, window in the background). */
  private fire(tabId: string, t: TabState, kind: NoticeKind, view: AgentView): boolean {
    const s = this.deps.settings();
    if (!kindEnabled(kind, s)) return true;
    if (this.deps.looking(tabId)) return true;
    let where: Where = 'in-app';
    if (!this.deps.windowFocused() && s.notifyWindows) {
      if (view.confirmed) where = 'windows';
      else if (isNeedsKind(kind)) return false;
    }
    this.deps.deliver({ tabId, workspaceId: t.workspaceId, kind, view }, where);
    t.live = kind;
    return true;
  }

  private withdraw(tabId: string, t: TabState): void {
    if (t.live === null) return;
    t.live = null;
    this.deps.withdraw(tabId);
  }

  /** A tab whose agent exited is kept only while something of it is pending or shown. */
  private dropIfIdle(tabId: string, t: TabState): void {
    if (t.view === null && t.doneTimer === null && t.live === null && t.pending === null) this.tabs.delete(tabId);
  }

  private cancelDone(t: TabState): void {
    if (t.doneTimer !== null) this.deps.clearTimer(t.doneTimer);
    t.doneTimer = null;
  }
}
