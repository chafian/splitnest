// Agent tasks on a repository stored inside WSL, with the distribution's own Git (skipped without
// an installed distribution). Everything happens in a temporary folder under /tmp in Linux.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runFile } from '../../src/main/exec';
import { createWindowsGitRunner, createWslGitRunner } from '../../src/main/git-runner';
import { isDirectory } from '../../src/main/launch-resolver';
import { fileExists, findOnPath } from '../../src/main/shells';
import { TaskService } from '../../src/main/task-service';
import { discoverWsl } from '../../src/main/wsl';
import type { TaskRecord } from '../../src/shared/tasks';

const WSL_EXE = `${process.env.SystemRoot ?? 'C:\\Windows'}\\System32\\wsl.exe`;
const IS_WINDOWS = process.platform === 'win32';
const discovery = IS_WINDOWS ? await discoverWsl(runFile, WSL_EXE, process.env) : null;
const distro = discovery?.distros.find((d) => d.isDefault)?.name ?? discovery?.distros[0]?.name;
const lx = (...args: string[]) => execFileSync(WSL_EXE, ['--distribution', distro!, '--exec', ...args], { encoding: 'utf8' }).replace(/\0/g, '').trim();
const hasGit = (() => {
  try {
    return !!distro && /git version/.test(lx('git', '--version'));
  } catch {
    return false;
  }
})();
if (!hasGit) console.warn('[wsl] SKIPPED agent tasks in WSL: no distribution with Git');

describe.skipIf(!hasGit)(`agent tasks in WSL (${distro ?? 'none'})`, () => {
  let tmp = '';
  let repo = ''; // Windows form: \\wsl.localhost\<distro>\tmp\…\app
  const unc = (linux: string) => `\\\\wsl.localhost\\${distro}${linux.replace(/\//g, '\\')}`;
  const g = (linuxCwd: string, ...args: string[]) => lx('git', '-C', linuxCwd, ...args);
  const service = new TaskService({
    git: createWindowsGitRunner({ run: runFile, findGit: () => findOnPath('git.exe', process.env, fileExists), env: process.env, home: os.homedir() }),
    wslGit: (d, host) => createWslGitRunner({ run: runFile, wslExe: WSL_EXE, distro: d, host }),
    isDirectory,
  });
  const created = async (name: string): Promise<TaskRecord> => {
    const r = await service.create(repo, name);
    if (!r.ok) throw new Error(r.error.code);
    return r.task;
  };

  beforeAll(() => {
    tmp = lx('mktemp', '-d', '/tmp/tw-wsl-tasks-XXXXXX');
    if (!/^\/tmp\/tw-wsl-tasks-[A-Za-z0-9]+$/.test(tmp)) throw new Error(`unexpected temp folder ${tmp}`);
    lx('sh', '-c', 'cd "$1" && mkdir app && cd app && git init -q -b main && git config user.name Test && git config user.email test@example.invalid && printf "one\\n" > a.txt && git add . && git commit -q -m first', 'sh', tmp);
    repo = unc(`${tmp}/app`);
  });
  afterAll(() => {
    if (tmp) lx('rm', '-rf', tmp);
  });

  it('creates the task with Linux Git: a worktree next to the repository, read back in Windows form', async () => {
    const t = await created('Fix login');
    expect(t).toMatchObject({ repoRoot: repo, branch: 'splitnest/fix-login', worktreePath: unc(`${tmp}/app.worktrees/fix-login`), baseBranch: 'main', subPath: '' });
    // Linux Git owns it: its .git file names a Linux path.
    expect(lx('cat', `${tmp}/app.worktrees/fix-login/.git`)).toBe(`gitdir: ${tmp}/app/.git/worktrees/fix-login`);
    expect(g(`${tmp}/app.worktrees/fix-login`, 'symbolic-ref', '--short', 'HEAD')).toBe('splitnest/fix-login');
    expect(existsSync(t.worktreePath)).toBe(true);
  });

  it('review, commit all, and a clean merge into main where it is checked out; then cleanup', async () => {
    const t = await created('feature');
    writeFileSync(`${t.worktreePath}\\feature.txt`, 'feature\n');
    const c = await service.changes(t);
    expect(c.ok && c.changes.files.map((f) => [f.path, f.kind])).toEqual([['feature.txt', 'untracked']]);
    expect(await service.commitAll(t, 'Add feature')).toMatchObject({ ok: true });
    const check = await service.finishCheck(t);
    // Ubuntu 22.04's Git (2.34) has no merge-tree --write-tree: no preview, the merge is undone on conflict instead.
    expect(check).toMatchObject({ ok: true, check: { commitsToMerge: 1, mergeFolder: repo, mergeFolderDirty: false, inProgress: null } });
    expect(await service.merge(t)).toMatchObject({ ok: true, result: { outcome: 'merged' } });
    expect(readFileSync(`${repo}\\feature.txt`, 'utf8')).toBe('feature\n');
    expect(await service.remove(t, { deleteBranch: true })).toEqual({ ok: true, branch: 'deleted' });
    expect(existsSync(t.worktreePath)).toBe(false);
  });

  it('a conflicting merge is undone and main is exactly as before; bringing in main resolves it in the task', async () => {
    const t = await created('conflict');
    writeFileSync(`${t.worktreePath}\\a.txt`, 'task\n');
    await service.commitAll(t, 'task side');
    lx('sh', '-c', 'cd "$1" && printf "main\\n" > a.txt && git commit -qam main', 'sh', `${tmp}/app`);
    const before = [g(`${tmp}/app`, 'rev-parse', 'HEAD'), g(`${tmp}/app`, 'status', '--porcelain')];
    expect(await service.merge(t)).toEqual({ ok: true, result: { outcome: 'conflicts', conflicts: ['a.txt'] } });
    expect([g(`${tmp}/app`, 'rev-parse', 'HEAD'), g(`${tmp}/app`, 'status', '--porcelain')]).toEqual(before);
    expect(lx('sh', '-c', 'test -e "$1/.git/MERGE_HEAD" && echo yes || echo no', 'sh', `${tmp}/app`)).toBe('no');
    // In the task: conflicts stay there (a merge in progress, found through Linux paths), then resolved.
    expect(await service.updateFromBase(t)).toEqual({ ok: true, result: { outcome: 'conflicts', conflicts: ['a.txt'] } });
    expect(await service.finishCheck(t)).toMatchObject({ ok: true, check: { inProgress: 'task', unresolved: ['a.txt'] } });
    expect(await service.commitAll(t, 'resolve')).toMatchObject({ ok: false, error: { code: 'CONFLICTS_UNRESOLVED' } });
    writeFileSync(`${t.worktreePath}\\a.txt`, 'both\n');
    expect(await service.commitAll(t, 'Bring in main')).toMatchObject({ ok: true });
    expect(await service.merge(t)).toMatchObject({ ok: true, result: { outcome: 'merged' } });
    expect(g(`${tmp}/app`, 'show', 'HEAD:a.txt')).toBe('both');
  });

  it('remove refuses uncommitted work; discard deletes it after confirming the commit shown', async () => {
    const t = await created('throwaway');
    writeFileSync(`${t.worktreePath}\\draft.txt`, 'draft\n');
    expect(await service.remove(t, { deleteBranch: true })).toMatchObject({ ok: false, error: { code: 'TASK_DIRTY' } });
    const check = await service.finishCheck(t);
    if (!check.ok) throw new Error(check.error.code);
    expect(await service.discard(t, check.check.head)).toEqual({ ok: true });
    expect(existsSync(t.worktreePath)).toBe(false);
    expect(g(`${tmp}/app`, 'branch', '--list', 'splitnest/throwaway')).toBe('');
  });

  it('a folder of another distribution, or an unknown one, is never handed to this Git', async () => {
    expect(await service.create(`\\\\wsl.localhost\\NoSuchDistro\\tmp\\x`, 'x')).toMatchObject({ ok: false });
    expect(await service.create(`\\\\wsl.localhost\\${distro}\\tmp\\..\\etc`, 'x')).toMatchObject({ ok: false, error: { code: 'UNSUPPORTED_LOCATION' } });
  });
});
