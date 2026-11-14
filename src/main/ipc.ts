// Validated IPC handlers. Every handler first checks that the message came
// from the app's own top-level page in the main window.
import { BrowserWindow, clipboard, dialog, ipcMain, shell, type IpcMainEvent, type IpcMainInvokeEvent } from 'electron';
import path from 'node:path';
import { IPC, type PickFolderResult } from '../shared/ipc';
import { PRODUCT } from '../shared/product';
import {
  type AppInfo,
  type ListDirectoryResult,
  type PersistedState,
  type ReadFileResult,
  type Result,
  type StatFileResult,
  type WriteFileRequest,
  type WriteFileResult,
} from '../shared/types';
import { listDirectory, resolveInsideRoot } from './file-explorer';
import { readTextFile, statTextFile, writeTextFile } from './file-editor';
import type { OpenFileWatcher } from './file-watch';
import type { AgentMonitor } from './agent-monitor';
import type { GitStatusService } from './git-status';
import { taskFailure, type TaskService } from './task-service';
import type { TaskSummaries } from './task-summaries';
import type { TaskFolderWatcher } from './task-watch';
import { taskRecordKey } from '../shared/tasks';
import type { NotificationService } from './notifications';
import { parseUpdatePrefs, type UpdatePrefs, type UpdateStatus } from '../shared/updates';
import { isAbsoluteWindowsPath, isAllowedExternalUrl, isId, parsePersistedState, parseWindowTheme } from '../shared/validation';
import type { ShellCache } from './launch-resolver';
import type { Logger } from './logger';
import type { SessionBroker } from './session-broker';
import type { StateStore } from './state-store';

export interface IpcContext {
  getWindow(): BrowserWindow | null;
  isTrustedUrl(url: string): boolean;
  store: StateStore;
  shells: ShellCache;
  broker: SessionBroker;
  log: Logger;
  appInfo(): AppInfo;
  /** Opens an already validated http(s) URL in the default browser (recorded instead in E2E runs). */
  openExternal(url: string): Promise<void>;
  isDirectory(p: string): Promise<boolean>;
  /** Number of editor tabs with unsaved changes, reported by the renderer. */
  setUnsavedEditors(count: number): void;
  fileWatcher: OpenFileWatcher;
  agentMonitor: AgentMonitor;
  gitStatus: GitStatusService;
  /** Agent tasks: Git worktrees per task (src/main/task-service.ts). */
  tasks: TaskService;
  /** Each task's summary, kept current after Git status checks (src/main/task-summaries.ts). */
  taskSummaries: TaskSummaries;
  /** The folder watch for the task whose Changes panel is on screen (src/main/task-watch.ts). */
  taskWatcher: TaskFolderWatcher;
  notifications: NotificationService;
  updates: {
    status(): UpdateStatus;
    setPrefs(prefs: UpdatePrefs): void;
    checkNow(): UpdateStatus;
    restart(): boolean;
    /** The saved state was (re)loaded: apply its update preferences. */
    stateLoaded(): void;
  };
  /** Delivers the renderer's answer to a save-all request sent before quitting. */
  resolveSaveAll(id: number, result: { ok: boolean; failed: number }): void;
  /** Development-only automation hook: `|`-separated folders returned instead of showing the dialog. */
  e2ePickFolder?: string;
}

const MAX_CLIPBOARD_CHARS = 4 * 1024 * 1024;

export function registerIpc(ctx: IpcContext): void {
  // Roots the renderer may persist: those loaded from disk or chosen in the folder dialog.
  const allowedRoots = new Set<string>();
  const rootKey = (p: string) => path.win32.normalize(p).toLowerCase();
  // Tasks the page may save: those loaded from disk or created by main in this run. A saved task's
  // paths and branch are what M4 removes and merges, so the page can't invent or change one.
  const knownTasks = new Set<string>();

  const trusted = (event: IpcMainEvent | IpcMainInvokeEvent): boolean => {
    const win = ctx.getWindow();
    const frame = event.senderFrame;
    const ok = !!win && !win.isDestroyed() && event.sender === win.webContents && !!frame && frame === event.sender.mainFrame && ctx.isTrustedUrl(frame.url);
    if (!ok) ctx.log.warn('rejected IPC from untrusted sender');
    return ok;
  };

  const handle = <T>(channel: string, fn: (event: IpcMainInvokeEvent, ...args: unknown[]) => Promise<T> | T) => {
    ipcMain.handle(channel, async (event, ...args) => {
      if (!trusted(event)) throw new Error('forbidden');
      return fn(event, ...args);
    });
  };
  const on = (channel: string, fn: (event: IpcMainEvent, ...args: unknown[]) => void) => {
    ipcMain.on(channel, (event, ...args) => {
      if (!trusted(event)) return;
      fn(event, ...args);
    });
  };

  handle(IPC.loadState, async () => {
    const result = await ctx.store.load();
    for (const w of result.state.workspaces) {
      allowedRoots.add(rootKey(w.rootPath));
      if (w.task) knownTasks.add(taskRecordKey(w.task));
    }
    ctx.gitStatus.sync();
    // Update preferences are in the saved settings: before this they are the defaults (notice not
    // seen, so no request), after it the user's choice applies.
    ctx.updates.stateLoaded();
    return result;
  });

  handle(IPC.saveState, (_event, raw): Result<object> => {
    const json = JSON.stringify(raw ?? null);
    if (json.length > 1024 * 1024) return { ok: false, error: { code: 'INVALID_REQUEST', message: 'state is too large' } };
    const parsed = parsePersistedState(raw);
    if (!parsed.ok) return { ok: false, error: { code: 'INVALID_REQUEST', message: parsed.reason } };
    const state: PersistedState = parsed.state;
    for (const w of state.workspaces) {
      if (!allowedRoots.has(rootKey(w.rootPath))) {
        return { ok: false, error: { code: 'FORBIDDEN', message: 'workspace folders must be chosen with the folder picker' } };
      }
      if (w.task && !knownTasks.has(taskRecordKey(w.task))) {
        return { ok: false, error: { code: 'FORBIDDEN', message: 'tasks must be created by SplitNest' } };
      }
    }
    ctx.store.update(state);
    // New or removed workspaces, or the Git status setting switched.
    ctx.gitStatus.sync();
    ctx.taskSummaries.sync();
    return { ok: true };
  });

  const e2eQueue = ctx.e2ePickFolder ? ctx.e2ePickFolder.split('|').filter(Boolean) : [];
  handle(IPC.pickFolder, async (): Promise<PickFolderResult | null> => {
    let chosen: string | undefined;
    if (e2eQueue.length > 0) {
      chosen = e2eQueue.shift();
    } else {
      const win = ctx.getWindow();
      const options = { title: 'Choose a project folder', properties: ['openDirectory' as const, 'dontAddToRecent' as const] };
      const result = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options);
      chosen = result.canceled ? undefined : result.filePaths[0];
    }
    if (!chosen || !isAbsoluteWindowsPath(chosen)) return null;
    allowedRoots.add(rootKey(chosen));
    const base = path.win32.basename(chosen) || chosen;
    return { path: chosen, suggestedName: base.slice(0, 120) };
  });

  handle(IPC.checkFolder, async (_event, workspaceId) => {
    if (!isId(workspaceId)) return { exists: false };
    const w = ctx.store.getWorkspace(workspaceId);
    return { exists: !!w && (await ctx.isDirectory(w.rootPath)) };
  });

  handle(IPC.listShells, async (_event, refresh) => (await ctx.shells.get(refresh === true)).discovery);

  handle(IPC.createSession, async (event, request) => {
    // Use the latest renderer state for workspace lookups.
    return ctx.broker.create(event.sender.id, request);
  });

  handle(IPC.closeSession, (event, sessionId) => {
    ctx.broker.close(event.sender.id, sessionId);
  });

  on(IPC.sessionInput, (event, sessionId, data) => {
    ctx.broker.input(event.sender.id, sessionId, data);
  });
  on(IPC.sessionResize, (event, sessionId, cols, rows) => {
    ctx.broker.resize(event.sender.id, sessionId, cols, rows);
  });
  on(IPC.sessionAck, (event, sessionId, chars) => {
    ctx.broker.ack(event.sender.id, sessionId, chars);
  });

  handle(IPC.clipboardRead, async () => (await clipboard.readText()).slice(0, MAX_CLIPBOARD_CHARS));
  handle(IPC.clipboardWrite, async (_event, text) => {
    if (typeof text !== 'string' || text.length > MAX_CLIPBOARD_CHARS) return;
    await clipboard.writeText(text);
  });

  handle(IPC.openExternal, async (_event, url) => {
    if (!isAllowedExternalUrl(url)) {
      ctx.log.warn('blocked external URL with disallowed scheme');
      return false;
    }
    await ctx.openExternal(url);
    return true;
  });

  handle(IPC.appInfo, () => ctx.appInfo());
  handle(IPC.revealStateFile, () => {
    shell.showItemInFolder(ctx.store.filePath);
  });

  handle(IPC.listDirectory, async (_event, workspaceId, relativePath): Promise<ListDirectoryResult> => {
    const workspace = isId(workspaceId) ? ctx.store.getWorkspace(workspaceId) : undefined;
    if (!workspace) return { ok: false, error: { code: 'WORKSPACE_NOT_FOUND', message: 'The workspace no longer exists.' } };
    return listDirectory(workspace.rootPath, relativePath);
  });

  handle(IPC.revealPath, (_event, workspaceId, relativePath) => {
    const workspace = isId(workspaceId) ? ctx.store.getWorkspace(workspaceId) : undefined;
    const target = workspace ? resolveInsideRoot(workspace.rootPath, relativePath) : null;
    if (!target) return false;
    // Selects the item in File Explorer; never opens or runs it.
    shell.showItemInFolder(target);
    return true;
  });

  const workspaceOf = (workspaceId: unknown) => (isId(workspaceId) ? ctx.store.getWorkspace(workspaceId) : undefined);
  const noWorkspace = { ok: false, error: { code: 'WORKSPACE_NOT_FOUND', message: 'The workspace no longer exists.' } } as const;

  handle(IPC.readFile, async (_event, workspaceId, relativePath): Promise<ReadFileResult> => {
    const workspace = workspaceOf(workspaceId);
    return workspace ? readTextFile(workspace.rootPath, relativePath) : noWorkspace;
  });

  handle(IPC.statFile, async (_event, workspaceId, relativePath): Promise<StatFileResult> => {
    const workspace = workspaceOf(workspaceId);
    return workspace ? statTextFile(workspace.rootPath, relativePath) : noWorkspace;
  });

  handle(IPC.writeFile, async (_event, raw): Promise<WriteFileResult> => {
    const r = (typeof raw === 'object' && raw !== null ? raw : {}) as Partial<WriteFileRequest>;
    const workspace = workspaceOf(r.workspaceId);
    if (!workspace) return noWorkspace;
    const result = await writeTextFile(workspace.rootPath, {
      path: r.path as string,
      content: r.content as string,
      encoding: r.encoding as WriteFileRequest['encoding'],
      expectedHash: r.expectedHash as string,
      overwrite: r.overwrite === true,
    });
    // Lifecycle only: never file names or contents.
    if (!result.ok && result.error.code !== 'CONFLICT') ctx.log.warn(`file save failed: ${result.error.code}`);
    if (result.ok) ctx.gitStatus.request(workspace.id);
    return result;
  });

  on(IPC.watchFile, (event, workspaceId, relativePath, enabled) => {
    const workspace = workspaceOf(workspaceId);
    const absolutePath = workspace ? resolveInsideRoot(workspace.rootPath, relativePath) : null;
    if (!workspace || !absolutePath || typeof relativePath !== 'string') return;
    const target = { ownerId: event.sender.id, workspaceId: workspace.id, relativePath, absolutePath };
    if (enabled === true) {
      if (!ctx.fileWatcher.watch(target)) ctx.log.warn('file watch not started (limit reached or folder unavailable)');
    } else {
      ctx.fileWatcher.unwatch(target);
    }
  });

  // Git status: the page asks when the user looks at a workspace; ids are checked against main's list.
  on(IPC.gitRefresh, (_event, workspaceId) => {
    const workspace = workspaceOf(workspaceId);
    if (workspace) ctx.gitStatus.request(workspace.id);
  });
  handle(IPC.gitStatuses, () => ctx.gitStatus.statuses());

  // Agent tasks. The page sends a workspace id and a name; main uses its own copy of the folder.
  const taskParent = (workspaceId: unknown) => {
    if (!ctx.store.state.settings.agentTasks) return taskFailure('DISABLED');
    const w = isId(workspaceId) ? ctx.store.getWorkspace(workspaceId) : undefined;
    return w ? { ok: true as const, workspace: w } : taskFailure('WORKSPACE_NOT_FOUND');
  };
  handle(IPC.taskPreview, async (_event, workspaceId, name) => {
    const p = taskParent(workspaceId);
    return p.ok ? ctx.tasks.preview(p.workspace.rootPath, name) : p;
  });
  handle(IPC.taskCreate, async (_event, workspaceId, name) => {
    const p = taskParent(workspaceId);
    if (!p.ok) return p;
    const r = await ctx.tasks.create(p.workspace.rootPath, name);
    if (r.ok) {
      knownTasks.add(taskRecordKey(r.task));
      allowedRoots.add(rootKey(r.task.taskRoot));
      ctx.log.info('agent task created');
    } else ctx.log.warn(`agent task not created (${r.error.code})`);
    return r;
  });
  handle(IPC.taskProgress, async (_event, workspaceId) => {
    const p = taskParent(workspaceId);
    if (!p.ok) return p;
    return p.workspace.task ? ctx.tasks.progress(p.workspace.task) : taskFailure('NOT_A_TASK');
  });
  handle(IPC.taskChanges, async (_event, workspaceId) => {
    const p = taskParent(workspaceId);
    if (!p.ok) return p;
    return p.workspace.task ? ctx.tasks.changes(p.workspace.task) : taskFailure('NOT_A_TASK');
  });
  handle(IPC.taskDiff, async (_event, workspaceId, file) => {
    const p = taskParent(workspaceId);
    if (!p.ok) return p;
    return p.workspace.task ? ctx.tasks.diff(p.workspace.task, file) : taskFailure('NOT_A_TASK');
  });

  // Finishing a task: each one acts on main's own copy of the task, never on paths from the page.
  const taskOf = (workspaceId: unknown) => {
    const p = taskParent(workspaceId);
    if (!p.ok) return p;
    return p.workspace.task ? { ok: true as const, id: p.workspace.id, task: p.workspace.task } : taskFailure('NOT_A_TASK');
  };
  on(IPC.taskWatch, (_event, workspaceId) => {
    // Only a task main knows, with agent tasks on; anything else stops the watch.
    const w = ctx.store.state.settings.agentTasks && isId(workspaceId) ? ctx.store.getWorkspace(workspaceId) : undefined;
    ctx.taskWatcher.set(w?.task ? { workspaceId: w.id, folder: w.task.worktreePath } : null);
  });
  handle(IPC.taskSummaries, () => (ctx.store.state.settings.agentTasks ? ctx.taskSummaries.all() : {}));
  handle(IPC.taskFinishCheck, async (_event, workspaceId) => {
    const t = taskOf(workspaceId);
    if (!t.ok) return t;
    const r = await ctx.tasks.finishCheck(t.task);
    return r.ok ? { ok: true, check: { ...r.check, runningTerminals: ctx.broker.liveInWorkspace(t.id) } } : r;
  });
  handle(IPC.taskCommit, async (_event, workspaceId, message) => {
    const t = taskOf(workspaceId);
    return t.ok ? ctx.tasks.commitAll(t.task, message) : t;
  });
  handle(IPC.taskMerge, async (_event, workspaceId) => {
    const t = taskOf(workspaceId);
    if (!t.ok) return t;
    const r = await ctx.tasks.merge(t.task);
    ctx.log.info(`agent task merge: ${r.ok ? r.result.outcome : r.error.code}`);
    // The base branch moved: check the sidebar's Git status again (one check at a time, a rare action).
    if (r.ok) for (const w of ctx.store.state.workspaces) ctx.gitStatus.request(w.id);
    return r;
  });
  handle(IPC.taskUpdate, async (_event, workspaceId) => {
    const t = taskOf(workspaceId);
    return t.ok ? ctx.tasks.updateFromBase(t.task) : t;
  });
  // Deleting the folder waits until no terminal runs in the task (the page ends them first).
  handle(IPC.taskRemove, async (_event, workspaceId, deleteBranch) => {
    const t = taskOf(workspaceId);
    if (!t.ok) return t;
    // What Git would refuse anyway comes first, so the page ends the terminals only when removal can go ahead.
    const blocked = await ctx.tasks.removalBlocked(t.task);
    if (blocked) return { ok: false, error: blocked };
    if (ctx.broker.liveInWorkspace(t.id) > 0) return taskFailure('TERMINALS_RUNNING');
    const r = await ctx.tasks.remove(t.task, { deleteBranch: deleteBranch === true });
    ctx.log.info(`agent task removed: ${r.ok ? r.branch : r.error.code}`);
    return r;
  });
  handle(IPC.taskDiscard, async (_event, workspaceId, confirmedKey) => {
    const t = taskOf(workspaceId);
    if (!t.ok) return t;
    const blocked = await ctx.tasks.discardBlocked(t.task, confirmedKey);
    if (blocked) return { ok: false, error: blocked };
    if (ctx.broker.liveInWorkspace(t.id) > 0) return taskFailure('TERMINALS_RUNNING');
    // Checked again inside: anything written while the terminals were ending makes it STALE.
    const r = await ctx.tasks.discard(t.task, confirmedKey);
    ctx.log.info(`agent task discarded: ${r.ok ? 'ok' : r.error.code}`);
    return r;
  });

  // Agent notifications: the page sends ids and the event; main writes the text (notifications.ts).
  handle(IPC.notifyAgent, (_event, notice) => ctx.notifications.notify(notice));
  on(IPC.notifyWithdraw, (_event, tabIds) => ctx.notifications.withdraw(tabIds));
  handle(IPC.notifyTest, () => ctx.notifications.test());

  // Automatic updates (updater.ts): state, preferences, "Check now", "Restart now".
  handle(IPC.updateStatus, () => ctx.updates.status());
  on(IPC.updatePrefs, (_event, prefs) => {
    const p = parseUpdatePrefs(prefs);
    if (p) ctx.updates.setPrefs(p);
  });
  handle(IPC.updateCheckNow, () => ctx.updates.checkNow());
  handle(IPC.updateRestart, () => ctx.updates.restart());

  on(IPC.agentPoke, (event, sessionId) => {
    if (ctx.broker.owns(event.sender.id, sessionId)) ctx.agentMonitor.poke();
  });

  // Appearance: recolour the window behind the page and the native caption buttons' area.
  on(IPC.windowTheme, (event, colors) => {
    const c = parseWindowTheme(colors);
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!c || !win || win.isDestroyed()) return;
    win.setBackgroundColor(c.background);
    try {
      win.setTitleBarOverlay({ color: c.titleBar, symbolColor: c.symbol });
    } catch {
      // Only windows created with a title bar overlay support this.
    }
  });

  on(IPC.saveAllResult, (_event, id, result) => {
    if (typeof id !== 'number') return;
    const r = (typeof result === 'object' && result !== null ? result : {}) as { ok?: unknown; failed?: unknown };
    ctx.resolveSaveAll(id, { ok: r.ok === true, failed: typeof r.failed === 'number' ? r.failed : 0 });
  });

  on(IPC.unsavedEditors, (_event, count) => {
    ctx.setUnsavedEditors(typeof count === 'number' && Number.isInteger(count) && count >= 0 ? Math.min(count, 10_000) : 0);
  });

  ctx.log.info(`${PRODUCT.name} IPC registered`);
}
