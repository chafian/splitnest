import { describe, expect, it } from 'vitest';
import type { DirEntry, SessionStatus, Workspace } from '../../src/shared/types';
import { editorSaveLabel } from '../../src/renderer/features/editor/save-label';
import {
  buildRows,
  chainContinuation,
  compactChain,
  MAX_PEEKS_PER_LISTING,
  peekCandidates,
  rowForPath,
  rowStart,
  type DirState,
} from '../../src/renderer/features/explorer/explorer-tree';
import { BINDINGS, matchShortcut } from '../../src/renderer/features/commands/shortcuts';
import { countRunningShells, shellsRunningLabel } from '../../src/renderer/features/terminal/shell-count';
import { tabLabel } from '../../src/renderer/features/terminal/tab-label';
import { effectiveMaximized } from '../../src/renderer/features/workspaces/maximize';

const dir = (name: string, symlink = false): DirEntry => ({ name, kind: 'directory', symlink });
const file = (name: string): DirEntry => ({ name, kind: 'file', symlink: false });
const loaded = (...entries: DirEntry[]): DirState => ({ status: 'loaded', entries });

// A Maven-style tree: src/main/java/com/example/{App.java, util/}
function javaTree(): Map<string, DirState> {
  return new Map([
    ['', loaded(dir('src'), file('pom.xml'))],
    ['src', loaded(dir('main'))],
    ['src/main', loaded(dir('java'))],
    ['src/main/java', loaded(dir('com'))],
    ['src/main/java/com', loaded(dir('example'))],
    ['src/main/java/com/example', loaded(dir('util'), file('App.java'))],
    ['src/main/java/com/example/util', loaded(file('Strings.java'))],
  ]);
}

describe('compact folders', () => {
  it('combines single-folder chains into one row whose target is the real deepest folder', () => {
    const expanded = new Set(['', 'src', 'src/main/java/com/example']);
    const rows = buildRows(javaTree(), expanded, true);
    const entries = rows.filter((r) => r.type === 'entry');
    expect(entries.map((r) => [r.name, r.path, r.depth])).toEqual([
      ['src/main/java/com/example', 'src/main/java/com/example', 0],
      ['util', 'src/main/java/com/example/util', 1],
      ['App.java', 'src/main/java/com/example/App.java', 1],
      ['pom.xml', 'pom.xml', 0],
    ]);
    // Each displayed segment keeps its own real path (for Copy path / Reveal on that part).
    const compact = entries[0]!;
    expect(compact.type === 'entry' && compact.segments?.map((s) => s.path)).toEqual([
      'src',
      'src/main',
      'src/main/java',
      'src/main/java/com',
      'src/main/java/com/example',
    ]);
    expect(rowForPath(rows, 'src/main/java')).toBe(compact);
    expect(compact.type === 'entry' && rowStart(compact)).toBe('src');
  });

  it('only compacts folders whose single entry is a folder (not files, links, truncated or unloaded folders)', () => {
    const tree = javaTree();
    tree.set('src/main', loaded(dir('java'), file('README.md'))); // two entries: stops here
    expect(compactChain(tree, 'src', 'src').map((s) => s.path)).toEqual(['src', 'src/main']);
    tree.set('src/main', loaded(dir('java', true))); // a junction is never folded in
    expect(compactChain(tree, 'src', 'src').map((s) => s.path)).toEqual(['src', 'src/main']);
    tree.set('src/main', { status: 'loaded', entries: [dir('java')], truncated: true });
    expect(compactChain(tree, 'src', 'src').map((s) => s.path)).toEqual(['src', 'src/main']);
    tree.set('src/main', { status: 'loading', entries: [] });
    expect(compactChain(tree, 'src', 'src').map((s) => s.path)).toEqual(['src', 'src/main']);
    expect(compactChain(new Map([['only', loaded(file('a.txt'))]]), 'only', 'only').map((s) => s.path)).toEqual(['only']);
  });

  it('with the setting off, every folder is its own row and paths are identical', () => {
    const expanded = new Set(['', 'src', 'src/main', 'src/main/java', 'src/main/java/com', 'src/main/java/com/example']);
    const off = buildRows(javaTree(), expanded, false).filter((r) => r.type === 'entry');
    expect(off.map((r) => r.path)).toEqual([
      'src',
      'src/main',
      'src/main/java',
      'src/main/java/com',
      'src/main/java/com/example',
      'src/main/java/com/example/util',
      'src/main/java/com/example/App.java',
      'pom.xml',
    ]);
    // The same file resolves to the same real path either way.
    const on = buildRows(javaTree(), expanded, true);
    expect(rowForPath(on, 'src/main/java/com/example/App.java')?.path).toBe('src/main/java/com/example/App.java');
  });
});

describe('compact folders on initial load', () => {
  it('inspects child folders of a shown listing (bounded, no links, no cached ones) and follows a chain one level at a time', () => {
    const entries = [dir('src'), dir('linked', true), dir('docs'), file('pom.xml'), ...Array.from({ length: 80 }, (_, i) => dir(`d${i}`))];
    const picks = peekCandidates('', entries, (p) => p === 'docs');
    expect(picks.slice(0, 2)).toEqual(['src', 'd0']);
    expect(picks).not.toContain('linked');
    expect(picks).not.toContain('docs');
    expect(picks).toHaveLength(MAX_PEEKS_PER_LISTING);
    expect(chainContinuation('src', [dir('main')])).toBe('src/main');
    expect(chainContinuation('src', [dir('main'), file('x')])).toBeNull();
    expect(chainContinuation('src', [dir('main', true)])).toBeNull();
    expect(chainContinuation('src', [dir('main')], true)).toBeNull();
  });

  it('shows the chain as one collapsed row before anything is expanded', () => {
    // Root listed and child folders inspected (as on first load); nothing expanded but the root.
    const rows = buildRows(javaTree(), new Set(['']), true).filter((r) => r.type === 'entry');
    expect(rows.map((r) => r.name)).toEqual(['src/main/java/com/example', 'pom.xml']);
  });

  it('breaks the chain when a file or a second folder appears (after the folder is re-listed)', () => {
    const tree = javaTree();
    tree.set('src/main', loaded(dir('java'), file('NOTES.md')));
    let rows = buildRows(tree, new Set(['']), true).filter((r) => r.type === 'entry');
    expect(rows[0]!.name).toBe('src/main');
    tree.set('src', loaded(dir('main'), dir('test')));
    rows = buildRows(tree, new Set(['']), true).filter((r) => r.type === 'entry');
    expect(rows[0]!.name).toBe('src');
  });

  it('an unreadable folder ends the chain instead of failing the tree', () => {
    const tree = javaTree();
    tree.set('src/main/java', { status: 'error', entries: [], error: 'Access to this folder was denied.' });
    const rows = buildRows(tree, new Set(['']), true).filter((r) => r.type === 'entry');
    expect(rows[0]!.name).toBe('src/main/java');
  });
});

describe('pane maximise', () => {
  const ws = (activePaneId: string | null): Workspace => ({
    id: 'w',
    name: 'w',
    rootPath: 'C:\\w',
    activePaneId,
    layout: {
      type: 'split',
      id: 's',
      direction: 'row',
      sizes: [0.3, 0.7],
      children: [
        { type: 'pane', id: 'A', tabs: [{ id: 'a', profileId: 'pwsh' }], activeTabId: 'a' },
        { type: 'pane', id: 'B', tabs: [{ id: 'b', kind: 'file', path: 'x.ts' }], activeTabId: 'b' },
      ],
    },
  });

  it('applies only while the pane exists, is focused, and has siblings; the split tree is untouched', () => {
    const w = ws('B');
    const before = JSON.stringify(w.layout);
    expect(effectiveMaximized(w, 'B')).toBe('B');
    expect(JSON.stringify(w.layout)).toBe(before); // proportions and tabs kept for restore
    expect(effectiveMaximized(ws('A'), 'B')).toBeNull(); // focus moved: layout shows again
    expect(effectiveMaximized(w, 'gone')).toBeNull(); // pane closed
    expect(effectiveMaximized(w, null)).toBeNull();
    const single: Workspace = { ...w, layout: { type: 'pane', id: 'B', tabs: [{ id: 'b', profileId: 'pwsh' }], activeTabId: 'b' } };
    expect(effectiveMaximized(single, 'B')).toBeNull();
  });
});

describe('shortcuts', () => {
  it('no two app shortcuts share a key combination, and Ctrl+Shift+M only means Maximise', () => {
    const combos = BINDINGS.flatMap((b) => b.codes.map((code) => `${b.ctrl}${b.shift}${b.alt}${code}`));
    expect(new Set(combos).size).toBe(combos.length);
    const key = (code: string, mods: Partial<{ ctrlKey: boolean; shiftKey: boolean; altKey: boolean }>) => ({ ctrlKey: false, shiftKey: false, altKey: false, metaKey: false, code, ...mods });
    expect(matchShortcut(key('KeyM', { ctrlKey: true, shiftKey: true }))).toBe('toggleMaximize');
    // Keys shells rely on stay with the shell: Ctrl+M (Enter), Ctrl+Alt+M, Alt+Shift+M.
    expect(matchShortcut(key('KeyM', { ctrlKey: true }))).toBeNull();
    expect(matchShortcut(key('KeyM', { ctrlKey: true, altKey: true }))).toBeNull();
    expect(matchShortcut(key('KeyM', { altKey: true, shiftKey: true }))).toBeNull();
  });
});

describe('workspace shell counts', () => {
  it('counts running sessions only (background tabs included)', () => {
    const states: (SessionStatus | null)[] = ['running', 'running', 'idle', 'starting', 'failed', 'exited', null];
    expect(countRunningShells(states)).toBe(2);
    expect(countRunningShells([])).toBe(0);
    expect(shellsRunningLabel(1)).toBe('1 shell running');
    expect(shellsRunningLabel(6)).toBe('6 shells running');
  });
});

describe('editor save state wording', () => {
  it('says Saved only after a successful write, and never for read-only files', () => {
    expect(editorSaveLabel({ readOnly: null, saveState: 'idle', dirty: false }).text).toBe('');
    expect(editorSaveLabel({ readOnly: null, saveState: 'idle', dirty: true }).key).toBe('unsaved');
    expect(editorSaveLabel({ readOnly: null, saveState: 'saving', dirty: true }).text).toBe('Saving…');
    expect(editorSaveLabel({ readOnly: null, saveState: 'saved', dirty: false }).text).toBe('Saved');
    expect(editorSaveLabel({ readOnly: null, saveState: 'failed', dirty: true })).toMatchObject({ key: 'failed', tone: 'danger' });
    expect(editorSaveLabel({ readOnly: 'The file is read-only.', saveState: 'saved', dirty: false }).text).toBe('Read-only');
    // Never "Saved" once the disk no longer matches.
    expect(editorSaveLabel({ readOnly: null, saveState: 'saved', dirty: false, conflict: 'deleted' }).text).toBe('Deleted on disk');
    expect(editorSaveLabel({ readOnly: null, saveState: 'failed', dirty: true, conflict: 'changed-on-disk' }).key).toBe('changed');
  });
});

describe('terminal tab labels', () => {
  it('shows "Name · Shell" for custom names and the shell alone otherwise', () => {
    expect(tabLabel({ customName: 'Project B', profileId: 'windows-powershell', shellLabel: 'Windows PowerShell' }).full).toBe('Project B · PowerShell');
    expect(tabLabel({ customName: 'Feature One', profileId: 'wsl:Ubuntu-22.04', shellLabel: 'Ubuntu-22.04' }).full).toBe('Feature One · Ubuntu-22.04');
    expect(tabLabel({ profileId: 'wsl:Ubuntu-22.04', shellLabel: 'Ubuntu-22.04' }).full).toBe('Ubuntu-22.04');
  });
});
