// Sandboxed preload: exposes a small, typed API. Raw ipcRenderer, Node.js
// modules and generic channels are never exposed to the page.
import { contextBridge, ipcRenderer } from 'electron';
import { IPC, type AppApi } from '../shared/ipc';
import type { AgentResume } from '../shared/agent-resume';
import type { AgentId } from '../shared/agents';
import type { UpdateStatus } from '../shared/updates';
import type { NoticeTarget } from '../shared/notifications';
import type { FileChangedEvent, GitStatus, SessionEvent } from '../shared/types';
import type { TaskSummary } from '../shared/tasks';

const sessionListeners = new Set<(event: SessionEvent) => void>();
ipcRenderer.on(IPC.sessionEvent, (_event, payload: SessionEvent) => {
  for (const listener of sessionListeners) listener(payload);
});

const fileListeners = new Set<(event: FileChangedEvent) => void>();
ipcRenderer.on(IPC.fileChanged, (_event, payload: FileChangedEvent) => {
  for (const listener of fileListeners) listener(payload);
});

let saveAllHandler: (() => Promise<{ ok: boolean; failed: number }>) | null = null;
ipcRenderer.on(IPC.saveAllRequest, (_event, id: number) => {
  const run = saveAllHandler ? saveAllHandler() : Promise.resolve({ ok: false, failed: -1 });
  void run
    .catch(() => ({ ok: false, failed: -1 }))
    .then((result) => ipcRenderer.send(IPC.saveAllResult, id, { ok: result.ok === true, failed: Number(result.failed) || 0 }));
});

const agentListeners = new Set<(event: { sessionId: string; agent: AgentId | null }) => void>();
ipcRenderer.on(IPC.sessionAgent, (_event, payload: { sessionId: string; agent: AgentId | null }) => {
  for (const listener of agentListeners) listener(payload);
});

const resumeListeners = new Set<(event: { sessionId: string; resume: AgentResume | null }) => void>();
ipcRenderer.on(IPC.sessionResume, (_event, payload: { sessionId: string; resume: AgentResume | null }) => {
  for (const listener of resumeListeners) listener(payload);
});

const updateListeners = new Set<(status: UpdateStatus) => void>();
ipcRenderer.on(IPC.updateChanged, (_event, status: UpdateStatus) => {
  for (const listener of updateListeners) listener(status);
});

const summaryListeners = new Set<(event: { workspaceId: string; summary: TaskSummary | null }) => void>();
ipcRenderer.on(IPC.taskSummary, (_event, payload: { workspaceId: string; summary: TaskSummary | null }) => {
  for (const listener of summaryListeners) listener(payload);
});

const gitListeners = new Set<(event: { workspaceId: string; status: GitStatus | null }) => void>();
ipcRenderer.on(IPC.gitStatus, (_event, payload: { workspaceId: string; status: GitStatus | null }) => {
  for (const listener of gitListeners) listener(payload);
});

let windowFocused = true;
const focusListeners = new Set<(focused: boolean) => void>();
ipcRenderer.on(IPC.windowFocus, (_event, focused: unknown) => {
  windowFocused = focused === true;
  for (const listener of focusListeners) listener(windowFocused);
});

const activateListeners = new Set<(target: NoticeTarget) => void>();
ipcRenderer.on(IPC.notifyActivate, (_event, payload: NoticeTarget) => {
  for (const listener of activateListeners) listener(payload);
});

const quitListeners = new Set<(result: { ok: boolean; failed: number }) => void>();
ipcRenderer.on(IPC.quitAborted, (_event, payload: { ok: boolean; failed: number }) => {
  for (const listener of quitListeners) listener(payload);
});

// "10.0.26300" -> 26300 (getSystemVersion is available in sandboxed preloads).
const windowsBuild = process.platform === 'win32' ? Number(process.getSystemVersion().split('.')[2]) || 0 : 0;

const api: AppApi = {
  windowsBuild,
  loadState: () => ipcRenderer.invoke(IPC.loadState),
  saveState: (state) => ipcRenderer.invoke(IPC.saveState, state),
  pickFolder: () => ipcRenderer.invoke(IPC.pickFolder),
  checkFolder: (workspaceId) => ipcRenderer.invoke(IPC.checkFolder, workspaceId),
  listShells: (refresh) => ipcRenderer.invoke(IPC.listShells, refresh === true),
  createSession: (request) => ipcRenderer.invoke(IPC.createSession, request),
  closeSession: (sessionId) => ipcRenderer.invoke(IPC.closeSession, sessionId),
  writeSession: (sessionId, data) => ipcRenderer.send(IPC.sessionInput, sessionId, data),
  resizeSession: (sessionId, cols, rows) => ipcRenderer.send(IPC.sessionResize, sessionId, cols, rows),
  ackSession: (sessionId, chars) => ipcRenderer.send(IPC.sessionAck, sessionId, chars),
  onSessionEvent: (listener) => {
    sessionListeners.add(listener);
    return () => {
      sessionListeners.delete(listener);
    };
  },
  readClipboard: () => ipcRenderer.invoke(IPC.clipboardRead),
  writeClipboard: (text) => ipcRenderer.invoke(IPC.clipboardWrite, text),
  openExternal: (url) => ipcRenderer.invoke(IPC.openExternal, url),
  getAppInfo: () => ipcRenderer.invoke(IPC.appInfo),
  revealStateFile: () => ipcRenderer.invoke(IPC.revealStateFile),
  listDirectory: (workspaceId, relativePath) => ipcRenderer.invoke(IPC.listDirectory, workspaceId, relativePath),
  revealPath: (workspaceId, relativePath) => ipcRenderer.invoke(IPC.revealPath, workspaceId, relativePath),
  readFile: (workspaceId, relativePath) => ipcRenderer.invoke(IPC.readFile, workspaceId, relativePath),
  statFile: (workspaceId, relativePath) => ipcRenderer.invoke(IPC.statFile, workspaceId, relativePath),
  writeFile: (request) => ipcRenderer.invoke(IPC.writeFile, request),
  setUnsavedEditors: (count) => ipcRenderer.send(IPC.unsavedEditors, count),
  watchFile: (workspaceId, relativePath, on) => ipcRenderer.send(IPC.watchFile, workspaceId, relativePath, on === true),
  onFileChanged: (listener) => {
    fileListeners.add(listener);
    return () => {
      fileListeners.delete(listener);
    };
  },
  onSaveAllRequest: (handler) => {
    saveAllHandler = handler;
  },
  onSessionResume: (listener) => {
    resumeListeners.add(listener);
    return () => {
      resumeListeners.delete(listener);
    };
  },
  onSessionAgent: (listener) => {
    agentListeners.add(listener);
    return () => {
      agentListeners.delete(listener);
    };
  },
  pokeAgentScan: (sessionId) => ipcRenderer.send(IPC.agentPoke, sessionId),
  setWindowTheme: (colors) => ipcRenderer.send(IPC.windowTheme, colors),
  refreshGit: (workspaceId) => ipcRenderer.send(IPC.gitRefresh, workspaceId),
  getGitStatuses: () => ipcRenderer.invoke(IPC.gitStatuses),
  previewTask: (workspaceId, name) => ipcRenderer.invoke(IPC.taskPreview, workspaceId, name),
  createTask: (workspaceId, name) => ipcRenderer.invoke(IPC.taskCreate, workspaceId, name),
  taskProgress: (workspaceId) => ipcRenderer.invoke(IPC.taskProgress, workspaceId),
  taskChanges: (workspaceId) => ipcRenderer.invoke(IPC.taskChanges, workspaceId),
  taskDiff: (workspaceId, path) => ipcRenderer.invoke(IPC.taskDiff, workspaceId, path),
  taskFinishCheck: (workspaceId) => ipcRenderer.invoke(IPC.taskFinishCheck, workspaceId),
  taskCommit: (workspaceId, message) => ipcRenderer.invoke(IPC.taskCommit, workspaceId, message),
  taskMerge: (workspaceId) => ipcRenderer.invoke(IPC.taskMerge, workspaceId),
  taskUpdate: (workspaceId) => ipcRenderer.invoke(IPC.taskUpdate, workspaceId),
  taskRemove: (workspaceId, deleteBranch) => ipcRenderer.invoke(IPC.taskRemove, workspaceId, deleteBranch),
  getTaskSummaries: () => ipcRenderer.invoke(IPC.taskSummaries),
  watchTask: (workspaceId) => ipcRenderer.send(IPC.taskWatch, workspaceId),
  onTaskSummary: (listener) => {
    summaryListeners.add(listener);
    return () => summaryListeners.delete(listener);
  },
  taskDiscard: (workspaceId, confirmedKey) => ipcRenderer.invoke(IPC.taskDiscard, workspaceId, confirmedKey),
  onGitStatus: (listener) => {
    gitListeners.add(listener);
    return () => {
      gitListeners.delete(listener);
    };
  },
  onQuitAborted: (listener) => {
    quitListeners.add(listener);
    return () => {
      quitListeners.delete(listener);
    };
  },
  notifyAgent: (notice) => ipcRenderer.invoke(IPC.notifyAgent, notice),
  withdrawNotifications: (tabIds) => ipcRenderer.send(IPC.notifyWithdraw, tabIds ?? null),
  onNotificationActivate: (listener) => {
    activateListeners.add(listener);
    return () => {
      activateListeners.delete(listener);
    };
  },
  testNotification: () => ipcRenderer.invoke(IPC.notifyTest),
  updateStatus: () => ipcRenderer.invoke(IPC.updateStatus),
  onUpdateStatus: (listener) => {
    updateListeners.add(listener);
    return () => {
      updateListeners.delete(listener);
    };
  },
  setUpdatePrefs: (prefs) => ipcRenderer.send(IPC.updatePrefs, prefs),
  checkForUpdates: () => ipcRenderer.invoke(IPC.updateCheckNow),
  restartToUpdate: () => ipcRenderer.invoke(IPC.updateRestart),
  windowFocused: () => windowFocused,
  onWindowFocus: (listener) => {
    focusListeners.add(listener);
    return () => {
      focusListeners.delete(listener);
    };
  },
};

contextBridge.exposeInMainWorld('appApi', api);
