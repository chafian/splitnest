import { describe, expect, it } from 'vitest';
import { activeTab, addTab, createPane, findPaneOfTab, listPanes, listTabs, removeTab, reorderTab } from '../../src/shared/layout';
import { emptyState, LIMITS, SCHEMA_VERSION, type PersistedState, type TerminalTab } from '../../src/shared/types';
import { parsePersistedState } from '../../src/shared/validation';
import { reducer } from '../../src/renderer/features/workspaces/workspace-state';

const ws = (id: string) => ({ id, name: id, rootPath: `C:\\code\\${id}`, layout: null, activePaneId: null });
const tabIds = (s: PersistedState, paneId: string) => listPanes(s.workspaces[0]!.layout).find((p) => p.id === paneId)!.tabs.map((t) => t.id);

function twoPanes(): PersistedState {
  let s = reducer(emptyState(), { type: 'addWorkspace', workspace: ws('w') });
  s = reducer(s, { type: 'addPane', workspaceId: 'w', paneId: 'A', tabId: 'a1', splitId: 's1', profileId: 'pwsh' });
  s = reducer(s, { type: 'addPane', workspaceId: 'w', paneId: 'B', tabId: 'b1', splitId: 's2', profileId: 'wsl:Ubuntu', direction: 'row' });
  return s;
}

describe('tab operations (pure)', () => {
  it('adds after the active tab, activates, and removes with a sensible neighbour', () => {
    let p = createPane('p', 'pwsh', 't1');
    p = addTab(p, { id: 't2', profileId: 'pwsh' });
    p = addTab({ ...p, activeTabId: 't1' }, { id: 't3', profileId: 'pwsh' });
    expect(p.tabs.map((t) => t.id)).toEqual(['t1', 't3', 't2']);
    expect(activeTab(p).id).toBe('t3');
    const q = removeTab(p, 't3')!;
    expect(q.activeTabId).toBe('t2');
    expect(removeTab(createPane('x', 'pwsh', 'only'), 'only')).toBeNull();
  });

  it('reorders within a pane', () => {
    let p = createPane('p', 'pwsh', 'a');
    p = addTab(p, { id: 'b', profileId: 'pwsh' });
    p = addTab(p, { id: 'c', profileId: 'pwsh' });
    expect(reorderTab(p, 'c', 0).tabs.map((t) => t.id)).toEqual(['c', 'a', 'b']);
    expect(reorderTab(p, 'a', 99).tabs.map((t) => t.id)).toEqual(['b', 'c', 'a']);
    expect(reorderTab(p, 'a', 0)).toBe(p);
  });
});

describe('tab reducer actions', () => {
  it('adds tabs to a pane and focuses that pane', () => {
    let s = twoPanes();
    s = reducer(s, { type: 'addTab', workspaceId: 'w', paneId: 'A', tabId: 'a2', profileId: 'windows-powershell' });
    expect(tabIds(s, 'A')).toEqual(['a1', 'a2']);
    expect(s.workspaces[0]!.activePaneId).toBe('A');
    expect(listTabs(s.workspaces[0]!.layout)).toHaveLength(3);
  });

  it('closing the last tab closes the pane', () => {
    let s = twoPanes();
    s = reducer(s, { type: 'closeTab', workspaceId: 'w', tabId: 'b1' });
    expect(listPanes(s.workspaces[0]!.layout).map((p) => p.id)).toEqual(['A']);
    expect(s.workspaces[0]!.activePaneId).toBe('A');
  });

  it('moves a tab to another pane, and an emptied source pane disappears', () => {
    let s = twoPanes();
    s = reducer(s, { type: 'addTab', workspaceId: 'w', paneId: 'A', tabId: 'a2', profileId: 'pwsh' });
    s = reducer(s, { type: 'moveTab', workspaceId: 'w', tabId: 'a2', toPaneId: 'B', toIndex: 0 });
    expect(tabIds(s, 'A')).toEqual(['a1']);
    expect(tabIds(s, 'B')).toEqual(['a2', 'b1']);
    expect(findPaneOfTab(s.workspaces[0]!.layout, 'a2')?.activeTabId).toBe('a2');
    s = reducer(s, { type: 'moveTab', workspaceId: 'w', tabId: 'a1', toPaneId: 'B', toIndex: 2 });
    expect(listPanes(s.workspaces[0]!.layout).map((p) => p.id)).toEqual(['B']);
    expect(tabIds(s, 'B')).toEqual(['a2', 'b1', 'a1']);
    expect(parsePersistedState(JSON.parse(JSON.stringify(s)))).toMatchObject({ ok: true });
  });

  it('activates tabs, changes a tab profile and caps tabs per pane', () => {
    let s = twoPanes();
    for (let i = 0; i < LIMITS.maxTabsPerPane + 2; i++) s = reducer(s, { type: 'addTab', workspaceId: 'w', paneId: 'A', tabId: `x${i}`, profileId: 'pwsh' });
    expect(tabIds(s, 'A')).toHaveLength(LIMITS.maxTabsPerPane);
    s = reducer(s, { type: 'activateTab', workspaceId: 'w', tabId: 'b1' });
    expect(s.workspaces[0]!.activePaneId).toBe('B');
    s = reducer(s, { type: 'setTabProfile', workspaceId: 'w', tabId: 'b1', profileId: 'windows-powershell' });
    expect((findPaneOfTab(s.workspaces[0]!.layout, 'b1')!.tabs[0] as TerminalTab).profileId).toBe('windows-powershell');
  });
});

describe('schema migration', () => {
  it('migrates version 1 files (one terminal per pane) to tabs', () => {
    const v1 = {
      schemaVersion: 1,
      activeWorkspaceId: 'w1',
      settings: { fontSize: 15 },
      workspaces: [
        {
          id: 'w1',
          name: 'Old',
          rootPath: 'C:\\code\\old',
          activePaneId: 'p2',
          layout: {
            type: 'split',
            id: 's1',
            direction: 'row',
            sizes: [0.4, 0.6],
            children: [
              { type: 'pane', id: 'p1', profileId: 'pwsh' },
              { type: 'pane', id: 'p2', profileId: 'wsl:Ubuntu-22.04' },
            ],
          },
        },
      ],
    };
    const result = parsePersistedState(v1);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.state.schemaVersion).toBe(SCHEMA_VERSION);
    const panes = listPanes(result.state.workspaces[0]!.layout);
    expect(panes.map((p) => ({ id: p.id, tabs: p.tabs, active: p.activeTabId }))).toEqual([
      { id: 'p1', tabs: [{ id: 'p1', profileId: 'pwsh' }], active: 'p1' },
      { id: 'p2', tabs: [{ id: 'p2', profileId: 'wsl:Ubuntu-22.04' }], active: 'p2' },
    ]);
    expect(result.state.settings.fontSize).toBe(15);
  });

  it('rejects empty, duplicate or invalid tabs and repairs a dangling active tab', () => {
    const state = (pane: object) => ({ ...emptyState(), workspaces: [{ ...ws('w'), layout: pane }] });
    expect(parsePersistedState(state({ type: 'pane', id: 'p', tabs: [], activeTabId: 'x' })).ok).toBe(false);
    expect(parsePersistedState(state({ type: 'pane', id: 'p', tabs: [{ id: 't', profileId: 'pwsh' }, { id: 't', profileId: 'pwsh' }], activeTabId: 't' })).ok).toBe(false);
    expect(parsePersistedState(state({ type: 'pane', id: 'p', tabs: [{ id: 't', profileId: 'evil.exe' }], activeTabId: 't' })).ok).toBe(false);
    const repaired = parsePersistedState(state({ type: 'pane', id: 'p', tabs: [{ id: 't', profileId: 'pwsh' }], activeTabId: 'gone' }));
    expect(repaired.ok && (repaired.state.workspaces[0]!.layout as { activeTabId: string }).activeTabId).toBe('t');
    expect(parsePersistedState({ ...emptyState(), schemaVersion: 4 })).toMatchObject({ ok: false, unsupportedVersion: 4 });
  });
});
