// Source Control for any workspace in a Git repository (the docked panel on a normal workspace):
// what changed, staged and not, and the actions on it. Main runs every Git command; the page sends
// only a workspace id, file paths taken from main's own listing, and a commit message.

export type ScFileKind = 'added' | 'modified' | 'deleted' | 'renamed' | 'copied' | 'typechange' | 'untracked' | 'conflicted';

export interface ScFile {
  /** Relative to the repository's top folder, `/`-separated (as Git lists it). */
  path: string;
  /** Renames and copies: where it came from. */
  oldPath?: string;
  kind: ScFileKind;
  /** Lines added and removed (null: binary, or not counted, e.g. a new untracked file). */
  added: number | null;
  removed: number | null;
  binary: boolean;
}

export interface ScStatus {
  /** The repository's top folder (Windows form). */
  top: string;
  /** The branch checked out; null when HEAD is detached (then `head` is its short commit). */
  branch: string | null;
  head: string | null;
  /** The branch's upstream (`origin/main`), or null. */
  upstream: string | null;
  ahead: number;
  behind: number;
  /** No commit yet in this repository. */
  unborn: boolean;
  staged: ScFile[];
  /** Not staged: changed tracked files, new untracked files, and conflicts. */
  unstaged: ScFile[];
  /** More files than listed (at most SC_LIMITS.maxFiles per group). */
  truncated: boolean;
  /** Files left out because their names can't be passed back to Git safely. */
  unlisted: number;
  /** A merge, rebase, cherry-pick or revert is in progress. */
  operation: 'merge' | 'rebase' | 'cherry-pick' | 'revert' | null;
}

export const SC_LIMITS = { maxFiles: 1000, maxMessage: 1000, maxPaths: 1000 } as const;

export type ScErrorCode =
  | 'NOT_A_REPOSITORY'
  | 'GIT_NOT_FOUND'
  | 'WSL_UNAVAILABLE'
  | 'CHANGES_NOT_CHECKED'
  | 'NOT_CHANGED'
  | 'STALE'
  | 'NOTHING_STAGED'
  | 'INVALID_MESSAGE'
  | 'COMMIT_FAILED'
  | 'NO_UPSTREAM'
  | 'NO_REMOTE'
  | 'DETACHED'
  | 'PUSH_FAILED'
  | 'PULL_DIVERGED'
  | 'PULL_FAILED'
  | 'OPERATION_IN_PROGRESS'
  | 'TIMEOUT'
  | 'GIT_FAILED';

export interface ScError {
  code: ScErrorCode;
  message: string;
  /** Git's own words (first lines of its error output, credentials in URLs hidden). */
  detail?: string;
}

export type ScResult<T> = ({ ok: true } & T) | { ok: false; error: ScError };

/** What Discard will do to one file, and the key that confirms it (refused if the file changed since). */
export interface ScDiscardPreview {
  path: string;
  /** `delete`: a new file is deleted; `restore`: its unstaged changes are undone (staged ones stay). */
  action: 'delete' | 'restore';
  key: string;
}

/** Push without an upstream: where it would go (shown before pushing and tracking). */
export interface ScPushTarget {
  remote: string;
  branch: string;
}
