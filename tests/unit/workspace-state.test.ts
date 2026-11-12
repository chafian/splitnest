import { describe, expect, it } from 'vitest';
import { listPanes } from '../../src/shared/layout';
import { emptyState, LIMITS, type PersistedState } from '../../src/shared/types';
import { parsePersistedState } from '../../src/shared/validation';
import { reducer } from '../../src/renderer/features/workspaces/workspace-state';
import { BINDINGS, matchShortcut } from '../../src/renderer/features/commands/shortcuts';
import { filterCommands } from '../../src/renderer/components/CommandPalette';

const ws = (id: string) => ({ id, name: id, rootPath: `C:\\code\\${id}`, layout: null, activePaneId: null });

function withPanes(): PersistedState {
  let s = reducer(emptyState(), { type: 'addWorkspace', workspace: ws('w1') });
  s = reducer(s, { type: 'addPane', workspaceId: 'w1', paneId: 'p1', splitId: 's1', profileId: 'pwsh' });
  s = reducer(s, { type: 'addPane', workspaceId: 'w1', paneId: 'p2', splitId: 's2', profileId: 'wsl:Ubuntu', direction: 'row' });
  return s;
}

describe('workspace reducer', () => {
  it('adds workspaces and activates the new one', () => {
    let s = reducer(emptyState(), { type: 'addWorkspace', workspace: ws('a') });
    s = reducer(s, { type: 'addWorkspace', workspace: ws('b') });
    expect(s.activeWorkspaceId).toBe('b');
    expect(s.workspaces.map((w) => w.id)).toEqual(['a', 'b']);
  });

  it('adds panes, focusing the new pane, and splits the active one', () => {
    const s = withPanes();
    const w = s.workspaces[0]!;
    expect(listPanes(w.layout).map((p) => (p.tabs[0] as { profileId: string }).profileId)).toEqual(['pwsh', 'wsl:Ubuntu']);
    expect(w.activePaneId).toBe('p2');
  });

  it('closing the active pane focuses a neighbour and keeps a valid state', () => {
    let s = withPanes();
    s = reducer(s, { type: 'removePane', workspaceId: 'w1', paneId: 'p2' });
    expect(s.workspaces[0]!.activePaneId).toBe('p1');
    s = reducer(s, { type: 'removePane', workspaceId: 'w1', paneId: 'p1' });
    expect(s.workspaces[0]!.layout).toBeNull();
    expect(s.workspaces[0]!.activePaneId).toBeNull();
    expect(parsePersistedState(JSON.parse(JSON.stringify(s))).ok).toBe(true);
  });

  it('removing a workspace only removes it from the list and picks a neighbour', () => {
    let s = reducer(emptyState(), { type: 'addWorkspace', workspace: ws('a') });
    s = reducer(s, { type: 'addWorkspace', workspace: ws('b') });
    s = reducer(s, { type: 'addWorkspace', workspace: ws('c') });
    s = reducer(s, { type: 'activateWorkspace', workspaceId: 'b' });
    s = reducer(s, { type: 'removeWorkspace', workspaceId: 'b' });
    expect(s.workspaces.map((w) => w.id)).toEqual(['a', 'c']);
    expect(s.activeWorkspaceId).toBe('c');
  });

  it('caps panes per workspace', () => {
    let s = reducer(emptyState(), { type: 'addWorkspace', workspace: ws('w') });
    for (let i = 0; i < LIMITS.maxPanesPerWorkspace + 3; i++) {
      s = reducer(s, { type: 'addPane', workspaceId: 'w', paneId: `p${i}`, splitId: `s${i}`, profileId: 'pwsh' });
    }
    expect(listPanes(s.workspaces[0]!.layout)).toHaveLength(LIMITS.maxPanesPerWorkspace);
    expect(parsePersistedState(JSON.parse(JSON.stringify(s)))).toMatchObject({ ok: true });
  });

  it('never produces a layout deeper than the persisted limit, even with alternating splits', () => {
    let s = reducer(emptyState(), { type: 'addWorkspace', workspace: ws('w') });
    s = reducer(s, { type: 'addPane', workspaceId: 'w', paneId: 'p0', splitId: 's0', profileId: 'pwsh' });
    for (let i = 1; i < LIMITS.maxPanesPerWorkspace; i++) {
      s = reducer(s, { type: 'addPane', workspaceId: 'w', paneId: `p${i}`, splitId: `s${i}`, profileId: 'pwsh', direction: i % 2 ? 'row' : 'column' });
    }
    expect(listPanes(s.workspaces[0]!.layout)).toHaveLength(LIMITS.maxPanesPerWorkspace);
    expect(parsePersistedState(JSON.parse(JSON.stringify(s)))).toMatchObject({ ok: true });
  });

  it('ignores empty renames and trims names', () => {
    let s = reducer(emptyState(), { type: 'addWorkspace', workspace: ws('w') });
    s = reducer(s, { type: 'renameWorkspace', workspaceId: 'w', name: '   ' });
    expect(s.workspaces[0]!.name).toBe('w');
    s = reducer(s, { type: 'renameWorkspace', workspaceId: 'w', name: '  API server  ' });
    expect(s.workspaces[0]!.name).toBe('API server');
  });
});

describe('keyboard shortcuts', () => {
  const key = (code: string, mods: Partial<{ ctrlKey: boolean; shiftKey: boolean; altKey: boolean }> = {}) => ({
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    metaKey: false,
    code,
    ...mods,
  });

  it('never captures plain Ctrl+letter keys the shell relies on', () => {
    for (const letter of 'ABCDEFGHIJKLMNOPQRSTUVWXYZ') {
      expect(matchShortcut(key(`Key${letter}`, { ctrlKey: true }))).toBeNull();
    }
    expect(matchShortcut(key('ArrowLeft', { altKey: true }))).toBeNull();
  });

  it('maps the documented shortcuts', () => {
    expect(matchShortcut(key('KeyP', { ctrlKey: true, shiftKey: true }))).toBe('palette');
    expect(matchShortcut(key('KeyD', { ctrlKey: true, shiftKey: true }))).toBe('splitRight');
    expect(matchShortcut(key('ArrowRight', { ctrlKey: true, altKey: true }))).toBe('focusRight');
    expect(matchShortcut(key('Equal', { ctrlKey: true }))).toBe('fontIncrease');
  });

  it('has no duplicate key combinations', () => {
    const combos = BINDINGS.flatMap((b) => b.codes.map((c) => `${b.ctrl}${b.shift}${b.alt}${c}`));
    expect(new Set(combos).size).toBe(combos.length);
  });

  it('filters palette commands by all words', () => {
    const cmds = [
      { id: '1', group: 'Pane', title: 'Split right', run: () => undefined },
      { id: '2', group: 'Pane', title: 'Split down', run: () => undefined },
      { id: '3', group: 'Workspace', title: 'Rename workspace…', run: () => undefined },
    ];
    expect(filterCommands(cmds, 'split do').map((c) => c.id)).toEqual(['2']);
    expect(filterCommands(cmds, 'pane').map((c) => c.id)).toEqual(['1', '2']);
    expect(filterCommands(cmds, '')).toHaveLength(3);
  });
});
