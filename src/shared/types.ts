// Shared contracts between main, preload, PTY host and renderer.

import type { AgentResume } from './agent-resume';
/**
 * 3: tabs can also be file-editor tabs. 2: panes hold tabs. Versions 1 and 2
 * are migrated on load (a version-3 file is rejected as unsupported by older
 * builds, which then keep it aside instead of misreading it).
 */
export const SCHEMA_VERSION = 3 as const;

// ---------------------------------------------------------------- profiles

export type ShellKind = 'pwsh' | 'windows-powershell' | 'wsl';

export interface ShellProfile {
  /** Stable ID: `pwsh`, `windows-powershell`, or `wsl:<distro>`. */
  id: string;
  kind: ShellKind;
  label: string;
  /** WSL distribution name (WSL profiles only). */
  distro?: string;
  /** True for the WSL distribution marked as default by `wsl --list`. */
  isDefaultDistro?: boolean;
}

export type WslStatus =
  | { state: 'available' }
  | { state: 'not-installed'; message: string }
  | { state: 'no-distributions'; message: string }
  | { state: 'error'; message: string };

export interface ShellDiscovery {
  profiles: ShellProfile[];
  wsl: WslStatus;
  /** The profile used when no default is configured or the configured one is missing. */
  fallbackProfileId: string | null;
}

// ------------------------------------------------------------------ layout

export type SplitDirection = 'row' | 'column';

/** One terminal inside a pane. Sessions and terminal views are keyed by tab id. */
export interface TerminalTab {
  id: string;
  /** Absent in files written before file tabs existed. */
  kind?: 'terminal';
  profileId: string;
  /**
   * User-chosen label ("Backend", "Tests"). Absent means the default shell
   * label. Optional so files written before it existed load unchanged.
   */
  name?: string;
  /**
   * The agent conversation running in this terminal (Claude Code, Codex, Gemini CLI), kept while the agent
   * runs and through a quit, so it can be resumed after a restart. Removed when the agent exits
   * on its own. Holds an id and a folder, never conversation text.
   */
  resume?: AgentResume;
}

/** A file open in the built-in editor. Only the path is saved, never the content. */
export interface FileTab {
  id: string;
  kind: 'file';
  /** Relative to the workspace root, `/`-separated. */
  path: string;
}

export type PaneTab = TerminalTab | FileTab;

export const isFileTab = (tab: PaneTab): tab is FileTab => tab.kind === 'file';
export const isTerminalTab = (tab: PaneTab): tab is TerminalTab => tab.kind !== 'file';

export interface PaneLeaf {
  type: 'pane';
  id: string;
  /** At least one tab; terminals and files may share a pane. */
  tabs: PaneTab[];
  activeTabId: string;
}

export interface SplitNode {
  type: 'split';
  id: string;
  /** `row`: children side by side (split right). `column`: stacked (split down). */
  direction: SplitDirection;
  children: LayoutNode[];
  /** Fractions that sum to 1, one per child. */
  sizes: number[];
}

export type LayoutNode = PaneLeaf | SplitNode;

// -------------------------------------------------------------- workspaces

export interface Workspace {
  id: string;
  name: string;
  /** Absolute Windows path chosen through the native folder picker. */
  rootPath: string;
  layout: LayoutNode | null;
  activePaneId: string | null;
}

export interface AppSettings {
  defaultProfileId: string | null;
  fontSize: number;
  scrollback: number;
  startShellsOnRestore: boolean;
  /** Workspace sidebar shown as a narrow icon rail. */
  sidebarCollapsed: boolean;
  /** Expanded workspace sidebar width in px (kept while collapsed). */
  sidebarWidth: number;
  explorerVisible: boolean;
  explorerWidth: number;
  /**
   * "Focus terminals": both sidebars are hidden without changing the settings
   * above, so turning it off brings back their previous visibility and widths.
   */
  focusMode: boolean;
  /**
   * Default prompts show only the current folder (`PS car-rental>`,
   * `.../car-rental$`). Custom prompts are never changed. Applies to shells
   * started after the change.
   */
  shortPromptPaths: boolean;
  /** Explorer shows chains of single-folder directories as one row (src/main/java). */
  compactFolders: boolean;
  /** Appearance: Dark (the chosen dark theme), Light (Silver Light) or follow Windows. */
  themeMode: ThemeMode;
  /** The dark theme used in Dark mode and at night in Match system. */
  darkTheme: DarkThemeId;
  /** Sidebar: branch and changed lines of each workspace folder that is in a Git repository. */
  showGitStatus: boolean;
  /**
   * Save the agent conversation's title with a terminal (shown with Resume after a restart). On by
   * default; a title can contain words from the prompt, and it is written to the state file.
   */
  resumeTitles: boolean;
  /** Resume each restored terminal's agent conversation as SplitNest opens (off: a Resume button). */
  resumeAutomatically: boolean;
  /** Automatic update checks (installed app only; see src/main/updater.ts). On by default. */
  updateCheck: boolean;
  /** The first-run notice about update checks was acknowledged; no update request happens before. */
  updateNoticeSeen: boolean;
  /** The newest SplitNest version that has started (the "What's new" notice is shown once per newer version). */
  lastVersionSeen: string | null;
  /** Notifications: an agent needs permission, has a question, needs sign-in, or otherwise waits for you. */
  notifyNeedsYou: boolean;
  /** Notifications: an agent reported that it finished. */
  notifyFinished: boolean;
  /** Notifications: an agent reported an error. */
  notifyErrors: boolean;
  /** Windows notifications while SplitNest is in the background or minimized (else in-app notices only). */
  notifyWindows: boolean;
  /** Flash the taskbar button when an agent needs you while SplitNest is in the background. */
  notifyFlash: boolean;
  /** Windows plays its notification sound. */
  notifySound: boolean;
  /**
   * Include what the agent wrote (its session title and message) in notifications. Off by
   * default: both can contain prompt text, file paths or commands, and Windows keeps
   * notifications in Notification Center and may show them on the lock screen.
   */
  notifyDetails: boolean;
  /** Also notify for estimated states ("may need you" after a terminal bell). */
  notifyEstimated: boolean;
}

/**
 * Git state of a workspace folder (read with `git status` and `git diff`; nothing is changed).
 * Line totals compare the working tree with the last commit, staged and unstaged together, for
 * files Git tracks; new untracked files are counted, their lines are not.
 */
export interface GitStatus {
  /** Current branch, or null when HEAD is detached. */
  branch: string | null;
  /** Short commit id when HEAD is detached, else null. */
  detached: string | null;
  /** No commit yet on the branch. */
  initial: boolean;
  /** Upstream branch (e.g. origin/main), or null. */
  upstream: string | null;
  ahead: number;
  behind: number;
  /** Tracked files with staged or unstaged changes (renames and conflicts included). */
  changedFiles: number;
  /**
   * Entries Git lists as untracked (ignored files excluded). Not a number of files: a new folder is
   * one entry however many files it holds, so it is only shown as "untracked files present".
   */
  untracked: number;
  /**
   * Changes were not checked: the repository's own Git configuration names a filter program that
   * Git would start to compare files (see src/main/git-status.ts). Only the branch is known.
   */
  changesNotChecked: boolean;
  /** Lines added and removed, or null when they could not be counted (e.g. Git took too long). */
  added: number | null;
  removed: number | null;
}

export const DARK_THEME_IDS = ['graphite', 'midnight', 'ember', 'lagoon'] as const;
export type DarkThemeId = (typeof DARK_THEME_IDS)[number];
export const THEME_MODES = ['dark', 'light', 'system'] as const;
export type ThemeMode = (typeof THEME_MODES)[number];

export interface PersistedState {
  schemaVersion: typeof SCHEMA_VERSION;
  workspaces: Workspace[];
  activeWorkspaceId: string | null;
  settings: AppSettings;
}

export const LIMITS = {
  fontSize: { min: 8, max: 32, default: 14 },
  scrollback: { min: 500, max: 100_000, default: 10_000 },
  explorerWidth: { min: 160, max: 640, default: 260 },
  sidebarWidth: { min: 180, max: 420, default: 236 },
  /** Width of the collapsed workspace rail. Must match --sidebar-collapsed-width. */
  sidebarRailWidth: 52,
  /** Terminals keep at least this much width when sidebars are clamped. */
  minTerminalAreaWidth: 360,
  maxTabNameLength: 48,
  /** Largest file the editor opens or saves. */
  maxEditorFileBytes: 5 * 1024 * 1024,
  maxDirectoryEntries: 5000,
  maxWorkspaces: 64,
  maxPanesPerWorkspace: 16,
  maxTabsPerPane: 16,
  maxLayoutDepth: 8,
  maxNameLength: 120,
  maxPathLength: 1024,
  maxIdLength: 64,
  maxInputChunk: 64 * 1024,
  maxCols: 1000,
  maxRows: 500,
  maxStateBytes: 1024 * 1024,
  maxSessions: 64,
  minSplitFraction: 0.08,
} as const;

export const DEFAULT_SETTINGS: AppSettings = {
  defaultProfileId: null,
  fontSize: LIMITS.fontSize.default,
  scrollback: LIMITS.scrollback.default,
  startShellsOnRestore: false,
  sidebarCollapsed: false,
  sidebarWidth: LIMITS.sidebarWidth.default,
  explorerVisible: true,
  explorerWidth: LIMITS.explorerWidth.default,
  focusMode: false,
  shortPromptPaths: true,
  compactFolders: true,
  themeMode: 'dark',
  darkTheme: 'graphite',
  showGitStatus: true,
  resumeTitles: true,
  resumeAutomatically: false,
  updateCheck: true,
  updateNoticeSeen: false,
  lastVersionSeen: null,
  notifyNeedsYou: true,
  notifyFinished: true,
  notifyErrors: true,
  notifyWindows: true,
  notifyFlash: true,
  notifySound: true,
  notifyDetails: false,
  notifyEstimated: false,
};

export function emptyState(): PersistedState {
  return {
    schemaVersion: SCHEMA_VERSION,
    workspaces: [],
    activeWorkspaceId: null,
    settings: { ...DEFAULT_SETTINGS },
  };
}

export type StateNotice =
  | { kind: 'recovered-corrupt'; backupPath: string; reason: string }
  | { kind: 'unsupported-version'; backupPath: string; version: unknown };

export interface LoadStateResult {
  state: PersistedState;
  notice: StateNotice | null;
  stateFilePath: string;
}

// ----------------------------------------------------------------- errors

export type ErrorCode =
  | 'INVALID_REQUEST'
  | 'FORBIDDEN'
  | 'UNKNOWN_PROFILE'
  | 'SHELL_NOT_FOUND'
  | 'WORKSPACE_NOT_FOUND'
  | 'FOLDER_MISSING'
  | 'WSL_UNAVAILABLE'
  | 'WSL_PATH_UNMAPPED'
  | 'WSL_TIMEOUT'
  | 'SPAWN_FAILED'
  | 'SESSION_NOT_FOUND'
  | 'LIMIT_REACHED'
  | 'ACCESS_DENIED'
  | 'FILE_NOT_FOUND'
  | 'NOT_A_FILE'
  | 'FILE_TOO_LARGE'
  | 'BINARY_FILE'
  | 'READ_ONLY'
  | 'CONFLICT'
  | 'INTERNAL';

export interface AppError {
  code: ErrorCode;
  message: string;
  /** Short, non-sensitive technical detail. */
  detail?: string;
  /** Present when the user may explicitly choose an alternative. */
  fallback?: 'start-in-home';
}

export type Result<T> = ({ ok: true } & T) | { ok: false; error: AppError };

// --------------------------------------------------------------- sessions

export type SessionStatus = 'idle' | 'starting' | 'running' | 'exited' | 'failed';

export type StartLocation = 'workspace-root' | 'home';

export interface CreateSessionRequest {
  workspaceId: string;
  /** The terminal (tab) the session belongs to; one live session per tab. */
  paneId: string;
  profileId: string;
  startIn: StartLocation;
  cols: number;
  rows: number;
  /** Shorten the folder in default prompts (setting `shortPromptPaths`). */
  shortPrompt?: boolean;
  /**
   * Start in this folder instead of the workspace folder (resuming an agent where it ran). It
   * must be inside the workspace folder; PowerShell profiles only.
   */
  startPath?: string;
}

export type CreateSessionResult = Result<{
  sessionId: string;
  /** Human-readable starting directory (not updated after `cd`). */
  cwdLabel: string;
  profileLabel: string;
  /**
   * The console host redraws its whole screen after each resize (the system ConPTY on Windows).
   * The terminal then has to anchor its screen the way the console does (terminal-controller.ts).
   */
  repaintsOnResize: boolean;
}>;

export type SessionEvent =
  | { type: 'data'; sessionId: string; data: string }
  /** The PTY has applied this size; all output produced before it was delivered first. */
  | { type: 'resized'; sessionId: string; cols: number; rows: number }
  | { type: 'exit'; sessionId: string; exitCode: number | null; reason?: string };

// ---------------------------------------------------------- file explorer

export interface DirEntry {
  name: string;
  kind: 'file' | 'directory';
  /** Symbolic link or junction (kind describes its target when reachable). */
  symlink: boolean;
}

/** `relativePath` uses `/` separators and is relative to the workspace root ('' = root). */
export type ListDirectoryResult = Result<{ entries: DirEntry[]; truncated: boolean }>;

/** How a file's bytes map to text; kept as-is when saving. */
export type TextEncoding = 'utf8' | 'utf8bom' | 'utf16le';

export type ReadFileResult = Result<{
  content: string;
  encoding: TextEncoding;
  mtimeMs: number;
  size: number;
  /** SHA-256 of the file's bytes: the version used for conflict checks (not the mtime). */
  hash: string;
  /** Set when saving is not offered, with the reason shown to the user. */
  readOnly: string | null;
}>;

export interface WriteFileRequest {
  workspaceId: string;
  path: string;
  content: string;
  encoding: TextEncoding;
  /**
   * Content hash from the last read or successful save. If the bytes on disk
   * hash differently right before writing, the save fails with CONFLICT.
   */
  expectedHash: string;
  /** Save even if the file changed on disk (user confirmed "Overwrite"). */
  overwrite?: boolean;
}

export type WriteFileResult = Result<{ mtimeMs: number; size: number; hash: string }>;

/** `hash` is null only for files too large to open in the editor. */
export type StatFileResult = Result<{ mtimeMs: number; size: number; hash: string | null }>;

/** Sent by main when something happened to an open file's directory entry (may be a no-op). */
export interface FileChangedEvent {
  workspaceId: string;
  path: string;
}

export interface AppInfo {
  productName: string;
  version: string;
  electron: string;
  stateFilePath: string;
  logFilePath: string;
  isPackaged: boolean;
}
