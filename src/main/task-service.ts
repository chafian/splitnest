// Agent tasks in main: creates a Git worktree on a new branch for a task, reports how far its
// branch is from the base, and removes it again, without ever losing work.
//
// - Paths and branches come only from main: the workspace folder (main's own copy) and names main
//   derives from the task name. The page never sends a path or a branch.
// - Task folders go next to the repository's main worktree (`C:\code\app.worktrees\<slug>`), on a
//   branch `splitnest/<slug>` that starts at the base branch's current commit. A taken branch or
//   folder (even a case-insensitive match, Windows refs are files) gets `-2`, `-3`… instead.
// - Nothing is forced. `git worktree remove` without --force refuses a folder with uncommitted or
//   untracked files and a locked worktree; a branch is deleted only when every commit on it is in
//   the base branch, and only if it still points where it was checked (update-ref with the old id).
//   SplitNest deletes nothing itself except empty folders: when a program has the task folder (or a
//   folder in it) open, Git deletes the files and the worktree but can't delete those folders, and
//   SplitNest removes them (now or on a retry) only while they contain no file at all, without
//   following links. Note that `git worktree remove` deletes ignored files (build output, .env)
//   along with the folder; the page must warn about that before finishing a task.
// - Operations that change a repository run one at a time per repository (two tasks created at
//   once never pick the same name). Different repositories don't wait for each other.
// - Nothing about repositories is logged; error messages name no path, branch or Git output.
import { access, lstat, open, readdir, readFile, realpath, rmdir } from 'node:fs/promises';
import path from 'node:path';
import { isWslRoot, repositoryFilterKeys } from './git-status';
import type { GitResult, GitRunner } from './git-runner';
import {
  fromGitPath,
  isSafeRelative,
  isStrictlyInside,
  parseLeftRight,
  parseNameStatus,
  parseNumstat,
  parsePaths,
  parseWorktreeList,
  removeRefusal,
  samePath,
  suffixed,
  taskBranch,
  taskSlug,
  versionAtLeast,
  worktreesDir,
  type WorktreeEntry,
} from './git-worktree';
import {
  isCommitMessage,
  isTaskName,
  TASK_BRANCH_PREFIX,
  TASK_LIMITS,
  type BranchOutcome,
  type TaskBase,
  type TaskChange,
  type TaskChangeKind,
  type TaskChanges,
  type TaskDiff,
  type TaskError,
  type TaskErrorCode,
  type TaskFinishCheck,
  type TaskMergeResult,
  type TaskUpdateResult,
  type TaskPreview,
  type TaskProgress,
  type TaskRecord,
  type TaskResult,
} from '../shared/tasks';

const win = path.win32;

/** A checkout can take a while in a large repository (and hooks run after it). */
export const ADD_TIMEOUT_MS = 5 * 60_000;
/** A merge (and its hooks) in a large repository. */
export const MERGE_TIMEOUT_MS = 5 * 60_000;
/** Deleting a large folder (node_modules) can take a while too. */
export const REMOVE_TIMEOUT_MS = 2 * 60_000;

const MESSAGES: Record<TaskErrorCode, string> = {
  DISABLED: 'Agent tasks are off. Turn them on in Settings › Workspaces › Agent tasks (preview).',
  WORKSPACE_NOT_FOUND: 'That workspace no longer exists.',
  GIT_NOT_FOUND: 'Git isn’t installed (git.exe wasn’t found on PATH).',
  NOT_A_REPOSITORY: 'This workspace folder isn’t in a Git repository, or Git refused to open it.',
  BARE_REPOSITORY: 'Tasks need a repository with a working folder; this one is bare.',
  DETACHED_HEAD: 'Check out a branch first: no branch is checked out here, so there is nothing to merge a task back into.',
  NO_COMMITS: 'Make a first commit first: a task branch starts from the current commit.',
  UNSUPPORTED_LOCATION: 'Tasks aren’t available for this folder’s location yet.',
  INVALID_NAME: 'Give the task a name with at least one letter or digit (up to 80 characters).',
  NAME_TAKEN: 'Branches or folders with this name already exist. Choose another name.',
  NOT_A_TASK: 'This folder isn’t a SplitNest task of this repository anymore, so SplitNest leaves it alone.',
  REPOSITORY_MISSING: 'The repository this task belongs to can’t be found.',
  TASK_DIRTY: 'The task folder has uncommitted or untracked files. Commit or remove them first.',
  TASK_LOCKED: 'The task’s worktree is locked in Git (git worktree unlock releases it).',
  FOLDER_IN_USE: 'The task folder couldn’t be deleted completely, probably because a program is using it. Close that program and try again.',
  LEFTOVER_FILES: 'Git no longer lists this folder as the task’s worktree, but it still contains files. SplitNest doesn’t delete files Git doesn’t track: check them and delete the folder yourself.',
  TIMEOUT: 'Git took too long and was stopped.',
  CHANGES_NOT_CHECKED: 'This repository’s own Git configuration names a filter program, which Git would start to compare files, so SplitNest doesn’t compare them here. Review the changes with Git yourself.',
  NOT_CHANGED: 'That file isn’t among the task’s changes (anymore).',
  TERMINALS_RUNNING: 'Terminals are still running in this task. They are ended first; try again in a moment.',
  BASE_NOT_CHECKED_OUT: 'The branch the task came from isn’t checked out in any folder, so there is nowhere to merge it. Check it out (for example in the workspace the task came from) and try again.',
  BASE_DIRTY: 'The folder where the task would be merged has uncommitted changes. Commit or stash them there first, so the merge can’t mix with them.',
  OPERATION_IN_PROGRESS: 'A merge, rebase, cherry-pick or revert is in progress there. Finish or abort it first.',
  TASK_UNCOMMITTED: 'The task has changes that aren’t committed. Commit them first (Commit all), so the merge brings everything you reviewed.',
  CONFLICTS_UNRESOLVED: 'Some files in the task still contain conflict markers (<<<<<<<). Resolve them first, in the task folder.',
  NOTHING_TO_COMMIT: 'There is nothing to commit in the task folder.',
  INVALID_MESSAGE: 'Write a commit message (up to 1000 characters).',
  COMMIT_FAILED: 'Git couldn’t commit. Check that your Git name and email are set (git config user.name / user.email) and that no commit hook refused it.',
  MERGE_FAILED: 'Git couldn’t merge (for example because it would overwrite untracked files there, or a hook refused). Nothing was changed.',
  MERGE_NOT_UNDONE: 'The merge stopped and SplitNest couldn’t undo it. Run `git merge --abort` in the folder it was merged in, then check that folder.',
  STALE: 'The task changed since this was shown (new commits). Look at it again before discarding it.',
  GIT_FAILED: 'Git couldn’t complete the operation.',
};

const fail = (code: TaskErrorCode): { ok: false; error: TaskError } => ({ ok: false, error: { code, message: MESSAGES[code] } });

/** A task error with its standard message (for callers that refuse before reaching the service). */
export const taskFailure = fail;

/** A failed Git run as a task error (null result: Git isn't installed). */
const gitFailure = (r: GitResult | null, otherwise: TaskErrorCode = 'GIT_FAILED') => fail(r === null ? 'GIT_NOT_FOUND' : r.timedOut ? 'TIMEOUT' : otherwise);

export interface TaskServiceDeps {
  git: GitRunner;
  isDirectory(p: string): Promise<boolean>;
}

interface Repo {
  base: TaskBase;
  /** Where task folders go. */
  dir: string;
}

export class TaskService {
  private readonly chains = new Map<string, Promise<unknown>>();

  constructor(private readonly deps: TaskServiceDeps) {}

  /** What a task created from `root` with this name would be, without creating anything. */
  async preview(root: string, name: unknown): Promise<TaskResult<{ preview: TaskPreview }>> {
    const slug = isTaskName(name) ? taskSlug(name) : null;
    if (!slug) return fail('INVALID_NAME');
    const repo = await this.inspect(root);
    if (!repo.ok) return repo;
    const picked = await this.pick(repo.repo, slug);
    if (!picked.ok) return picked;
    return { ok: true, preview: { ...repo.repo.base, ...picked.names, taskRoot: taskRoot(picked.names.worktreePath, repo.repo.base.subPath) } };
  }

  /** Creates the task's branch and worktree from the branch checked out in `root`. */
  async create(root: string, name: unknown): Promise<TaskResult<{ task: TaskRecord }>> {
    const slug = isTaskName(name) ? taskSlug(name) : null;
    if (!slug) return fail('INVALID_NAME');
    const inspected = await this.inspect(root);
    if (!inspected.ok) return inspected;
    const repo = inspected.repo;
    return this.serial(repo.base.repoRoot, async () => {
      const picked = await this.pick(repo, slug);
      if (!picked.ok) return picked;
      const { branch, worktreePath } = picked.names;
      const { repoRoot, baseCommit } = repo.base;
      const add = await this.deps.git.run(repoRoot, ['worktree', 'add', '-b', branch, worktreePath, baseCommit], { timeoutMs: ADD_TIMEOUT_MS });
      const list = await this.list(repoRoot);
      const entry = list?.find((e) => samePath(e.path, worktreePath)) ?? null;
      if (add === null || add.code !== 0) {
        // Git cleans up after a failed add; if it got as far as the branch (but no worktree uses
        // it), delete that branch, only while it is still exactly the base commit.
        if (add !== null && !entry && !list?.some((e) => e.branch === branch)) {
          await this.deps.git.run(repoRoot, ['update-ref', '-d', `refs/heads/${branch}`, baseCommit]);
        }
        return gitFailure(add);
      }
      if (!entry || entry.branch !== branch) return fail('GIT_FAILED');
      return { ok: true, task: { ...repo.base, branch, worktreePath, taskRoot: taskRoot(worktreePath, repo.base.subPath) } };
    });
  }

  /** The task branch against its base branch, and whether its folder is still there. */
  async progress(task: TaskRecord): Promise<TaskResult<{ progress: TaskProgress }>> {
    if (!(await this.deps.isDirectory(task.repoRoot))) return fail('REPOSITORY_MISSING');
    const list = await this.list(task.repoRoot);
    if (!list) return fail('REPOSITORY_MISSING');
    const folderExists = await this.deps.isDirectory(task.worktreePath);
    const registered = list.some((e) => samePath(e.path, task.worktreePath));
    const branchExists = (await this.refId(task.repoRoot, task.branch)) !== null;
    let ahead: number | null = null;
    let behind: number | null = null;
    if (branchExists && (await this.refId(task.repoRoot, task.baseBranch)) !== null) {
      const r = await this.deps.git.run(task.repoRoot, ['rev-list', '--left-right', '--count', `refs/heads/${task.baseBranch}...refs/heads/${task.branch}`]);
      const counts = r?.code === 0 ? parseLeftRight(r.stdout) : null;
      if (counts) [behind, ahead] = counts;
    }
    return { ok: true, progress: { folderExists, registered, branchExists, ahead, behind } };
  }

  /**
   * Removes the task's worktree (refused while it has uncommitted or untracked files) and, if
   * asked, its branch when every commit on it is in the base branch. A folder that is already
   * gone is fine; a folder Git doesn't list as this task's worktree is never touched.
   */
  async remove(task: TaskRecord, options: { deleteBranch: boolean }): Promise<TaskResult<{ branch: BranchOutcome }>> {
    const dir = worktreesDir(task.repoRoot);
    if (!dir || !isStrictlyInside(task.worktreePath, dir) || !task.branch.startsWith(TASK_BRANCH_PREFIX)) return fail('NOT_A_TASK');
    if (!(await this.deps.isDirectory(task.repoRoot))) return fail('REPOSITORY_MISSING');
    return this.serial(task.repoRoot, async () => {
      const list = await this.list(task.repoRoot);
      if (!list) return fail('REPOSITORY_MISSING');
      if (!list[0] || !samePath(list[0].path, task.repoRoot)) return fail('NOT_A_TASK');
      const entry = list.find((e) => samePath(e.path, task.worktreePath));
      const folderExists = await this.deps.isDirectory(task.worktreePath);
      if (entry) {
        if (entry.branch !== task.branch) return fail('NOT_A_TASK');
        if (entry.locked) return fail('TASK_LOCKED');
        const r = await this.deps.git.run(task.repoRoot, ['worktree', 'remove', task.worktreePath], { timeoutMs: REMOVE_TIMEOUT_MS });
        if (r === null || r.code !== 0) {
          const why = r ? removeRefusal(r.stderr) : null;
          if (why === 'dirty') return fail('TASK_DIRTY');
          if (why === 'locked') return fail('TASK_LOCKED');
          // Git deletes the files and the worktree first; folders in use stay behind.
          const after = r && !r.timedOut ? await this.list(task.repoRoot) : null;
          if (!after || after.some((e) => samePath(e.path, task.worktreePath))) return gitFailure(r);
          const left = await removeEmptyFolders(task.worktreePath);
          if (left !== 'removed') return fail(left === 'files' ? 'LEFTOVER_FILES' : 'FOLDER_IN_USE');
        }
      } else if (folderExists) {
        // Left behind by an earlier removal (or never a worktree): only empty folders are deleted.
        const left = await removeEmptyFolders(task.worktreePath);
        if (left !== 'removed') return fail(left === 'files' ? 'LEFTOVER_FILES' : 'FOLDER_IN_USE');
      }
      if (!options.deleteBranch) return { ok: true, branch: 'kept' };
      return { ok: true, branch: await this.deleteMergedBranch(task) };
    });
  }

  /**
   * Review: every file the task changed against the commit where its branch left the base branch
   * (what merging it would bring), committed or not, plus new files Git doesn't track yet. Read-only:
   * like the sidebar's Git status, no index refresh or lock, no file-system monitor, external diff or
   * text conversion, no submodules, and nothing at all when the repository's own configuration names a
   * filter program (Git would start it to compare files).
   */
  async changes(task: TaskRecord): Promise<TaskResult<{ changes: TaskChanges }>> {
    const cwd = task.worktreePath;
    if (!(await this.deps.isDirectory(cwd))) return fail('NOT_A_TASK');
    const cfg = await this.read(cwd, ['config', '--show-scope', '--includes', '--null', '--get-regexp', '^filter\\..*\\.(clean|process)$']);
    if (cfg === null) return fail('GIT_NOT_FOUND');
    if (cfg.code !== 0 && cfg.code !== 1) return gitFailure(cfg);
    if (cfg.code === 0 && repositoryFilterKeys(cfg.stdout).length > 0) return fail('CHANGES_NOT_CHECKED');
    // Where the task branch left the base branch; the recorded start if the base branch is gone.
    const mb = (await this.refId(cwd, task.baseBranch)) ? await this.read(cwd, ['merge-base', `refs/heads/${task.baseBranch}`, 'HEAD']) : null;
    const mergeBase = mb?.code === 0 && /^[0-9a-f]{40,64}$/.test(mb.stdout.trim()) ? mb.stdout.trim() : task.baseCommit;
    const diff = ['diff', '-M', '-z', '--no-color', '--no-ext-diff', '--no-textconv', '--ignore-submodules=all'];
    const [names, nums, dirty, others] = await Promise.all([
      this.read(cwd, [...diff, '--name-status', mergeBase]),
      this.read(cwd, [...diff, '--numstat', mergeBase]),
      this.read(cwd, [...diff, '--name-only', 'HEAD']),
      this.read(cwd, ['ls-files', '--others', '--exclude-standard', '--full-name', '-z']),
    ]);
    for (const r of [names, nums, dirty, others]) if (r === null || r.code !== 0) return gitFailure(r);
    const counts = parseNumstat(nums!.stdout);
    const uncommitted = new Set(parsePaths(dirty!.stdout));
    const files: TaskChange[] = [];
    for (const n of parseNameStatus(names!.stdout)) {
      if (!isSafeRelative(n.path) || (n.oldPath !== undefined && !isSafeRelative(n.oldPath))) continue;
      const c = counts.get(n.path) ?? { added: null, removed: null };
      files.push({
        path: n.path,
        ...(n.oldPath !== undefined ? { oldPath: n.oldPath } : {}),
        kind: changeKind(n.status),
        added: c.added,
        removed: c.removed,
        binary: c.added === null && c.removed === null && n.status !== 'D',
        uncommitted: uncommitted.has(n.path) || (n.oldPath !== undefined && uncommitted.has(n.oldPath)),
      });
    }
    for (const p of parsePaths(others!.stdout)) {
      if (isSafeRelative(p)) files.push({ path: p, kind: 'untracked', added: null, removed: null, binary: false, uncommitted: true });
    }
    files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    const truncated = files.length > TASK_LIMITS.maxChangedFiles || !!names!.overflow || !!others!.overflow;
    return { ok: true, changes: { baseBranch: task.baseBranch, mergeBase, files: files.slice(0, TASK_LIMITS.maxChangedFiles), truncated } };
  }

  /** Review: one changed file's diff against the merge base (only a file `changes` lists). */
  async diff(task: TaskRecord, file: unknown): Promise<TaskResult<{ diff: TaskDiff }>> {
    if (typeof file !== 'string' || !isSafeRelative(file)) return fail('NOT_CHANGED');
    const listed = await this.changes(task);
    if (!listed.ok) return listed;
    const entry = listed.changes.files.find((f) => f.path === file);
    if (!entry) return fail('NOT_CHANGED');
    if (entry.kind === 'untracked') return { ok: true, diff: await untrackedDiff(task.worktreePath, entry.path) };
    if (entry.binary) return { ok: true, diff: { text: '', binary: true, truncated: false } };
    const paths = entry.oldPath !== undefined ? [entry.oldPath, entry.path] : [entry.path];
    const r = await this.read(task.worktreePath, [
      'diff',
      '-M',
      '-U3',
      '--no-color',
      '--no-ext-diff',
      '--no-textconv',
      '--ignore-submodules=all',
      listed.changes.mergeBase,
      '--',
      ...paths.map((p) => `:(literal)${p}`),
    ]);
    if (r === null || (r.code !== 0 && !r.overflow)) return gitFailure(r);
    return { ok: true, diff: capDiff(r.stdout, !!r.overflow) };
  }

  // ---------------------------------------------------------------- finishing (M4)
  //
  // Everything here runs on the user's explicit action (Finish). Commands that change the repository
  // run the repository's hooks, as the same command typed in a terminal would. Nothing is forced
  // except Discard, which the user confirms with the list of what is lost, and which is refused when
  // the task got new commits since that list was shown.

  /** What Finish shows before it offers to merge or clean up (read-only). */
  async finishCheck(task: TaskRecord): Promise<TaskResult<{ check: Omit<TaskFinishCheck, 'runningTerminals'> }>> {
    const listed = await this.changes(task);
    if (!listed.ok) return listed;
    const uncommitted = listed.changes.files.filter((f) => f.uncommitted).map((f) => f.path);
    const head = await this.refId(task.repoRoot, task.branch);
    const progress = await this.progress(task);
    const commitsToMerge = progress.ok ? (progress.progress.ahead ?? 0) : 0;
    const behind = progress.ok ? (progress.progress.behind ?? 0) : 0;
    const mergeFolder = await this.mergeFolder(task);
    const mergeFolderDirty = mergeFolder ? await this.trackedChanges(mergeFolder) : false;
    const inProgress = (await this.operationInProgress(task.worktreePath)) ? 'task' : mergeFolder && (await this.operationInProgress(mergeFolder)) ? 'base' : null;
    const unresolved = await this.unmergedOrNull(task.worktreePath);
    if (unresolved === null) return fail('GIT_FAILED');
    let preview: TaskFinishCheck['preview'] = commitsToMerge === 0 ? 'nothing' : 'unknown';
    let conflicts: string[] = [];
    if (commitsToMerge > 0 && head && versionAtLeast(await this.deps.git.version(), [2, 38])) {
      // Computes the merge without touching any folder or branch (it only adds Git objects).
      const r = await this.read(task.repoRoot, ['merge-tree', '--write-tree', '--name-only', '--no-messages', '-z', `refs/heads/${task.baseBranch}`, `refs/heads/${task.branch}`]);
      if (r?.code === 0) preview = 'clean';
      else if (r?.code === 1) {
        preview = 'conflicts';
        conflicts = [...new Set(parsePaths(r.stdout).slice(1))].filter(isSafeRelative);
      }
    }
    const ig = await this.read(task.worktreePath, ['ls-files', '--others', '--ignored', '--exclude-standard', '--directory', '-z']);
    const ignoredAll = ig?.code === 0 ? parsePaths(ig.stdout) : [];
    return {
      ok: true,
      check: {
        head,
        uncommitted: uncommitted.slice(0, 50),
        uncommittedCount: uncommitted.length,
        commitsToMerge,
        behind,
        mergeFolder,
        mergeFolderDirty,
        inProgress,
        unresolved,
        preview,
        conflicts,
        ignored: ignoredAll.slice(0, 20),
        ignoredCount: ignoredAll.length,
      },
    };
  }

  /**
   * "Commit all" in the task folder: stage everything (as `git add -A`: new files too, ignored ones
   * not) and commit with the user's message. It also concludes a merge of the base branch whose
   * conflicts were resolved; files still containing conflict markers are refused.
   */
  async commitAll(task: TaskRecord, message: unknown): Promise<TaskResult<{ commit: string }>> {
    if (!isCommitMessage(message)) return fail('INVALID_MESSAGE');
    if (!(await this.isTaskFolder(task))) return fail('NOT_A_TASK');
    return this.serial(task.repoRoot, async () => {
      // Fails closed: if Git can't list the unresolved files, or one can't be checked, nothing is committed.
      const unresolved = await this.unmergedOrNull(task.worktreePath);
      if (unresolved === null) return fail('GIT_FAILED');
      if (unresolved.length > 0 && (await stillConflicted(task.worktreePath, unresolved)).length > 0) return fail('CONFLICTS_UNRESOLVED');
      const add = await this.deps.git.run(task.worktreePath, ['add', '-A']);
      if (add === null || add.code !== 0) return gitFailure(add);
      const staged = await this.deps.git.run(task.worktreePath, ['diff', '--cached', '--quiet', '--ignore-submodules=all']);
      const merging = await this.operationInProgress(task.worktreePath);
      if (staged?.code === 0 && !merging) return fail('NOTHING_TO_COMMIT');
      const commit = await this.deps.git.run(task.worktreePath, ['commit', '--quiet', '-m', message.trim()], { timeoutMs: MERGE_TIMEOUT_MS });
      if (commit === null || commit.timedOut) return gitFailure(commit);
      if (commit.code !== 0) return fail('COMMIT_FAILED');
      const id = await this.refId(task.repoRoot, task.branch);
      return id ? { ok: true, commit: id } : fail('GIT_FAILED');
    });
  }

  /**
   * Merges the task branch into the base branch, in the folder where the base branch is checked out.
   * Only when that folder has no changes to tracked files, nothing is in progress anywhere, and the
   * task has nothing uncommitted. If Git stops with conflicts (or any other way mid-merge), the merge
   * is aborted at once and the folder is checked to be exactly as before.
   */
  async merge(task: TaskRecord): Promise<TaskResult<{ result: TaskMergeResult }>> {
    if (!(await this.isTaskFolder(task))) return fail('NOT_A_TASK');
    return this.serial(task.repoRoot, async () => {
      const listed = await this.changes(task);
      if (!listed.ok) return listed;
      if (listed.changes.files.some((f) => f.uncommitted)) return fail('TASK_UNCOMMITTED');
      if (await this.operationInProgress(task.worktreePath)) return fail('OPERATION_IN_PROGRESS');
      const folder = await this.mergeFolder(task);
      if (!folder) return fail('BASE_NOT_CHECKED_OUT');
      if (await this.operationInProgress(folder)) return fail('OPERATION_IN_PROGRESS');
      if (await this.trackedChanges(folder)) return fail('BASE_DIRTY');
      const before = await this.refId(folder, task.baseBranch);
      if (!before) return fail('BASE_NOT_CHECKED_OUT');
      const r = await this.deps.git.run(folder, ['merge', '--no-edit', '--no-stat', `refs/heads/${task.branch}`], { timeoutMs: MERGE_TIMEOUT_MS });
      if (r !== null && r.code === 0 && !r.timedOut) {
        const after = await this.refId(folder, task.baseBranch);
        return after ? { ok: true, result: { outcome: 'merged', commit: after } } : fail('GIT_FAILED');
      }
      if (r === null) return fail('GIT_NOT_FOUND');
      // Stopped: undo whatever it left.
      // Unknown (Git couldn't list them): still undone and verified below, reported as a failed merge.
      const conflicts = (await this.unmergedOrNull(folder)) ?? [];
      if (await this.operationInProgress(folder)) {
        const abort = await this.deps.git.run(folder, ['merge', '--abort'], { timeoutMs: MERGE_TIMEOUT_MS });
        if (abort === null || abort.code !== 0) return fail('MERGE_NOT_UNDONE');
      }
      const now = await this.refId(folder, task.baseBranch);
      if (now !== before || (await this.trackedChanges(folder)) || (await this.operationInProgress(folder))) return fail('MERGE_NOT_UNDONE');
      return conflicts.length > 0 ? { ok: true, result: { outcome: 'conflicts', conflicts } } : fail(r.timedOut ? 'TIMEOUT' : 'MERGE_FAILED');
    });
  }

  /**
   * Brings the base branch's newer commits into the task folder (a merge there). Conflicts stay in
   * the task folder, where you or the agent resolve them and then commit (Commit all); the base
   * branch and the workspace it came from are not touched.
   */
  async updateFromBase(task: TaskRecord): Promise<TaskResult<{ result: TaskUpdateResult }>> {
    if (!(await this.isTaskFolder(task))) return fail('NOT_A_TASK');
    return this.serial(task.repoRoot, async () => {
      if (await this.operationInProgress(task.worktreePath)) return fail('OPERATION_IN_PROGRESS');
      if (await this.trackedChanges(task.worktreePath)) return fail('TASK_UNCOMMITTED');
      if (!(await this.refId(task.repoRoot, task.baseBranch))) return fail('BASE_NOT_CHECKED_OUT');
      const before = await this.refId(task.repoRoot, task.branch);
      const r = await this.deps.git.run(task.worktreePath, ['merge', '--no-edit', '--no-stat', `refs/heads/${task.baseBranch}`], { timeoutMs: MERGE_TIMEOUT_MS });
      if (r === null) return fail('GIT_NOT_FOUND');
      if (r.code === 0 && !r.timedOut) {
        const after = await this.refId(task.repoRoot, task.branch);
        return { ok: true, result: { outcome: after === before ? 'up-to-date' : 'updated' } };
      }
      const conflicts = await this.unmergedOrNull(task.worktreePath);
      // Can't tell whether conflicts are left: the task folder stays as Git left it (nothing is aborted).
      if (conflicts === null) return fail('GIT_FAILED');
      if (conflicts.length > 0) return { ok: true, result: { outcome: 'conflicts', conflicts } };
      // Stopped another way: undo it in the task folder too.
      if (await this.operationInProgress(task.worktreePath)) await this.deps.git.run(task.worktreePath, ['merge', '--abort']);
      return fail(r.timedOut ? 'TIMEOUT' : 'MERGE_FAILED');
    });
  }

  /**
   * Discard: deletes the task folder with whatever is in it, and its branch, even if not merged.
   * The user confirmed with the list of what is lost; `head` is the branch commit that list was
   * made for, and anything newer is refused (STALE). A locked worktree is still refused.
   */
  async discard(task: TaskRecord, head: unknown): Promise<TaskResult<object>> {
    const dir = worktreesDir(task.repoRoot);
    if (!dir || !isStrictlyInside(task.worktreePath, dir) || !task.branch.startsWith(TASK_BRANCH_PREFIX)) return fail('NOT_A_TASK');
    if (typeof head !== 'string' || !/^[0-9a-f]{40,64}$/.test(head)) return fail('STALE');
    return this.serial(task.repoRoot, async () => {
      const list = await this.list(task.repoRoot);
      if (!list || !list[0] || !samePath(list[0].path, task.repoRoot)) return fail('NOT_A_TASK');
      const now = await this.refId(task.repoRoot, task.branch);
      if (now !== null && now !== head) return fail('STALE');
      const entry = list.find((e) => samePath(e.path, task.worktreePath));
      if (entry) {
        if (entry.branch !== task.branch) return fail('NOT_A_TASK');
        if (entry.locked) return fail('TASK_LOCKED');
        const r = await this.deps.git.run(task.repoRoot, ['worktree', 'remove', '--force', task.worktreePath], { timeoutMs: REMOVE_TIMEOUT_MS });
        if (r === null || r.code !== 0) {
          const after = r && !r.timedOut ? await this.list(task.repoRoot) : null;
          if (!after || after.some((e) => samePath(e.path, task.worktreePath))) return gitFailure(r);
          const left = await removeEmptyFolders(task.worktreePath);
          if (left !== 'removed') return fail('FOLDER_IN_USE');
        }
      } else if (await this.deps.isDirectory(task.worktreePath)) {
        const left = await removeEmptyFolders(task.worktreePath);
        if (left !== 'removed') return fail(left === 'files' ? 'LEFTOVER_FILES' : 'FOLDER_IN_USE');
      }
      if (now !== null) {
        const others = await this.list(task.repoRoot);
        // Checked out somewhere else (by the user): the branch stays.
        if (others && !others.some((e) => e.branch === task.branch)) await this.deps.git.run(task.repoRoot, ['update-ref', '-d', `refs/heads/${task.branch}`, now]);
      }
      return { ok: true };
    });
  }

  /** The folder where the base branch is checked out (from Git's own worktree list), never the task's. */
  private async mergeFolder(task: TaskRecord): Promise<string | null> {
    const list = await this.list(task.repoRoot);
    const e = list?.find((x) => x.branch === task.baseBranch && !x.bare && !samePath(x.path, task.worktreePath));
    return e && (await this.deps.isDirectory(e.path)) ? e.path : null;
  }

  /** Changes to tracked files (staged or not) in a folder. */
  private async trackedChanges(cwd: string): Promise<boolean> {
    const r = await this.read(cwd, ['status', '--porcelain=v2', '-z', '--untracked-files=no', '--ignore-submodules=all']);
    return r === null || r.code !== 0 || r.stdout.length > 0;
  }

  /** Files Git lists as unmerged (conflicts) in a folder. */
  /** Files Git lists as unmerged (conflicts) in a folder, or null when Git couldn't tell. */
  private async unmergedOrNull(cwd: string): Promise<string[] | null> {
    const r = await this.read(cwd, ['diff', '--name-only', '--diff-filter=U', '-z', '--no-ext-diff', '--no-textconv', '--ignore-submodules=all']);
    if (r?.code !== 0) return null;
    const all = [...new Set(parsePaths(r.stdout))];
    // A path Git lists that can't be checked safely counts as unresolved.
    return all.every(isSafeRelative) ? all : null;
  }

  /** A merge, rebase, cherry-pick or revert is in progress in that folder's worktree. */
  private async operationInProgress(cwd: string): Promise<boolean> {
    const names = ['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'rebase-merge', 'rebase-apply'];
    const r = await this.read(cwd, ['rev-parse', ...names.flatMap((n) => ['--git-path', n])]);
    if (r === null || r.code !== 0) return true;
    for (const line of r.stdout.split('\n').map((l) => l.trim()).filter(Boolean)) {
      const full = win.isAbsolute(fromGitPath(line)) ? fromGitPath(line) : win.join(cwd, fromGitPath(line));
      if (await pathExists(full)) return true;
    }
    return false;
  }

  /** The task folder is there and Git lists it as this task's worktree. */
  private async isTaskFolder(task: TaskRecord): Promise<boolean> {
    const dir = worktreesDir(task.repoRoot);
    if (!dir || !isStrictlyInside(task.worktreePath, dir) || !task.branch.startsWith(TASK_BRANCH_PREFIX)) return false;
    const list = await this.list(task.repoRoot);
    return !!list?.some((e) => samePath(e.path, task.worktreePath) && e.branch === task.branch) && (await this.deps.isDirectory(task.worktreePath));
  }

  /** A read-only Git command (no optional locks). */
  private read(cwd: string, args: string[]): Promise<GitResult | null> {
    return this.deps.git.run(cwd, ['--no-optional-locks', ...args]);
  }

  /** Deletes the task branch only if the base branch has all its commits and nothing checks it out. */
  private async deleteMergedBranch(task: TaskRecord): Promise<BranchOutcome> {
    const id = await this.refId(task.repoRoot, task.branch);
    if (id === null) return 'missing';
    const list = await this.list(task.repoRoot);
    if (!list || list.some((e) => e.branch === task.branch)) return 'unmerged';
    if ((await this.refId(task.repoRoot, task.baseBranch)) === null) return 'unmerged';
    const merged = await this.deps.git.run(task.repoRoot, ['merge-base', '--is-ancestor', id, `refs/heads/${task.baseBranch}`]);
    if (merged?.code !== 0) return 'unmerged';
    const del = await this.deps.git.run(task.repoRoot, ['update-ref', '-d', `refs/heads/${task.branch}`, id]);
    return del?.code === 0 ? 'deleted' : 'unmerged';
  }

  /** The repository, branch and commit a task created from `root` starts from. */
  private async inspect(root: string): Promise<TaskResult<{ repo: Repo }>> {
    if (isWslRoot(root)) return fail('UNSUPPORTED_LOCATION');
    // Where the workspace folder is inside its worktree ('' at the top), as Git sees it. Asking Git
    // rather than comparing paths: the folder may be spelled differently from what Git prints (a
    // short 8.3 name such as RUNNER~1, a junction, other letter case).
    const prefix = await this.deps.git.run(root, ['rev-parse', '--show-prefix']);
    if (prefix === null || prefix.code !== 0) return gitFailure(prefix, 'NOT_A_REPOSITORY');
    const list = await this.list(root);
    const main = list?.[0];
    if (!main) return fail('NOT_A_REPOSITORY');
    if (main.bare) return fail('BARE_REPOSITORY');
    // The workspace is a folder inside the repository: the task workspace is the same folder in the task's worktree.
    const subPath = prefix.stdout.trim().replace(/\/+$/, '').replace(/\//g, '\\');
    if (subPath.split('\\').some((part) => part === '..' || part === '.')) return fail('UNSUPPORTED_LOCATION');
    const sym = await this.deps.git.run(root, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
    if (sym === null) return fail('GIT_NOT_FOUND');
    if (sym.code !== 0) return fail('DETACHED_HEAD');
    const head = await this.deps.git.run(root, ['rev-parse', '--verify', '--quiet', 'HEAD^{commit}']);
    if (head === null) return fail('GIT_NOT_FOUND');
    if (head.code !== 0) return fail('NO_COMMITS');
    const dir = worktreesDir(main.path);
    if (!dir) return fail('UNSUPPORTED_LOCATION');
    return { ok: true, repo: { dir, base: { repoRoot: main.path, subPath, baseBranch: sym.stdout.trim(), baseCommit: head.stdout.trim() } } };
  }

  /** The first free name: no branch (case-insensitive, nor one it would clash with as a folder), no worktree, no folder. */
  private async pick(repo: Repo, slug: string): Promise<TaskResult<{ names: { branch: string; worktreePath: string } }>> {
    const refs = await this.deps.git.run(repo.base.repoRoot, ['for-each-ref', '--format=%(refname)', 'refs/heads/']);
    if (refs === null || refs.code !== 0) return gitFailure(refs);
    const branches = refs.stdout
      .split('\n')
      .map((l) => l.trim().toLowerCase())
      .filter((l) => l.startsWith('refs/heads/'))
      .map((l) => l.slice(11));
    // A branch named `splitnest` (a file where Git needs a folder) blocks every task branch.
    const prefix = TASK_BRANCH_PREFIX.slice(0, -1);
    if (branches.includes(prefix)) return fail('NAME_TAKEN');
    const list = (await this.list(repo.base.repoRoot)) ?? [];
    for (let n = 1; n <= TASK_LIMITS.maxSuffix; n++) {
      const name = suffixed(slug, n);
      const branch = taskBranch(name);
      const b = branch.toLowerCase();
      if (branches.some((x) => x === b || x.startsWith(`${b}/`))) continue;
      const worktreePath = win.join(repo.dir, name);
      if (list.some((e: WorktreeEntry) => samePath(e.path, worktreePath))) continue;
      if (await pathExists(worktreePath)) continue;
      return { ok: true, names: { branch, worktreePath } };
    }
    return fail('NAME_TAKEN');
  }

  /** The repository's worktrees (main first), or null when Git can't list them. */
  private async list(cwd: string): Promise<WorktreeEntry[] | null> {
    const nul = versionAtLeast(await this.deps.git.version(), [2, 36]);
    const r = await this.deps.git.run(cwd, ['worktree', 'list', '--porcelain', ...(nul ? ['-z'] : [])]);
    if (r === null || r.code !== 0) return null;
    return parseWorktreeList(r.stdout, nul);
  }

  /** A branch's commit id, or null when there is no such branch. */
  private async refId(cwd: string, branch: string): Promise<string | null> {
    const r = await this.deps.git.run(cwd, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}^{commit}`]);
    return r?.code === 0 ? r.stdout.trim() || null : null;
  }

  /** Runs `fn` after every earlier operation on the same repository has finished. */
  private serial<T>(repoRoot: string, fn: () => Promise<T>): Promise<T> {
    const key = fromGitPath(repoRoot).toLowerCase();
    const prev = this.chains.get(key) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    const settled = next.catch(() => undefined);
    this.chains.set(key, settled);
    void settled.then(() => {
      if (this.chains.get(key) === settled) this.chains.delete(key);
    });
    return next;
  }
}

function taskRoot(worktreePath: string, subPath: string): string {
  return subPath ? win.join(worktreePath, subPath) : worktreePath;
}

/** Anything at that path (a file with the folder's name blocks it as well). */
async function pathExists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * Deletes `dir` if it contains nothing but (nested) empty folders. Anything else (a file, a link or
 * junction) leaves everything in place: 'files'. A folder Windows won't delete (in use): 'busy'.
 */
export async function removeEmptyFolders(dir: string): Promise<'removed' | 'files' | 'busy'> {
  const folders: string[] = [];
  const walk = async (d: string): Promise<boolean> => {
    const st = await lstat(d);
    if (!st.isDirectory() || st.isSymbolicLink()) return false;
    folders.push(d);
    for (const e of await readdir(d, { withFileTypes: true })) {
      if (!e.isDirectory() || e.isSymbolicLink()) return false;
      if (!(await walk(win.join(d, e.name)))) return false;
    }
    return true;
  };
  try {
    if (!(await walk(dir))) return 'files';
  } catch {
    return 'busy';
  }
  // Deepest first, so each folder is empty when it is deleted (rmdir refuses one that isn't).
  for (const f of folders.reverse()) {
    try {
      await rmdir(f);
    } catch {
      return 'busy';
    }
  }
  return 'removed';
}

function changeKind(status: string): TaskChangeKind {
  switch (status) {
    case 'A':
      return 'added';
    case 'D':
      return 'deleted';
    case 'R':
      return 'renamed';
    case 'C':
      return 'copied';
    case 'T':
      return 'typechange';
    default:
      return 'modified';
  }
}

/** Diff text cut at the review limit, on a line boundary. */
export function capDiff(text: string, alreadyCut: boolean): TaskDiff {
  if (text.length <= TASK_LIMITS.maxDiffBytes && !alreadyCut) return { text, binary: false, truncated: false };
  const cut = text.slice(0, TASK_LIMITS.maxDiffBytes);
  const nl = cut.lastIndexOf('\n');
  return { text: nl > 0 ? cut.slice(0, nl + 1) : cut, binary: false, truncated: true };
}

/**
 * A new file Git doesn't track yet, shown as all added lines. Only a regular file inside the task
 * folder (no link, nothing outside it), at most TASK_LIMITS.maxUntrackedBytes.
 */
export async function untrackedDiff(folder: string, rel: string): Promise<TaskDiff> {
  const full = win.join(folder, ...rel.split('/'));
  try {
    const st = await lstat(full);
    if (!st.isFile()) return { text: '', binary: true, truncated: false };
    const [realFolder, realFile] = await Promise.all([realpath(folder), realpath(full)]);
    if (!isStrictlyInside(realFile, realFolder)) return { text: '', binary: true, truncated: false };
    if (st.size > TASK_LIMITS.maxUntrackedBytes) return { text: '', binary: false, truncated: true };
    const bytes = await readFile(full);
    if (bytes.subarray(0, 8000).includes(0)) return { text: '', binary: true, truncated: false };
    const text = bytes.toString('utf8');
    const lines = text.split(/\r?\n/);
    if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
    const body = lines.map((l) => `+${l}`).join('\n');
    return { text: `@@ -0,0 +1,${lines.length} @@\n${body}${body ? '\n' : ''}`, binary: false, truncated: false };
  } catch {
    return { text: '', binary: true, truncated: false };
  }
}

/** Unresolved files checked for conflict markers at most (more: all count as unresolved). */
export const MAX_CONFLICT_FILES = 500;
/** A conflicted file larger than this isn't read; it counts as unresolved. */
export const MAX_CONFLICT_FILE_BYTES = 10 * 1024 * 1024;

/**
 * Of these unmerged files in the task folder, those that may still be conflicted: they contain a
 * conflict marker line, or they can't be checked safely (fails closed). Only regular files whose real
 * path is inside the folder are read, never through a link, up to MAX_CONFLICT_FILE_BYTES each. A file
 * deleted in the resolution is resolved.
 */
export async function stillConflicted(folder: string, files: string[]): Promise<string[]> {
  if (files.length > MAX_CONFLICT_FILES) return files;
  const out: string[] = [];
  let realFolder: string;
  try {
    realFolder = await realpath(folder);
  } catch {
    return files;
  }
  for (const f of files) {
    const full = win.join(folder, ...f.split('/'));
    try {
      const st = await lstat(full);
      if (!st.isFile() || st.size > MAX_CONFLICT_FILE_BYTES || !isStrictlyInside(await realpath(full), realFolder)) {
        out.push(f);
        continue;
      }
      // Read through one handle that is checked to be the very file examined above (not swapped for a
      // link or another file in between), and never more than the size limit.
      const handle = await open(full, 'r');
      let text: string;
      try {
        const hs = await handle.stat();
        if (!hs.isFile() || hs.ino !== st.ino || hs.dev !== st.dev || hs.size > MAX_CONFLICT_FILE_BYTES) {
          out.push(f);
          continue;
        }
        const buf = Buffer.alloc(Math.min(hs.size, MAX_CONFLICT_FILE_BYTES));
        const { bytesRead } = await handle.read(buf, 0, buf.length, 0);
        text = buf.subarray(0, bytesRead).toString('utf8');
      } finally {
        await handle.close();
      }
      // The opening and closing markers (a line of seven `=` alone can be a Markdown heading underline).
      if (/^(<{7}|>{7})( |\r?$)/m.test(text)) out.push(f);
    } catch (e) {
      // Deleted in the resolution: resolved. Anything else: can't tell, so unresolved.
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') out.push(f);
    }
  }
  return out;
}
