// Agent tasks: a Git worktree on its own branch, opened as a workspace of its own, so several
// agents can work on one repository at once without editing the same files. Main creates and
// removes worktrees (src/main/task-service.ts); the page only ever sends ids and a task name.

export const TASK_LIMITS = {
  /** What the user types ("Fix the login form"). */
  maxNameLength: 80,
  /** The folder and branch part derived from it ("fix-the-login-form"). */
  maxSlugLength: 40,
  /** `-2` … `-99` are tried when a branch or folder with that name exists. */
  maxSuffix: 99,
} as const;

/** The branch prefix of every task branch: `splitnest/<slug>`. */
export const TASK_BRANCH_PREFIX = 'splitnest/';

export type TaskErrorCode =
  | 'GIT_NOT_FOUND'
  | 'NOT_A_REPOSITORY'
  | 'BARE_REPOSITORY'
  | 'DETACHED_HEAD'
  | 'NO_COMMITS'
  | 'UNSUPPORTED_LOCATION'
  | 'INVALID_NAME'
  | 'NAME_TAKEN'
  | 'NOT_A_TASK'
  | 'REPOSITORY_MISSING'
  | 'TASK_DIRTY'
  | 'TASK_LOCKED'
  | 'FOLDER_IN_USE'
  | 'LEFTOVER_FILES'
  | 'TIMEOUT'
  | 'GIT_FAILED';

export interface TaskError {
  code: TaskErrorCode;
  /** One sentence for the user. Never contains a path, branch name or Git's own message. */
  message: string;
}

export type TaskResult<T> = ({ ok: true } & T) | { ok: false; error: TaskError };

/** Where a task comes from: the repository and branch of the workspace it was created in. */
export interface TaskBase {
  /** The repository's main worktree (Windows path). Task folders go next to it. */
  repoRoot: string;
  /** The workspace folder relative to its worktree's top folder ('' when it is the top). */
  subPath: string;
  /** The branch checked out where the task was created; changes are merged back into it. */
  baseBranch: string;
  /** That branch's commit when the task was created: the task branch starts here. */
  baseCommit: string;
}

/** What main created for a task. Saved with the task's workspace (from M2 on). */
export interface TaskRecord extends TaskBase {
  /** `splitnest/<slug>` (with `-2`, `-3`… when taken). */
  branch: string;
  /** The task's worktree: `<repoRoot>.worktrees\<slug>`. */
  worktreePath: string;
  /** The task workspace's folder: the worktree plus `subPath`. */
  taskRoot: string;
}

/** What creating a task with a given name would make (shown before anything is created). */
export interface TaskPreview extends TaskBase {
  branch: string;
  worktreePath: string;
  taskRoot: string;
}

/** A task's branch against its base branch. Working-tree changes come from Git status. */
export interface TaskProgress {
  /** The task folder exists on disk. */
  folderExists: boolean;
  /** Git still lists the folder as a worktree of the repository. */
  registered: boolean;
  /** The task branch exists. */
  branchExists: boolean;
  /** Commits on the task branch that the base branch doesn't have (null: unknown). */
  ahead: number | null;
  /** Commits on the base branch since the task branched off (null: unknown, e.g. base deleted). */
  behind: number | null;
}

/** What happened to the branch when a task was removed. */
export type BranchOutcome =
  /** Deleted: every commit on it is in the base branch. */
  | 'deleted'
  /** Kept because the caller asked to keep it. */
  | 'kept'
  /** Kept because it has commits the base branch doesn't have. */
  | 'unmerged'
  /** There was no such branch anymore. */
  | 'missing';

/** A task name as typed: 1–80 characters after trimming, no control characters. */
export function isTaskName(v: unknown): v is string {
  if (typeof v !== 'string') return false;
  const t = v.trim();
  return t.length > 0 && t.length <= TASK_LIMITS.maxNameLength && !/[\u0000-\u001f\u007f]/.test(t);
}
