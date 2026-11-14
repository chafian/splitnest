// What Finish offers, from main's check: one line per step, whether it is done, blocked or ready,
// and which buttons are enabled. Pure (tested on its own); main checks everything again anyway.
import type { TaskFinishCheck } from '../../../shared/tasks';

export type StepState = 'done' | 'ready' | 'blocked';

export interface FinishPlan {
  commit: { state: StepState; text: string; canCommit: boolean };
  merge: { state: StepState; text: string; canUpdate: boolean };
  clean: { state: StepState };
  /** "Merge and clean up" (or "Clean up" when there is nothing to merge). */
  canMerge: boolean;
  /** "Remove folder, keep branch". */
  canRemove: boolean;
}

const n = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

export function finishPlan(c: TaskFinishCheck, dirtyEditors: number, base: string): FinishPlan {
  const commit: FinishPlan['commit'] =
    c.unresolved.length > 0
      ? {
          state: 'blocked',
          text: `${n(c.unresolved.length, 'file has', 'files have')} conflicts from bringing in ${base}. Resolve them in the task folder (or ask the agent), then commit.`,
          canCommit: true,
        }
      : c.inProgress === 'task'
        ? { state: 'ready', text: `The conflicts are resolved. Commit to finish bringing in ${base}.`, canCommit: true }
        : c.uncommittedCount > 0
          ? { state: 'ready', text: `${n(c.uncommittedCount, 'file isn’t', 'files aren’t')} committed yet. Commit all of them, or let the agent commit.`, canCommit: true }
          : c.hasUncommitted
            ? { state: 'ready', text: 'Some changes in the task folder aren’t committed yet (not all of them can be listed here). Commit all of them, or let the agent commit.', canCommit: true }
            : { state: 'done', text: 'Everything in the task folder is committed.', canCommit: false };

  const taskReady = commit.state === 'done';
  let merge: FinishPlan['merge'];
  if (c.commitsToMerge === null)
    merge = {
      state: 'blocked',
      text: `SplitNest can’t tell how the task relates to ${base} (that branch may have been renamed or deleted). Merge it with Git yourself, or remove the folder and keep the branch.`,
      canUpdate: false,
    };
  else if (c.commitsToMerge === 0) merge = { state: 'done', text: `Nothing to merge: the task has no commits that ${base} doesn’t have.`, canUpdate: false };
  else if (!c.mergeFolder) merge = { state: 'blocked', text: `${base} isn’t checked out in any folder. Check it out (for example in the workspace the task came from).`, canUpdate: false };
  else if (c.inProgress === 'base') merge = { state: 'blocked', text: `A merge, rebase or cherry-pick is in progress in ${c.mergeFolder}. Finish or abort it first.`, canUpdate: false };
  else if (c.mergeFolderDirty) merge = { state: 'blocked', text: `${c.mergeFolder} has uncommitted changes. Commit or stash them there first, so the merge can’t mix with them.`, canUpdate: false };
  else if (c.preview === 'conflicts')
    merge = {
      state: 'blocked',
      text: `Merging would conflict with ${base} in these files. Bring in ${base} to resolve them in the task folder; your folder isn’t touched.`,
      canUpdate: taskReady,
    };
  else
    merge = {
      state: taskReady ? 'ready' : 'blocked',
      text:
        (c.preview === 'clean'
          ? `${n(c.commitsToMerge, 'commit merges', 'commits merge')} cleanly into ${base}, in ${c.mergeFolder}.`
          : `${n(c.commitsToMerge, 'commit', 'commits')} to merge into ${base}, in ${c.mergeFolder}. This Git version can’t check for conflicts first; if the merge conflicts, it is undone.`) +
        (c.behind ? ` ${base} has ${n(c.behind, 'newer commit', 'newer commits')}, which the merge combines.` : ''),
      canUpdate: taskReady && !!c.behind,
    };

  const canRemove = taskReady && c.inProgress !== 'task' && dirtyEditors === 0;
  const canMerge = canRemove && c.commitsToMerge !== null && (c.commitsToMerge === 0 || merge.state === 'ready');
  return { commit, merge, clean: { state: canMerge ? 'ready' : 'blocked' }, canMerge, canRemove };
}
