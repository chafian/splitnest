import { describe, expect, it } from 'vitest';
import { finishPlan } from '../../src/renderer/features/tasks/finish-plan';
import type { TaskFinishCheck } from '../../src/shared/tasks';

const ready: TaskFinishCheck = {
  head: 'a'.repeat(40),
  uncommitted: [],
  uncommittedCount: 0,
  commitsToMerge: 2,
  behind: 0,
  mergeFolder: 'C:\\code\\app',
  mergeFolderDirty: false,
  inProgress: null,
  unresolved: [],
  preview: 'clean',
  conflicts: [],
  ignored: [],
  ignoredCount: 0,
  runningTerminals: 1,
};
const plan = (c: Partial<TaskFinishCheck>, dirty = 0) => finishPlan({ ...ready, ...c }, dirty, 'main');

describe('Finish plan', () => {
  it('committed and clean: merge and clean up are offered', () => {
    const p = plan({});
    expect(p).toMatchObject({ canMerge: true, canRemove: true, commit: { state: 'done', canCommit: false }, merge: { state: 'ready', canUpdate: false } });
    expect(p.merge.text).toBe('2 commits merge cleanly into main, in C:\\code\\app.');
  });

  it('uncommitted files: commit first; nothing else until then', () => {
    const p = plan({ uncommitted: ['a.txt'], uncommittedCount: 1 });
    expect(p.commit).toMatchObject({ state: 'ready', canCommit: true });
    expect(p.commit.text).toMatch(/^1 file isn’t committed/);
    expect(p).toMatchObject({ canMerge: false, canRemove: false, merge: { state: 'blocked' } });
  });

  it('conflicts with main: blocked, and bringing in main is offered once the task is committed', () => {
    expect(plan({ preview: 'conflicts', conflicts: ['a.txt'] })).toMatchObject({ canMerge: false, canRemove: true, merge: { state: 'blocked', canUpdate: true } });
    expect(plan({ preview: 'conflicts', conflicts: ['a.txt'], uncommittedCount: 1 }).merge.canUpdate).toBe(false);
  });

  it('conflicts left in the task after bringing in main: resolve, then commit', () => {
    const p = plan({ inProgress: 'task', unresolved: ['a.txt'] });
    expect(p.commit).toMatchObject({ state: 'blocked', canCommit: true });
    expect(p.commit.text).toMatch(/conflicts from bringing in main/);
    expect(p).toMatchObject({ canMerge: false, canRemove: false });
    expect(plan({ inProgress: 'task' }).commit).toMatchObject({ state: 'ready', text: 'The conflicts are resolved. Commit to finish bringing in main.' });
  });

  it('the base folder: not checked out, changes, an operation in progress', () => {
    expect(plan({ mergeFolder: null })).toMatchObject({ canMerge: false, merge: { state: 'blocked' } });
    expect(plan({ mergeFolderDirty: true }).merge.text).toMatch(/has uncommitted changes/);
    expect(plan({ inProgress: 'base' }).merge.text).toMatch(/in progress/);
    // Removing the folder (keeping the branch) doesn't depend on the base folder.
    expect(plan({ mergeFolderDirty: true }).canRemove).toBe(true);
  });

  it('nothing to merge: Clean up only', () => {
    expect(plan({ commitsToMerge: 0, preview: 'nothing' })).toMatchObject({ canMerge: true, merge: { state: 'done' } });
  });

  it('older Git (no preview): the merge is offered and says it is undone on conflict', () => {
    const p = plan({ preview: 'unknown', behind: 3 });
    expect(p.canMerge).toBe(true);
    expect(p.merge.text).toMatch(/can’t check for conflicts first; if the merge conflicts, it is undone\. main has 3 newer commits/);
    expect(p.merge.canUpdate).toBe(true);
  });

  it('unsaved editor files in the task block cleaning up', () => {
    expect(plan({}, 2)).toMatchObject({ canMerge: false, canRemove: false });
  });
});
