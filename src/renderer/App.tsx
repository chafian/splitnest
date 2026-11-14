import { useCallback, useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState, useSyncExternalStore } from 'react';
import { cleanTitle, RESUME_LABEL, type AgentResume } from '../shared/agent-resume';
import { activeTab, findPane, findPaneOfTab, listFileTabs, listPanes, listTabs, listTerminalTabs, neighborPane, type FocusDirection } from '../shared/layout';
import { PRODUCT } from '../shared/product';
import { isFileTab, isTerminalTab, LIMITS, type GitStatus, type LoadStateResult, type ShellDiscovery, type SplitDirection, type Workspace } from '../shared/types';
import { api } from './api';
import { CommandPalette, type PaletteCommand } from './components/CommandPalette';
import { ConfirmDialog, type ConfirmRequest } from './components/Dialog';
import { setConfirmHandler } from './components/confirm-service';
import { Icon } from './components/Icon';
import { RenameDialog } from './components/RenameDialog';
import { SettingsView, type SettingsSection } from './features/settings/SettingsView';
import { ShortcutsDialog } from './components/ShortcutsDialog';
import { TitleBar } from './components/TitleBar';
import { Toasts, type Toast } from './components/Toasts';
import { wslGuidance } from './components/ProfileMenu';
import { matchShortcut, shortcutLabel, type CommandId } from './features/commands/shortcuts';
import { BulkStartTracker, startAll } from './features/terminal/bulk-start';
import { registry } from './features/terminal/terminal-registry';
import { applyThemeVars, resolveTheme } from './features/appearance/themes';
import { editors } from './features/editor/editor-registry';
import { focusTab } from './features/terminal/tab-focus';
import type { PaneLeaf } from '../shared/types';

const isFileTabActive = (pane: PaneLeaf) => isFileTab(activeTab(pane));
import { terminalPathText } from './features/explorer/paths';
import { flushSave, onSaveError, scheduleSave } from './features/workspaces/persistence';
import { computeChrome, toggleExplorer, toggleFocusMode, toggleSidebar } from './features/workspaces/chrome';
import { effectiveMaximized } from './features/workspaces/maximize';
import { useAgentNotifications } from './features/notifications/useAgentNotifications';
import { UpdateNotices, useUpdateStatus, WhatsNewNotice } from './features/updates/UpdateNotices';
import { whatsNewDecision } from './features/updates/whats-new';
import { bugReportUrl, DISCUSSIONS_URL, FEATURE_REQUEST_URL } from './features/feedback/links';
import { nextInboxItem } from './features/notifications/agent-notifier';
import type { InboxRow } from './features/notifications/AgentInbox';
import { noticeBody, noticeTitle } from '../shared/notifications';
import { Sidebar } from './features/workspaces/Sidebar';
import { WorkspaceView } from './features/workspaces/WorkspaceView';
import { WelcomeGuide } from './features/workspaces/WelcomeGuide';
import { NewTaskDialog, type NewTaskChoice } from './features/tasks/NewTaskDialog';
import { ReviewDialog } from './features/tasks/ReviewDialog';
import { taskShells } from './features/tasks/task-text';
import { FinishTaskDialog, type FinishOutcome } from './features/tasks/FinishTaskDialog';
import type { TaskError, TaskProgress } from '../shared/tasks';
import { canAddPane, canAddTab, initialState, reducer } from './features/workspaces/workspace-state';

const uid = () => crypto.randomUUID();
const samePath = (a: string, b: string) => a.replace(/[\\/]+$/, '').toLowerCase() === b.replace(/[\\/]+$/, '').toLowerCase();

// Loaded once per page, independent of React's development double-invocation.
let boot: Promise<[LoadStateResult, ShellDiscovery]> | null = null;
const loadOnce = () => (boot ??= Promise.all([api.loadState(), api.listShells()]));

const NO_GIT: ReadonlyMap<string, GitStatus> = new Map();

export function App() {
  const [state, dispatch] = useReducer(reducer, initialState);
  const [loaded, setLoaded] = useState(false);
  const [discovery, setDiscovery] = useState<ShellDiscovery | null>(null);
  const [freshTabs] = useState(() => new Set<string>());
  const [startOnRestore, setStartOnRestore] = useState(false);
  const [missing, setMissing] = useState<Set<string>>(() => new Set());
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [paletteOpen, setPaletteOpen] = useState(false);
  // Settings is a page in the main area (not a modal). While "shown" it has a row in the sidebar
  // under the workspaces; `view` says whether that page or the active workspace is on screen.
  const [settingsShown, setSettingsShown] = useState(false);
  const [view, setView] = useState<'workspace' | 'settings'>('workspace');
  const [settingsSection, setSettingsSection] = useState<SettingsSection>('appearance');
  const openSettings = () => {
    setSettingsShown(true);
    setView('settings');
  };
  const closeSettings = () => {
    setSettingsShown(false);
    setView('workspace');
  };
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [renameId, setRenameId] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<ConfirmRequest | null>(null);
  const [searchPaneId, setSearchPaneId] = useState<string | null>(null);
  const [explorerFocus, setExplorerFocus] = useState(0);
  // Tabs that came from the saved layout (not created in this session). They
  // stay unstarted until the user starts them; the restore notice tracks them.
  const [restoredTabs, setRestoredTabs] = useState<ReadonlySet<string>>(() => new Set());
  const [dismissedNotices, setDismissedNotices] = useState<ReadonlySet<string>>(() => new Set());
  const [bulkProgress, setBulkProgress] = useState<Record<string, { total: number; settled: number }>>({});
  const bulkStarts = useRef(new BulkStartTracker());
  const [renamingTabId, setRenamingTabId] = useState<string | null>(null);
  const [windowWidth, setWindowWidth] = useState(() => window.innerWidth);
  /** Terminal tab last focused in each workspace (target for inserted paths). */
  const lastTerminal = useRef(new Map<string, string>());
  /** Maximised pane per workspace (session only; the split tree itself is untouched). */
  const [maximized, setMaximized] = useState<Record<string, string>>({});
  const stateRef = useRef(state);
  stateRef.current = state;
  const registryVersion = useSyncExternalStore(registry.subscribe, registry.getVersion);
  /** Git branch and changed lines per workspace (main checks; see src/main/git-status.ts). */
  const [gitStatuses, setGitStatuses] = useState<ReadonlyMap<string, GitStatus>>(() => new Map());
  /** Agent tasks: the workspace the New task dialog is open for, and each task's commits against its base. */
  const [taskFor, setTaskFor] = useState<string | null>(null);
  /** The task workspace whose Review dialog is open. */
  const [reviewFor, setReviewFor] = useState<string | null>(null);
  /** The task workspace whose Finish dialog is open. */
  const [finishFor, setFinishFor] = useState<string | null>(null);
  /** Re-render after saving editors from Finish (their dirty state lives outside React). */
  const [, setEditorsSaved] = useState(0);
  const [taskProgress, setTaskProgress] = useState<ReadonlyMap<string, TaskProgress>>(() => new Map());

  const progressFor = useRef(new Map<string, GitStatus | undefined>());
  useEffect(() => {
    for (const w of state.workspaces) {
      if (!w.task) continue;
      const status = gitStatuses.get(w.id);
      if (progressFor.current.has(w.id) && progressFor.current.get(w.id) === status) continue;
      progressFor.current.set(w.id, status);
      void api.taskProgress(w.id).then((r) => {
        if (r.ok) setTaskProgress((m) => new Map(m).set(w.id, r.progress));
      });
    }
  }, [state.workspaces, gitStatuses]);
  // Also when a task is selected: a commit leaves the folder as clean as before, so its Git status
  // (above) doesn't change, but the number of commits does.
  useEffect(() => {
    const w = state.workspaces.find((x) => x.id === state.activeWorkspaceId);
    if (!w?.task) return;
    const id = w.id;
    void api.taskProgress(id).then((r) => {
      if (r.ok) setTaskProgress((m) => new Map(m).set(id, r.progress));
    });
    // Only on selection; the effect above follows Git status changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.activeWorkspaceId]);

  const toastSeq = useRef(0);
  const pushToast = useCallback((kind: Toast['kind'], message: string, detail?: string) => {
    const id = ++toastSeq.current;
    setToasts((t) => [...t.slice(-3), { id, kind, message, detail }]);
    if (kind === 'info') setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 6000);
  }, []);

  // ------------------------------------------------------------ loading

  // "Resume agents automatically" (read once at start-up): each workspace's restored agent terminals
  // resume the first time that workspace is shown (its terminals exist from then on).
  const resumeOnOpen = useRef(false);
  const autoResumed = useRef(new Set<string>());
  useEffect(() => {
    const id = state.activeWorkspaceId;
    if (!loaded || !resumeOnOpen.current || !id || autoResumed.current.has(id)) return;
    autoResumed.current.add(id);
    setTimeout(() => startAllRestored(id, true), 0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loaded, state.activeWorkspaceId]);

  useEffect(() => {
    let cancelled = false;
    onSaveError((error) => pushToast('error', 'Workspace state could not be saved.', error.message));
    loadOnce().then(
      ([result, shells]) => {
        if (cancelled) return;
        setDiscovery(shells);
        setStartOnRestore(result.state.settings.startShellsOnRestore);
        resumeOnOpen.current = result.state.settings.resumeAutomatically;
        if (!result.state.settings.startShellsOnRestore) {
          setRestoredTabs(new Set(result.state.workspaces.flatMap((w) => listTerminalTabs(w.layout).map((t) => t.id))));
        } else {
          // Fresh shells everywhere, except where an agent was running: those terminals offer Resume
          // (or resume by themselves with "Resume agents automatically").
          setRestoredTabs(new Set(result.state.workspaces.flatMap((w) => listTerminalTabs(w.layout).filter((t) => t.resume).map((t) => t.id))));
        }
        dispatch({ type: 'load', state: result.state });
        setLoaded(true);
        if (result.notice) {
          pushToast(
            'warning',
            result.notice.kind === 'recovered-corrupt'
              ? 'Saved workspaces could not be read, so the app started empty.'
              : 'Saved workspaces came from an unsupported version, so the app started empty.',
            `The original file was kept at ${result.notice.backupPath}`,
          );
        }
      },
      () => {
        if (cancelled) return;
        setLoaded(true);
        pushToast('error', 'Starting up failed. Workspaces could not be loaded.');
      },
    );
    return () => {
      cancelled = true;
    };
  }, [pushToast]);

  // Layout effect so the save is queued in the same commit that adds a pane;
  // a pane's first session request flushes it before asking main to start.
  useLayoutEffect(() => {
    if (loaded) scheduleSave(state);
  }, [state, loaded]);

  // Git status: what main has so far, then every change it reports.
  useEffect(() => {
    let cancelled = false;
    const off = api.onGitStatus(({ workspaceId, status }) => {
      setGitStatuses((prev) => {
        const next = new Map(prev);
        if (status) next.set(workspaceId, status);
        else next.delete(workspaceId);
        return next;
      });
    });
    void api.getGitStatuses().then((all) => {
      if (!cancelled) setGitStatuses((prev) => new Map([...Object.entries(all), ...prev]));
    });
    return () => {
      cancelled = true;
      off();
    };
  }, []);

  // The user looks at a workspace: its Git state is checked now (main limits how often).
  useEffect(() => {
    if (loaded && state.settings.showGitStatus && state.activeWorkspaceId) api.refreshGit(state.activeWorkspaceId);
  }, [loaded, state.activeWorkspaceId, state.settings.showGitStatus]);

  useEffect(() => {
    registry.applySettings({ fontSize: state.settings.fontSize, scrollback: state.settings.scrollback, shortPrompt: state.settings.shortPromptPaths });
  }, [state.settings.fontSize, state.settings.scrollback, state.settings.shortPromptPaths]);

  // A maximised pane that closed or lost focus ends for good (refocusing it later must not re-maximise it).
  useEffect(() => {
    const stale = Object.keys(maximized).filter((id) => {
      const ws = state.workspaces.find((w) => w.id === id);
      return !ws || effectiveMaximized(ws, maximized[id]) === null;
    });
    if (stale.length === 0) return;
    setMaximized((m) => {
      const next = { ...m };
      for (const id of stale) delete next[id];
      return next;
    });
  }, [state.workspaces, maximized]);

  useEffect(() => {
    setConfirmHandler(setConfirm);
    return () => setConfirmHandler(null);
  }, []);

  useEffect(() => {
    const onResize = () => setWindowWidth(window.innerWidth);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  const folderKey =state.workspaces.map((w) => `${w.id}=${w.rootPath}`).join('|');
  const recheckFolders = useCallback(async () => {
    await flushSave();
    const results = await Promise.all(
      stateRef.current.workspaces.map(async (w) => [w.id, (await api.checkFolder(w.id)).exists] as const),
    );
    setMissing(new Set(results.filter(([, exists]) => !exists).map(([id]) => id)));
  }, []);
  useEffect(() => {
    if (loaded) void recheckFolders();
  }, [loaded, folderKey, state.activeWorkspaceId, recheckFolders]);

  // ------------------------------------------------------------ derived

  const effectiveDefault = useMemo(() => {
    const profiles = discovery?.profiles ?? [];
    if (state.settings.defaultProfileId && profiles.some((p) => p.id === state.settings.defaultProfileId)) {
      return state.settings.defaultProfileId;
    }
    return discovery?.fallbackProfileId ?? null;
  }, [discovery, state.settings.defaultProfileId]);
  const defaultRef = useRef(effectiveDefault);
  defaultRef.current = effectiveDefault;

  const liveCounts = useMemo(() => {
    void registryVersion;
    return new Map(state.workspaces.map((w) => [w.id, registry.runningCount(listTerminalTabs(w.layout).map((t) => t.id))]));
  }, [state.workspaces, registryVersion]);

  const agentCounts = useMemo(() => {
    void registryVersion;
    return new Map(state.workspaces.map((w) => [w.id, registry.agentCounts(listTerminalTabs(w.layout).map((t) => t.id))]));
  }, [state.workspaces, registryVersion]);
  const agentsNeedingYou = [...agentCounts.values()].reduce((n, c) => n + c.needs, 0);

  const activeWorkspace = state.workspaces.find((w) => w.id === state.activeWorkspaceId) ?? null;
  const chrome = computeChrome(state.settings, windowWidth, !!activeWorkspace);

  // The taskbar / Alt+Tab label follows the active workspace.
  useEffect(() => {
    // "(1) car-rental — SplitNest" in the taskbar when an agent is waiting for you anywhere.
    const page = view === 'settings' ? 'Settings' : activeWorkspace?.name;
    const base = page ? `${page} — ${PRODUCT.name}` : PRODUCT.name;
    document.title = agentsNeedingYou > 0 ? `(${agentsNeedingYou}) ${base}` : base;
  }, [activeWorkspace, agentsNeedingYou, view]);
  // Appearance: the theme on screen. "Match system" follows Windows' app mode live.
  const [systemDark, setSystemDark] = useState(() => window.matchMedia('(prefers-color-scheme: dark)').matches);
  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = (e: MediaQueryListEvent) => setSystemDark(e.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);
  const theme = resolveTheme(state.settings.themeMode, state.settings.darkTheme, systemDark);
  useLayoutEffect(() => {
    applyThemeVars(theme);
    registry.applyTheme(theme);
    api.setWindowTheme({ background: theme.ui.bg, titleBar: theme.ui.side, symbol: theme.ui.titlebarSymbol });
  }, [theme]);

  // Switching workspace (sidebar, palette, shortcuts) always shows that workspace.
  useEffect(() => setView('workspace'), [state.activeWorkspaceId]);
  const anyDialogOpen = paletteOpen || shortcutsOpen || !!renameId || !!confirm || !!renamingTabId || !!taskFor || !!reviewFor || !!finishFor;

  // Keep keyboard focus on the active pane's active tab.
  const activePaneId = activeWorkspace?.activePaneId ?? null;
  const activePane = activeWorkspace && activePaneId ? findPane(activeWorkspace.layout, activePaneId) : null;
  const activeTabId = activePane ? activeTab(activePane).id : null;
  useEffect(() => {
    // Not while the settings page is shown: its controls keep the focus.
    if (!activeTabId || anyDialogOpen || view === 'settings' || searchPaneId === activePaneId) return;
    // Never pull focus out of the explorer, a tab strip, a menu or a control the user is using.
    if (document.activeElement?.closest('.explorer, [role="tablist"], .menu, .notice, input, select, .panel-handle')) return;
    const frame = requestAnimationFrame(() => focusTab(activeTabId));
    return () => cancelAnimationFrame(frame);
  }, [activeTabId, activePaneId, state.activeWorkspaceId, anyDialogOpen, searchPaneId, view]);

  // ------------------------------------------------------------ actions

  const getActive = (): Workspace | null => {
    const s = stateRef.current;
    return s.workspaces.find((w) => w.id === s.activeWorkspaceId) ?? null;
  };

  const addWorkspace = async () => {
    const picked = await api.pickFolder();
    if (!picked) return;
    const existing = stateRef.current.workspaces.find((w) => samePath(w.rootPath, picked.path));
    if (existing) {
      dispatch({ type: 'activateWorkspace', workspaceId: existing.id });
      pushToast('info', `That folder is already open as “${existing.name}”.`);
      return;
    }
    if (stateRef.current.workspaces.length >= LIMITS.maxWorkspaces) {
      pushToast('warning', `At most ${LIMITS.maxWorkspaces} workspaces are supported.`);
      return;
    }
    const workspaceId = uid();
    dispatch({
      type: 'addWorkspace',
      workspace: { id: workspaceId, name: picked.suggestedName, rootPath: picked.path, layout: null, activePaneId: null },
    });
    const profileId = defaultRef.current;
    if (profileId) {
      const paneId = uid();
      const tabId = uid();
      freshTabs.add(tabId);
      dispatch({ type: 'addPane', workspaceId, paneId, tabId, splitId: uid(), profileId });
    }
  };

  const addPane = (workspace: Workspace, profileId: string, direction?: SplitDirection, targetPaneId?: string) => {
    if (!canAddPane(workspace)) {
      pushToast('warning', `A workspace can have at most ${LIMITS.maxPanesPerWorkspace} panes.`);
      return;
    }
    const paneId = uid();
    const tabId = uid();
    freshTabs.add(tabId);
    dispatch({ type: 'addPane', workspaceId: workspace.id, paneId, tabId, splitId: uid(), profileId, direction, targetPaneId });
  };

  const addTabTo = (workspace: Workspace, paneId: string, profileId: string) => {
    if (!canAddTab(workspace, paneId)) {
      pushToast('warning', `A pane can have at most ${LIMITS.maxTabsPerPane} tabs.`);
      return;
    }
    const tabId = uid();
    freshTabs.add(tabId);
    dispatch({ type: 'addTab', workspaceId: workspace.id, paneId, tabId, profileId });
    requestAnimationFrame(() => registry.get(tabId)?.focus());
  };

  /** New tab in the active pane (or the first pane of an empty workspace). */
  const newTerminal = (profileId?: string) => {
    const ws = getActive();
    if (!ws) {
      void addWorkspace();
      return;
    }
    const id = profileId ?? defaultRef.current;
    if (!id) {
      pushToast('error', 'No shell is available. Install PowerShell or check Settings.');
      return;
    }
    const pane = ws.activePaneId ? findPane(ws.layout, ws.activePaneId) : listPanes(ws.layout)[0];
    if (pane) addTabTo(ws, pane.id, id);
    else addPane(ws, id);
  };

  const split = (paneId: string | null, direction: SplitDirection, profileId?: string) => {
    const ws = getActive();
    if (!ws) return;
    const target = paneId ?? ws.activePaneId;
    const pane = target ? findPane(ws.layout, target) : null;
    if (!pane) {
      newTerminal(profileId);
      return;
    }
    const current = activeTab(pane);
    const shell = profileId ?? (isTerminalTab(current) ? current.profileId : defaultRef.current);
    if (!shell) {
      pushToast('error', 'No shell is available. Install PowerShell or check Settings.');
      return;
    }
    addPane(ws, shell, direction, pane.id);
  };

  /**
   * Saves the dirty editors among `tabIds`, then runs `then`. If any save
   * fails, nothing is closed: the affected tab shows why and keeps its text.
   */
  const saveThen = async (tabIds: string[], then: () => void) => {
    const dirty = tabIds.map((id) => editors.get(id)).filter((e) => e?.isDirty);
    const results = await Promise.all(dirty.map((e) => e!.save()));
    if (results.every(Boolean)) {
      then();
      return;
    }
    const failed = dirty.filter((_, i) => !results[i]);
    const first = failed[0];
    if (first) showTab(first.tabId);
    pushToast(
      'error',
      failed.length === 1 ? `“${first?.fileName}” could not be saved, so nothing was closed.` : `${failed.length} files could not be saved, so nothing was closed.`,
      first?.getSnapshot().lastSaveError?.message,
    );
  };

  const workspaceOfTab = (tabId: string) => stateRef.current.workspaces.find((w) => findPaneOfTab(w.layout, tabId));

  const closeTab = (tabId?: string) => {
    const ws = tabId ? workspaceOfTab(tabId) : getActive();
    const pane = ws && (tabId ? findPaneOfTab(ws.layout, tabId) : ws.activePaneId ? findPane(ws.layout, ws.activePaneId) : null);
    if (!ws || !pane) return;
    const target = tabId ?? activeTab(pane).id;
    const doClose = () => {
      registry.dispose(target);
      editors.dispose(target);
      setRenamingTabId((id) => (id === target ? null : id));
      if (pane.tabs.length === 1) setSearchPaneId((id) => (id === pane.id ? null : id));
      dispatch({ type: 'closeTab', workspaceId: ws.id, tabId: target });
    };
    const editor = editors.get(target);
    if (editor?.isDirty) {
      setConfirm({
        title: 'Save changes?',
        message: `“${editor.fileName}” has unsaved changes.`,
        detail: 'Save writes them to disk before closing; Discard closes without saving. Cancel keeps the file open.',
        confirmLabel: 'Save and close',
        // A failed save (or a conflict) keeps the tab open with the edits intact.
        onConfirm: () => void saveThen([target], doClose),
        extra: { label: 'Discard', danger: true, run: doClose },
      });
    } else if (registry.get(target)?.isLive) {
      setConfirm({
        title: 'Close tab?',
        message: 'The shell in this tab is still running.',
        detail: 'Closing ends the shell and programs running in it. Other tabs and panes are not affected.',
        confirmLabel: 'End session and close',
        danger: true,
        onConfirm: doClose,
      });
    } else {
      doClose();
    }
  };

  const closePane = (paneId: string) => {
    const ws = getActive();
    const pane = ws ? findPane(ws.layout, paneId) : null;
    if (!ws || !pane) return;
    const live = registry.liveCount(pane.tabs.map((t) => t.id));
    const dirty = editors.dirtyCount(pane.tabs.map((t) => t.id));
    const doClose = () => {
      pane.tabs.forEach((t) => {
        registry.dispose(t.id);
        editors.dispose(t.id);
      });
      setRenamingTabId((id) => (id && pane.tabs.some((t) => t.id === id) ? null : id));
      setSearchPaneId((id) => (id === pane.id ? null : id));
      dispatch({ type: 'removePane', workspaceId: ws.id, paneId: pane.id });
    };
    if (live > 0 || dirty > 0) {
      setConfirm({
        title: 'Close pane?',
        message: [
          live > 0 ? (live === 1 ? 'A shell in this pane is still running.' : `${live} shells in this pane are still running.`) : '',
          dirty > 0 ? (dirty === 1 ? 'A file in this pane has unsaved changes.' : `${dirty} files in this pane have unsaved changes.`) : '',
        ]
          .filter(Boolean)
          .join(' '),
        detail:
          `Closing the pane closes all ${pane.tabs.length} of its tabs` +
          (live > 0 ? ' and ends their shells' : '') +
          '. Other panes are not affected.' +
          (dirty > 0 ? ' Save writes the unsaved files first; Discard drops their changes.' : ''),
        ...(dirty > 0
          ? {
              confirmLabel: live > 0 ? 'Save, end sessions and close' : 'Save and close',
              onConfirm: () => void saveThen(pane.tabs.map((t) => t.id), doClose),
              extra: { label: 'Discard and close', danger: true, run: doClose },
            }
          : { confirmLabel: 'End sessions and close', danger: true, onConfirm: doClose }),
      });
    } else {
      doClose();
    }
  };

  const restartTab = (tabId?: string) => {
    const ws = tabId ? workspaceOfTab(tabId) : getActive();
    const pane = ws && (tabId ? findPaneOfTab(ws.layout, tabId) : ws.activePaneId ? findPane(ws.layout, ws.activePaneId) : null);
    if (!pane) return;
    const tab = pane.tabs.find((t) => t.id === (tabId ?? pane.activeTabId)) ?? activeTab(pane);
    const controller = registry.get(tab.id);
    if (!controller || !isTerminalTab(tab)) return;
    if (controller.getSnapshot().status === 'running') {
      setConfirm({
        title: 'Restart shell?',
        message: 'The shell in this tab is still running.',
        detail: 'Restarting ends it, including any program running in it, and starts a fresh shell.',
        confirmLabel: 'Restart',
        onConfirm: () => controller.restart(tab.profileId),
      });
    } else {
      controller.restart(tab.profileId);
    }
  };

  const focusPaneTerminal = (ws: Workspace, paneId: string) => {
    const pane = findPane(ws.layout, paneId);
    if (pane) focusTab(activeTab(pane).id);
  };

  /** Maximises the pane (the current one by default), or restores the layout if it already is. */
  const toggleMaximize = (paneId?: string) => {
    const ws = getActive();
    const target = paneId ?? ws?.activePaneId;
    if (!ws || !target) return;
    const current = effectiveMaximized(ws, maximized[ws.id]);
    if (current === target) {
      setMaximized((m) => {
        const next = { ...m };
        delete next[ws.id];
        return next;
      });
    } else {
      if (ws.activePaneId !== target) dispatch({ type: 'focusPane', workspaceId: ws.id, paneId: target });
      setMaximized((m) => ({ ...m, [ws.id]: target }));
    }
    requestAnimationFrame(() => focusPaneTerminal(ws, target));
  };

  const focusDirection = (direction: FocusDirection) => {
    const ws = getActive();
    if (!ws?.activePaneId) return;
    const next = neighborPane(ws.layout, ws.activePaneId, direction);
    if (next) {
      dispatch({ type: 'focusPane', workspaceId: ws.id, paneId: next });
      focusPaneTerminal(ws, next);
    }
  };

  const cycleTab = (delta: number) => {
    const ws = getActive();
    const pane = ws?.activePaneId ? findPane(ws.layout, ws.activePaneId) : null;
    if (!ws || !pane || pane.tabs.length < 2) return;
    const index = pane.tabs.findIndex((t) => t.id === pane.activeTabId);
    const next = pane.tabs[(index + delta + pane.tabs.length) % pane.tabs.length]!;
    dispatch({ type: 'activateTab', workspaceId: ws.id, tabId: next.id });
    requestAnimationFrame(() => focusTab(next.id));
  };

  const cycleWorkspace = (delta: number) => {
    const s = stateRef.current;
    if (s.workspaces.length < 2) return;
    const index = s.workspaces.findIndex((w) => w.id === s.activeWorkspaceId);
    const next = s.workspaces[(index + delta + s.workspaces.length) % s.workspaces.length];
    if (next) dispatch({ type: 'activateWorkspace', workspaceId: next.id });
  };

  const removeWorkspace = (workspaceId: string) => {
    const ws = stateRef.current.workspaces.find((w) => w.id === workspaceId);
    if (!ws) return;
    const tabIds = listTabs(ws.layout).map((t) => t.id);
    const live = registry.liveCount(tabIds);
    const dirty = editors.dirtyCount(tabIds);
    const remove = () => {
      tabIds.forEach((id) => {
        registry.dispose(id);
        editors.dispose(id);
      });
      dispatch({ type: 'removeWorkspace', workspaceId });
    };
    setConfirm({
      title: 'Remove workspace?',
      message: `Remove “${ws.name}” from ${PRODUCT.name}?`,
      detail:
        (ws.task
          ? `The task’s folder ${ws.task.worktreePath} and its branch ${ws.task.branch} are kept as they are. To merge it and delete them, use Finish task instead.`
          : `The folder ${ws.rootPath} and its files are not deleted.`) +
        (live > 0 ? ` ${live} running ${live === 1 ? 'session' : 'sessions'} in this workspace will be ended.` : '') +
        (dirty > 0 ? ` ${dirty} ${dirty === 1 ? 'file has' : 'files have'} unsaved changes: save them first, or discard them.` : ''),
      ...(dirty > 0
        ? {
            confirmLabel: 'Save and remove',
            onConfirm: () => void saveThen(tabIds, remove),
            extra: { label: 'Discard and remove', danger: true, run: remove },
          }
        : { confirmLabel: 'Remove workspace', danger: true, onConfirm: remove }),
    });
  };

  /** Opens the New agent task dialog for a workspace (preview setting on). */
  const newTask = (workspaceId: string) => {
    if (!stateRef.current.settings.agentTasks) return;
    if (stateRef.current.workspaces.length >= LIMITS.maxWorkspaces) {
      pushToast('warning', `At most ${LIMITS.maxWorkspaces} workspaces are supported, and each task is one.`);
      return;
    }
    setTaskFor(workspaceId);
  };

  /**
   * Main creates the worktree and branch; the task then opens as a workspace listed under its parent,
   * with one terminal that starts the shell and types the agent's command.
   */
  const createTask = async (parentId: string, choice: NewTaskChoice): Promise<TaskError | null> => {
    // Main checks the setting and the parent in its own copy of the state.
    await flushSave();
    const r = await api.createTask(parentId, choice.name);
    if (!r.ok) return r.error;
    const workspaceId = uid();
    dispatch({
      type: 'addWorkspace',
      after: parentId,
      workspace: {
        id: workspaceId,
        name: choice.name,
        rootPath: r.task.taskRoot,
        layout: null,
        activePaneId: null,
        task: { ...r.task, parentId, agent: choice.agent, createdAt: Date.now() },
      },
    });
    const paneId = uid();
    const tabId = uid();
    freshTabs.add(tabId);
    if (choice.agent) registry.startAgentOnCreate(tabId, choice.agent);
    dispatch({ type: 'addPane', workspaceId, paneId, tabId, splitId: uid(), profileId: choice.profileId });
    setView('workspace');
    return null;
  };

  /** Finish: the task's terminals end before its folder is deleted (main waits until none runs). */
  const endTaskTerminals = (workspaceId: string) => {
    const ws = stateRef.current.workspaces.find((w) => w.id === workspaceId);
    if (!ws) return;
    for (const t of listTerminalTabs(ws.layout)) {
      // Not "new" anymore: its pane would otherwise start a fresh shell right after this one ends.
      freshTabs.delete(t.id);
      registry.dispose(t.id);
    }
  };

  /** Finish: the task's folder is gone, so its workspace leaves the list (no question: the user just chose it). */
  const taskFinished = (workspaceId: string, outcome: FinishOutcome) => {
    const ws = stateRef.current.workspaces.find((w) => w.id === workspaceId);
    if (!ws?.task) return;
    for (const t of listTabs(ws.layout)) {
      registry.dispose(t.id);
      editors.dispose(t.id);
    }
    dispatch({ type: 'removeWorkspace', workspaceId });
    setFinishFor(null);
    const parent = stateRef.current.workspaces.find((w) => w.id === ws.task!.parentId);
    if (parent) {
      dispatch({ type: 'activateWorkspace', workspaceId: parent.id });
      api.refreshGit(parent.id);
    }
    const what = {
      merged: `“${ws.name}” was merged into ${ws.task.baseBranch}; its folder and branch were deleted.`,
      removed: `“${ws.name}” had nothing to merge; its folder and branch were deleted.`,
      'kept-branch': `The folder of “${ws.name}” was deleted; its branch ${ws.task.branch} was kept.`,
      discarded: `“${ws.name}” was discarded: its folder and branch were deleted.`,
    }[outcome];
    pushToast('info', what);
  };

  const relinkWorkspace = async (workspaceId: string) => {
    const picked = await api.pickFolder();
    if (!picked) return;
    dispatch({ type: 'relinkWorkspace', workspaceId, rootPath: picked.path });
  };

  /** Puts a quoted path at the active pane's prompt without running anything. */
  const insertPath = (workspaceId: string, relativePath: string) => {
    const ws = stateRef.current.workspaces.find((w) => w.id === workspaceId);
    if (!ws) return;
    // The current pane's terminal; otherwise the terminal used last in this workspace; otherwise any running one.
    const running = (id: string | null | undefined) => (id && registry.get(id)?.getSnapshot().status === 'running' ? id : null);
    const pane = ws.activePaneId ? findPane(ws.layout, ws.activePaneId) : null;
    const terminals = listTerminalTabs(ws.layout);
    const targetId =
      running(pane ? activeTab(pane).id : null) ??
      running(lastTerminal.current.get(ws.id)) ??
      terminals.map((t) => t.id).find((id) => running(id)) ??
      null;
    const tab = terminals.find((t) => t.id === targetId);
    const controller = targetId ? registry.get(targetId) : undefined;
    if (!tab || !controller) {
      pushToast('info', 'Start a terminal in this workspace first, then insert the path.');
      return;
    }
    const owner = findPaneOfTab(ws.layout, tab.id);
    if (owner && owner.activeTabId !== tab.id) dispatch({ type: 'activateTab', workspaceId: ws.id, tabId: tab.id });
    else if (owner) dispatch({ type: 'focusPane', workspaceId: ws.id, paneId: owner.id });
    const kind = discovery?.profiles.find((p) => p.id === tab.profileId)?.kind;
    const snap = controller.getSnapshot();
    const text = terminalPathText({
      shell: kind === 'wsl' ? 'wsl' : 'powershell',
      workspaceRoot: ws.rootPath,
      relativePath,
      linuxRoot: snap.startIn === 'workspace-root' ? snap.cwdLabel : null,
    });
    controller.insertText(text);
  };

  /**
   * Opens a workspace file in the editor. An already-open file is shown
   * again; otherwise it goes into the pane that is showing a file (current
   * pane first), or a new pane split to the right of the current one.
   */
  const openFile = (workspaceId: string, relativePath: string) => {
    const ws = stateRef.current.workspaces.find((w) => w.id === workspaceId);
    if (!ws) return;
    const existing = listFileTabs(ws.layout).find((t) => t.path.toLowerCase() === relativePath.toLowerCase());
    const show = (tabId: string) => requestAnimationFrame(() => editors.get(tabId)?.focus());
    if (existing) {
      dispatch({ type: 'activateTab', workspaceId: ws.id, tabId: existing.id });
      show(existing.id);
      return;
    }
    const tabId = uid();
    const panes = listPanes(ws.layout);
    const current = ws.activePaneId ? findPane(ws.layout, ws.activePaneId) : null;
    const editorPane = [current, ...panes].find((p) => p && isFileTabActive(p));
    if (editorPane && canAddTab(ws, editorPane.id)) {
      dispatch({ type: 'addTab', workspaceId: ws.id, paneId: editorPane.id, tabId, profileId: '', filePath: relativePath });
    } else if (!ws.layout || (current && canAddPane(ws))) {
      // Split the largest pane on screen so the editor gets usable room:
      // side by side when that pane is wide, stacked when it is tall.
      let target = current?.id;
      let direction: SplitDirection = 'row';
      let best = 0;
      for (const p of panes) {
        const r = document.querySelector(`[data-pane-id="${p.id}"]`)?.getBoundingClientRect();
        if (r && r.width * r.height > best) {
          best = r.width * r.height;
          target = p.id;
          direction = r.width >= r.height * 1.2 ? 'row' : 'column';
        }
      }
      dispatch({
        type: 'addPane',
        workspaceId: ws.id,
        paneId: uid(),
        tabId,
        splitId: uid(),
        profileId: '',
        filePath: relativePath,
        direction,
        targetPaneId: target,
      });
    } else if (current && canAddTab(ws, current.id)) {
      dispatch({ type: 'addTab', workspaceId: ws.id, paneId: current.id, tabId, profileId: '', filePath: relativePath });
    } else {
      pushToast('warning', `No room for another tab: panes are limited to ${LIMITS.maxPanesPerWorkspace} and tabs to ${LIMITS.maxTabsPerPane}.`);
      return;
    }
    show(tabId);
  };

  /** The tab's current shell selection (the user may change it before starting). */
  const tabProfile = (tabId: string): string | null => {
    for (const w of stateRef.current.workspaces) {
      const tab = findPaneOfTab(w.layout, tabId)?.tabs.find((t) => t.id === tabId);
      if (tab) return isTerminalTab(tab) ? tab.profileId : null;
    }
    return null;
  };

  /**
   * Starts a fresh shell in every restored, not-yet-started terminal of one
   * workspace (background tabs included). Running terminals are skipped,
   * concurrent individual starts are joined rather than duplicated, and one
   * failure does not affect the others.
   */
  const startAllRestored = (workspaceId: string, agentsOnly = false) => {
    void bulkStarts.current.run(workspaceId, async () => {
      const ws = stateRef.current.workspaces.find((w) => w.id === workspaceId);
      if (!ws) return;
      const targets = listTerminalTabs(ws.layout).flatMap((t) => {
        const controller = registry.get(t.id);
        if (!restoredTabs.has(t.id) || !controller || controller.getSnapshot().status !== 'idle') return [];
        const profileId = tabProfile(t.id) ?? t.profileId;
        // "Resume agents": only the terminals an agent was running in; the others stay as they are.
        const resume = t.resume ?? null;
        if (agentsOnly && !resume) return [];
        return [
          {
            tabId: t.id,
            status: () => controller.getSnapshot().status,
            start: () => (agentsOnly && resume ? controller.resume(profileId, resume) : controller.start(profileId, 'workspace-root')),
          },
        ];
      });
      if (targets.length === 0) return;
      setBulkProgress((p) => ({ ...p, [workspaceId]: { total: targets.length, settled: 0 } }));
      try {
        await startAll(targets, {
          concurrency: 3,
          onSettled: () =>
            setBulkProgress((p) => {
              const cur = p[workspaceId];
              return cur ? { ...p, [workspaceId]: { ...cur, settled: cur.settled + 1 } } : p;
            }),
        });
      } finally {
        setBulkProgress((p) => {
          const next = { ...p };
          delete next[workspaceId];
          return next;
        });
      }
    });
  };

  const retryStart = (tabId: string) => {
    const controller = registry.get(tabId);
    const profileId = tabProfile(tabId);
    if (controller && profileId) void controller.start(profileId, controller.getSnapshot().startIn);
  };

  const showTab = (tabId: string) => {
    const ws = workspaceOfTab(tabId);
    if (!ws) return;
    dispatch({ type: 'activateWorkspace', workspaceId: ws.id });
    dispatch({ type: 'activateTab', workspaceId: ws.id, tabId });
    requestAnimationFrame(() => registry.get(tabId)?.focus());
  };

  // Agent notifications: in-app notices (window focused, another tab shown) and Windows ones.
  const agentNotices = useAgentNotifications({
    workspaces: state.workspaces,
    settings: state.settings,
    registryVersion,
    screenKey: `${view}|${state.activeWorkspaceId}|${activeWorkspace ? listPanes(activeWorkspace.layout).map((p) => p.activeTabId).join(',') : ''}|${activeWorkspace ? (effectiveMaximized(activeWorkspace, maximized[activeWorkspace.id]) ?? '') : ''}`,
    tabOnScreen: (tabId) => {
      if (view !== 'workspace' || !activeWorkspace) return false;
      const pane = findPaneOfTab(activeWorkspace.layout, tabId);
      if (!pane || pane.activeTabId !== tabId) return false;
      const max = effectiveMaximized(activeWorkspace, maximized[activeWorkspace.id]);
      return !max || max === pane.id;
    },
    showNotice: (key, title, body, onShow) => {
      const id = ++toastSeq.current;
      const run = () => {
        setToasts((t) => t.filter((x) => x.id !== id));
        agentNotices.dismissed(key);
        onShow();
      };
      setToasts((t) => [...t.filter((x) => x.key !== key).slice(-3), { id, kind: 'agent', message: title, detail: body, key, action: { label: 'Show', run } }]);
    },
    removeNotice: (key) => setToasts((t) => t.filter((x) => x.key !== key)),
    showTab: (tabId) => {
      setView('workspace');
      showTab(tabId);
    },
    openNotificationSettings: () => {
      setSettingsSection('notifications');
      openSettings();
    },
  });

  // The agent inbox: what is waiting, in order, with the same wording as the notices.
  const [inboxOpen, setInboxOpen] = useState(false);
  const inboxRows: InboxRow[] = agentNotices.inbox.map((i) => {
    const ws = state.workspaces.find((w) => w.id === i.workspaceId);
    const tab = ws ? listTerminalTabs(ws.layout).find((t) => t.id === i.tabId) : undefined;
    return {
      tabId: i.tabId,
      kind: i.kind,
      agent: i.view.id,
      title: noticeTitle(i.kind, i.view.label),
      body: noticeBody({ workspace: ws?.name ?? null, tabName: tab?.name ?? null, label: i.view.label, details: state.settings.notifyDetails, session: i.view.title, message: i.view.message }).replace(/\n/g, ' · '),
      since: i.since,
    };
  });
  const openInboxTab = (tabId: string) => {
    setView('workspace');
    showTab(tabId);
  };
  /** The tab the user is looking at (the active pane's selected tab, when a workspace is shown). */
  const tabInFront = (): string | null => {
    if (view !== 'workspace' || !activeWorkspace) return null;
    const pane = listPanes(activeWorkspace.layout).find((p) => p.id === activeWorkspace.activePaneId);
    return pane?.activeTabId ?? null;
  };
  const goToNextAgent = () => {
    const next = nextInboxItem(agentNotices.inbox, tabInFront());
    if (next) openInboxTab(next.tabId);
    else if (agentNotices.inbox.length === 0) pushToast('info', 'No agents are waiting for you.');
  };

  const renameTab = (tabId: string, name: string) => {
    const ws = workspaceOfTab(tabId);
    if (ws) dispatch({ type: 'renameTab', workspaceId: ws.id, tabId, name });
  };

  /** Starts inline renaming of a tab (the active tab of the current pane by default). */
  const beginRename = (tabId?: string) => {
    const ws = getActive();
    const pane = ws?.activePaneId ? findPane(ws.layout, ws.activePaneId) : null;
    const target = tabId ?? (pane ? activeTab(pane).id : null);
    if (!target || !registry.get(target)) return;
    const owner = workspaceOfTab(target);
    if (owner) dispatch({ type: 'activateTab', workspaceId: owner.id, tabId: target });
    setRenamingTabId(target);
  };

  const setFontSize = (size: number) =>
    dispatch({
      type: 'updateSettings',
      patch: { fontSize: Math.min(LIMITS.fontSize.max, Math.max(LIMITS.fontSize.min, size)) },
    });

  const refreshShells = async () => {
    setDiscovery(await api.listShells(true));
    pushToast('info', 'Shell list refreshed.');
  };

  const runCommand = (id: CommandId): boolean => {
    const ws = getActive();
    // Terminal, pane and explorer commands act on the workspace: show it (leave the settings page).
    if (!['palette', 'newWorkspace', 'settings', 'shortcuts', 'toggleSidebar', 'toggleFocusMode'].includes(id)) setView('workspace');
    switch (id) {
      case 'palette':
        setPaletteOpen((v) => !v);
        return true;
      case 'newWorkspace':
        void addWorkspace();
        return true;
      case 'newTerminal':
        newTerminal();
        return true;
      case 'splitRight':
        split(null, 'row');
        return true;
      case 'splitDown':
        split(null, 'column');
        return true;
      case 'closePane':
        closeTab();
        return true;
      case 'nextTab':
        cycleTab(1);
        return true;
      case 'prevTab':
        cycleTab(-1);
        return true;
      case 'find': {
        const pane = ws?.activePaneId ? findPane(ws.layout, ws.activePaneId) : null;
        if (pane && isFileTab(activeTab(pane))) editors.get(activeTab(pane).id)?.openSearch();
        else if (ws?.activePaneId) setSearchPaneId((p) => (p === ws.activePaneId ? null : ws.activePaneId));
        return true;
      }
      case 'restartShell':
        restartTab();
        return true;
      case 'focusLeft':
        focusDirection('left');
        return true;
      case 'focusRight':
        focusDirection('right');
        return true;
      case 'focusUp':
        focusDirection('up');
        return true;
      case 'focusDown':
        focusDirection('down');
        return true;
      case 'nextWorkspace':
        cycleWorkspace(1);
        return true;
      case 'prevWorkspace':
        cycleWorkspace(-1);
        return true;
      case 'toggleSidebar':
        dispatch({ type: 'updateSettings', patch: toggleSidebar(stateRef.current.settings) });
        return true;
      case 'toggleExplorer': {
        const patch = toggleExplorer(stateRef.current.settings);
        dispatch({ type: 'updateSettings', patch });
        if (patch.explorerVisible) setExplorerFocus((n) => n + 1);
        else if (ws?.activePaneId) focusPaneTerminal(ws, ws.activePaneId);
        return true;
      }
      case 'toggleMaximize':
        toggleMaximize();
        return true;
      case 'toggleFocusMode':
        dispatch({ type: 'updateSettings', patch: toggleFocusMode(stateRef.current.settings) });
        if (ws?.activePaneId) requestAnimationFrame(() => focusPaneTerminal(ws, ws.activePaneId!));
        return true;
      case 'fontIncrease':
        setFontSize(stateRef.current.settings.fontSize + 1);
        return true;
      case 'fontDecrease':
        setFontSize(stateRef.current.settings.fontSize - 1);
        return true;
      case 'fontReset':
        setFontSize(LIMITS.fontSize.default);
        return true;
      case 'settings':
        openSettings();
        return true;
      case 'shortcuts':
        setShortcutsOpen(true);
        return true;
      case 'inbox':
        setInboxOpen((v) => !v);
        return true;
      case 'nextAgent':
        goToNextAgent();
        return true;
    }
  };
  // Automatic updates: the first-run notice and the Settings switch both end up here.
  const updateStatus = useUpdateStatus();
  const chooseUpdates = (updateCheck: boolean) => {
    dispatch({ type: 'updateSettings', patch: { updateCheck, updateNoticeSeen: true } });
    api.setUpdatePrefs({ updateCheck, updateNoticeSeen: true });
  };
  // "What's new": decided once, from the settings as loaded (before this run records its version).
  const [whatsNew, setWhatsNew] = useState<string | null>(null);
  const whatsNewChecked = useRef(false);
  useEffect(() => {
    if (!loaded || whatsNewChecked.current) return;
    whatsNewChecked.current = true;
    const settings = state.settings;
    void api.getAppInfo().then((info) => {
      const d = whatsNewDecision(settings, info.version);
      if (d.kind === 'show') setWhatsNew(d.version);
      else if (d.kind === 'record') dispatch({ type: 'updateSettings', patch: { lastVersionSeen: d.version } });
    });
  }, [loaded, state.settings]);
  const whatsNewDone = () => {
    if (whatsNew) dispatch({ type: 'updateSettings', patch: { lastVersionSeen: whatsNew } });
    setWhatsNew(null);
  };

  const runRef = useRef(runCommand);
  runRef.current = runCommand;
  const showTabRef = useRef(showTab);
  showTabRef.current = showTab;
  const toastRef = useRef(pushToast);
  toastRef.current = pushToast;

  useEffect(() => {
    const handle = (event: KeyboardEvent): boolean => {
      const id = matchShortcut(event);
      return id ? runRef.current(id) : false;
    };
    registry.setShortcutHandler(handle);
    editors.setShortcutHandler(handle);
    // "Save all and quit": main waits for this answer and quits only if everything was written.
    api.onSaveAllRequest(async () => {
      const result = await editors.saveAll();
      if (!result.ok) {
        const left = editors.dirtyControllers();
        if (left[0]) showTabRef.current(left[0].tabId);
        toastRef.current(
          'error',
          `${result.failed === 1 ? '1 file was' : `${result.failed} files were`} not saved, so ${PRODUCT.name} stayed open.`,
          left[0]?.getSnapshot().lastSaveError?.message ?? 'Your edits are still in the editor.',
        );
      }
      return { ok: result.ok, failed: result.failed };
    });
    editors.setFocusHandler((tabId) => {
      const ws = stateRef.current.workspaces.find((w) => findPaneOfTab(w.layout, tabId));
      if (ws) dispatch({ type: 'activateTab', workspaceId: ws.id, tabId });
    });
    // Pick up changes made on disk by other tools when the window comes back.
    const onWindowFocus = () => {
      editors.checkDisk();
      // Back from another program (a commit, a checkout elsewhere): check the visible workspace.
      const s = stateRef.current;
      if (s.settings.showGitStatus && s.activeWorkspaceId) api.refreshGit(s.activeWorkspaceId);
    };
    window.addEventListener('focus', onWindowFocus);
    // The agent conversation in a terminal, kept with the tab so Resume can reopen it.
    registry.setResumeHandler((tabId, resume) => {
      const ws = stateRef.current.workspaces.find((w) => findPaneOfTab(w.layout, tabId));
      if (!ws) return;
      let next = resume;
      if (next && !next.cwd) {
        // A WSL tab's "this agent runs here" (from its reports): it never replaces the exact
        // conversation main already found for the same agent in that terminal.
        const current = listTerminalTabs(ws.layout).find((t) => t.id === tabId)?.resume;
        if (current?.wsl && current.agent === next.agent && current.sessionId) return;
        next = { ...next, cwd: ws.rootPath, wsl: true };
      }
      if (next) {
        // The title: the agent's own record (Claude Code), else the session title it reported in the terminal.
        const { title: fromMain, ...rest } = next;
        const title = stateRef.current.settings.resumeTitles ? cleanTitle(fromMain ?? registry.get(tabId)?.getSnapshot().agent?.title) : null;
        next = { ...rest, ...(title ? { title } : {}) };
      }
      dispatch({ type: 'setTabResume', workspaceId: ws.id, tabId, resume: next });
    });
    // Controllers report focus by tab id.
    registry.setFocusHandler((tabId) => {
      const ws = stateRef.current.workspaces.find((w) => findPaneOfTab(w.layout, tabId));
      if (ws) {
        lastTerminal.current.set(ws.id, tabId);
        dispatch({ type: 'activateTab', workspaceId: ws.id, tabId });
      }
    });
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      if (handle(event)) event.preventDefault();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('focus', onWindowFocus);
    };
  }, []);

  // ------------------------------------------------------------ palette

  const paletteCommands = (): PaletteCommand[] => {
    const ws = activeWorkspace;
    const hasPane = !!ws?.activePaneId;
    // Resume: restored terminals not started yet whose agent was running.
    const idleResume = (t: { id: string; resume?: AgentResume }) => !!t.resume && restoredTabs.has(t.id) && registry.get(t.id)?.getSnapshot().status === 'idle';
    const resumableHere = ws ? listTerminalTabs(ws.layout).some(idleResume) : false;
    const activePane = ws ? listPanes(ws.layout).find((p) => p.id === ws.activePaneId) : undefined;
    const activeTerm = activePane?.tabs.find((t) => t.id === activePane.activeTabId);
    const activeResume = activeTerm && isTerminalTab(activeTerm) && idleResume(activeTerm) ? { tabId: activeTerm.id, profileId: activeTerm.profileId, resume: activeTerm.resume! } : null;
    const cmd = (id: string, group: string, title: string, run: () => void, shortcut?: CommandId, disabled?: boolean): PaletteCommand => ({
      id,
      group,
      title,
      run,
      shortcut: shortcut ? shortcutLabel(shortcut) : undefined,
      disabled,
    });
    const list: PaletteCommand[] = [
      cmd('ws-new', 'Workspace', 'New workspace from folder…', () => void addWorkspace(), 'newWorkspace'),
      ...(state.settings.agentTasks
        ? [
            cmd('ws-task', 'Workspace', 'New agent task…', () => ws && newTask(ws.id), undefined, !ws),
            cmd('ws-task-review', 'Workspace', 'Review task changes…', () => ws?.task && setReviewFor(ws.id), undefined, !ws?.task),
            cmd('ws-task-finish', 'Workspace', 'Finish task (commit, merge, clean up)…', () => ws?.task && setFinishFor(ws.id), undefined, !ws?.task),
          ]
        : []),
      cmd('term-new', 'Terminal', 'New terminal in current pane (default shell)', () => newTerminal(), 'newTerminal', !ws),
      ...(discovery?.profiles ?? []).flatMap((p) => {
        const name = p.kind === 'wsl' ? `WSL · ${p.label}` : p.label;
        return [
          cmd(`term-new-${p.id}`, 'Terminal', `New terminal in current pane: ${name}`, () => newTerminal(p.id), undefined, !ws),
          cmd(`split-right-${p.id}`, 'Pane', `Split left/right (new pane on the right): ${name}`, () => split(null, 'row', p.id), undefined, !hasPane),
          cmd(`split-down-${p.id}`, 'Pane', `Split top/bottom (new pane below): ${name}`, () => split(null, 'column', p.id), undefined, !hasPane),
        ];
      }),
      cmd('tab-next', 'Terminal', 'Next terminal in pane', () => cycleTab(1), 'nextTab', !hasPane),
      cmd('tab-prev', 'Terminal', 'Previous terminal in pane', () => cycleTab(-1), 'prevTab', !hasPane),
      cmd('tab-rename', 'Terminal', 'Rename terminal…', () => beginRename(), undefined, !hasPane),
      cmd('tab-close', 'Terminal', 'Close terminal', () => closeTab(), 'closePane', !hasPane),
      cmd('pane-split-right', 'Pane', 'Split left/right (new pane on the right)', () => split(null, 'row'), 'splitRight', !hasPane),
      cmd('pane-split-down', 'Pane', 'Split top/bottom (new pane below)', () => split(null, 'column'), 'splitDown', !hasPane),
      cmd(
        'pane-maximize',
        'Pane',
        ws && effectiveMaximized(ws, maximized[ws.id]) ? 'Restore layout (show all panes)' : 'Maximise pane',
        () => toggleMaximize(),
        'toggleMaximize',
        !ws || listPanes(ws.layout).length < 2,
      ),
      cmd('pane-close', 'Pane', 'Close pane (all its terminals)', () => ws?.activePaneId && closePane(ws.activePaneId), undefined, !hasPane),
      cmd('pane-restart', 'Terminal', 'Start / restart shell', () => restartTab(), 'restartShell', !hasPane),
      cmd('agent-inbox', 'Agents', 'Agent inbox (agents waiting for you)', () => setInboxOpen(true), 'inbox'),
      cmd('agent-next', 'Agents', 'Go to the next waiting agent', () => goToNextAgent(), 'nextAgent', inboxRows.length === 0),
      ...inboxRows.map((r) => cmd(`agent-go-${r.tabId}`, 'Agents', `${r.title} — ${r.body}`, () => openInboxTab(r.tabId))),
      cmd('ws-start-all', 'Workspace', 'Start all restored shells in this workspace', () => ws && startAllRestored(ws.id), undefined, !ws),
      cmd(
        'tab-resume',
        'Terminal',
        activeResume ? `Resume ${RESUME_LABEL[activeResume.resume.agent]} in this terminal` : 'Resume agent in this terminal',
        () => activeResume && void registry.get(activeResume.tabId)?.resume(tabProfile(activeResume.tabId) ?? activeResume.profileId, activeResume.resume),
        undefined,
        !activeResume,
      ),
      cmd('ws-resume-all', 'Workspace', 'Resume agents in this workspace', () => ws && startAllRestored(ws.id, true), undefined, !ws || !resumableHere),
      cmd('pane-find', 'Pane', 'Find in terminal', () => runCommand('find'), 'find', !hasPane),
      cmd('pane-left', 'Pane', 'Focus pane to the left', () => focusDirection('left'), 'focusLeft', !hasPane),
      cmd('pane-right', 'Pane', 'Focus pane to the right', () => focusDirection('right'), 'focusRight', !hasPane),
      cmd('pane-up', 'Pane', 'Focus pane above', () => focusDirection('up'), 'focusUp', !hasPane),
      cmd('pane-down', 'Pane', 'Focus pane below', () => focusDirection('down'), 'focusDown', !hasPane),
      ...state.workspaces.map((w) =>
        cmd(`ws-switch-${w.id}`, 'Switch to', w.name, () => dispatch({ type: 'activateWorkspace', workspaceId: w.id })),
      ),
      cmd('ws-next', 'Workspace', 'Next workspace', () => cycleWorkspace(1), 'nextWorkspace'),
      cmd('ws-prev', 'Workspace', 'Previous workspace', () => cycleWorkspace(-1), 'prevWorkspace'),
      cmd('ws-rename', 'Workspace', 'Rename workspace…', () => ws && setRenameId(ws.id), undefined, !ws),
      cmd('ws-remove', 'Workspace', 'Remove workspace…', () => ws && removeWorkspace(ws.id), undefined, !ws),
      cmd('view-sidebar', 'View', 'Collapse / expand workspace sidebar', () => runCommand('toggleSidebar'), 'toggleSidebar'),
      cmd('view-explorer', 'View', 'Show / hide file explorer', () => runCommand('toggleExplorer'), 'toggleExplorer'),
      cmd(
        'view-focus',
        'View',
        state.settings.focusMode ? 'Exit focus mode (restore sidebars)' : 'Focus terminals (hide both sidebars)',
        () => runCommand('toggleFocusMode'),
        'toggleFocusMode',
      ),
      cmd('view-font-up', 'View', 'Increase font size', () => runCommand('fontIncrease'), 'fontIncrease'),
      cmd('view-font-down', 'View', 'Decrease font size', () => runCommand('fontDecrease'), 'fontDecrease'),
      cmd('view-font-reset', 'View', 'Reset font size', () => runCommand('fontReset'), 'fontReset'),
      cmd('app-settings', 'App', 'Settings', openSettings, 'settings'),
      ...(settingsShown ? [cmd('app-settings-close', 'App', 'Close settings', closeSettings)] : []),
      cmd('app-shortcuts', 'App', 'Keyboard shortcuts', () => setShortcutsOpen(true), 'shortcuts'),
      cmd('app-refresh-shells', 'App', 'Refresh shell list', () => void refreshShells()),
      cmd('app-state-file', 'App', 'Show saved state file in Explorer', () => void api.revealStateFile()),
      cmd('help-bug', 'Help', 'Report a bug (opens GitHub)', () =>
        void api
          .getAppInfo()
          .then((i) => i.version, () => undefined)
          .then((v) => api.openExternal(bugReportUrl(v))),
      ),
      cmd('help-feature', 'Help', 'Suggest a feature (opens GitHub)', () => void api.openExternal(FEATURE_REQUEST_URL)),
      cmd('help-discussions', 'Help', 'Questions and ideas: GitHub Discussions', () => void api.openExternal(DISCUSSIONS_URL)),
    ];
    return list;
  };

  // ------------------------------------------------------------ render

  const renameTarget = state.workspaces.find((w) => w.id === renameId);
  const guidance = wslGuidance(discovery);
  return (
    <div className={`app app--sidebar-${chrome.sidebar}${state.settings.focusMode ? ' app--focus' : ''}`}>
      <TitleBar
        workspace={activeWorkspace}
        pageTitle={view === 'settings' ? 'Settings' : null}
        hasPanes={!!activeWorkspace?.layout}
        sidebar={chrome.sidebar}
        explorerVisible={chrome.explorer}
        focusMode={state.settings.focusMode}
        discovery={discovery}
        defaultProfileId={effectiveDefault}
        onToggleSidebar={() => runCommand('toggleSidebar')}
        onToggleExplorer={() => runCommand('toggleExplorer')}
        onToggleFocusMode={() => runCommand('toggleFocusMode')}
        onOpenPalette={() => setPaletteOpen(true)}
        inbox={inboxRows}
        inboxOpen={inboxOpen}
        onInboxOpenChange={setInboxOpen}
        onInboxPick={openInboxTab}
        onNewTab={(profileId) => {
          setView('workspace');
          newTerminal(profileId);
        }}
        onSplit={(direction) => {
          setView('workspace');
          split(null, direction);
        }}
      />
      <div
        className="app__body"
        style={{ gridTemplateColumns: chrome.sidebar === 'hidden' ? 'minmax(0, 1fr)' : `${chrome.sidebarWidth}px minmax(0, 1fr)` }}
      >
      <Sidebar
        workspaces={state.workspaces}
        activeId={state.activeWorkspaceId}
        mode={chrome.sidebar}
        width={chrome.sidebarWidth}
        maxWidth={chrome.sidebarMax}
        liveCounts={liveCounts}
        agentCounts={agentCounts}
        gitStatuses={state.settings.showGitStatus ? gitStatuses : NO_GIT}
        missing={missing}
        onSelect={(id) => {
          setView('workspace');
          dispatch({ type: 'activateWorkspace', workspaceId: id });
        }}
        settingsShown={settingsShown}
        settingsActive={view === 'settings'}
        onShowSettings={() => setView('settings')}
        onCloseSettings={closeSettings}
        onAdd={() => void addWorkspace()}
        onRename={setRenameId}
        onRemove={removeWorkspace}
        tasksEnabled={state.settings.agentTasks}
        taskProgress={taskProgress}
        onNewTask={newTask}
        onReviewTask={setReviewFor}
        onWidthChange={(sidebarWidth) => dispatch({ type: 'updateSettings', patch: { sidebarWidth } })}
        onSettings={openSettings}
        onShortcuts={() => setShortcutsOpen(true)}
        onPalette={() => setPaletteOpen(true)}
      />
      <main className="main">
        <UpdateNotices status={updateStatus} onChoose={(updateCheck) => chooseUpdates(updateCheck)} />
        {whatsNew && <WhatsNewNotice version={whatsNew} onDone={whatsNewDone} />}
        <div className="main__views">
        {settingsShown && (
          <SettingsView
            active={view === 'settings'}
            section={settingsSection}
            onSection={setSettingsSection}
            settings={state.settings}
            systemDark={systemDark}
            discovery={discovery}
            effectiveDefault={effectiveDefault}
            onChange={(patch) => {
              dispatch({ type: 'updateSettings', patch });
              // Main applies update preferences at once (the saved settings follow a moment later).
              if ('updateCheck' in patch) chooseUpdates(patch.updateCheck === true);
            }}
            onRefreshShells={() => void refreshShells()}
            updateStatus={updateStatus}
          />
        )}
        {loaded && state.workspaces.length === 0 && view === 'workspace' && (
          <div className="welcome">
            <div className="welcome__inner">
              <Icon name="terminal" size={32} />
              <h1>Open a project folder</h1>
              <p>
                Each workspace is one folder on your computer with its own terminal panes. Layouts are saved on this computer; shells start only
                when you open a terminal.
              </p>
              <button type="button" className="button button--primary button--large" onClick={() => void addWorkspace()}>
                <Icon name="folderPlus" /> Open folder…
              </button>
              <WelcomeGuide />
              <p className="welcome__meta">
                <kbd className="kbd">{shortcutLabel('newWorkspace')}</kbd> open folder · <kbd className="kbd">{shortcutLabel('palette')}</kbd>{' '}
                commands · <kbd className="kbd">{shortcutLabel('shortcuts')}</kbd> all shortcuts
              </p>
              {discovery && (
                <p className="welcome__meta">
                  Shells found: {discovery.profiles.map((p) => (p.kind === 'wsl' ? `WSL · ${p.label}` : p.label)).join(', ') || 'none'}
                  {guidance && (
                    <>
                      <br />
                      {guidance} PowerShell terminals work without it.
                    </>
                  )}
                </p>
              )}
            </div>
          </div>
        )}
        {state.workspaces.map((w) => (
          <WorkspaceView
            key={w.id}
            workspace={w}
            active={w.id === state.activeWorkspaceId && view === 'workspace'}
            discovery={discovery}
            defaultProfileId={effectiveDefault}
            folderMissing={missing.has(w.id)}
            freshTabs={freshTabs}
            startOnRestore={startOnRestore}
            restoredTabIds={restoredTabs}
            restoreNoticeDismissed={dismissedNotices.has(w.id)}
            bulkProgress={bulkProgress[w.id] ?? null}
            searchPaneId={searchPaneId}
            renamingTabId={renamingTabId}
            maximizedPaneId={effectiveMaximized(w, maximized[w.id])}
            onToggleMaximize={(paneId) => toggleMaximize(paneId)}
            onRenameStart={setRenamingTabId}
            onRenameTab={renameTab}
            onStartAll={() => startAllRestored(w.id)}
            onResumeAll={() => startAllRestored(w.id, true)}
            onRetryStart={retryStart}
            onShowTab={showTab}
            onDismissRestoreNotice={() => setDismissedNotices((s) => new Set(s).add(w.id))}
            onNewTerminal={(profileId) => newTerminal(profileId)}
            onNewTab={(paneId, profileId) => addTabTo(w, paneId, profileId)}
            onActivateTab={(tabId) => dispatch({ type: 'activateTab', workspaceId: w.id, tabId })}
            onCloseTab={(tabId) => closeTab(tabId)}
            onMoveTab={(tabId, toPaneId, toIndex) => dispatch({ type: 'moveTab', workspaceId: w.id, tabId, toPaneId, toIndex })}
            onSplit={(paneId, direction, profileId) => split(paneId, direction, profileId)}
            onClosePane={closePane}
            onRestartTab={(tabId) => restartTab(tabId)}
            onFocusPane={(paneId) => dispatch({ type: 'focusPane', workspaceId: w.id, paneId })}
            onChangeProfile={(tabId, profileId) => dispatch({ type: 'setTabProfile', workspaceId: w.id, tabId, profileId })}
            onResize={(splitId, sizes) => dispatch({ type: 'setSplitSizes', workspaceId: w.id, splitId, sizes })}
            onToggleSearch={(paneId, open) => setSearchPaneId(open ? paneId : null)}
            onRelink={() => void relinkWorkspace(w.id)}
            onRemove={() => removeWorkspace(w.id)}
            explorerVisible={chrome.explorer}
            explorerWidth={chrome.explorerWidth}
            explorerMaxWidth={chrome.explorerMax}
            compactFolders={state.settings.compactFolders}
            explorerFocusToken={w.id === state.activeWorkspaceId ? explorerFocus : 0}
            onExplorerWidth={(explorerWidth) => dispatch({ type: 'updateSettings', patch: { explorerWidth } })}
            onToggleExplorer={() => runCommand('toggleExplorer')}
            onInsertPath={(rel) => insertPath(w.id, rel)}
            onOpenFile={(rel) => openFile(w.id, rel)}
            notify={pushToast}
          />
        ))}
        </div>
      </main>
      </div>

      <CommandPalette open={paletteOpen} commands={paletteOpen ? paletteCommands() : []} onClose={() => setPaletteOpen(false)} />
      <ShortcutsDialog open={shortcutsOpen} onClose={() => setShortcutsOpen(false)} />
      <RenameDialog
        open={!!renameTarget}
        initial={renameTarget?.name ?? ''}
        onSubmit={(name) => renameTarget && dispatch({ type: 'renameWorkspace', workspaceId: renameTarget.id, name })}
        onClose={() => setRenameId(null)}
      />
      <ConfirmDialog request={confirm} onClose={() => setConfirm(null)} />
      <NewTaskDialog
        open={!!taskFor}
        workspace={state.workspaces.find((w) => w.id === taskFor) ?? null}
        gitStatus={(taskFor && gitStatuses.get(taskFor)) || null}
        profiles={taskShells(discovery?.profiles ?? [], state.workspaces.find((w) => w.id === taskFor)?.rootPath ?? '')}
        wslAvailable={(discovery?.profiles ?? []).some((p) => p.kind === 'wsl')}
        defaultProfileId={state.settings.defaultProfileId ?? discovery?.fallbackProfileId ?? null}
        onCreate={(choice) => (taskFor ? createTask(taskFor, choice) : Promise.resolve(null))}
        onClose={() => setTaskFor(null)}
      />
      <ReviewDialog
        open={!!reviewFor}
        workspace={state.workspaces.find((w) => w.id === reviewFor && w.task) ?? null}
        onFinish={() => {
          setFinishFor(reviewFor);
          setReviewFor(null);
        }}
        onClose={() => setReviewFor(null)}
      />
      {(() => {
        const ws = state.workspaces.find((w) => w.id === finishFor && w.task) ?? null;
        const tabIds = ws ? listTabs(ws.layout).map((t) => t.id) : [];
        return (
          <FinishTaskDialog
            open={!!ws}
            workspace={ws}
            dirtyEditors={editors.dirtyCount(tabIds)}
            onSaveEditors={async () => {
              await Promise.all(tabIds.map((id) => editors.get(id)).filter((e) => e?.isDirty).map((e) => e!.save()));
              setEditorsSaved((n) => n + 1);
            }}
            onEndTerminals={() => ws && endTaskTerminals(ws.id)}
            onDone={(outcome) => ws && taskFinished(ws.id, outcome)}
            onClose={() => setFinishFor(null)}
          />
        );
      })()}
      <Toasts
        toasts={toasts}
        onDismiss={(id) => {
          const key = toasts.find((x) => x.id === id)?.key;
          if (key) agentNotices.dismissed(key);
          setToasts((t) => t.filter((x) => x.id !== id));
        }}
      />
    </div>
  );
}
