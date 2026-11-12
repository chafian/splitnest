// Pure reducer for persisted workspace state (layout, tabs, workspaces,
// settings). Runtime session state lives in terminal controllers, not here.
import type { AgentResume } from '../../../shared/agent-resume';
import {
  addTab,
  createFilePane,
  createPane,
  findPane,
  findPaneOfTab,
  layoutDepth,
  listPanes,
  mapPane,
  preferredSplitDirection,
  removePane,
  removeTab,
  reorderTab,
  setActiveTab,
  setSplitSizes,
  splitPane,
} from '../../../shared/layout';
import {
  emptyState,
  LIMITS,
  type AppSettings,
  type LayoutNode,
  type PersistedState,
  type SplitDirection,
  type SplitNode,
  isTerminalTab,
  type PaneTab,
  type TerminalTab,
  type Workspace,
} from '../../../shared/types';
import { normalizeTabName } from '../../../shared/validation';

export type Action =
  | { type: 'load'; state: PersistedState }
  | { type: 'addWorkspace'; workspace: Workspace }
  | { type: 'renameWorkspace'; workspaceId: string; name: string }
  | { type: 'relinkWorkspace'; workspaceId: string; rootPath: string }
  | { type: 'removeWorkspace'; workspaceId: string }
  | { type: 'activateWorkspace'; workspaceId: string }
  | {
      type: 'addPane';
      workspaceId: string;
      paneId: string;
      /** Id of the pane's first tab; defaults to the pane id. */
      tabId?: string;
      splitId: string;
      profileId: string;
      /** When set, the pane opens this workspace-relative file instead of a terminal (profileId is ignored). */
      filePath?: string;
      direction?: SplitDirection;
      targetPaneId?: string;
    }
  | { type: 'removePane'; workspaceId: string; paneId: string }
  | { type: 'addTab'; workspaceId: string; paneId: string; tabId: string; profileId: string; filePath?: string }
  | { type: 'closeTab'; workspaceId: string; tabId: string }
  | { type: 'activateTab'; workspaceId: string; tabId: string }
  | { type: 'moveTab'; workspaceId: string; tabId: string; toPaneId: string; toIndex: number }
  | { type: 'setTabProfile'; workspaceId: string; tabId: string; profileId: string }
  /** Blank `name` resets the tab to its default shell label. */
  | { type: 'renameTab'; workspaceId: string; tabId: string; name: string }
  | { type: 'setTabResume'; workspaceId: string; tabId: string; resume: AgentResume | null }
  | { type: 'setSplitSizes'; workspaceId: string; splitId: string; sizes: number[] }
  | { type: 'focusPane'; workspaceId: string; paneId: string }
  | { type: 'updateSettings'; patch: Partial<AppSettings> };

function mapWorkspace(state: PersistedState, id: string, fn: (w: Workspace) => Workspace): PersistedState {
  let changed = false;
  const workspaces = state.workspaces.map((w) => {
    if (w.id !== id) return w;
    const next = fn(w);
    if (next !== w) changed = true;
    return next;
  });
  return changed ? { ...state, workspaces } : state;
}

function findParentSplit(node: LayoutNode, paneId: string): SplitNode | null {
  if (node.type === 'pane') return null;
  if (node.children.some((c) => c.type === 'pane' && c.id === paneId)) return node;
  for (const child of node.children) {
    const found = findParentSplit(child, paneId);
    if (found) return found;
  }
  return null;
}

export function canAddPane(workspace: Workspace): boolean {
  return listPanes(workspace.layout).length < LIMITS.maxPanesPerWorkspace;
}

export function canAddTab(workspace: Workspace, paneId: string): boolean {
  const pane = findPane(workspace.layout, paneId);
  return !!pane && pane.tabs.length < LIMITS.maxTabsPerPane;
}

/** Removes a pane and moves focus to a neighbour when needed. */
function withoutPane(w: Workspace, paneId: string): Workspace {
  if (!w.layout || !findPane(w.layout, paneId)) return w;
  const index = listPanes(w.layout).findIndex((p) => p.id === paneId);
  const layout = removePane(w.layout, paneId);
  const after = listPanes(layout);
  let activePaneId = w.activePaneId;
  if (activePaneId === paneId || !after.some((p) => p.id === activePaneId)) {
    activePaneId = after[Math.max(0, index - 1)]?.id ?? after[0]?.id ?? null;
  }
  return { ...w, layout, activePaneId };
}

function withoutTab(w: Workspace, tabId: string): Workspace {
  const pane = findPaneOfTab(w.layout, tabId);
  if (!w.layout || !pane) return w;
  const next = removeTab(pane, tabId);
  if (!next) return withoutPane(w, pane.id);
  return { ...w, layout: mapPane(w.layout, pane.id, () => next) };
}

export function reducer(state: PersistedState, action: Action): PersistedState {
  switch (action.type) {
    case 'load':
      return action.state;
    case 'addWorkspace':
      if (state.workspaces.length >= LIMITS.maxWorkspaces) return state;
      return { ...state, workspaces: [...state.workspaces, action.workspace], activeWorkspaceId: action.workspace.id };
    case 'renameWorkspace': {
      const name = action.name.trim().slice(0, LIMITS.maxNameLength);
      if (!name) return state;
      return mapWorkspace(state, action.workspaceId, (w) => (w.name === name ? w : { ...w, name }));
    }
    case 'relinkWorkspace':
      return mapWorkspace(state, action.workspaceId, (w) => ({ ...w, rootPath: action.rootPath }));
    case 'removeWorkspace': {
      const index = state.workspaces.findIndex((w) => w.id === action.workspaceId);
      if (index < 0) return state;
      const workspaces = state.workspaces.filter((w) => w.id !== action.workspaceId);
      const activeWorkspaceId =
        state.activeWorkspaceId === action.workspaceId
          ? (workspaces[Math.min(index, workspaces.length - 1)]?.id ?? null)
          : state.activeWorkspaceId;
      return { ...state, workspaces, activeWorkspaceId };
    }
    case 'activateWorkspace':
      if (!state.workspaces.some((w) => w.id === action.workspaceId)) return state;
      return { ...state, activeWorkspaceId: action.workspaceId };
    case 'addPane':
      return mapWorkspace(state, action.workspaceId, (w) => {
        if (!canAddPane(w)) return w;
        const tabId = action.tabId ?? action.paneId;
        const pane = action.filePath
          ? createFilePane(action.paneId, { id: tabId, kind: 'file', path: action.filePath })
          : createPane(action.paneId, action.profileId, tabId);
        if (!w.layout) return { ...w, layout: pane, activePaneId: pane.id };
        const target = action.targetPaneId ?? w.activePaneId ?? listPanes(w.layout)[0]?.id;
        if (!target || !findPane(w.layout, target)) return w;
        const direction = action.direction ?? preferredSplitDirection(w.layout, target);
        let layout = splitPane(w.layout, target, direction, pane, action.splitId);
        if (layoutDepth(layout) > LIMITS.maxLayoutDepth) {
          // Too deep: add a sibling in the parent's direction, which never adds depth.
          const parent = findParentSplit(w.layout, target);
          if (!parent) return w;
          layout = splitPane(w.layout, target, parent.direction, pane, action.splitId);
          if (layoutDepth(layout) > LIMITS.maxLayoutDepth) return w;
        }
        return { ...w, layout, activePaneId: pane.id };
      });
    case 'removePane':
      return mapWorkspace(state, action.workspaceId, (w) => withoutPane(w, action.paneId));
    case 'addTab':
      return mapWorkspace(state, action.workspaceId, (w) => {
        if (!w.layout || !canAddTab(w, action.paneId)) return w;
        const tab: PaneTab = action.filePath ? { id: action.tabId, kind: 'file', path: action.filePath } : { id: action.tabId, profileId: action.profileId };
        const layout = mapPane(w.layout, action.paneId, (p) => addTab(p, tab));
        return { ...w, layout, activePaneId: action.paneId };
      });
    case 'closeTab':
      return mapWorkspace(state, action.workspaceId, (w) => withoutTab(w, action.tabId));
    case 'activateTab':
      return mapWorkspace(state, action.workspaceId, (w) => {
        const pane = findPaneOfTab(w.layout, action.tabId);
        if (!w.layout || !pane) return w;
        const layout = mapPane(w.layout, pane.id, (p) => setActiveTab(p, action.tabId));
        return layout === w.layout && w.activePaneId === pane.id ? w : { ...w, layout, activePaneId: pane.id };
      });
    case 'moveTab':
      return mapWorkspace(state, action.workspaceId, (w) => {
        const from = findPaneOfTab(w.layout, action.tabId);
        const to = findPane(w.layout, action.toPaneId);
        if (!w.layout || !from || !to) return w;
        if (from.id === to.id) {
          return { ...w, layout: mapPane(w.layout, from.id, (p) => setActiveTab(reorderTab(p, action.tabId, action.toIndex), action.tabId)) };
        }
        if (to.tabs.length >= LIMITS.maxTabsPerPane) return w;
        const tab = from.tabs.find((t) => t.id === action.tabId)!;
        const moved = withoutTab(w, action.tabId);
        if (!moved.layout || !findPane(moved.layout, to.id)) return w;
        const layout = mapPane(moved.layout, to.id, (p) => addTab(p, tab, action.toIndex));
        return { ...moved, layout, activePaneId: to.id };
      });
    case 'setTabProfile':
      return mapWorkspace(state, action.workspaceId, (w) => {
        const pane = findPaneOfTab(w.layout, action.tabId);
        if (!w.layout || !pane) return w;
        const layout = mapPane(w.layout, pane.id, (p) => ({
          ...p,
          tabs: p.tabs.map((t) => (t.id === action.tabId && isTerminalTab(t) ? { ...t, profileId: action.profileId } : t)),
        }));
        return { ...w, layout };
      });
    case 'renameTab':
      return mapWorkspace(state, action.workspaceId, (w) => {
        const pane = findPaneOfTab(w.layout, action.tabId);
        const tab = pane?.tabs.find((t) => t.id === action.tabId);
        if (!w.layout || !pane || !tab || !isTerminalTab(tab)) return w;
        const name = normalizeTabName(action.name);
        if ((tab.name ?? null) === name) return w;
        const renamed: TerminalTab = { ...tab, name: name ?? undefined };
        if (!name) delete renamed.name;
        const layout = mapPane(w.layout, pane.id, (p) => ({ ...p, tabs: p.tabs.map((t) => (t.id === action.tabId ? renamed : t)) }));
        return { ...w, layout };
      });
    case 'setTabResume':
      return mapWorkspace(state, action.workspaceId, (w) => {
        const pane = findPaneOfTab(w.layout, action.tabId);
        const tab = pane?.tabs.find((t) => t.id === action.tabId);
        if (!w.layout || !pane || !tab || !isTerminalTab(tab)) return w;
        if (JSON.stringify(tab.resume ?? null) === JSON.stringify(action.resume)) return w;
        const next: TerminalTab = { ...tab };
        if (action.resume) next.resume = action.resume;
        else delete next.resume;
        const layout = mapPane(w.layout, pane.id, (p) => ({ ...p, tabs: p.tabs.map((t) => (t.id === action.tabId ? next : t)) }));
        return { ...w, layout };
      });
    case 'setSplitSizes':
      return mapWorkspace(state, action.workspaceId, (w) =>
        w.layout ? { ...w, layout: setSplitSizes(w.layout, action.splitId, action.sizes) } : w,
      );
    case 'focusPane':
      return mapWorkspace(state, action.workspaceId, (w) =>
        w.activePaneId === action.paneId || !findPane(w.layout, action.paneId) ? w : { ...w, activePaneId: action.paneId },
      );
    case 'updateSettings': {
      const next = { ...state, settings: { ...state.settings, ...action.patch } };
      // Titles off: the ones already saved go too, not only future ones.
      return action.patch.resumeTitles === false ? withoutResumeTitles(next) : next;
    }
    default:
      return state;
  }
}

export const initialState: PersistedState = emptyState();

/** Every terminal's saved conversation title removed (setting `resumeTitles` turned off). */
function withoutResumeTitles(state: PersistedState): PersistedState {
  const strip = (node: LayoutNode): LayoutNode =>
    node.type === 'pane'
      ? {
          ...node,
          tabs: node.tabs.map((t) => {
            if (!isTerminalTab(t) || !t.resume?.title) return t;
            const { title: _title, ...resume } = t.resume;
            return { ...t, resume };
          }),
        }
      : { ...node, children: node.children.map(strip) };
  return { ...state, workspaces: state.workspaces.map((w) => (w.layout ? { ...w, layout: strip(w.layout) } : w)) };
}
