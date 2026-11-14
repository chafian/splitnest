// Text about agent tasks shown in the sidebar and the New task dialog.
import type { TaskProgress, TaskSummary, WorkspaceTask } from '../../../shared/tasks';
import { shortCount } from '../workspaces/git-label';
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

/** The WSL distribution a folder is in (`\\wsl.localhost\<distro>\…`, `\\wsl$\<distro>\…`), or null. */
export function wslDistroOf(folder: string): string | null {
  const m = /^[\\/]{2}(?:wsl\$|wsl\.localhost)[\\/]([A-Za-z0-9._-]+)(?:[\\/]|$)/i.exec(folder);
  return m ? m[1]! : null;
}

/**
 * The shells a task can start in: for a repository inside WSL, that distribution's WSL profile (its own
 * Git made the task folder); otherwise PowerShell, since Git inside WSL can't use a task folder that
 * Windows Git made (their worktree records hold each other's paths).
 */
export function taskShells<P extends { kind: string; distro?: string }>(profiles: readonly P[], parentRoot: string): P[] {
  const distro = wslDistroOf(parentRoot);
  if (distro) return profiles.filter((p) => p.kind === 'wsl' && p.distro?.toLowerCase() === distro.toLowerCase());
  return profiles.filter((p) => p.kind !== 'wsl');
}

const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;

/** The row's `+356 −41` (`≥` when new files weren't all counted), or null when there is nothing to show. */
export function taskCounts(s: TaskSummary | undefined): { added: string; removed: string } | null {
  if (!s || (s.files === 0 && s.added === 0 && s.removed === 0)) return null;
  const at = s.approximate ? '≥' : '';
  return { added: `${at}+${shortCount(s.added)}`, removed: `−${shortCount(s.removed)}` };
}

/**
 * The task row's tooltip: what the counts mean (against where the task left its base branch, not
 * against the last commit as for other workspaces), and the rest of the summary.
 */
export function taskTooltip(task: WorkspaceTask, s: TaskSummary | undefined): string[] {
  const lines = [`Branch ${task.branch}, from ${task.baseBranch}`];
  if (!s) return [...lines, 'Changes not checked yet (or not available for this task).'];
  if (s.ahead !== null) lines.push(s.ahead === 0 ? 'No commits yet' : `${plural(s.ahead, 'commit')} that ${task.baseBranch} doesn’t have`);
  else lines.push(`Can’t tell how it relates to ${task.baseBranch} (that branch may have been renamed or deleted)`);
  if (s.behind) lines.push(`${task.baseBranch} has ${plural(s.behind, 'newer commit')}`);
  if (s.files === 0) lines.push('No changes yet');
  else {
    lines.push(
      `${s.approximate ? 'At least ' : ''}${s.added.toLocaleString('en-US')} lines added, ${s.removed.toLocaleString('en-US')} removed in ${plural(s.files, 'file')}, ` +
        `compared with where the task left ${task.baseBranch}: committed and uncommitted changes, new files included${s.binary ? ` (${plural(s.binary, 'binary file')} not counted)` : ''}`,
    );
    if (s.approximate) lines.push('Some new files weren’t counted (too large, too many, or a whole new folder)');
  }
  if (s.uncommitted) lines.push(`${plural(s.uncommitted, 'change')} not committed yet`);
  return lines;
}

export interface TaskFact {
  text: string;
  tone: 'quiet' | 'info' | 'warn';
}

/**
 * The Changes panel header: only what the summary knows for certain, cheaply. Whether merging would
 * conflict is not shown here (it is checked on demand in Finish; older Git can't tell at all).
 */
export function taskFacts(s: TaskSummary | undefined, base: string): TaskFact[] {
  if (!s) return [{ text: 'Checking…', tone: 'quiet' }];
  const out: TaskFact[] = [];
  if (s.files === 0 && s.ahead === 0) out.push({ text: 'No changes yet', tone: 'quiet' });
  if (s.uncommitted > 0) out.push({ text: `${s.uncommitted} not committed`, tone: 'warn' });
  if (s.ahead === null) out.push({ text: `Can’t tell what ${base} lacks`, tone: 'warn' });
  else if (s.ahead > 0) out.push({ text: `${s.ahead} ${s.ahead === 1 ? 'commit' : 'commits'} to merge`, tone: 'info' });
  if (s.behind) out.push({ text: `${base} +${s.behind}`, tone: 'quiet' });
  return out;
}
