// Source Control against real Git in temporary repositories (skipped when git.exe is not on PATH):
// status groups, stage and unstage, diffs, commit (and a refusing hook), push with upstream setup to
// a local bare repository, fast-forward pull and its refusal, and discard with its key.
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { runFile } from '../../src/main/exec';
import { createWindowsGitRunner } from '../../src/main/git-runner';
import { gitEnv } from '../../src/main/git-status';
import { fileExists, findOnPath } from '../../src/main/shells';
import { gitDetail, parsePorcelainV2, SourceControlService } from '../../src/main/source-control';

const git = await findOnPath('git.exe', process.env, fileExists);
const env = gitEnv(process.env);
const runner = createWindowsGitRunner({ run: runFile, findGit: async () => git, env: process.env, home: os.homedir() });
const sc = new SourceControlService({ git: runner });
const work = realpathSync.native(mkdtempSync(path.join(os.tmpdir(), 'tw-sc-')));
let n = 0;

async function g(cwd: string, ...args: string[]): Promise<string> {
  const r = await runFile(git!, ['-C', cwd, ...args], { timeoutMs: 20_000, env });
  if (r.code !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr.toString()}`);
  return r.stdout.toString().trim();
}

async function configure(repo: string): Promise<void> {
  for (const [k, v] of [
    ['core.autocrlf', 'false'],
    ['user.name', 'Test'],
    ['user.email', 'test@example.invalid'],
    ['commit.gpgsign', 'false'],
  ]) await g(repo, 'config', k!, v!);
}

async function newRepo(): Promise<string> {
  const repo = path.join(work, `${n++}`, 'my app');
  mkdirSync(repo, { recursive: true });
  await g(repo, 'init', '-q', '-b', 'main');
  await configure(repo);
  writeFileSync(path.join(repo, 'a.txt'), 'one\ntwo\n');
  writeFileSync(path.join(repo, 'b.txt'), 'bee\n');
  await g(repo, 'add', '.');
  await g(repo, 'commit', '-q', '-m', 'first');
  return repo;
}

afterAll(() => rmSync(work, { recursive: true, force: true }));

describe('porcelain v2 parsing', () => {
  it('reads branch, upstream, ahead/behind and each kind of entry', () => {
    const z = [
      '# branch.oid 0123456789abcdef0123456789abcdef01234567',
      '# branch.head main',
      '# branch.upstream origin/main',
      '# branch.ab +2 -1',
      '1 M. N... 100644 100644 100644 aaa bbb staged only.txt',
      '1 .M N... 100644 100644 100644 aaa aaa work.txt',
      '1 MM N... 100644 100644 100644 aaa bbb both.txt',
      '2 R. N... 100644 100644 100644 aaa aaa R100 new name.txt',
      'old name.txt',
      'u UU N... 100644 100644 100644 100644 a b c conflict.txt',
      '? new file.txt',
      '',
    ].join('\0');
    const p = parsePorcelainV2(z);
    expect(p).toMatchObject({ branch: 'main', head: '0123456', upstream: 'origin/main', ahead: 2, behind: 1, unborn: false });
    expect(p.staged).toEqual([
      { path: 'staged only.txt', kind: 'modified' },
      { path: 'both.txt', kind: 'modified' },
      { path: 'new name.txt', oldPath: 'old name.txt', kind: 'renamed' },
    ]);
    expect(p.unstaged).toEqual([
      { path: 'work.txt', kind: 'modified' },
      { path: 'both.txt', kind: 'modified' },
      { path: 'conflict.txt', kind: 'conflicted' },
      { path: 'new file.txt', kind: 'untracked' },
    ]);
    expect(parsePorcelainV2('# branch.oid (initial)\0# branch.head (detached)\0')).toMatchObject({ unborn: true, branch: null });
  });

  it('shows Git’s error lines without credentials or progress noise', () => {
    expect(gitDetail('Counting objects: 3\nremote: Compressing objects: 100%\nfatal: unable to access \'https://me:ghp_secret@github.com/a/b.git/\': denied\n')).toBe(
      "fatal: unable to access 'https://***@github.com/a/b.git/': denied",
    );
    expect(gitDetail('')).toBeUndefined();
  });
});

describe.skipIf(!git)('source control with real Git', { timeout: 30_000 }, () => {
  it('lists staged and unstaged changes, stages, unstages and shows each diff', async () => {
    const repo = await newRepo();
    const sub = path.join(repo, 'src');
    mkdirSync(sub);
    writeFileSync(path.join(repo, 'a.txt'), 'one\nTWO\nthree\n');
    writeFileSync(path.join(sub, 'new.ts'), 'export {};\n');
    rmSync(path.join(repo, 'b.txt'));
    // From a subfolder of the repository: everything is relative to its top.
    let s = await sc.status(sub);
    if (!s.ok) throw new Error(s.error.message);
    expect(s.status).toMatchObject({ branch: 'main', upstream: null, unborn: false, operation: null, staged: [] });
    expect(s.status.top.toLowerCase()).toBe(repo.toLowerCase());
    expect(s.status.unstaged.map((f) => [f.path, f.kind, f.added, f.removed])).toEqual([
      ['a.txt', 'modified', 2, 1],
      ['b.txt', 'deleted', 0, 1],
      ['src/new.ts', 'untracked', null, null],
    ]);
    const st = await sc.stage(repo, ['a.txt', 'src/new.ts']);
    if (!st.ok) throw new Error(st.error.message);
    expect(st.status.staged.map((f) => [f.path, f.kind])).toEqual([
      ['a.txt', 'modified'],
      ['src/new.ts', 'added'],
    ]);
    expect(st.status.unstaged.map((f) => f.path)).toEqual(['b.txt']);
    // A path not in the list (or made up) is refused.
    expect(await sc.stage(repo, ['../outside.txt'])).toMatchObject({ ok: false, error: { code: 'NOT_CHANGED' } });
    const staged = await sc.diff(repo, 'a.txt', true);
    expect(staged.ok && staged.diff.text).toContain('+TWO');
    writeFileSync(path.join(repo, 'a.txt'), 'one\nTWO\nthree\nfour\n');
    const unstagedDiff = await sc.diff(repo, 'a.txt', false);
    expect(unstagedDiff.ok && unstagedDiff.diff.text).toContain('+four');
    expect(unstagedDiff.ok && unstagedDiff.diff.text).not.toContain('+TWO');
    const un = await sc.unstage(repo, ['a.txt']);
    if (!un.ok) throw new Error(un.error.message);
    expect(un.status.staged.map((f) => f.path)).toEqual(['src/new.ts']);
    expect(readFileSync(path.join(repo, 'a.txt'), 'utf8')).toBe('one\nTWO\nthree\nfour\n'); // nothing lost
    s = await sc.stage(repo, 'all');
    expect(s.ok && s.status.unstaged).toEqual([]);
    s = await sc.unstage(repo, 'all');
    expect(s.ok && s.status.staged).toEqual([]);
  });

  it('commits what is staged, or everything; a refusing hook is reported and nothing is lost', async () => {
    const repo = await newRepo();
    writeFileSync(path.join(repo, 'a.txt'), 'changed\n');
    expect(await sc.commit(repo, 'x', false)).toMatchObject({ ok: false, error: { code: 'NOTHING_STAGED' } });
    expect(await sc.commit(repo, '   ', true)).toMatchObject({ ok: false, error: { code: 'INVALID_MESSAGE' } });
    const c = await sc.commit(repo, 'Change a', true);
    if (!c.ok) throw new Error(c.error.message);
    expect(c.commit).toMatch(/^[0-9a-f]{7,}$/);
    expect(c.status.unstaged).toEqual([]);
    expect(await g(repo, 'log', '-1', '--format=%s')).toBe('Change a');
    // A pre-commit hook that refuses.
    mkdirSync(path.join(repo, '.git', 'hooks'), { recursive: true });
    writeFileSync(path.join(repo, '.git', 'hooks', 'pre-commit'), '#!/bin/sh\necho "lint failed: 3 problems" >&2\nexit 1\n');
    writeFileSync(path.join(repo, 'b.txt'), 'bee 2\n');
    const refused = await sc.commit(repo, 'Change b', true);
    expect(refused).toMatchObject({ ok: false, error: { code: 'COMMIT_FAILED' } });
    expect(!refused.ok && refused.error.detail).toContain('lint failed: 3 problems');
    expect(readFileSync(path.join(repo, 'b.txt'), 'utf8')).toBe('bee 2\n');
  });

  it('pushes a new branch only to the confirmed remote, then to its upstream; pulls fast-forward only', async () => {
    const repo = await newRepo();
    const bare = path.join(work, `${n++}`, 'remote.git');
    mkdirSync(bare, { recursive: true });
    await g(bare, 'init', '-q', '--bare', '-b', 'main');
    await g(repo, 'remote', 'add', 'origin', bare);
    expect(await sc.push(repo)).toMatchObject({ ok: false, error: { code: 'NO_UPSTREAM' } });
    const t = await sc.pushTarget(repo);
    expect(t).toEqual({ ok: true, target: { remote: 'origin', branch: 'main' } });
    expect(await sc.push(repo, { remote: 'elsewhere', branch: 'main' })).toMatchObject({ ok: false, error: { code: 'NO_UPSTREAM' } });
    const first = await sc.push(repo, t.ok ? t.target : undefined);
    if (!first.ok) throw new Error(`${first.error.message} ${first.error.detail}`);
    expect(first.status).toMatchObject({ upstream: 'origin/main', ahead: 0, behind: 0 });
    writeFileSync(path.join(repo, 'a.txt'), 'pushed\n');
    const c = await sc.commit(repo, 'Second', true);
    expect(c.ok && c.status.ahead).toBe(1);
    const second = await sc.push(repo);
    expect(second.ok && second.status.ahead).toBe(0);
    // Someone else pushes: our clone is behind, and pull fast-forwards.
    const other = path.join(work, `${n++}`, 'other');
    await g(work, 'clone', '-q', bare, other);
    await configure(other);
    writeFileSync(path.join(other, 'c.txt'), 'from elsewhere\n');
    await g(other, 'add', '.');
    await g(other, 'commit', '-q', '-m', 'Theirs');
    await g(other, 'push', '-q');
    await g(repo, 'fetch', '-q');
    const pulled = await sc.pull(repo);
    if (!pulled.ok) throw new Error(`${pulled.error.message} ${pulled.error.detail}`);
    expect(existsSync(path.join(repo, 'c.txt'))).toBe(true);
    // Both move on: pull refuses instead of merging.
    writeFileSync(path.join(other, 'c.txt'), 'theirs again\n');
    await g(other, 'commit', '-q', '-am', 'Theirs 2');
    await g(other, 'push', '-q');
    writeFileSync(path.join(repo, 'a.txt'), 'ours\n');
    await sc.commit(repo, 'Ours', true);
    const diverged = await sc.pull(repo);
    expect(diverged).toMatchObject({ ok: false, error: { code: 'PULL_DIVERGED' } });
    expect(await g(repo, 'log', '-1', '--format=%s')).toBe('Ours'); // no merge commit
  }, 60_000);

  it('discards with a key that matches the file as confirmed: restores a change, deletes a new file', async () => {
    const repo = await newRepo();
    writeFileSync(path.join(repo, 'a.txt'), 'oops\n');
    writeFileSync(path.join(repo, 'scratch.txt'), 'temp\n');
    const pa = await sc.discardPreview(repo, 'a.txt');
    const pn = await sc.discardPreview(repo, 'scratch.txt');
    expect(pa.ok && pa.preview.action).toBe('restore');
    expect(pn.ok && pn.preview.action).toBe('delete');
    // Changed again after the preview: refused.
    writeFileSync(path.join(repo, 'a.txt'), 'oops, more\n');
    expect(await sc.discard(repo, 'a.txt', pa.ok ? pa.preview.key : '')).toMatchObject({ ok: false, error: { code: 'STALE' } });
    const again = await sc.discardPreview(repo, 'a.txt');
    expect((await sc.discard(repo, 'a.txt', again.ok ? again.preview.key : '')).ok).toBe(true);
    expect(readFileSync(path.join(repo, 'a.txt'), 'utf8')).toBe('one\ntwo\n');
    expect((await sc.discard(repo, 'scratch.txt', pn.ok ? pn.preview.key : '')).ok).toBe(true);
    expect(existsSync(path.join(repo, 'scratch.txt'))).toBe(false);
    expect(await sc.discard(repo, 'b.txt', 'x')).toMatchObject({ ok: false, error: { code: 'NOT_CHANGED' } });
  });

  it('a new repository without commits: stages, unstages and makes the first commit', async () => {
    const repo = path.join(work, `${n++}`, 'fresh');
    mkdirSync(repo, { recursive: true });
    await g(repo, 'init', '-q', '-b', 'main');
    await configure(repo);
    writeFileSync(path.join(repo, 'x.txt'), 'x\n');
    let s = await sc.stage(repo, 'all');
    expect(s.ok && s.status).toMatchObject({ unborn: true, staged: [{ path: 'x.txt', kind: 'added' }] });
    s = await sc.unstage(repo, ['x.txt']);
    expect(s.ok && s.status.staged).toEqual([]);
    const c = await sc.commit(repo, 'Initial', true);
    expect(c.ok && c.status.unborn).toBe(false);
  });

  it('outside a repository', async () => {
    const plain = path.join(work, `${n++}`, 'plain');
    mkdirSync(plain, { recursive: true });
    expect(await sc.status(plain)).toMatchObject({ ok: false, error: { code: 'NOT_A_REPOSITORY' } });
  });
});
