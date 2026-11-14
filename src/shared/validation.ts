// Runtime validation for untrusted data: persisted state files and IPC payloads.
import { parseWorkspaceTask } from './tasks';
import { parseAgentResume } from './agent-resume';
import { layoutDepth, listPanes, normalizeSizes } from './layout';
import { isVersion } from './version';
import {
  DARK_THEME_IDS,
  DEFAULT_SETTINGS,
  LIMITS,
  SCHEMA_VERSION,
  THEME_MODES,
  type AppSettings,
  type DarkThemeId,
  type ThemeMode,
  type CreateSessionRequest,
  type LayoutNode,
  type PersistedState,
  type StartLocation,
  type PaneTab,
  type ChangesPanelState,
  type Workspace,
} from './types';

export class ValidationError extends Error {}

const HEX_COLOR = /^#[0-9a-f]{6}$/i;

/** Window colours sent by the renderer (Appearance): three `#rrggbb` values, nothing else. */
export function parseWindowTheme(value: unknown): { background: string; titleBar: string; symbol: string } | null {
  if (typeof value !== 'object' || value === null) return null;
  const v = value as Record<string, unknown>;
  const ok = (x: unknown): x is string => typeof x === 'string' && HEX_COLOR.test(x);
  if (!ok(v.background) || !ok(v.titleBar) || !ok(v.symbol)) return null;
  return { background: v.background, titleBar: v.titleBar, symbol: v.symbol };
}

const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const DISTRO_RE = /^[A-Za-z0-9._-]{1,64}$/;

export function isId(value: unknown): value is string {
  return typeof value === 'string' && ID_RE.test(value);
}

export function isDistroName(value: unknown): value is string {
  return typeof value === 'string' && DISTRO_RE.test(value);
}

export function isProfileId(value: unknown): value is string {
  if (value === 'pwsh' || value === 'windows-powershell') return true;
  return typeof value === 'string' && value.startsWith('wsl:') && isDistroName(value.slice(4));
}

/** Absolute drive-letter (`C:\x`) or UNC (`\\server\share`) path without control characters. */
export function isAbsoluteWindowsPath(value: unknown): value is string {
  if (typeof value !== 'string' || value.length < 3 || value.length > LIMITS.maxPathLength) return false;
   
  if (/[\u0000-\u001f]/.test(value)) return false;
  return /^[A-Za-z]:[\\/]/.test(value) || /^\\\\[^\\/]+[\\/][^\\/]+/.test(value);
}

export function isInt(value: unknown, min: number, max: number): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max;
}

function fail(message: string): never {
  throw new ValidationError(message);
}

function record(value: unknown, what: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) fail(`${what} must be an object`);
  return value as Record<string, unknown>;
}

function name(value: unknown, what: string): string {
  if (typeof value !== 'string') fail(`${what} must be a string`);
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > LIMITS.maxNameLength) fail(`${what} has an invalid length`);
  return trimmed;
}

/**
 * A workspace-relative file path as stored in a file tab: `/`-separated, no
 * empty, `.` or `..` segments, no drive letters, streams, wildcards or control
 * characters. Main re-resolves it against the workspace root on every access.
 */
export function normalizeRelativeFilePath(value: unknown): string | null {
  if (typeof value !== 'string' || value.length === 0 || value.length > LIMITS.maxPathLength) return null;
  if (/[\u0000-\u001f:*?"<>|]/.test(value) || /^[\\/]/.test(value)) return null;
  const segments = value.split(/[\\/]+/).filter(Boolean);
  if (segments.length === 0 || segments.some((s) => s === '.' || s === '..' || /[. ]$/.test(s))) return null;
  return segments.join('/');
}

function validateTab(value: unknown, tabSeen: Set<string>): PaneTab {
  const tab = record(value, 'tab');
  if (!isId(tab.id)) fail('tab id is invalid');
  if (tabSeen.has(tab.id)) fail('tab ids must be unique');
  tabSeen.add(tab.id);
  if (tab.kind === 'file') {
    const p = normalizeRelativeFilePath(tab.path);
    if (!p) fail('file tab path is invalid');
    return { id: tab.id, kind: 'file', path: p };
  }
  if (tab.kind !== undefined && tab.kind !== 'terminal') fail('tab kind is invalid');
  if (!isProfileId(tab.profileId)) fail('tab profile is invalid');
  const name = normalizeTabName(tab.name);
  // An odd resume record only loses Resume, never the layout.
  const resume = tab.resume === undefined ? null : parseAgentResume(tab.resume);
  return { id: tab.id, profileId: tab.profileId, ...(name ? { name } : {}), ...(resume ? { resume } : {}) };
}

/**
 * A custom tab label, or null for "use the default shell label". Control
 * characters are removed and whitespace collapsed; never fails, so an odd
 * name in a saved file only loses the name, not the layout.
 */
export function normalizeTabName(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const clean = value.replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').replace(/\s+/g, ' ').trim();
  return clean ? [...clean].slice(0, LIMITS.maxTabNameLength).join('').trim() : null;
}

export function validateLayout(value: unknown, seen = new Set<string>(), depth = 1, tabSeen = new Set<string>()): LayoutNode {
  if (depth > LIMITS.maxLayoutDepth) fail('layout is nested too deeply');
  const node = record(value, 'layout node');
  if (!isId(node.id)) fail('layout node id is invalid');
  if (seen.has(node.id)) fail('layout node ids must be unique');
  seen.add(node.id);
  if (node.type === 'pane') {
    // Schema 1 panes held a single terminal: { id, profileId }. They become one tab with the pane's id.
    const rawTabs = node.tabs === undefined && node.profileId !== undefined ? [{ id: node.id, profileId: node.profileId }] : node.tabs;
    if (!Array.isArray(rawTabs) || rawTabs.length < 1 || rawTabs.length > LIMITS.maxTabsPerPane) fail('pane must have between 1 and 16 tabs');
    const tabs = rawTabs.map((t) => validateTab(t, tabSeen));
    const activeTabId = tabs.some((t) => t.id === node.activeTabId) ? (node.activeTabId as string) : tabs[0]!.id;
    return { type: 'pane', id: node.id, tabs, activeTabId };
  }
  if (node.type !== 'split') fail('layout node type is invalid');
  if (node.direction !== 'row' && node.direction !== 'column') fail('split direction is invalid');
  if (!Array.isArray(node.children) || node.children.length < 2 || node.children.length > LIMITS.maxPanesPerWorkspace) {
    fail('split must have between 2 and 16 children');
  }
  if (!Array.isArray(node.sizes) || node.sizes.length !== node.children.length) fail('split sizes do not match children');
  const sizes = node.sizes.map((s) => {
    if (typeof s !== 'number' || !Number.isFinite(s) || s <= 0 || s > 1) fail('split size is invalid');
    return s;
  });
  const children = node.children.map((c) => validateLayout(c, seen, depth + 1, tabSeen));
  return { type: 'split', id: node.id, direction: node.direction, children, sizes: normalizeSizes(sizes) };
}

export function validateWorkspace(value: unknown): Workspace {
  const w = record(value, 'workspace');
  if (!isId(w.id)) fail('workspace id is invalid');
  if (!isAbsoluteWindowsPath(w.rootPath)) fail('workspace folder must be an absolute Windows path');
  const layout = w.layout === null || w.layout === undefined ? null : validateLayout(w.layout);
  const panes = listPanes(layout);
  if (panes.length > LIMITS.maxPanesPerWorkspace) fail('too many panes in workspace');
  if (layoutDepth(layout) > LIMITS.maxLayoutDepth) fail('layout is nested too deeply');
  let activePaneId: string | null = null;
  if (typeof w.activePaneId === 'string' && panes.some((p) => p.id === w.activePaneId)) activePaneId = w.activePaneId;
  else if (panes[0]) activePaneId = panes[0].id;
  // A task record that doesn't check out is dropped; the workspace itself still loads.
  const task = w.task === undefined ? null : parseWorkspaceTask(w.task, w.rootPath);
  // Only for tasks; anything odd is dropped (the panel then opens as for a new task).
  const panel = task ? parseChangesPanel(w.changesPanel) : null;
  return { id: w.id, name: name(w.name, 'workspace name'), rootPath: w.rootPath, layout, activePaneId, ...(task ? { task } : {}), ...(panel ? { changesPanel: panel } : {}) };
}

export function parseChangesPanel(v: unknown): ChangesPanelState | null {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const p = v as Record<string, unknown>;
  if (typeof p.open !== 'boolean' || typeof p.width !== 'number' || !Number.isFinite(p.width)) return null;
  return { open: p.open, width: Math.round(Math.min(LIMITS.changesWidth.max, Math.max(LIMITS.changesWidth.min, p.width))) };
}

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.round(value)));
}

/** Settings are clamped to safe bounds rather than rejected. */
export function validateSettings(value: unknown): AppSettings {
  const s = value === undefined ? {} : record(value, 'settings');
  return {
    defaultProfileId: isProfileId(s.defaultProfileId) ? s.defaultProfileId : DEFAULT_SETTINGS.defaultProfileId,
    fontSize: clampInt(s.fontSize, LIMITS.fontSize.min, LIMITS.fontSize.max, DEFAULT_SETTINGS.fontSize),
    scrollback: clampInt(s.scrollback, LIMITS.scrollback.min, LIMITS.scrollback.max, DEFAULT_SETTINGS.scrollback),
    startShellsOnRestore: s.startShellsOnRestore === true,
    sidebarCollapsed: s.sidebarCollapsed === true,
    sidebarWidth: clampInt(s.sidebarWidth, LIMITS.sidebarWidth.min, LIMITS.sidebarWidth.max, DEFAULT_SETTINGS.sidebarWidth),
    explorerVisible: s.explorerVisible !== false,
    explorerWidth: clampInt(s.explorerWidth, LIMITS.explorerWidth.min, LIMITS.explorerWidth.max, DEFAULT_SETTINGS.explorerWidth),
    focusMode: s.focusMode === true,
    shortPromptPaths: s.shortPromptPaths !== false,
    compactFolders: s.compactFolders !== false,
    themeMode: (THEME_MODES as readonly unknown[]).includes(s.themeMode) ? (s.themeMode as ThemeMode) : DEFAULT_SETTINGS.themeMode,
    darkTheme: (DARK_THEME_IDS as readonly unknown[]).includes(s.darkTheme) ? (s.darkTheme as DarkThemeId) : DEFAULT_SETTINGS.darkTheme,
    showGitStatus: s.showGitStatus !== false,
    resumeTitles: s.resumeTitles !== false,
    resumeAutomatically: s.resumeAutomatically === true,
    updateCheck: s.updateCheck !== false,
    updateNoticeSeen: s.updateNoticeSeen === true,
    lastVersionSeen: isVersion(s.lastVersionSeen) ? s.lastVersionSeen : null,
    notifyNeedsYou: s.notifyNeedsYou !== false,
    notifyFinished: s.notifyFinished !== false,
    notifyErrors: s.notifyErrors !== false,
    notifyWindows: s.notifyWindows !== false,
    notifyFlash: s.notifyFlash !== false,
    notifySound: s.notifySound !== false,
    notifyDetails: s.notifyDetails === true,
    notifyEstimated: s.notifyEstimated === true,
    agentTasks: s.agentTasks !== false,
  };
}

export type ParseStateResult =
  | { ok: true; state: PersistedState }
  | { ok: false; reason: string; unsupportedVersion?: unknown };

export function parsePersistedState(raw: unknown): ParseStateResult {
  try {
    const s = record(raw, 'state');
    // Version 1 differs only in pane shape, which validateLayout migrates.
    if (s.schemaVersion !== SCHEMA_VERSION && s.schemaVersion !== 1 && s.schemaVersion !== 2) {
      return { ok: false, reason: `unsupported schema version`, unsupportedVersion: s.schemaVersion };
    }
    if (!Array.isArray(s.workspaces)) fail('workspaces must be an array');
    if (s.workspaces.length > LIMITS.maxWorkspaces) fail('too many workspaces');
    const workspaces = s.workspaces.map(validateWorkspace);
    const ids = new Set<string>();
    const nodeIds = new Set<string>();
    const tabIds = new Set<string>();
    for (const w of workspaces) {
      if (ids.has(w.id)) fail('workspace ids must be unique');
      ids.add(w.id);
      for (const p of listPanes(w.layout)) {
        if (nodeIds.has(p.id)) fail('pane ids must be unique across workspaces');
        nodeIds.add(p.id);
        for (const t of p.tabs) {
          if (tabIds.has(t.id)) fail('tab ids must be unique across workspaces');
          tabIds.add(t.id);
        }
      }
    }
    const activeWorkspaceId =
      typeof s.activeWorkspaceId === 'string' && ids.has(s.activeWorkspaceId)
        ? s.activeWorkspaceId
        : (workspaces[0]?.id ?? null);
    return {
      ok: true,
      state: { schemaVersion: SCHEMA_VERSION, workspaces, activeWorkspaceId, settings: validateSettings(s.settings) },
    };
  } catch (error) {
    if (error instanceof ValidationError) return { ok: false, reason: error.message };
    throw error;
  }
}

export function validateCreateSessionRequest(value: unknown): CreateSessionRequest {
  const r = record(value, 'request');
  if (!isId(r.workspaceId)) fail('workspaceId is invalid');
  if (!isId(r.paneId)) fail('paneId is invalid');
  if (!isProfileId(r.profileId)) fail('profileId is invalid');
  const startIn: StartLocation = r.startIn === 'home' ? 'home' : 'workspace-root';
  if (r.startIn !== undefined && r.startIn !== 'home' && r.startIn !== 'workspace-root') fail('startIn is invalid');
  if (!isInt(r.cols, 2, LIMITS.maxCols)) fail('cols is out of range');
  if (!isInt(r.rows, 1, LIMITS.maxRows)) fail('rows is out of range');
  if (r.shortPrompt !== undefined && typeof r.shortPrompt !== 'boolean') fail('shortPrompt is invalid');
  if (r.startPath !== undefined && (!isAbsoluteWindowsPath(r.startPath) || startIn !== 'workspace-root')) fail('startPath is invalid');
  return {
    workspaceId: r.workspaceId,
    paneId: r.paneId,
    profileId: r.profileId,
    startIn,
    cols: r.cols,
    rows: r.rows,
    shortPrompt: r.shortPrompt === true,
    ...(r.startPath !== undefined ? { startPath: r.startPath as string } : {}),
  };
}

export function isAllowedExternalUrl(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 2048) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:';
  } catch {
    return false;
  }
}
