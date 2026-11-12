// Pure split-tree operations. Every function returns a new tree and never
// mutates its input, so React state updates stay predictable.
import { LIMITS, type LayoutNode, type PaneLeaf, type SplitDirection, type SplitNode, type FileTab, type PaneTab, type TerminalTab } from './types';
import { isFileTab, isTerminalTab } from './types';

export type FocusDirection = 'left' | 'right' | 'up' | 'down';

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export function createPane(id: string, profileId: string, tabId: string = id): PaneLeaf {
  return { type: 'pane', id, tabs: [{ id: tabId, profileId }], activeTabId: tabId };
}

/** A pane whose first tab is a file in the editor. */
export function createFilePane(id: string, tab: FileTab): PaneLeaf {
  return { type: 'pane', id, tabs: [tab], activeTabId: tab.id };
}

export function activeTab(pane: PaneLeaf): PaneTab {
  return pane.tabs.find((t) => t.id === pane.activeTabId) ?? pane.tabs[0]!;
}

export function listTabs(node: LayoutNode | null): PaneTab[] {
  return listPanes(node).flatMap((p) => p.tabs);
}

export function listTerminalTabs(node: LayoutNode | null): TerminalTab[] {
  return listTabs(node).filter(isTerminalTab);
}

export function listFileTabs(node: LayoutNode | null): FileTab[] {
  return listTabs(node).filter(isFileTab);
}

export function findPaneOfTab(node: LayoutNode | null, tabId: string): PaneLeaf | null {
  return listPanes(node).find((p) => p.tabs.some((t) => t.id === tabId)) ?? null;
}

/** Applies `fn` to one pane; returns the same tree object when nothing changed. */
export function mapPane(root: LayoutNode, paneId: string, fn: (pane: PaneLeaf) => PaneLeaf): LayoutNode {
  if (root.type === 'pane') return root.id === paneId ? fn(root) : root;
  let changed = false;
  const children = root.children.map((c) => {
    const next = mapPane(c, paneId, fn);
    if (next !== c) changed = true;
    return next;
  });
  return changed ? { ...root, children } : root;
}

/** Adds a tab after the active tab and activates it. */
export function addTab(pane: PaneLeaf, tab: PaneTab, index?: number): PaneLeaf {
  const tabs = [...pane.tabs];
  const at = index ?? tabs.findIndex((t) => t.id === pane.activeTabId) + 1;
  tabs.splice(Math.max(0, Math.min(tabs.length, at)), 0, tab);
  return { ...pane, tabs, activeTabId: tab.id };
}

/** Removes a tab. Returns null when it was the last one (the pane should close). */
export function removeTab(pane: PaneLeaf, tabId: string): PaneLeaf | null {
  const index = pane.tabs.findIndex((t) => t.id === tabId);
  if (index < 0) return pane;
  const tabs = pane.tabs.filter((t) => t.id !== tabId);
  if (tabs.length === 0) return null;
  const activeTabId = pane.activeTabId === tabId ? (tabs[Math.min(index, tabs.length - 1)]!.id) : pane.activeTabId;
  return { ...pane, tabs, activeTabId };
}

export function setActiveTab(pane: PaneLeaf, tabId: string): PaneLeaf {
  if (pane.activeTabId === tabId || !pane.tabs.some((t) => t.id === tabId)) return pane;
  return { ...pane, activeTabId: tabId };
}

/** Moves a tab within its pane to `toIndex` (index in the list without the moved tab). */
export function reorderTab(pane: PaneLeaf, tabId: string, toIndex: number): PaneLeaf {
  const tab = pane.tabs.find((t) => t.id === tabId);
  if (!tab) return pane;
  const rest = pane.tabs.filter((t) => t.id !== tabId);
  rest.splice(Math.max(0, Math.min(rest.length, toIndex)), 0, tab);
  if (rest.every((t, i) => t === pane.tabs[i])) return pane;
  return { ...pane, tabs: rest };
}

export function listPanes(node: LayoutNode | null): PaneLeaf[] {
  if (!node) return [];
  if (node.type === 'pane') return [node];
  return node.children.flatMap((child) => listPanes(child));
}

export function findPane(node: LayoutNode | null, paneId: string): PaneLeaf | null {
  return listPanes(node).find((pane) => pane.id === paneId) ?? null;
}

export function layoutDepth(node: LayoutNode | null): number {
  if (!node) return 0;
  if (node.type === 'pane') return 1;
  return 1 + Math.max(...node.children.map(layoutDepth));
}

export function normalizeSizes(sizes: number[]): number[] {
  if (sizes.length === 0) return [];
  const cleaned = sizes.map((s) => (Number.isFinite(s) && s > 0 ? s : 0));
  const total = cleaned.reduce((a, b) => a + b, 0);
  if (total <= 0) return sizes.map(() => 1 / sizes.length);
  return cleaned.map((s) => s / total);
}

/**
 * Splits `targetPaneId`, placing `newPane` after it. Splitting in the same
 * direction as the parent adds a sibling instead of nesting another split.
 */
export function splitPane(
  root: LayoutNode,
  targetPaneId: string,
  direction: SplitDirection,
  newPane: PaneLeaf,
  newSplitId: string,
): LayoutNode {
  if (root.type === 'pane') {
    if (root.id !== targetPaneId) return root;
    return { type: 'split', id: newSplitId, direction, children: [root, newPane], sizes: [0.5, 0.5] };
  }
  const index = root.children.findIndex((c) => c.type === 'pane' && c.id === targetPaneId);
  if (index >= 0 && root.direction === direction) {
    const share = root.sizes[index] ?? 1 / root.children.length;
    const children = [...root.children];
    children.splice(index + 1, 0, newPane);
    const sizes = [...root.sizes];
    sizes.splice(index, 1, share / 2, share / 2);
    return { ...root, children, sizes: normalizeSizes(sizes) };
  }
  return {
    ...root,
    children: root.children.map((child) => splitPane(child, targetPaneId, direction, newPane, newSplitId)),
  };
}

/** Removes a pane. Space goes to the remaining siblings; single-child splits collapse. */
export function removePane(root: LayoutNode, paneId: string): LayoutNode | null {
  if (root.type === 'pane') return root.id === paneId ? null : root;
  const children: LayoutNode[] = [];
  const sizes: number[] = [];
  root.children.forEach((child, i) => {
    const next = removePane(child, paneId);
    if (next) {
      children.push(next);
      sizes.push(root.sizes[i] ?? 0);
    }
  });
  if (children.length === 0) return null;
  if (children.length === 1) return children[0] ?? null;
  return flattenSplit({ ...root, children, sizes: normalizeSizes(sizes) });
}

/** Merges child splits that share the parent's direction. */
function flattenSplit(node: SplitNode): SplitNode {
  const children: LayoutNode[] = [];
  const sizes: number[] = [];
  node.children.forEach((child, i) => {
    const share = node.sizes[i] ?? 0;
    if (child.type === 'split' && child.direction === node.direction) {
      child.children.forEach((grandChild, j) => {
        children.push(grandChild);
        sizes.push(share * (child.sizes[j] ?? 0));
      });
    } else {
      children.push(child);
      sizes.push(share);
    }
  });
  return { ...node, children, sizes: normalizeSizes(sizes) };
}

export function setSplitSizes(root: LayoutNode, splitId: string, sizes: number[]): LayoutNode {
  if (root.type === 'pane') return root;
  if (root.id === splitId) {
    if (sizes.length !== root.children.length) return root;
    return { ...root, sizes: normalizeSizes(sizes) };
  }
  return { ...root, children: root.children.map((c) => setSplitSizes(c, splitId, sizes)) };
}

/**
 * Moves the boundary between child `index` and `index + 1` by `delta`
 * (fraction of the split), keeping both sides above `min`.
 */
export function resizeAt(sizes: number[], index: number, delta: number, min: number = LIMITS.minSplitFraction): number[] {
  const a = sizes[index];
  const b = sizes[index + 1];
  if (a === undefined || b === undefined || !Number.isFinite(delta)) return sizes;
  const pair = a + b;
  const floor = Math.min(min, pair / 2);
  const nextA = Math.min(Math.max(a + delta, floor), pair - floor);
  const next = [...sizes];
  next[index] = nextA;
  next[index + 1] = pair - nextA;
  return next;
}

/** Pane rectangles in a unit square, used for directional focus movement. */
export function computeRects(root: LayoutNode | null): Map<string, Rect> {
  const rects = new Map<string, Rect>();
  const walk = (node: LayoutNode, rect: Rect) => {
    if (node.type === 'pane') {
      rects.set(node.id, rect);
      return;
    }
    let offset = 0;
    node.children.forEach((child, i) => {
      const share = node.sizes[i] ?? 0;
      const childRect =
        node.direction === 'row'
          ? { x: rect.x + offset * rect.w, y: rect.y, w: share * rect.w, h: rect.h }
          : { x: rect.x, y: rect.y + offset * rect.h, w: rect.w, h: share * rect.h };
      offset += share;
      walk(child, childRect);
    });
  };
  if (root) walk(root, { x: 0, y: 0, w: 1, h: 1 });
  return rects;
}

export function neighborPane(root: LayoutNode | null, paneId: string, direction: FocusDirection): string | null {
  const rects = computeRects(root);
  const from = rects.get(paneId);
  if (!from) return null;
  const eps = 1e-6;
  const cx = from.x + from.w / 2;
  const cy = from.y + from.h / 2;
  let best: { id: string; score: number } | null = null;
  for (const [id, r] of rects) {
    if (id === paneId) continue;
    let gap: number;
    let overlap: number;
    switch (direction) {
      case 'left':
        gap = from.x - (r.x + r.w);
        overlap = Math.min(from.y + from.h, r.y + r.h) - Math.max(from.y, r.y);
        break;
      case 'right':
        gap = r.x - (from.x + from.w);
        overlap = Math.min(from.y + from.h, r.y + r.h) - Math.max(from.y, r.y);
        break;
      case 'up':
        gap = from.y - (r.y + r.h);
        overlap = Math.min(from.x + from.w, r.x + r.w) - Math.max(from.x, r.x);
        break;
      case 'down':
        gap = r.y - (from.y + from.h);
        overlap = Math.min(from.x + from.w, r.x + r.w) - Math.max(from.x, r.x);
        break;
    }
    if (gap < -eps || overlap <= eps) continue;
    const distance = Math.hypot(r.x + r.w / 2 - cx, r.y + r.h / 2 - cy);
    const score = gap * 10 + distance;
    if (!best || score < best.score) best = { id, score };
  }
  return best?.id ?? null;
}

/** Suggests a split direction for "new terminal": split along the longer side. */
export function preferredSplitDirection(root: LayoutNode | null, paneId: string, aspect = 16 / 9): SplitDirection {
  const rect = computeRects(root).get(paneId);
  if (!rect) return 'row';
  return rect.w * aspect >= rect.h ? 'row' : 'column';
}
