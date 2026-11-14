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
