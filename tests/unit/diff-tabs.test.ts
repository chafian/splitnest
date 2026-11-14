// Diff tabs: never saved (a build that doesn't know them would reject the whole state file), never
// mistaken for terminals, and added like file tabs.
import { describe, expect, it } from 'vitest';
import { listPanes, listTabs, listTerminalTabs, withoutDiffTabs } from '../../src/shared/layout';
import { DEFAULT_SETTINGS, isDiffTab, isFileTab, isTerminalTab, type PaneLeaf, type PersistedState, type SplitNode, type Workspace } from '../../src/shared/types';
import { parsePersistedState } from '../../src/shared/validation';
import { reducer } from '../../src/renderer/features/workspaces/workspace-state';

const term = { id: 't1', profileId: 'windows-powershell' };
const file = { id: 'f1', kind: 'file' as const, path: 'src/a.ts' };
const diff = (id: string, path = 'src/a.ts') => ({ id, kind: 'diff' as const, path });
const pane = (id: string, tabs: PaneLeaf['tabs'], activeTabId = tabs[0]!.id): PaneLeaf => ({ type: 'pane', id, tabs, activeTabId });
const split = (children: SplitNode['children']): SplitNode => ({ type: 'split', id: 's', direction: 'row', children, sizes: children.map(() => 1 / children.length) });
const state = (layout: Workspace['layout'], activePaneId: string | null): PersistedState => ({
  schemaVersion: 3,
  workspaces: [{ id: 'w', name: 'W', rootPath: 'C:\\w', layout, activePaneId }],
  activeWorkspaceId: 'w',
  settings: DEFAULT_SETTINGS,
});

describe('kinds', () => {
  it('a diff tab is neither a terminal nor a file; tabs saved before kinds existed are terminals', () => {
    expect([isTerminalTab(diff('d')), isFileTab(diff('d')), isDiffTab(diff('d'))]).toEqual([false, false, true]);
    expect(isTerminalTab(term)).toBe(true);
    expect(isTerminalTab({ ...term, kind: 'terminal' })).toBe(true);
    expect(isTerminalTab(file)).toBe(false);
    expect(listTerminalTabs(pane('p', [term, diff('d')])).map((t) => t.id)).toEqual(['t1']);
  });
});

describe('never saved', () => {
  it('a state with a diff tab is rejected by validation (as by builds that don’t know them), and is valid once stripped', () => {
    const s = state(pane('p', [term, diff('d')]), 'p');
    expect(parsePersistedState(JSON.parse(JSON.stringify(s))).ok).toBe(false);
    const stripped = withoutDiffTabs(s);
    expect(parsePersistedState(JSON.parse(JSON.stringify(stripped))).ok).toBe(true);
    expect(listTabs(stripped.workspaces[0]!.layout).map((t) => t.id)).toEqual(['t1']);
  });

  it('a pane whose active tab was a diff shows its first remaining tab', () => {
    const s = withoutDiffTabs(state(pane('p', [term, diff('d'), file], 'd'), 'p'));
    expect(s.workspaces[0]!.layout).toMatchObject({ type: 'pane', activeTabId: 't1', tabs: [{ id: 't1' }, { id: 'f1' }] });
  });

  it('a pane of only diffs closes (its split collapses) and the active pane moves to a remaining one', () => {
    const s = withoutDiffTabs(state(split([pane('a', [term]), pane('b', [diff('d1'), diff('d2', 'b.txt')])]), 'b'));
    const w = s.workspaces[0]!;
    expect(listPanes(w.layout).map((p) => p.id)).toEqual(['a']);
    expect(w.layout?.type).toBe('pane');
    expect(w.activePaneId).toBe('a');
    expect(parsePersistedState(JSON.parse(JSON.stringify(s))).ok).toBe(true);
  });

  it('a workspace of only diffs keeps no layout; nothing to strip returns the same object', () => {
    const s = withoutDiffTabs(state(pane('p', [diff('d')]), 'p'));
    expect(s.workspaces[0]).toMatchObject({ layout: null, activePaneId: null });
    const clean = state(pane('p', [term, file]), 'p');
    expect(withoutDiffTabs(clean)).toBe(clean);
  });
});

describe('added like file tabs', () => {
  it('as a tab in a pane, or as a new pane to the right', () => {
    const s0 = state(pane('p', [term]), 'p');
    const s1 = reducer(s0, { type: 'addTab', workspaceId: 'w', paneId: 'p', tabId: 'd', profileId: '', diffPath: 'src/a.ts' });
    expect(listTabs(s1.workspaces[0]!.layout)).toEqual([term, diff('d')]);
    const s2 = reducer(s0, { type: 'addPane', workspaceId: 'w', paneId: 'q', tabId: 'd2', splitId: 'sp', profileId: '', diffPath: 'b.txt', direction: 'row', targetPaneId: 'p' });
    const w = s2.workspaces[0]!;
    expect(listPanes(w.layout).map((p) => [p.id, p.tabs.map((t) => t.id)])).toEqual([
      ['p', ['t1']],
      ['q', ['d2']],
    ]);
    expect(w.activePaneId).toBe('q');
  });
});
