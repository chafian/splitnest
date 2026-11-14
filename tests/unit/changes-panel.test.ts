// The Changes panel: layout next to the other panels, what is saved per workspace, the folder
// watch's filtering and timing, and the header's facts.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { computeChrome, newChangesPanel } from '../../src/renderer/features/workspaces/chrome';
import { reducer } from '../../src/renderer/features/workspaces/workspace-state';
import { taskFacts } from '../../src/renderer/features/tasks/task-text';
import { MIN_GAP_MS, QUIET_MS, relevant, TaskFolderWatcher } from '../../src/main/task-watch';
import { parseChangesPanel, validateWorkspace } from '../../src/shared/validation';
import { DEFAULT_SETTINGS, LIMITS, type PersistedState, type Workspace } from '../../src/shared/types';
import type { TaskSummary, WorkspaceTask } from '../../src/shared/tasks';

const settings = { ...DEFAULT_SETTINGS, sidebarCollapsed: false, sidebarWidth: 236, explorerVisible: true, explorerWidth: 260, focusMode: false };
const task: WorkspaceTask = {
  repoRoot: 'C:\\code\\app',
  subPath: '',
  baseBranch: 'main',
  baseCommit: 'a'.repeat(40),
  branch: 'splitnest/fix',
  worktreePath: 'C:\\code\\app.worktrees\\fix',
  taskRoot: 'C:\\code\\app.worktrees\\fix',
  parentId: 'p',
  agent: null,
  createdAt: 1,
};

describe('layout', () => {
  it('a wide window: all three panels at their widths, terminals keep the rest', () => {
    const c = computeChrome(settings, 1800, true, { open: true, width: 340 });
    expect(c).toMatchObject({ changes: true, changesWidth: 340, explorerWidth: 260, sidebarWidth: 236 });
  });

  it('too narrow: the explorer gives way first, then the Changes panel, then the sidebar; terminals keep their minimum', () => {
    const c = computeChrome(settings, 1100, true, { open: true, width: 500 });
    // budget = 1100 − 360 = 740: explorer to 160, then changes to 740 − 236 − 160 = 344.
    expect(c).toMatchObject({ explorerWidth: 160, changesWidth: 344, sidebarWidth: 236 });
    const tiny = computeChrome(settings, 700, true, { open: true, width: 500 });
    expect(tiny.explorerWidth).toBe(LIMITS.explorerWidth.min);
    expect(tiny.changesWidth).toBe(LIMITS.changesWidth.min);
  });

  it('closed, no task, or focus mode: no panel; the others can use the room', () => {
    expect(computeChrome(settings, 1800, true, { open: false, width: 340 }).changes).toBe(false);
    expect(computeChrome(settings, 1800, true, null).changes).toBe(false);
    expect(computeChrome({ ...settings, focusMode: true }, 1800, true, { open: true, width: 340 })).toMatchObject({ changes: false, changesWidth: 0 });
    const withPanel = computeChrome(settings, 1200, true, { open: true, width: 400 });
    const without = computeChrome(settings, 1200, true, null);
    expect(without.explorerMax).toBeGreaterThan(withPanel.explorerMax);
  });

  it('a new task’s panel: open on a wide enough window, closed on a narrow one', () => {
    expect(newChangesPanel(1280)).toEqual({ open: true, width: LIMITS.changesWidth.default });
    expect(newChangesPanel(900)).toEqual({ open: false, width: LIMITS.changesWidth.default });
  });
});

describe('saved per workspace', () => {
  const ws = (extra: Partial<Workspace>): Workspace => ({ id: 't', name: 'T', rootPath: task.taskRoot, layout: null, activePaneId: null, ...extra });

  it('kept for tasks, width clamped; anything odd or on a non-task is dropped (older builds drop it too)', () => {
    expect(validateWorkspace(ws({ task, changesPanel: { open: true, width: 5000 } })).changesPanel).toEqual({ open: true, width: LIMITS.changesWidth.max });
    expect(validateWorkspace(ws({ task, changesPanel: { open: false, width: 1 } })).changesPanel).toEqual({ open: false, width: LIMITS.changesWidth.min });
    expect(validateWorkspace(ws({ changesPanel: { open: true, width: 300 } })).changesPanel).toBeUndefined();
    for (const bad of [null, 'open', { open: 'yes', width: 300 }, { open: true, width: Number.NaN }, []]) expect(parseChangesPanel(bad)).toBeNull();
  });

  it('the reducer changes it only for tasks, clamped, and returns the same state when nothing changes', () => {
    const state: PersistedState = { schemaVersion: 3, workspaces: [ws({ task }), { id: 'n', name: 'N', rootPath: 'C:\\n', layout: null, activePaneId: null }], activeWorkspaceId: 't', settings: DEFAULT_SETTINGS };
    const a = reducer(state, { type: 'setChangesPanel', workspaceId: 't', panel: { open: true, width: 9999 } });
    expect(a.workspaces[0]!.changesPanel).toEqual({ open: true, width: LIMITS.changesWidth.max });
    expect(reducer(a, { type: 'setChangesPanel', workspaceId: 't', panel: { open: true, width: 9999 } })).toBe(a);
    expect(reducer(state, { type: 'setChangesPanel', workspaceId: 'n', panel: { open: true, width: 300 } })).toBe(state);
  });
});

describe('the folder watch', () => {
  // Fake timers fake Date.now too, so the watcher's clock and its timers move together.
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('ignores .git and what Git ignores (folders and files, either separator, any case)', () => {
    const ignored = ['node_modules/', 'dist/', '.env'];
    expect(relevant('.git', ignored)).toBe(false);
    expect(relevant('.git\\index.lock', ignored)).toBe(false);
    expect(relevant('node_modules\\left-pad\\index.js', ignored)).toBe(false);
    expect(relevant('Node_Modules', ignored)).toBe(false);
    expect(relevant('.env', ignored)).toBe(false);
    expect(relevant('src\\login.js', ignored)).toBe(true);
    expect(relevant('.envrc', ignored)).toBe(true);
    expect(relevant('.github/ci.yml', ignored)).toBe(true);
    expect(relevant(null, ignored)).toBe(true);
  });

  it('a burst of changes becomes one check after quiet; checks are at least the gap apart; one folder at a time; WSL not watched', async () => {
    const fired: string[] = [];
    const listeners = new Map<string, (f: string | null) => void>();
    const closed: string[] = [];
    const w = new TaskFolderWatcher({
      changed: (id) => fired.push(id),
      ignored: async () => ['node_modules/'],
      watch: (folder, cb) => {
        listeners.set(folder, cb);
        return { close: () => closed.push(folder) };
      },
    });
    w.set({ workspaceId: 't1', folder: 'C:\\a' });
    await Promise.resolve();
    const emit = (f: string) => listeners.get('C:\\a')!(f);
    for (let i = 0; i < 20; i++) {
      emit('src\\x.js');
      vi.advanceTimersByTime(100);
    }
    expect(fired).toEqual([]); // still changing
    vi.advanceTimersByTime(QUIET_MS);
    expect(fired).toEqual(['t1']);
    emit('node_modules\\y.js'); // ignored
    vi.advanceTimersByTime(QUIET_MS * 2);
    expect(fired).toEqual(['t1']);
    emit('src\\y.js');
    vi.advanceTimersByTime(QUIET_MS);
    expect(fired).toEqual(['t1']); // within the gap: waits
    vi.advanceTimersByTime(MIN_GAP_MS);
    expect(fired).toEqual(['t1', 't1']);
    // Another task: the first watch closes; WSL folders aren't watched at all.
    w.set({ workspaceId: 't2', folder: 'C:\\b' });
    expect(closed).toEqual(['C:\\a']);
    expect(w.count).toBe(1);
    w.set({ workspaceId: 't3', folder: '\\\\wsl.localhost\\Ubuntu\\home\\me\\app' });
    expect(w.count).toBe(0);
    w.set(null);
    expect(w.count).toBe(0);
  });
});

describe('header facts', () => {
  const s = (o: Partial<TaskSummary>): TaskSummary => ({ added: 0, removed: 0, approximate: false, files: 0, uncommitted: 0, binary: 0, ahead: 0, behind: 0, version: 'v', ...o });
  it('only what the summary knows: no changes, not committed, commits to merge, unknown base, base moved on', () => {
    expect(taskFacts(undefined, 'main').map((f) => f.text)).toEqual(['Checking…']);
    expect(taskFacts(s({}), 'main').map((f) => f.text)).toEqual(['No changes yet']);
    expect(taskFacts(s({ files: 2, uncommitted: 2 }), 'main').map((f) => f.text)).toEqual(['2 not committed']);
    expect(taskFacts(s({ files: 1, ahead: 3, behind: 1 }), 'main').map((f) => f.text)).toEqual(['3 to merge', 'main ahead 1']);
    expect(taskFacts(s({ files: 1, ahead: null, behind: null }), 'main').map((f) => f.text)).toEqual(['main not found']);
  });
});
