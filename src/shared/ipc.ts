import type { AgentResume } from './agent-resume';
import type { AgentId } from './agents';
import type { UpdatePrefs, UpdateStatus } from './updates';
import type { BranchOutcome, TaskChanges, TaskDiff, TaskFinishCheck, TaskMergeResult, TaskPreview, TaskProgress, TaskRecord, TaskResult, TaskUpdateResult } from './tasks';
import type { AgentNotice, NoticeDelivery, NoticeTarget } from './notifications';
import type {
  AppInfo,
  CreateSessionRequest,
  CreateSessionResult,
  FileChangedEvent,
  GitStatus,
  ListDirectoryResult,
  ReadFileResult,
  StatFileResult,
  WriteFileRequest,
  WriteFileResult,
  LoadStateResult,
  PersistedState,
  Result,
  SessionEvent,
  ShellDiscovery,
} from './types';

/** IPC channel names. Each one has a single, specific purpose. */
export const IPC = {
  loadState: 'tw:state:load',
  saveState: 'tw:state:save',
  pickFolder: 'tw:dialog:pick-folder',
  checkFolder: 'tw:folder:check',
  listShells: 'tw:shells:list',
  createSession: 'tw:session:create',
  closeSession: 'tw:session:close',
  sessionInput: 'tw:session:input',
  sessionResize: 'tw:session:resize',
  sessionAck: 'tw:session:ack',
  sessionEvent: 'tw:session:event',
  clipboardRead: 'tw:clipboard:read',
  clipboardWrite: 'tw:clipboard:write',
  openExternal: 'tw:app:open-external',
  appInfo: 'tw:app:info',
  revealStateFile: 'tw:app:reveal-state-file',
  listDirectory: 'tw:fs:list-directory',
  revealPath: 'tw:fs:reveal-path',
  readFile: 'tw:fs:read-file',
  statFile: 'tw:fs:stat-file',
  writeFile: 'tw:fs:write-file',
  unsavedEditors: 'tw:editor:unsaved',
  watchFile: 'tw:fs:watch-file',
  fileChanged: 'tw:fs:file-changed',
  saveAllRequest: 'tw:app:save-all-request',
  saveAllResult: 'tw:app:save-all-result',
  quitAborted: 'tw:app:quit-aborted',
  sessionAgent: 'tw:session:agent',
  sessionResume: 'tw:session:resume',
  agentPoke: 'tw:session:agent-poke',
  windowTheme: 'tw:window:theme',
  gitRefresh: 'tw:git:refresh',
  gitStatuses: 'tw:git:statuses',
  gitStatus: 'tw:git:status',
  notifyAgent: 'tw:notify:agent',
  notifyWithdraw: 'tw:notify:withdraw',
  notifyActivate: 'tw:notify:activate',
  notifyTest: 'tw:notify:test',
  updateStatus: 'tw:update:status',
  updateChanged: 'tw:update:changed',
  updatePrefs: 'tw:update:prefs',
  updateCheckNow: 'tw:update:check',
  updateRestart: 'tw:update:restart',
  windowFocus: 'tw:window:focus',
  taskPreview: 'tw:task:preview',
  taskCreate: 'tw:task:create',
  taskProgress: 'tw:task:progress',
  taskChanges: 'tw:task:changes',
  taskDiff: 'tw:task:diff',
  taskFinishCheck: 'tw:task:finish-check',
  taskCommit: 'tw:task:commit',
  taskMerge: 'tw:task:merge',
  taskUpdate: 'tw:task:update',
  taskRemove: 'tw:task:remove',
  taskDiscard: 'tw:task:discard',
} as const;

export interface PickFolderResult {
  path: string;
  suggestedName: string;
}

/** The complete API the renderer can use, exposed as `window.appApi`. */
export interface AppApi {
  /** Windows build number (e.g. 26300), or 0 if unknown. xterm needs it to treat rows as ConPTY does. */
  readonly windowsBuild: number;
  loadState(): Promise<LoadStateResult>;
  saveState(state: PersistedState): Promise<Result<object>>;
  pickFolder(): Promise<PickFolderResult | null>;
  checkFolder(workspaceId: string): Promise<{ exists: boolean }>;
  listShells(refresh?: boolean): Promise<ShellDiscovery>;
  createSession(request: CreateSessionRequest): Promise<CreateSessionResult>;
  closeSession(sessionId: string): Promise<void>;
  writeSession(sessionId: string, data: string): void;
  resizeSession(sessionId: string, cols: number, rows: number): void;
  ackSession(sessionId: string, chars: number): void;
  onSessionEvent(listener: (event: SessionEvent) => void): () => void;
  readClipboard(): Promise<string>;
  writeClipboard(text: string): Promise<void>;
  openExternal(url: string): Promise<boolean>;
  getAppInfo(): Promise<AppInfo>;
  revealStateFile(): Promise<void>;
  /** Lists a folder inside a workspace (`relativePath` uses `/`, '' = workspace root). */
  listDirectory(workspaceId: string, relativePath: string): Promise<ListDirectoryResult>;
  /** Shows a file or folder inside a workspace in Windows File Explorer. */
  revealPath(workspaceId: string, relativePath: string): Promise<boolean>;
  /** Reads an existing text file inside a workspace for the editor. */
  readFile(workspaceId: string, relativePath: string): Promise<ReadFileResult>;
  statFile(workspaceId: string, relativePath: string): Promise<StatFileResult>;
  /** Saves an existing file inside a workspace (explicit user save only). */
  writeFile(request: WriteFileRequest): Promise<WriteFileResult>;
  /** Tells main how many editor tabs have unsaved changes (for the quit confirmation). */
  setUnsavedEditors(count: number): void;
  /** Starts (`true`) or stops watching an open file for changes made outside the editor. */
  watchFile(workspaceId: string, relativePath: string, on: boolean): void;
  onFileChanged(listener: (event: FileChangedEvent) => void): () => void;
  /**
   * Main asks the page to save every dirty editor before quitting; the
   * handler's result is sent back. Only one handler is kept.
   */
  onSaveAllRequest(handler: () => Promise<{ ok: boolean; failed: number }>): void;
  /** Quitting was stopped because saving failed. */
  onQuitAborted(listener: (result: { ok: boolean; failed: number }) => void): () => void;
  /** Main detected (or lost) an AI agent CLI among a session's processes (PowerShell sessions only). */
  onSessionAgent(listener: (event: { sessionId: string; agent: AgentId | null }) => void): () => void;
  /** The conversation the agent in a session runs (null: the agent exited), for resuming after a restart. */
  onSessionResume(listener: (event: { sessionId: string; resume: AgentResume | null }) => void): () => void;
  /** Something changed in a session (e.g. its title); main looks for agent processes sooner. */
  pokeAgentScan(sessionId: string): void;
  /** Appearance: window background and title bar (native caption buttons) colours, `#rrggbb`. */
  setWindowTheme(colors: { background: string; titleBar: string; symbol: string }): void;
  /** The user is looking at this workspace (selected it, came back to the window): check Git now. */
  refreshGit(workspaceId: string): void;
  /** Git state of every workspace checked so far (workspaces without one are absent). */
  getGitStatuses(): Promise<Record<string, GitStatus>>;
  /** A workspace's Git state changed; `status` is null when it is not (or no longer) shown. */
  onGitStatus(listener: (event: { workspaceId: string; status: GitStatus | null }) => void): () => void;
  /**
   * An agent event for a tab the user is not looking at, while SplitNest is in the background.
   * Main writes the notification text itself (see shared/notifications.ts); `in-app` means the
   * window is focused after all (or Windows notifications are off), so the page shows its notice.
   */
  notifyAgent(notice: AgentNotice): Promise<NoticeDelivery>;
  /** The user has seen these tabs (or their agents moved on): remove their notifications. No ids = all. */
  withdrawNotifications(tabIds?: string[]): void;
  /** A notification was clicked: show this tab (or Settings › Notifications for the test notification). */
  onNotificationActivate(listener: (target: NoticeTarget) => void): () => void;
  /** Settings › Notifications: sends a test Windows notification; resolves with what Windows reported. */
  testNotification(): Promise<{ ok: boolean; detail: string }>;
  /**
   * The window is in front and not minimized (main's view). The page's own `document.hasFocus()`
   * stays true while the window is minimized or another program is in front, so it can't be used.
   */
  windowFocused(): boolean;
  onWindowFocus(listener: (focused: boolean) => void): () => void;
  /** Automatic updates (installed app): the current state. */
  updateStatus(): Promise<UpdateStatus>;
  onUpdateStatus(listener: (status: UpdateStatus) => void): () => void;
  /** The page's update preferences (also saved in settings); main applies them at once. */
  setUpdatePrefs(prefs: UpdatePrefs): void;
  /** Settings › About "Check now": the user's explicit request. */
  checkForUpdates(): Promise<UpdateStatus>;
  /** "Restart now" for a downloaded update: runs the normal quit flow, then installs and restarts. */
  restartToUpdate(): Promise<boolean>;
  /** Agent tasks: what a task created from this workspace with this name would be (nothing is created). */
  previewTask(workspaceId: string, name: string): Promise<TaskResult<{ preview: TaskPreview }>>;
  /**
   * Creates the task's Git worktree and branch from this workspace. The page then adds the task's
   * workspace with this record; main accepts a saved task only if it created it.
   */
  createTask(workspaceId: string, name: string): Promise<TaskResult<{ task: TaskRecord }>>;
  /** A task workspace's branch against its base branch (read-only Git). */
  taskProgress(workspaceId: string): Promise<TaskResult<{ progress: TaskProgress }>>;
  /** Review: the files a task changed against where it left its base branch (read-only Git). */
  taskChanges(workspaceId: string): Promise<TaskResult<{ changes: TaskChanges }>>;
  /** Review: one of those files' diff (`path` as listed by taskChanges; anything else is refused). */
  taskDiff(workspaceId: string, path: string): Promise<TaskResult<{ diff: TaskDiff }>>;
  /** Finish: what merging and cleaning up would involve (read-only Git, plus main's count of running terminals). */
  taskFinishCheck(workspaceId: string): Promise<TaskResult<{ check: TaskFinishCheck }>>;
  /** Finish: stage everything in the task folder and commit it with this message. */
  taskCommit(workspaceId: string, message: string): Promise<TaskResult<{ commit: string }>>;
  /** Finish: merge the task branch into its base branch (undone at once if it stops with conflicts). */
  taskMerge(workspaceId: string): Promise<TaskResult<{ result: TaskMergeResult }>>;
  /** Finish: bring the base branch's newer commits into the task folder (conflicts stay there). */
  taskUpdate(workspaceId: string): Promise<TaskResult<{ result: TaskUpdateResult }>>;
  /** Finish: delete the task folder (refused with uncommitted files) and, if asked, its branch once merged. */
  taskRemove(workspaceId: string, deleteBranch: boolean): Promise<TaskResult<{ branch: BranchOutcome }>>;
  /** Finish: delete the task folder and branch whatever they contain; `head` is the commit the user confirmed for. */
  taskDiscard(workspaceId: string, head: string): Promise<TaskResult<object>>;
}
