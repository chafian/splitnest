// Agent tasks against real Git in temporary repositories (skipped when git.exe is not on PATH):
// creating worktrees and branches, names that are taken, two tasks at once, removing without ever
// losing work, and refusing folders that aren't SplitNest tasks.
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { runFile } from '../../src/main/exec';
import { createWindowsGitRunner } from '../../src/main/git-runner';
import { gitEnv } from '../../src/main/git-status';
import { isDirectory } from '../../src/main/launch-resolver';
import { fileExists, findOnPath } from '../../src/main/shells';
import { MAX_CONFLICT_FILES, stillConflicted, TaskService } from '../../src/main/task-service';
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
  // The same line endings on every machine (task folders follow the repository's configuration).
  await g(repo, 'config', 'core.autocrlf', 'false');
  // Commit all and merges commit with the repository's identity (CI runners have none set globally).
  await g(repo, 'config', 'user.name', 'Test');
  await g(repo, 'config', 'user.email', 'test@example.invalid');
  await g(repo, 'config', 'commit.gpgsign', 'false');
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

    expect(await service.create(repo, '   ')).toMatchObject({ ok: false, error: { code: 'INVALID_NAME' } });
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

  describe('review: what a task changed', () => {
    /** A task with every kind of change: committed and not, added, deleted, renamed, binary, untracked. */
    async function busyTask() {
      writeFileSync(path.join(repo, 'old name.txt'), 'rename me\nline 2\nline 3\nline 4\n');
      writeFileSync(path.join(repo, 'gone.txt'), 'delete me\n');
      writeFileSync(path.join(repo, 'base-only.txt'), 'one\n');
      await g(repo, 'add', '.');
      await g(repo, 'commit', '-q', '-m', 'files');
      const t = await created(repo, 'review');
      const w = (f: string, text: string | Buffer) => writeFileSync(path.join(t.worktreePath, ...f.split('/')), text);
      w('a.txt', 'one\ntwo\n'); // committed edit: +1
      mkdirSync(path.join(t.worktreePath, 'src'));
      w('src/new.js', 'export const x = 1;\n');
      w('logo.bin', Buffer.from([0, 1, 2, 3, 0, 255]));
      await g(t.worktreePath, 'mv', 'old name.txt', 'new name.txt');
      await g(t.worktreePath, 'rm', '-q', 'gone.txt');
      await g(t.worktreePath, 'add', '.');
      await g(t.worktreePath, 'commit', '-q', '-m', 'task work');
      w('src/new.js', 'export const x = 2;\nexport const y = 3;\n'); // uncommitted edit on top
      w('notes.md', '# notes\nfirst\n'); // untracked
      // The base branch moves on: its own change is not part of the task.
      writeFileSync(path.join(repo, 'base-only.txt'), 'one\ntwo\n');
      await g(repo, 'commit', '-q', '-am', 'base work');
      return t;
    }

    it('lists every change against where the task left its base branch, committed or not', async () => {
      const t = await busyTask();
      const r = await service.changes(t);
      if (!r.ok) throw new Error(r.error.code);
      const byPath = Object.fromEntries(r.changes.files.map((f) => [f.path, f]));
      expect(Object.keys(byPath)).toEqual(['a.txt', 'gone.txt', 'logo.bin', 'new name.txt', 'notes.md', 'src/new.js']);
      expect(byPath['a.txt']).toMatchObject({ kind: 'modified', added: 1, removed: 0, uncommitted: false });
      expect(byPath['gone.txt']).toMatchObject({ kind: 'deleted', added: 0, removed: 1, binary: false });
      expect(byPath['logo.bin']).toMatchObject({ kind: 'added', binary: true, added: null });
      expect(byPath['new name.txt']).toMatchObject({ kind: 'renamed', oldPath: 'old name.txt' });
      expect(byPath['notes.md']).toMatchObject({ kind: 'untracked', uncommitted: true });
      expect(byPath['src/new.js']).toMatchObject({ kind: 'added', added: 2, removed: 0, uncommitted: true });
      expect(r.changes).toMatchObject({ baseBranch: 'main', mergeBase: t.baseCommit, truncated: false });
    });

    it('diffs: a hunk for a changed file, all lines for a new untracked one, nothing for a binary', async () => {
      const t = await busyTask();
      const a = await service.diff(t, 'a.txt');
      expect(a.ok && a.diff.text).toMatch(/@@ -1 \+1,2 @@[\s\S]*\n \s*one\r?\n\+two/);
      const renamed = await service.diff(t, 'new name.txt');
      expect(renamed.ok && renamed.diff.text).toMatch(/rename from old name\.txt[\s\S]*rename to new name\.txt/);
      const notes = await service.diff(t, 'notes.md');
      expect(notes).toEqual({ ok: true, diff: { text: '@@ -0,0 +1,2 @@\n+# notes\n+first\n', binary: false, truncated: false } });
      expect(await service.diff(t, 'logo.bin')).toEqual({ ok: true, diff: { text: '', binary: true, truncated: false } });
    });

    it('only files the task changed: nothing else in the folder, nothing outside it', async () => {
      const t = await busyTask();
      for (const f of ['README.md', 'base-only.txt', '../my app/a.txt', '..\\x', 'C:\\Windows\\win.ini', '/etc/passwd', 'src/../a.txt', ':(glob)*', 42, null]) {
        expect(await service.diff(t, f)).toMatchObject({ ok: false, error: { code: 'NOT_CHANGED' } });
      }
    });

    it('a pathspec-like file name is taken literally', async () => {
      const t = await created(repo, 'literal');
      // As a glob, `[ab].txt` would match a.txt; taken literally it is only this file.
      writeFileSync(path.join(t.worktreePath, '[ab].txt'), 'star\n');
      await g(t.worktreePath, 'add', '.');
      await g(t.worktreePath, 'commit', '-q', '-m', 'star');
      const d = await service.diff(t, '[ab].txt');
      expect(d.ok && d.diff.text).toContain('+star');
      expect(d.ok && d.diff.text).not.toContain('a.txt');
    });

    it('a large diff is cut off on a line boundary and says so', async () => {
      const t = await created(repo, 'big');
      writeFileSync(path.join(t.worktreePath, 'big.txt'), `${'x'.repeat(99)}\n`.repeat(15_000)); // 1.5 MB
      await g(t.worktreePath, 'add', '.');
      await g(t.worktreePath, 'commit', '-q', '-m', 'big');
      const d = await service.diff(t, 'big.txt');
      if (!d.ok) throw new Error(d.error.code);
      expect(d.diff.truncated).toBe(true);
      expect(d.diff.text.length).toBeLessThanOrEqual(1024 * 1024);
      expect(d.diff.text.endsWith('\n')).toBe(true);
    });

    it('nothing is compared when the repository’s own configuration names a filter program', async () => {
      const t = await created(repo, 'filtered');
      await g(repo, 'config', 'filter.sneaky.clean', 'sneaky-program');
      expect(await service.changes(t)).toMatchObject({ ok: false, error: { code: 'CHANGES_NOT_CHECKED' } });
      expect(await service.diff(t, 'a.txt')).toMatchObject({ ok: false, error: { code: 'CHANGES_NOT_CHECKED' } });
      await g(repo, 'config', '--unset', 'filter.sneaky.clean');
    });

    it('reviewing writes nothing into the repository', async () => {
      const t = await busyTask();
      const gitDir = path.join(repo, '.git');
      const stamp = () => JSON.stringify([readFileSync(path.join(gitDir, 'index')).length, existsSync(path.join(gitDir, 'index.lock')), readFileSync(path.join(gitDir, 'worktrees', 'review', 'index')).toString('base64')]);
      const before = stamp();
      await service.changes(t);
      await service.diff(t, 'a.txt');
      expect(stamp()).toBe(before);
    });
  });

  describe('finishing: commit, merge, bring in the base, discard', () => {
    const w = (dir: string, f: string, text: string) => writeFileSync(path.join(dir, ...f.split('/')), text);
    const head = (dir: string) => g(dir, 'rev-parse', 'HEAD');
    const state = async (dir: string) => [await head(dir), await g(dir, 'status', '--porcelain'), existsSync(path.join(dir, '.git', 'MERGE_HEAD'))];
    async function check(t: TaskRecord) {
      const r = await service.finishCheck(t);
      if (!r.ok) throw new Error(r.error.code);
      return r.check;
    }

    it('a fresh task: nothing to merge, merges into the workspace folder, lists what Git ignores there', async () => {
      w(repo, '.gitignore', 'node_modules/\n.env\n');
      await g(repo, 'add', '.');
      await g(repo, 'commit', '-q', '-m', 'ignore');
      const t = await created(repo, 'fresh');
      mkdirSync(path.join(t.worktreePath, 'node_modules', 'x'), { recursive: true });
      w(t.worktreePath, 'node_modules/x/i.js', '//');
      w(t.worktreePath, '.env', 'SECRET=1');
      const c = await check(t);
      expect(c).toMatchObject({ commitsToMerge: 0, preview: 'nothing', mergeFolder: repo, mergeFolderDirty: false, inProgress: null, uncommittedCount: 0, unresolved: [] });
      expect([...c.ignored].sort()).toEqual(['.env', 'node_modules/']);
      expect(c.head).toBe(t.baseCommit);
    });

    it('Commit all stages new and changed files and commits them with the message', async () => {
      const t = await created(repo, 'commit');
      expect(await service.commitAll(t, 'x')).toMatchObject({ ok: false, error: { code: 'NOTHING_TO_COMMIT' } });
      for (const bad of ['', '   ', 'a\u0000b', 'x'.repeat(1001), 42]) expect(await service.commitAll(t, bad)).toMatchObject({ ok: false, error: { code: 'INVALID_MESSAGE' } });
      w(t.worktreePath, 'a.txt', 'one\ntwo\n');
      w(t.worktreePath, 'new.txt', 'new\n');
      expect((await check(t)).uncommittedCount).toBe(2);
      const r = await service.commitAll(t, 'Task work\n\nwith a body');
      expect(r.ok).toBe(true);
      expect(await g(t.worktreePath, 'log', '-1', '--format=%B')).toBe('Task work\n\nwith a body');
      expect(await g(t.worktreePath, 'status', '--porcelain')).toBe('');
      expect(await check(t)).toMatchObject({ uncommittedCount: 0, commitsToMerge: 1, preview: 'clean' });
    });

    it('merge: brings the task into the base branch where it is checked out', async () => {
      const t = await created(repo, 'merge');
      w(t.worktreePath, 'feature.txt', 'feature\n');
      await service.commitAll(t, 'feature');
      // The base branch moves on without touching the same lines: still a clean merge.
      w(repo, 'other.txt', 'other\n');
      await g(repo, 'add', '.');
      await g(repo, 'commit', '-q', '-m', 'other');
      // Untracked files in the workspace folder don't stop it.
      w(repo, 'scratch.txt', 'mine\n');
      const r = await service.merge(t);
      expect(r).toMatchObject({ ok: true, result: { outcome: 'merged' } });
      expect(readFileSync(path.join(repo, 'feature.txt'), 'utf8')).toBe('feature\n');
      expect(await g(repo, 'merge-base', '--is-ancestor', 'splitnest/merge', 'main').then(() => 'yes')).toBe('yes');
      expect(readFileSync(path.join(repo, 'scratch.txt'), 'utf8')).toBe('mine\n');
      expect(await check(t)).toMatchObject({ commitsToMerge: 0, preview: 'nothing' });
      // Then cleanup deletes the folder and the merged branch.
      expect(await service.remove(t, { deleteBranch: true })).toEqual({ ok: true, branch: 'deleted' });
    });

    it('merge is refused while the task has uncommitted work, the base folder has changes, or the base isn’t checked out', async () => {
      const t = await created(repo, 'refused');
      w(t.worktreePath, 'f.txt', 'f\n');
      expect(await service.merge(t)).toMatchObject({ ok: false, error: { code: 'TASK_UNCOMMITTED' } });
      await service.commitAll(t, 'f');
      w(repo, 'a.txt', 'local edit\n');
      const before = await state(repo);
      expect(await service.merge(t)).toMatchObject({ ok: false, error: { code: 'BASE_DIRTY' } });
      expect(await state(repo)).toEqual(before);
      await g(repo, 'checkout', '-q', '--', 'a.txt');
      await g(repo, 'switch', '-q', '-c', 'elsewhere');
      expect(await check(t)).toMatchObject({ mergeFolder: null });
      expect(await service.merge(t)).toMatchObject({ ok: false, error: { code: 'BASE_NOT_CHECKED_OUT' } });
    });

    it('conflicts: the preview names them, and a merge anyway is undone, leaving the base exactly as before', async () => {
      const t = await created(repo, 'conflict');
      w(t.worktreePath, 'a.txt', 'task version\n');
      await service.commitAll(t, 'task side');
      w(repo, 'a.txt', 'base version\n');
      await g(repo, 'commit', '-q', '-am', 'base side');
      expect(await check(t)).toMatchObject({ preview: 'conflicts', conflicts: ['a.txt'], behind: 1 });
      const before = await state(repo);
      expect(await service.merge(t)).toEqual({ ok: true, result: { outcome: 'conflicts', conflicts: ['a.txt'] } });
      expect(await state(repo)).toEqual(before);
      expect(readFileSync(path.join(repo, 'a.txt'), 'utf8')).toBe('base version\n');
    });

    it('bring in the base: conflicts stay in the task to resolve; Commit all refuses markers, then concludes it; then the merge is clean', async () => {
      const t = await created(repo, 'update');
      w(t.worktreePath, 'a.txt', 'task version\n');
      await service.commitAll(t, 'task side');
      w(repo, 'a.txt', 'base version\n');
      await g(repo, 'commit', '-q', '-am', 'base side');
      const baseBefore = await state(repo);
      expect(await service.updateFromBase(t)).toEqual({ ok: true, result: { outcome: 'conflicts', conflicts: ['a.txt'] } });
      expect(await state(repo)).toEqual(baseBefore); // the workspace the task came from is untouched
      expect(await check(t)).toMatchObject({ inProgress: 'task', unresolved: ['a.txt'] });
      expect(await service.merge(t)).toMatchObject({ ok: false });
      expect(await service.commitAll(t, 'resolve')).toMatchObject({ ok: false, error: { code: 'CONFLICTS_UNRESOLVED' } });
      w(t.worktreePath, 'a.txt', 'both versions\n');
      expect((await service.commitAll(t, 'Bring in main')).ok).toBe(true);
      expect(await check(t)).toMatchObject({ inProgress: null, unresolved: [], preview: 'clean', behind: 0 });
      expect(await service.merge(t)).toMatchObject({ ok: true, result: { outcome: 'merged' } });
      expect(readFileSync(path.join(repo, 'a.txt'), 'utf8')).toBe('both versions\n');
    });

    it('bring in the base when nothing changed there, and when it merges cleanly', async () => {
      const t = await created(repo, 'up');
      expect(await service.updateFromBase(t)).toEqual({ ok: true, result: { outcome: 'up-to-date' } });
      w(repo, 'later.txt', 'later\n');
      await g(repo, 'add', '.');
      await g(repo, 'commit', '-q', '-m', 'later');
      expect(await service.updateFromBase(t)).toEqual({ ok: true, result: { outcome: 'updated' } });
      expect(existsSync(path.join(t.worktreePath, 'later.txt'))).toBe(true);
    });

    it('a merge already in progress in the workspace folder blocks finishing and is left alone', async () => {
      const t = await created(repo, 'busy-base');
      w(t.worktreePath, 'f.txt', 'f\n');
      await service.commitAll(t, 'f');
      await g(repo, 'switch', '-q', '-c', 'side');
      w(repo, 'a.txt', 'side\n');
      await g(repo, 'commit', '-q', '-am', 'side');
      await g(repo, 'switch', '-q', 'main');
      w(repo, 'a.txt', 'main\n');
      await g(repo, 'commit', '-q', '-am', 'main');
      await g(repo, 'merge', 'side').catch(() => undefined); // conflicts: MERGE_HEAD stays
      expect(await check(t)).toMatchObject({ inProgress: 'base' });
      expect(await service.merge(t)).toMatchObject({ ok: false, error: { code: 'OPERATION_IN_PROGRESS' } });
      expect(existsSync(path.join(repo, '.git', 'MERGE_HEAD'))).toBe(true);
    });

    it.skipIf(process.platform !== 'win32')('a hook that refuses the merge commit: nothing changes in the base folder', async () => {
      const t = await created(repo, 'hooked');
      w(t.worktreePath, 'f.txt', 'f\n');
      await service.commitAll(t, 'f');
      w(repo, 'other.txt', 'other\n'); // diverge, so a merge commit (and its hook) is needed
      await g(repo, 'add', '.');
      await g(repo, 'commit', '-q', '-m', 'other');
      w(repo, '.git/hooks/pre-merge-commit', '#!/bin/sh\nexit 1\n');
      const before = await state(repo);
      expect(await service.merge(t)).toMatchObject({ ok: false, error: { code: 'MERGE_FAILED' } });
      expect(await state(repo)).toEqual(before);
    });

    it('discard deletes the folder with uncommitted work and the unmerged branch, but only for what was shown', async () => {
      const t = await created(repo, 'throwaway');
      w(t.worktreePath, 'f.txt', 'f\n');
      await service.commitAll(t, 'f');
      w(t.worktreePath, 'draft.txt', 'uncommitted\n');
      let shown = (await check(t)).discardKey;
      // New commits after the list was shown: refused.
      w(t.worktreePath, 'g.txt', 'g\n');
      await g(t.worktreePath, 'add', 'g.txt');
      await g(t.worktreePath, 'commit', '-q', '-m', 'g');
      expect(await service.discard(t, shown)).toMatchObject({ ok: false, error: { code: 'STALE' } });
      expect(await service.discardBlocked(t, shown)).toMatchObject({ code: 'STALE' });
      // A new file written after the list was shown (an agent still running): refused too.
      shown = (await check(t)).discardKey;
      w(t.worktreePath, 'late.txt', 'written while the confirmation was open\n');
      expect(await service.discard(t, shown)).toMatchObject({ ok: false, error: { code: 'STALE' } });
      // So is a change to an already-listed file, and a new ignored file.
      shown = (await check(t)).discardKey;
      w(t.worktreePath, 'draft.txt', 'changed again\n');
      await g(t.worktreePath, 'add', 'draft.txt');
      expect(await service.discard(t, shown)).toMatchObject({ ok: false, error: { code: 'STALE' } });
      expect(existsSync(path.join(t.worktreePath, 'draft.txt'))).toBe(true);
      expect(await service.discard(t, 'not-a-key')).toMatchObject({ ok: false, error: { code: 'STALE' } });
      const now = (await check(t)).discardKey;
      expect(await service.discardBlocked(t, now)).toBeNull();
      expect(await service.discard(t, now)).toEqual({ ok: true, branch: 'deleted' });
      expect(existsSync(t.worktreePath)).toBe(false);
      expect(await branches(repo)).toEqual(['main']);
      // Never anything that isn't a task.
      expect(await service.discard({ ...t, worktreePath: repo }, 'a'.repeat(64))).toMatchObject({ ok: false, error: { code: 'NOT_A_TASK' } });
    });

    it('a tag with the base branch’s name doesn’t confuse it (Git’s short name would be heads/main)', async () => {
      await g(repo, 'tag', 'main');
      const t = await created(repo, 'tagged');
      expect(t.baseBranch).toBe('main');
      w(t.worktreePath, 'f.txt', 'f\n');
      await service.commitAll(t, 'f');
      expect(await check(t)).toMatchObject({ commitsToMerge: 1, mergeFolder: repo });
      expect(await service.merge(t)).toMatchObject({ ok: true, result: { outcome: 'merged' } });
    });

    it('Commit all refuses conflict markers in files already staged with git add (as agents often do)', async () => {
      const t = await created(repo, 'staged-markers');
      w(t.worktreePath, 'a.txt', 'task\n');
      await service.commitAll(t, 'task side');
      w(repo, 'a.txt', 'main\n');
      await g(repo, 'commit', '-q', '-am', 'main side');
      expect(await service.updateFromBase(t)).toMatchObject({ ok: true, result: { outcome: 'conflicts' } });
      // "Resolved" by staging the file with its markers still in it.
      await g(t.worktreePath, 'add', 'a.txt');
      expect(await check(t)).toMatchObject({ unresolved: [] });
      expect(await service.commitAll(t, 'resolve')).toMatchObject({ ok: false, error: { code: 'CONFLICTS_UNRESOLVED' } });
      w(t.worktreePath, 'a.txt', 'both\n');
      expect((await service.commitAll(t, 'resolve')).ok).toBe(true);
    });

    it('the base branch deleted or renamed: not “nothing to merge”; Clean up isn’t offered and the branch is kept', async () => {
      const t = await created(repo, 'orphan');
      w(t.worktreePath, 'f.txt', 'f\n');
      await service.commitAll(t, 'work');
      await g(repo, 'switch', '-q', '-c', 'trunk');
      await g(repo, 'branch', '-q', '-D', 'main');
      const c = await check(t);
      expect(c).toMatchObject({ commitsToMerge: null, behind: null, preview: 'unknown', branchCommits: 1 });
      // Removing the folder keeps the unmerged branch, and says so.
      expect(await service.remove(t, { deleteBranch: true })).toEqual({ ok: true, branch: 'unmerged' });
      expect(await branches(repo)).toContain('splitnest/orphan');
    });

    it('uncommitted work is found by Git’s own status, also beyond what the list shows; removal is refused before anything is ended', async () => {
      const t = await created(repo, 'dirty-check');
      w(t.worktreePath, 'x.txt', 'x\n');
      expect(await check(t)).toMatchObject({ hasUncommitted: true });
      expect(await service.removalBlocked(t)).toMatchObject({ code: 'TASK_DIRTY' });
      expect(await service.merge(t)).toMatchObject({ ok: false, error: { code: 'TASK_UNCOMMITTED' } });
      rmSync(path.join(t.worktreePath, 'x.txt'));
      expect(await service.removalBlocked(t)).toBeNull();
    });

    it('a name without Latin letters or digits still gets a branch; a folder deleted outside SplitNest says so and can be removed', async () => {
      const t = await created(repo, '日本語のタスク');
      expect(t.branch).toBe('splitnest/task');
      rmSync(t.worktreePath, { recursive: true, force: true });
      expect(await service.finishCheck(t)).toMatchObject({ ok: false, error: { code: 'TASK_FOLDER_MISSING' } });
      expect(await service.removalBlocked(t)).toBeNull();
      expect(await service.remove(t, { deleteBranch: true })).toEqual({ ok: true, branch: 'deleted' });
    });
  });

  describe('conflict markers: which unmerged files count as still conflicted', () => {
    it('markers, resolved, deleted, folders, links, oversized and too many files', async () => {
      const dir = path.join(work, `${n++}`, 'conflicts');
      mkdirSync(path.join(dir, 'sub'), { recursive: true });
      writeFileSync(path.join(dir, 'marked.txt'), 'a\n<<<<<<< HEAD\nx\n=======\ny\n>>>>>>> main\n');
      writeFileSync(path.join(dir, 'crlf.txt'), 'a\r\n>>>>>>>\r\n');
      writeFileSync(path.join(dir, 'resolved.md'), 'Title\n=======\n\ntext\n');
      writeFileSync(path.join(dir, 'big.txt'), Buffer.alloc(10 * 1024 * 1024 + 1, 97));
      const outside = path.join(work, `${n++}`, 'outside');
      mkdirSync(outside, { recursive: true });
      symlinkSync(outside, path.join(dir, 'link'), 'junction');
      const files = ['marked.txt', 'crlf.txt', 'resolved.md', 'gone.txt', 'sub', 'link', 'big.txt'];
      expect((await stillConflicted(dir, files)).sort()).toEqual(['big.txt', 'crlf.txt', 'link', 'marked.txt', 'sub']);
      const many = Array.from({ length: MAX_CONFLICT_FILES + 1 }, (_, i) => `f${i}.txt`);
      expect(await stillConflicted(dir, many)).toEqual(many);
      expect(await stillConflicted(path.join(dir, 'missing-folder'), ['resolved.md'])).toEqual(['resolved.md']);
    });
  });
});
