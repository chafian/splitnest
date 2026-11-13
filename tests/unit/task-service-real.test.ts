// Agent tasks against real Git in temporary repositories (skipped when git.exe is not on PATH):
// creating worktrees and branches, names that are taken, two tasks at once, removing without ever
// losing work, and refusing folders that aren't SplitNest tasks.
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { runFile } from '../../src/main/exec';
import { createWindowsGitRunner } from '../../src/main/git-runner';
import { gitEnv } from '../../src/main/git-status';
import { isDirectory } from '../../src/main/launch-resolver';
import { fileExists, findOnPath } from '../../src/main/shells';
import { TaskService } from '../../src/main/task-service';
import type { TaskRecord } from '../../src/shared/tasks';

const git = await findOnPath('git.exe', process.env, fileExists);
const env = gitEnv(process.env);
const runner = createWindowsGitRunner({ run: runFile, findGit: async () => git, env: process.env, home: os.homedir() });
const service = new TaskService({ git: runner, isDirectory });

// The long, real path: Git reports folders that way, while the temporary folder can come as a short
// 8.3 name (C:\Users\RUNNER~1\… on GitHub's runners).
const work = realpathSync.native(mkdtempSync(path.join(os.tmpdir(), 'tw-tasks-')));

/** The folder's 8.3 short name, or the same path when the volume doesn't make short names. */
function shortName(p: string): string {
  const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', '(New-Object -ComObject Scripting.FileSystemObject).GetFolder($env:TW_P).ShortPath'], {
    env: { ...process.env, TW_P: p },
    encoding: 'utf8',
    windowsHide: true,
  });
  return out.trim() || p;
}
let n = 0;

async function g(cwd: string, ...args: string[]): Promise<string> {
  const r = await runFile(git!, ['-C', cwd, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false', '-c', 'core.autocrlf=false', ...args], { timeoutMs: 20_000, env });
  if (r.code !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr.toString()}`);
  return r.stdout.toString().trim();
}

/** A new repository with one commit on `main` (in a folder whose name has a space). */
async function newRepo(name = 'my app'): Promise<string> {
  const repo = path.join(work, `${n++}`, name);
  mkdirSync(repo, { recursive: true });
  await g(repo, 'init', '-q', '-b', 'main');
  writeFileSync(path.join(repo, 'a.txt'), 'one\n');
  await g(repo, 'add', '.');
  await g(repo, 'commit', '-q', '-m', 'first');
  return repo;
}

async function created(root: string, name: string): Promise<TaskRecord> {
  const r = await service.create(root, name);
  if (!r.ok) throw new Error(r.error.code);
  return r.task;
}

/** A file's text with Windows line endings as \n (checkouts follow the user's core.autocrlf). */
const text = (p: string) => readFileSync(p, 'utf8').replace(/\r\n/g, '\n');

const branches = async (repo: string) => (await g(repo, 'for-each-ref', '--format=%(refname:short)', 'refs/heads/')).split('\n').filter(Boolean).sort();

describe.skipIf(!git)('agent tasks with real Git', { timeout: 60_000 }, () => {
  let repo = '';
  beforeEach(async () => {
    repo = await newRepo();
  });
  afterAll(() => {
    rmSync(work, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  });

  it('creates a worktree next to the repository on a new branch from the current commit', async () => {
    const head = await g(repo, 'rev-parse', 'HEAD');
    const t = await created(repo, 'Fix the login form');
    expect(t).toEqual({
      repoRoot: repo,
      subPath: '',
      baseBranch: 'main',
      baseCommit: head,
      branch: 'splitnest/fix-the-login-form',
      worktreePath: path.join(`${repo}.worktrees`, 'fix-the-login-form'),
      taskRoot: path.join(`${repo}.worktrees`, 'fix-the-login-form'),
    });
    expect(text(path.join(t.worktreePath, 'a.txt'))).toBe('one\n');
    expect(await g(t.worktreePath, 'symbolic-ref', '--short', 'HEAD')).toBe('splitnest/fix-the-login-form');
    expect(await g(t.worktreePath, 'rev-parse', 'HEAD')).toBe(head);
  });

  it('leaves the workspace folder as it was: its branch, commit and uncommitted changes', async () => {
    writeFileSync(path.join(repo, 'a.txt'), 'changed\n');
    writeFileSync(path.join(repo, 'new.txt'), 'untracked\n');
    const before = [await g(repo, 'rev-parse', 'HEAD'), await g(repo, 'symbolic-ref', 'HEAD'), await g(repo, 'status', '--porcelain')];
    const t = await created(repo, 'x');
    expect([await g(repo, 'rev-parse', 'HEAD'), await g(repo, 'symbolic-ref', 'HEAD'), await g(repo, 'status', '--porcelain')]).toEqual(before);
    // Uncommitted work is not part of the task.
    expect(text(path.join(t.worktreePath, 'a.txt'))).toBe('one\n');
    expect(existsSync(path.join(t.worktreePath, 'new.txt'))).toBe(false);
  });

  it('preview names what create will make, and creates nothing', async () => {
    const p = await service.preview(repo, 'Add tests');
    expect(p).toMatchObject({ ok: true, preview: { branch: 'splitnest/add-tests', baseBranch: 'main', worktreePath: path.join(`${repo}.worktrees`, 'add-tests') } });
    expect(existsSync(`${repo}.worktrees`)).toBe(false);
    expect(await branches(repo)).toEqual(['main']);
  });

  it('a taken branch, folder or file name gets the next free suffix', async () => {
    await g(repo, 'branch', 'splitnest/fix');
    mkdirSync(path.join(`${repo}.worktrees`, 'fix-2'), { recursive: true });
    writeFileSync(path.join(`${repo}.worktrees`, 'fix-3'), 'a file');
    await g(repo, 'branch', 'splitnest/FIX-4'); // Windows refs are files: a case-insensitive match clashes
    await g(repo, 'branch', 'splitnest/fix-5/sub'); // a folder of refs where the branch would be
    const t = await created(repo, 'fix');
    expect(t.branch).toBe('splitnest/fix-6');
    expect(t.worktreePath).toBe(path.join(`${repo}.worktrees`, 'fix-6'));
    const again = await created(repo, 'fix');
    expect(again.branch).toBe('splitnest/fix-7');
  });

  it('two tasks created at once with the same name get different branches and folders', async () => {
    const [a, b, c] = await Promise.all([service.create(repo, 'same'), service.create(repo, 'same'), service.create(repo, 'same')]);
    const names = [a, b, c].map((r) => (r.ok ? r.task.branch : r.error.code)).sort();
    expect(names).toEqual(['splitnest/same', 'splitnest/same-2', 'splitnest/same-3']);
    expect(await branches(repo)).toEqual(['main', 'splitnest/same', 'splitnest/same-2', 'splitnest/same-3']);
  });

  it('a workspace that is a folder inside the repository gets the same folder in the task', async () => {
    mkdirSync(path.join(repo, 'packages', 'web'), { recursive: true });
    writeFileSync(path.join(repo, 'packages', 'web', 'index.js'), '//\n');
    await g(repo, 'add', '.');
    await g(repo, 'commit', '-q', '-m', 'web');
    const t = await created(path.join(repo, 'packages', 'web'), 'web task');
    expect(t.subPath).toBe(path.join('packages', 'web'));
    expect(t.taskRoot).toBe(path.join(t.worktreePath, 'packages', 'web'));
    expect(existsSync(path.join(t.taskRoot, 'index.js'))).toBe(true);
  });

  it.skipIf(process.platform !== 'win32')('a workspace folder opened by its short 8.3 name (or another spelling) works like the long one', async (ctx) => {
    const long = await newRepo('my long app folder');
    mkdirSync(path.join(long, 'packages', 'web site'), { recursive: true });
    writeFileSync(path.join(long, 'packages', 'web site', 'x.txt'), 'x\n');
    await g(long, 'add', '.');
    await g(long, 'commit', '-q', '-m', 'web');
    const short = shortName(long);
    if (short.toLowerCase() === long.toLowerCase()) ctx.skip();
    const t = await created(short, 'short');
    expect(t).toMatchObject({ repoRoot: long, subPath: '', worktreePath: path.join(`${long}.worktrees`, 'short') });
    const inner = await created(shortName(path.join(long, 'packages', 'web site')), 'inner');
    expect(inner).toMatchObject({ repoRoot: long, subPath: path.join('packages', 'web site'), taskRoot: path.join(`${long}.worktrees`, 'inner', 'packages', 'web site') });
    expect(existsSync(path.join(inner.taskRoot, 'x.txt'))).toBe(true);
    // Other letter case.
    expect(await service.create(long.toUpperCase(), 'upper')).toMatchObject({ ok: true, task: { repoRoot: long } });
  });

  it('a task created inside a task branches from the task branch, into the same task folder', async () => {
    const t = await created(repo, 'outer');
    const inner = await created(t.worktreePath, 'inner');
    expect(inner).toMatchObject({ repoRoot: repo, baseBranch: 'splitnest/outer', branch: 'splitnest/inner', worktreePath: path.join(`${repo}.worktrees`, 'inner') });
  });

  it('refuses what has no base to start from or merge back into', async () => {
    const plain = path.join(work, `${n++}`);
    mkdirSync(plain, { recursive: true });
    expect(await service.create(plain, 'x')).toMatchObject({ ok: false, error: { code: 'NOT_A_REPOSITORY' } });

    const empty = path.join(work, `${n++}`);
    mkdirSync(empty, { recursive: true });
    await g(empty, 'init', '-q', '-b', 'main');
    expect(await service.create(empty, 'x')).toMatchObject({ ok: false, error: { code: 'NO_COMMITS' } });

    await g(repo, 'checkout', '-q', '--detach');
    expect(await service.create(repo, 'x')).toMatchObject({ ok: false, error: { code: 'DETACHED_HEAD' } });

    expect(await service.create(repo, '!!!')).toMatchObject({ ok: false, error: { code: 'INVALID_NAME' } });
    expect(await service.create(repo, 'a'.repeat(81))).toMatchObject({ ok: false, error: { code: 'INVALID_NAME' } });
    expect(await service.create('\\\\wsl.localhost\\Ubuntu\\home\\me\\app', 'x')).toMatchObject({ ok: false, error: { code: 'UNSUPPORTED_LOCATION' } });
    expect(existsSync(`${repo}.worktrees`)).toBe(false);
  });

  it('a branch named `splitnest` blocks task branches (Git would need it as a folder)', async () => {
    await g(repo, 'branch', 'splitnest');
    expect(await service.create(repo, 'x')).toMatchObject({ ok: false, error: { code: 'NAME_TAKEN' } });
  });

  it('progress: commits on the task branch and on the base branch since the task started', async () => {
    const t = await created(repo, 'p');
    expect(await service.progress(t)).toEqual({ ok: true, progress: { folderExists: true, registered: true, branchExists: true, ahead: 0, behind: 0 } });
    writeFileSync(path.join(t.worktreePath, 'b.txt'), 'b\n');
    await g(t.worktreePath, 'add', '.');
    await g(t.worktreePath, 'commit', '-q', '-m', 'task work');
    writeFileSync(path.join(repo, 'c.txt'), 'c\n');
    await g(repo, 'add', '.');
    await g(repo, 'commit', '-q', '-m', 'base work 1');
    await g(repo, 'commit', '-q', '--allow-empty', '-m', 'base work 2');
    expect(await service.progress(t)).toMatchObject({ ok: true, progress: { ahead: 1, behind: 2 } });
  });

  it('remove refuses uncommitted or untracked files and keeps them', async () => {
    const t = await created(repo, 'dirty');
    writeFileSync(path.join(t.worktreePath, 'notes.txt'), 'keep me\n');
    expect(await service.remove(t, { deleteBranch: true })).toMatchObject({ ok: false, error: { code: 'TASK_DIRTY' } });
    expect(readFileSync(path.join(t.worktreePath, 'notes.txt'), 'utf8')).toBe('keep me\n');
    writeFileSync(path.join(t.worktreePath, 'notes.txt'), '');
    rmSync(path.join(t.worktreePath, 'notes.txt'));
    writeFileSync(path.join(t.worktreePath, 'a.txt'), 'edited\n');
    expect(await service.remove(t, { deleteBranch: true })).toMatchObject({ ok: false, error: { code: 'TASK_DIRTY' } });
    expect(readFileSync(path.join(t.worktreePath, 'a.txt'), 'utf8')).toBe('edited\n');
  });

  it('remove keeps a branch with commits the base doesn’t have, and deletes a merged one', async () => {
    const t = await created(repo, 'work');
    writeFileSync(path.join(t.worktreePath, 'b.txt'), 'b\n');
    await g(t.worktreePath, 'add', '.');
    await g(t.worktreePath, 'commit', '-q', '-m', 'task work');
    expect(await service.remove(t, { deleteBranch: true })).toEqual({ ok: true, branch: 'unmerged' });
    expect(existsSync(t.worktreePath)).toBe(false);
    expect(await branches(repo)).toContain('splitnest/work');

    await g(repo, 'merge', '-q', '--no-edit', 'splitnest/work');
    // The folder is gone already: removing again only deletes the (now merged) branch.
    expect(await service.remove(t, { deleteBranch: true })).toEqual({ ok: true, branch: 'deleted' });
    expect(await branches(repo)).toEqual(['main']);
    expect(await service.remove(t, { deleteBranch: true })).toEqual({ ok: true, branch: 'missing' });
  });

  it('remove without deleting the branch keeps it, and a branch with no new commits is deleted', async () => {
    const kept = await created(repo, 'kept');
    expect(await service.remove(kept, { deleteBranch: false })).toEqual({ ok: true, branch: 'kept' });
    expect(await branches(repo)).toContain('splitnest/kept');
    const fresh = await created(repo, 'fresh');
    expect(await service.remove(fresh, { deleteBranch: true })).toEqual({ ok: true, branch: 'deleted' });
    expect(await branches(repo)).not.toContain('splitnest/fresh');
  });

  it('a branch checked out somewhere else is never deleted', async () => {
    const t = await created(repo, 'elsewhere');
    expect(await service.remove(t, { deleteBranch: false })).toMatchObject({ ok: true });
    const other = path.join(work, `${n++}`, 'other');
    await g(repo, 'worktree', 'add', '-q', other, 'splitnest/elsewhere');
    expect(await service.remove(t, { deleteBranch: true })).toEqual({ ok: true, branch: 'unmerged' });
    expect(await branches(repo)).toContain('splitnest/elsewhere');
  });

  it('a task folder whose files are deleted already is removed from Git', async () => {
    const t = await created(repo, 'gone');
    rmSync(t.worktreePath, { recursive: true, force: true });
    expect(await service.progress(t)).toMatchObject({ ok: true, progress: { folderExists: false, registered: true } });
    expect(await service.remove(t, { deleteBranch: true })).toEqual({ ok: true, branch: 'deleted' });
    expect(await g(repo, 'worktree', 'list', '--porcelain')).not.toContain('gone');
  });

  it('a locked worktree is refused', async () => {
    const t = await created(repo, 'locked');
    await g(repo, 'worktree', 'lock', t.worktreePath);
    expect(await service.remove(t, { deleteBranch: true })).toMatchObject({ ok: false, error: { code: 'TASK_LOCKED' } });
    expect(existsSync(t.worktreePath)).toBe(true);
  });

  it('never touches folders that aren’t this repository’s task worktrees', async () => {
    const t = await created(repo, 'real');
    // The repository itself, a folder outside the task folder, a look-alike next to it.
    for (const worktreePath of [repo, path.join(work, 'elsewhere'), `${repo}.worktrees-x\\real`, path.join(`${repo}.worktrees`, '..', 'my app')]) {
      expect(await service.remove({ ...t, worktreePath }, { deleteBranch: true })).toMatchObject({ ok: false, error: { code: 'NOT_A_TASK' } });
    }
    expect(await service.remove({ ...t, branch: 'main' }, { deleteBranch: true })).toMatchObject({ ok: false, error: { code: 'NOT_A_TASK' } });
    // A folder in the task folder that Git doesn't list as a worktree.
    const stray = path.join(`${repo}.worktrees`, 'stray');
    mkdirSync(stray);
    writeFileSync(path.join(stray, 'mine.txt'), 'x');
    expect(await service.remove({ ...t, worktreePath: stray, branch: 'splitnest/stray' }, { deleteBranch: true })).toMatchObject({ ok: false, error: { code: 'LEFTOVER_FILES' } });
    expect(existsSync(path.join(stray, 'mine.txt'))).toBe(true);
    // The task's folder with another branch checked out in it now.
    await g(t.worktreePath, 'checkout', '-q', '-b', 'other');
    expect(await service.remove(t, { deleteBranch: true })).toMatchObject({ ok: false, error: { code: 'NOT_A_TASK' } });
    expect(existsSync(t.worktreePath)).toBe(true);
    // A repository root that isn't the main worktree.
    expect(await service.remove({ ...t, repoRoot: t.worktreePath }, { deleteBranch: true })).toMatchObject({ ok: false, error: { code: 'NOT_A_TASK' } });
  });

  it.skipIf(process.platform !== 'win32')('a program using the task folder: nothing is lost, the folder stays, and a retry finishes once it ends', async () => {
    const t = await created(repo, 'busy');
    // A process whose current folder is inside the task folder: Windows won't delete that folder.
    const sub = path.join(t.worktreePath, 'sub');
    mkdirSync(sub);
    const child = spawn('ping.exe', ['-n', '60', '127.0.0.1'], { cwd: sub, windowsHide: true, stdio: 'ignore' });
    await new Promise((r) => setTimeout(r, 500));
    try {
      expect(await service.remove(t, { deleteBranch: true })).toMatchObject({ ok: false, error: { code: 'FOLDER_IN_USE' } });
      expect(existsSync(sub)).toBe(true);
      expect(await branches(repo)).toContain('splitnest/busy');
      // Still in use: the retry says so again and deletes nothing.
      expect(await service.remove(t, { deleteBranch: true })).toMatchObject({ ok: false, error: { code: 'FOLDER_IN_USE' } });
    } finally {
      child.kill();
      await new Promise((r) => child.once('exit', r));
    }
    expect(await service.remove(t, { deleteBranch: true })).toEqual({ ok: true, branch: 'deleted' });
    expect(existsSync(t.worktreePath)).toBe(false);
  });

  it('a leftover folder with a file in it is never deleted', async () => {
    const t = await created(repo, 'leftover');
    expect(await service.remove(t, { deleteBranch: false })).toMatchObject({ ok: true });
    mkdirSync(path.join(t.worktreePath, 'a', 'b'), { recursive: true });
    writeFileSync(path.join(t.worktreePath, 'a', 'b', 'kept.log'), 'x');
    expect(await service.remove(t, { deleteBranch: true })).toMatchObject({ ok: false, error: { code: 'LEFTOVER_FILES' } });
    expect(existsSync(path.join(t.worktreePath, 'a', 'b', 'kept.log'))).toBe(true);
    expect(await branches(repo)).toContain('splitnest/leftover');
  });
});
