// Task summaries: the queue in main, the pure helpers, and the row's text.
import { describe, expect, it } from 'vitest';
import { parseBatch } from '../../src/main/git-runner';
import { parseStatusEntries } from '../../src/main/git-worktree';
import { lineCount } from '../../src/main/task-service';
import { TaskSummaries } from '../../src/main/task-summaries';
import { taskCounts, taskTooltip } from '../../src/renderer/features/tasks/task-text';
import type { TaskSummary, WorkspaceTask } from '../../src/shared/tasks';
import type { Workspace } from '../../src/shared/types';

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
const sum = (o: Partial<TaskSummary> = {}): TaskSummary => ({ added: 3, removed: 1, approximate: false, files: 2, uncommitted: 1, binary: 0, ahead: 1, behind: 0, version: 'v', ...o });

describe('the summary queue', () => {
  const setup = (opts: { slow?: boolean; enabled?: boolean } = {}) => {
    const workspaces: Workspace[] = [
      { id: 't1', name: 'T1', rootPath: task.taskRoot, layout: null, activePaneId: null, task },
      { id: 'plain', name: 'P', rootPath: 'C:\\p', layout: null, activePaneId: null },
    ];
    const published: [string, TaskSummary | null][] = [];
    let release: (() => void) | null = null;
    let calls = 0;
    let enabled = opts.enabled ?? true;
    const q = new TaskSummaries({
      summarize: async () => {
        calls++;
        if (opts.slow) await new Promise<void>((r) => (release = r));
        return sum({ added: calls });
      },
      workspaces: () => workspaces,
      enabled: () => enabled,
      publish: (id, s) => published.push([id, s]),
    });
    return { q, published, workspaces, calls: () => calls, release: () => release?.(), setEnabled: (v: boolean) => (enabled = v) };
  };
  const tick = () => new Promise((r) => setTimeout(r, 0));

  it('only task workspaces, only when on; publishes changes only', async () => {
    const s = setup();
    s.q.request('plain');
    s.q.request('t1');
    await tick();
    expect(s.calls()).toBe(1);
    expect(s.published).toEqual([['t1', sum({ added: 1 })]]);
    expect(s.q.all()).toEqual({ t1: sum({ added: 1 }) });
    const off = setup({ enabled: false });
    off.q.request('t1');
    await tick();
    expect(off.calls()).toBe(0);
  });

  it('requests while one runs become exactly one more run', async () => {
    const s = setup({ slow: true });
    s.q.request('t1');
    await tick();
    for (let i = 0; i < 5; i++) s.q.request('t1');
    s.release();
    await tick();
    await tick();
    expect(s.calls()).toBe(2);
    s.release();
    await tick();
    expect(s.calls()).toBe(2);
  });

  it('removed tasks and turning off clear what the page shows', async () => {
    const s = setup();
    s.q.request('t1');
    await tick();
    s.setEnabled(false);
    s.q.sync();
    expect(s.published.at(-1)).toEqual(['t1', null]);
    expect(s.q.all()).toEqual({});
  });
});

describe('summary helpers', () => {
  it('line counts: final line without newline, empty file, CRLF, binary', () => {
    expect(lineCount(Buffer.from('a\nb\n'))).toEqual({ lines: 2, binary: false });
    expect(lineCount(Buffer.from('a\nb'))).toEqual({ lines: 2, binary: false });
    expect(lineCount(Buffer.from(''))).toEqual({ lines: 0, binary: false });
    expect(lineCount(Buffer.from('a\r\nb\r\n'))).toEqual({ lines: 2, binary: false });
    expect(lineCount(Buffer.from([1, 0, 2, 10]))).toEqual({ lines: 0, binary: true });
  });

  it('status entries: tracked changes, renames (two paths), untracked files and folders', () => {
    const z = ['# branch.oid x', '1 .M N... 100644 100644 100644 a b src/a.ts', '2 R. N... 100644 100644 100644 a b R100 new.ts', 'old.ts', 'u UU N... 1 2 3 4 a b c conflict.ts', '? notes.md', '? newdir/', ''].join('\0');
    expect(parseStatusEntries(z)).toEqual({ tracked: 3, untracked: ['notes.md', 'newdir/'] });
  });

  it('batch output: framed by length, NULs inside, missing results after a stop', () => {
    const out = Buffer.concat([Buffer.from('0 4\nmain'), Buffer.from('1 5\na\0b\0c'), Buffer.from('0 0\n')]);
    expect(parseBatch(out, 4, true, false)).toEqual([
      { code: 0, stdout: 'main', stderr: '', timedOut: false },
      { code: 1, stdout: 'a\0b\0c', stderr: '', timedOut: false },
      { code: 0, stdout: '', stderr: '', timedOut: false },
      { code: null, stdout: '', stderr: '', timedOut: true },
    ]);
    // Cut off by the output limit.
    expect(parseBatch(Buffer.from('0 10\nabc'), 1, false, true)).toEqual([{ code: 0, stdout: 'abc', stderr: '', timedOut: false, overflow: true }]);
  });
});

describe('the task row', () => {
  it('counts: nothing without changes, ≥ when not all new files were counted, short for large numbers', () => {
    expect(taskCounts(undefined)).toBeNull();
    expect(taskCounts(sum({ files: 0, added: 0, removed: 0 }))).toBeNull();
    expect(taskCounts(sum())).toEqual({ added: '+3', removed: '−1' });
    expect(taskCounts(sum({ approximate: true }))).toEqual({ added: '≥+3', removed: '−1' });
    expect(taskCounts(sum({ added: 12_345, removed: 0 }))?.added).toBe('+12.3k');
  });

  it('tooltip: what the counts are against, commits, uncommitted, binary and approximate', () => {
    const tip = taskTooltip(task, sum({ binary: 1, approximate: true, behind: 2 })).join('\n');
    expect(tip).toContain('Branch splitnest/fix, from main');
    expect(tip).toContain('1 commit that main doesn’t have');
    expect(tip).toContain('main has 2 newer commits');
    expect(tip).toContain('At least 3 lines added, 1 removed in 2 files, compared with where the task left main: committed and uncommitted changes, new files included (1 binary file not counted)');
    expect(tip).toContain('1 change not committed yet');
    expect(taskTooltip(task, sum({ ahead: null })).join('\n')).toContain('Can’t tell how it relates to main');
    expect(taskTooltip(task, undefined).join('\n')).toContain('Changes not checked yet');
  });
});
