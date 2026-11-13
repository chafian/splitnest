// Text about agent tasks shown in the sidebar and the New task dialog.
import type { TaskProgress } from '../../../shared/tasks';
import type { GitStatus } from '../../../shared/types';

/** "2 commits" on the task branch that its base doesn't have yet (and how far the base moved on). */
export function taskProgressText(p: TaskProgress | undefined): string | null {
  if (!p) return null;
  if (!p.folderExists) return 'task folder missing';
  if (p.ahead === null) return null;
  const ahead = p.ahead === 0 ? 'no commits yet' : `${p.ahead} ${p.ahead === 1 ? 'commit' : 'commits'}`;
  return p.behind ? `${ahead} · base ${p.behind} ahead` : ahead;
}

/** What the parent's uncommitted changes mean for a new task (it starts from the last commit). */
export function uncommittedNote(status: GitStatus | null, baseBranch: string): string | null {
  if (!status || (status.changedFiles === 0 && status.untracked === 0)) return null;
  return `This workspace has uncommitted changes. They are not part of the task, which starts from the last commit on ${baseBranch}.`;
}
