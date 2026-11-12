// Connects the AgentNotifier to the app: agent views from the terminal registry, what is on
// screen, the in-app notice, and Windows notifications through main.
import { useEffect, useRef, useState } from 'react';
import { findPaneOfTab, listTerminalTabs } from '../../../shared/layout';
import { noticeBody, noticeTitle, type NoticeTarget } from '../../../shared/notifications';
import type { AppSettings, Workspace } from '../../../shared/types';
import { api } from '../../api';
import { registry } from '../terminal/terminal-registry';
import { AgentNotifier, type AgentEvent, type InboxItem } from './agent-notifier';

export interface AgentNotificationOptions {
  workspaces: Workspace[];
  settings: AppSettings;
  registryVersion: number;
  /** Changes whenever what is on screen may have changed (view, workspace, tab, maximised pane). */
  screenKey: string;
  /** The tab is on screen in SplitNest (selected in its pane, in the shown workspace, not hidden). */
  tabOnScreen(tabId: string): boolean;
  showNotice(key: string, title: string, body: string, onShow: () => void): void;
  removeNotice(key: string): void;
  /** Bring this tab to the front (from a notice's Show button or a Windows notification). */
  showTab(tabId: string): void;
  openNotificationSettings(): void;
}

// Main's view of the window (see AppApi.windowFocused): the page's own document.hasFocus() stays
// true while the window is minimized or behind another program.
const windowFocused = () => api.windowFocused();

export function useAgentNotifications(o: AgentNotificationOptions): { dismissed(key: string): void; inbox: InboxItem[] } {
  const ref = useRef(o);
  ref.current = o;
  const notifier = useRef<AgentNotifier | null>(null);
  const [inbox, setInbox] = useState<InboxItem[]>([]);

  if (!notifier.current) {
    const inApp = (e: AgentEvent) => {
      const c = ref.current;
      const ws = c.workspaces.find((w) => w.id === e.workspaceId);
      const tab = ws ? listTerminalTabs(ws.layout).find((t) => t.id === e.tabId) : undefined;
      const title = noticeTitle(e.kind, e.view.label);
      const body = noticeBody({
        workspace: ws?.name ?? null,
        tabName: tab?.name ?? null,
        label: e.view.label,
        details: c.settings.notifyDetails,
        session: e.view.title,
        message: e.view.message,
      });
      c.showNotice(e.tabId, title, body, () => ref.current.showTab(e.tabId));
    };
    notifier.current = new AgentNotifier({
      settings: () => ref.current.settings,
      looking: (tabId) => windowFocused() && ref.current.tabOnScreen(tabId),
      windowFocused,
      deliver: (e, where) => {
        if (where === 'in-app') {
          inApp(e);
          return;
        }
        const details = ref.current.settings.notifyDetails;
        void api
          .notifyAgent({
            workspaceId: e.workspaceId,
            tabId: e.tabId,
            kind: e.kind,
            agent: e.view.id,
            app: e.view.id ? null : e.view.label,
            // What the agent wrote never leaves the page unless the user allows it.
            details,
            session: details ? e.view.title : null,
            message: details ? e.view.message : null,
          })
          .then((r) => {
            if (r === 'in-app') inApp(e);
          })
          .catch(() => inApp(e));
      },
      withdraw: (tabId) => {
        api.withdrawNotifications([tabId]);
        ref.current.removeNotice(tabId);
      },
      setTimer: (fn, ms) => window.setTimeout(fn, ms),
      clearTimer: (h) => window.clearTimeout(h as number),
      inboxChanged: () => setInbox(notifier.current?.inbox() ?? []),
    });
  }

  // Agent state changes (the registry notifies on any terminal snapshot change).
  useEffect(() => {
    const n = notifier.current!;
    const present = new Set<string>();
    for (const ws of o.workspaces) {
      for (const tab of listTerminalTabs(ws.layout)) {
        present.add(tab.id);
        n.update(tab.id, ws.id, registry.get(tab.id)?.getSnapshot().agent ?? null);
      }
    }
    n.retain(present);
  }, [o.registryVersion, o.workspaces]);

  // The user may now be looking at a tab with a notice: withdraw it.
  useEffect(() => {
    notifier.current!.reviewSeen();
  }, [o.screenKey]);
  useEffect(() => {
    const review = () => notifier.current!.reviewSeen();
    const offFocus = api.onWindowFocus((focused) => {
      if (focused) review();
    });
    const off = api.onNotificationActivate((target: NoticeTarget) => {
      if ('settings' in target) {
        ref.current.openNotificationSettings();
        return;
      }
      // Only tabs that still exist; the ids come back from main as they were sent.
      const ws = ref.current.workspaces.find((w) => w.id === target.workspaceId);
      if (ws && findPaneOfTab(ws.layout, target.tabId)) ref.current.showTab(target.tabId);
    });
    return () => {
      offFocus();
      off();
      notifier.current?.dispose();
      api.withdrawNotifications();
    };
  }, []);

  return { dismissed: (key) => notifier.current?.dismissed(key), inbox };
}
