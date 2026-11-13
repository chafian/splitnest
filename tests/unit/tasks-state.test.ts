// Agent tasks in the saved state and the page: validation of saved tasks, where a new task is
// listed, and the sidebar's text.
import { describe, expect, it } from 'vitest';
import { parseWorkspaceTask, taskAgentCommand, taskRecordKey, TASK_AGENTS, type WorkspaceTask } from '../../src/shared/tasks';
import { DEFAULT_SETTINGS, type PersistedState, type Workspace } from '../../src/shared/types';
import { parsePersistedState, validateSettings, validateWorkspace } from '../../src/shared/validation';
import { insertionIndex, reducer } from '../../src/renderer/features/workspaces/workspace-state';
import { taskProgressText, uncommittedNote } from '../../src/renderer/features/tasks/task-text';

const task: WorkspaceTask = {
  repoRoot: 'C:\\code\\app',
  subPath: '',
  baseBranch: 'main',
  baseCommit: 'a'.repeat(40),
  branch: 'splitnest/fix-login',
  worktreePath: 'C:\\code\\app.worktrees\\fix-login',
  taskRoot: 'C:\\code\\app.worktrees\\fix-login',
  parentId: 'parent1',
  agent: 'claude',
  createdAt: 1_700_000_000_000,
};
const ws = (id: string, extra: Partial<Workspace> = {}): Workspace => ({ id, name: id, rootPath: `C:\\${id}`, layout: null, activePaneId: null, ...extra });

describe('saved tasks', () => {
  it('a valid task is kept as it is', () => {
    expect(parseWorkspaceTask(task, task.taskRoot)).toEqual(task);
    expect(validateWorkspace(ws('t', { rootPath: task.taskRoot, task })).task).toEqual(task);
  });

  it('a task with a sub-folder workspace, no agent, or a SHA-256 commit', () => {
    const sub = { ...task, subPath: 'packages\\web', taskRoot: 'C:\\code\\app.worktrees\\fix-login\\packages\\web', agent: null, baseCommit: 'b'.repeat(64) };
    expect(parseWorkspaceTask(sub, sub.taskRoot)).toEqual(sub);
  });

  it('anything off drops the task, never the workspace', () => {
    const bad: Partial<Record<keyof WorkspaceTask, unknown>>[] = [
      { repoRoot: 'code\\app' },
      { worktreePath: '/home/me/app' },
      { taskRoot: 'C:\\elsewhere' }, // not the workspace folder
      { subPath: '..\\..\\Windows' },
      { subPath: 'C:\\Windows' },
      { branch: 'main' }, // not a task branch
      { baseCommit: 'HEAD' },
      { baseCommit: 'A'.repeat(40) },
      { parentId: '../x' },
      { branch: 'splitnest/' + 'x'.repeat(300) },
    ];
    for (const b of bad) {
      expect(parseWorkspaceTask({ ...task, ...b }, task.taskRoot)).toBeNull();
      const w = validateWorkspace(ws('t', { rootPath: task.taskRoot, task: { ...task, ...b } as WorkspaceTask }));
      expect(w.task).toBeUndefined();
      expect(w.rootPath).toBe(task.taskRoot);
    }
    expect(parseWorkspaceTask(null, task.taskRoot)).toBeNull();
    expect(parseWorkspaceTask('x', task.taskRoot)).toBeNull();
    expect(parseWorkspaceTask([], task.taskRoot)).toBeNull();
  });

  it('an unknown agent is read as none; a bad date as 0', () => {
    expect(parseWorkspaceTask({ ...task, agent: 'rm -rf' }, task.taskRoot)?.agent).toBeNull();
    expect(parseWorkspaceTask({ ...task, createdAt: 'yesterday' }, task.taskRoot)?.createdAt).toBe(0);
  });

  it('workspaces saved before tasks existed load unchanged', () => {
    const state: PersistedState = { schemaVersion: 3, workspaces: [ws('a')], activeWorkspaceId: 'a', settings: DEFAULT_SETTINGS };
    const r = parsePersistedState(JSON.parse(JSON.stringify(state)));
    expect(r.ok && r.state.workspaces[0]).toEqual(ws('a'));
  });

  it('the preview setting is off by default and only `true` turns it on', () => {
    expect(DEFAULT_SETTINGS.agentTasks).toBe(false);
    expect(validateSettings({}).agentTasks).toBe(false);
    expect(validateSettings({ agentTasks: 'yes' }).agentTasks).toBe(false);
    expect(validateSettings({ agentTasks: true }).agentTasks).toBe(true);
  });

  it('the key main checks saved tasks against covers every path and the branch; only folders ignore letter case', () => {
    expect(taskRecordKey(task)).toBe(taskRecordKey({ ...task, worktreePath: task.worktreePath.toUpperCase(), taskRoot: task.taskRoot.toUpperCase(), repoRoot: task.repoRoot.toLowerCase() }));
    // Git branch names are case-sensitive: another case is another branch.
    expect(taskRecordKey({ ...task, branch: 'splitnest/FIX-LOGIN' })).not.toBe(taskRecordKey(task));
    expect(taskRecordKey({ ...task, baseBranch: 'Main' })).not.toBe(taskRecordKey(task));
    for (const k of ['repoRoot', 'subPath', 'baseBranch', 'baseCommit', 'branch', 'worktreePath', 'taskRoot'] as const) {
      expect(taskRecordKey({ ...task, [k]: `${task[k]}x` })).not.toBe(taskRecordKey(task));
    }
    // What the page adds (parent, agent, date) isn't part of it.
    const other: WorkspaceTask = { ...task, parentId: 'other', agent: null, createdAt: 1 };
    expect(taskRecordKey(other)).toBe(taskRecordKey(task));
  });

  it('only the agent’s own name is typed to start it', () => {
    expect(TASK_AGENTS.map(taskAgentCommand)).toEqual(['claude', 'codex', 'gemini']);
  });
});

describe('where a new task is listed', () => {
  const t = (id: string, parentId: string) => ws(id, { task: { ...task, parentId } });

  it('right after its workspace and the tasks already under it', () => {
    const list = [ws('a'), t('a1', 'a'), t('a2', 'a'), ws('b'), t('b1', 'b')];
    expect(insertionIndex(list, 'a')).toBe(3);
    expect(insertionIndex(list, 'b')).toBe(5);
    expect(insertionIndex([ws('a'), ws('b')], 'a')).toBe(1);
    expect(insertionIndex(list, 'gone')).toBe(5);
  });

  it('the reducer inserts there and selects the task', () => {
    const state: PersistedState = { schemaVersion: 3, workspaces: [ws('a'), t('a1', 'a'), ws('b')], activeWorkspaceId: 'b', settings: DEFAULT_SETTINGS };
    const next = reducer(state, { type: 'addWorkspace', workspace: t('a2', 'a'), after: 'a' });
    expect(next.workspaces.map((w) => w.id)).toEqual(['a', 'a1', 'a2', 'b']);
    expect(next.activeWorkspaceId).toBe('a2');
    // A workspace from a folder still goes at the end.
    expect(reducer(next, { type: 'addWorkspace', workspace: ws('c') }).workspaces.map((w) => w.id)).toEqual(['a', 'a1', 'a2', 'b', 'c']);
  });
});

describe('task text', () => {
  const p = { folderExists: true, registered: true, branchExists: true, ahead: 0, behind: 0 };
  it('commits on the task branch, and how far the base moved on', () => {
    expect(taskProgressText(undefined)).toBeNull();
    expect(taskProgressText(p)).toBe('no commits yet');
    expect(taskProgressText({ ...p, ahead: 1 })).toBe('1 commit');
    expect(taskProgressText({ ...p, ahead: 3, behind: 2 })).toBe('3 commits · base 2 ahead');
    expect(taskProgressText({ ...p, ahead: null, behind: null })).toBeNull();
    expect(taskProgressText({ ...p, folderExists: false })).toBe('task folder missing');
  });

  it('uncommitted changes in the parent are named, since the task starts from the last commit', () => {
    const clean = { branch: 'main', detached: null, initial: false, upstream: null, ahead: 0, behind: 0, changedFiles: 0, untracked: 0, changesNotChecked: false, added: 0, removed: 0 };
    expect(uncommittedNote(null, 'main')).toBeNull();
    expect(uncommittedNote(clean, 'main')).toBeNull();
    expect(uncommittedNote({ ...clean, changedFiles: 2 }, 'main')).toMatch(/uncommitted changes.*last commit on main/);
    expect(uncommittedNote({ ...clean, untracked: 1 }, 'dev')).toMatch(/last commit on dev/);
  });
});
