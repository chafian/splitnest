// Real Git in a temporary repository (skipped when git.exe is not on PATH). Checks what the
// sidebar would show, that checking writes nothing into the repository, and that settings a
// repository can carry to run programs (fsmonitor, external diff, textconv) are not followed.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runFile } from '../../src/main/exec';
import { gitEnv, readGitStatus, withCeiling } from '../../src/main/git-status';
import os from 'node:os';
import { findOnPath, fileExists } from '../../src/main/shells';

const git = await findOnPath('git.exe', process.env, fileExists);
const env = gitEnv(process.env);
let repo = '';

async function g(...args: string[]): Promise<string> {
  const r = await runFile(git!, ['-C', repo, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false', ...args], { timeoutMs: 20_000, env });
  if (r.code !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr.toString()}`);
  return r.stdout.toString();
}
const read = () => readGitStatus(runFile, git!, repo, env);
const write = (name: string, text: string) => writeFileSync(path.join(repo, name), text);

/** Every file under .git with its size, time and content hash. */
function snapshot(dir = path.join(repo, '.git')): string {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else {
        const st = statSync(p);
        out.push(`${path.relative(dir, p)} ${st.size} ${st.mtimeMs} ${createHash('sha1').update(readFileSync(p)).digest('hex')}`);
      }
    }
  };
  walk(dir);
  return out.sort().join('\n');
}

// Each test runs several real Git commands (and some start a .cmd); 5 s is too tight on a busy CI runner.
describe.skipIf(!git)('Git status against a real repository', { timeout: 30_000 }, () => {
  beforeAll(async () => {
    repo = mkdtempSync(path.join(tmpdir(), 'tw-git-'));
    await g('init', '-q', '-b', 'main');
    write('a.txt', 'one\ntwo\nthree\n');
    write('b.txt', 'keep\n');
    await g('add', '.');
    await g('commit', '-q', '-m', 'first');
  });
  afterAll(() => {
    if (repo) rmSync(repo, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  });

  it('a clean repository: the branch, no changes', async () => {
    expect(await read()).toMatchObject({ branch: 'main', detached: null, initial: false, changedFiles: 0, untracked: 0, added: 0, removed: 0 });
  });

  it('edited lines, staged and unstaged together, against the last commit', async () => {
    write('a.txt', 'one\nTWO\nthree\nfour\n');
    await g('add', 'a.txt');
    write('b.txt', 'keep\nmore\n');
    expect(await read()).toMatchObject({ changedFiles: 2, added: 3, removed: 1 });
    await g('checkout', '--', 'b.txt');
    await g('reset', '-q', '--hard');
  });

  it('a renamed file: a change with no lines added or removed', async () => {
    renameSync(path.join(repo, 'b.txt'), path.join(repo, 'renamed.txt'));
    await g('add', '-A');
    expect(await read()).toMatchObject({ changedFiles: 1, added: 0, removed: 0 });
    await g('reset', '-q', '--hard');
  });

  it('new untracked files are counted, their lines are not', async () => {
    write('new.txt', 'x\ny\n');
    expect(await read()).toMatchObject({ changedFiles: 0, untracked: 1, added: 0, removed: 0 });
    rmSync(path.join(repo, 'new.txt'));
  });

  it('a branch switch and a detached HEAD', async () => {
    await g('checkout', '-q', '-b', 'feature/login');
    expect((await read())?.branch).toBe('feature/login');
    const head = (await g('rev-parse', 'HEAD')).trim();
    await g('checkout', '-q', '--detach');
    expect(await read()).toMatchObject({ branch: null, detached: head.slice(0, 7) });
    await g('checkout', '-q', 'main');
  });

  it('checking writes nothing into .git (not even the index)', async () => {
    write('a.txt', 'changed\n'); // a modified file: status would normally refresh the index
    const before = snapshot();
    for (let i = 0; i < 3; i++) await read();
    expect(snapshot()).toBe(before);
    await g('checkout', '--', 'a.txt');
  });

  it('programs a repository configures are not run: fsmonitor, external diff, textconv', async () => {
    const marker = path.join(repo, 'ran.txt');
    // A tiny program that leaves a mark when Git starts it.
    const script = path.join(repo, '.git', 'mark.cmd');
    writeFileSync(script, `@echo off\r\necho ran> "${marker}"\r\n`);
    const cmd = script.replace(/\\/g, '/');
    await g('config', 'core.fsmonitor', cmd);
    await g('config', 'diff.external', cmd);
    await g('config', 'diff.mark.textconv', cmd);
    write('.gitattributes', '*.txt diff=mark\n');
    write('a.txt', 'one\nTWO\n');
    const s = await read();
    expect(s).toMatchObject({ changedFiles: 1 });
    expect(s?.added).toBeGreaterThan(0);
    expect(existsSync(marker)).toBe(false);
    for (const k of ['core.fsmonitor', 'diff.external', 'diff.mark.textconv']) await g('config', '--unset', k);
    rmSync(path.join(repo, '.gitattributes'));
    await g('checkout', '--', 'a.txt');
  });

  it("a clean filter set in the repository's own config (directly or through an included file) is never started", async () => {
    const marker = path.join(repo, 'filter-ran.txt');
    const script = path.join(repo, '.git', 'filter.cmd');
    // Like a real clean filter it passes the content through, and leaves a mark.
    writeFileSync(script, `@echo off\r\necho ran> "${marker}"\r\nmore\r\n`);
    const cmd = script.replace(/\\/g, '/');
    write('.gitattributes', '*.txt filter=evil\n');
    write('a.txt', 'one\nTWO\n');
    for (const how of ['direct', 'include'] as const) {
      if (how === 'direct') await g('config', 'filter.evil.clean', cmd);
      else {
        writeFileSync(path.join(repo, '.git', 'more.cfg'), `[filter "evil"]\n\tclean = ${cmd}\n`);
        await g('config', 'include.path', 'more.cfg');
      }
      const s = await read();
      expect(s, how).toMatchObject({ branch: 'main', changesNotChecked: true, added: null, removed: null });
      expect(existsSync(marker), how).toBe(false);
      if (how === 'direct') {
        // Control: the same diff without the guard does start this filter (so the check above is
        // meaningful). `git diff` passes working-tree files through clean filters to compare them
        // (`--no-textconv` does not prevent that); `git status` does when file times are ambiguous.
        await g('diff', '--shortstat', '--no-ext-diff', '--no-textconv', 'HEAD');
        expect(existsSync(marker), 'git diff starts the filter').toBe(true);
        rmSync(marker);
      }
      if (how === 'direct') await g('config', '--unset', 'filter.evil.clean');
      else await g('config', '--unset', 'include.path');
    }
    // Without the setting, the same tree is checked as usual (and Git would have used the filter).
    expect(await read()).toMatchObject({ changesNotChecked: false });
    rmSync(path.join(repo, '.gitattributes'));
    rmSync(path.join(repo, '.git', 'more.cfg'), { force: true });
    await g('checkout', '--', 'a.txt');
  });

  it("a submodule's own clean filter is never started (submodules are not looked into)", async () => {
    // A separate repository with a filter set in its own config, added as a submodule.
    const sub = mkdtempSync(path.join(tmpdir(), 'tw-git-sub-'));
    const marker = path.join(sub, 'sub-filter-ran.txt');
    const opts = { timeoutMs: 20_000, env };
    const sg = async (cwd: string, ...args: string[]) => {
      const r = await runFile(git!, ['-C', cwd, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false', '-c', 'protocol.file.allow=always', ...args], opts);
      if (r.code !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr.toString()}`);
      return r.stdout.toString();
    };
    try {
      await sg(sub, 'init', '-q', '-b', 'main');
      writeFileSync(path.join(sub, 's.txt'), 'one\n');
      writeFileSync(path.join(sub, '.gitattributes'), '*.txt filter=evil\n');
      await sg(sub, 'add', '.');
      await sg(sub, 'commit', '-q', '-m', 'sub');
      await sg(repo, 'submodule', 'add', '-q', sub.replace(/\\/g, '/'), 'mod');
      await sg(repo, 'commit', '-q', '-m', 'add submodule');
      const inside = path.join(repo, 'mod');
      const script = path.join(sub, 'filter.cmd');
      writeFileSync(script, `@echo off\r\necho ran> "${marker}"\r\nmore\r\n`);
      // The filter is configured in the submodule's own config only (not in the outer repository).
      await sg(inside, 'config', 'filter.evil.clean', script.replace(/\\/g, '/'));
      // Same size (line endings may have been converted on checkout), new time: Git must read
      // (and filter) the content to know whether it changed.
      const file = path.join(inside, 's.txt');
      const crlf = readFileSync(file).includes(13);
      await new Promise((r) => setTimeout(r, 1100));
      writeFileSync(file, crlf ? 'two\r\n' : 'two\n');

      const s = await read();
      expect(s).toMatchObject({ branch: 'main', changesNotChecked: false });
      expect(existsSync(marker), 'SplitNest started the submodule filter').toBe(false);

      // Control: `git status` without --ignore-submodules does look into the submodule and start it.
      await runFile(git!, ['-C', repo, 'status', '--porcelain=v2'], opts);
      expect(existsSync(marker), 'plain git starts the submodule filter').toBe(true);
    } finally {
      // Leave the outer repository as the other tests expect it.
      await runFile(git!, ['-C', repo, 'reset', '-q', '--hard', 'HEAD~1'], opts).catch(() => undefined);
      rmSync(path.join(repo, 'mod'), { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
      rmSync(path.join(repo, '.git', 'modules'), { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
      await runFile(git!, ['-C', repo, 'config', '--remove-section', 'submodule.mod'], opts).catch(() => undefined);
      rmSync(sub, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    }
  });

  it('a branch without commits yet', async () => {
    const other = mkdtempSync(path.join(tmpdir(), 'tw-git-new-'));
    try {
      const r = await runFile(git!, ['-C', other, 'init', '-q', '-b', 'start'], { timeoutMs: 20_000, env });
      expect(r.code).toBe(0);
      writeFileSync(path.join(other, 'x.txt'), 'a\nb\n');
      await runFile(git!, ['-C', other, 'add', 'x.txt'], { timeoutMs: 20_000, env });
      expect(await readGitStatus(runFile, git!, other, env)).toMatchObject({ branch: 'start', initial: true, changedFiles: 1, added: 2, removed: 0 });
    } finally {
      rmSync(other, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    }
  });

  // Same tests in a SHA-1 and a SHA-256 repository: the empty tree has a different id in each.
  describe.each(['sha1', 'sha256'] as const)('before the first commit (%s repository): net lines against the empty tree, once', (format) => {
    /**
     * A new repository of this object format (no commit) with `prepare` applied; untracked files
     * (a 3-line file and a folder) are added in every case. Returns the state and whether reading
     * it changed anything in .git.
     */
    async function fresh(prepare: (dir: string, git: (...a: string[]) => Promise<void>) => Promise<void>) {
      const dir = mkdtempSync(path.join(tmpdir(), `tw-git-first-${format}-`));
      const run = async (...args: string[]) => {
        const r = await runFile(git!, ['-C', dir, ...args], { timeoutMs: 20_000, env });
        if (r.code !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr.toString()}`);
      };
      await run('init', '-q', `--object-format=${format}`, '-b', 'main');
      await prepare(dir, run);
      writeFileSync(path.join(dir, 'scratch.txt'), 'u1\nu2\nu3\n');
      mkdirSync(path.join(dir, 'notes'));
      writeFileSync(path.join(dir, 'notes', 'n.txt'), 'n1\nn2\n');
      try {
        const objectFormat = (await runFile(git!, ['-C', dir, 'rev-parse', '--show-object-format'], { timeoutMs: 20_000, env })).stdout.toString().trim();
        const before = snapshot(path.join(dir, '.git'));
        const status = await readGitStatus(runFile, git!, dir, withCeiling(env, dir, os.homedir()));
        return { status, objectFormat, gitUnchanged: snapshot(path.join(dir, '.git')) === before };
      } finally {
        rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
      }
    }

    it('a one-line file staged, then its contents replaced: +1 −0; untracked lines excluded; .git unchanged', async () => {
      const r = await fresh(async (dir, run) => {
        writeFileSync(path.join(dir, 'f.txt'), 'first\n');
        await run('add', 'f.txt');
        writeFileSync(path.join(dir, 'f.txt'), 'second\n');
      });
      expect(r.objectFormat).toBe(format);
      expect(r.status).toMatchObject({ branch: 'main', initial: true, changedFiles: 1, untracked: 2, added: 1, removed: 0 });
      expect(r.gitUnchanged).toBe(true);
    });

    it('the staged file deleted from the working copy: zero added, zero removed; .git unchanged', async () => {
      const r = await fresh(async (dir, run) => {
        writeFileSync(path.join(dir, 'f.txt'), 'first\n');
        await run('add', 'f.txt');
        rmSync(path.join(dir, 'f.txt'));
      });
      expect(r.objectFormat).toBe(format);
      expect(r.status).toMatchObject({ initial: true, changedFiles: 1, untracked: 2, added: 0, removed: 0 });
      expect(r.gitUnchanged).toBe(true);
    });
  });

  it('untracked: a folder of three new files is one entry for Git (the count is not a number of files)', async () => {
    mkdirSync(path.join(repo, 'drafts'));
    for (const n of ['1', '2', '3']) writeFileSync(path.join(repo, 'drafts', `${n}.txt`), `${n}\n`);
    try {
      expect(await read()).toMatchObject({ untracked: 1, changedFiles: 0, added: 0, removed: 0 });
    } finally {
      rmSync(path.join(repo, 'drafts'), { recursive: true, force: true });
    }
  });

  it('a folder that is not in a repository: nothing, also when the home folder is a repository', async () => {
    const plain = mkdtempSync(path.join(tmpdir(), 'tw-plain-'));
    try {
      // As the app runs it: Git does not go up into the home folder or the drive root.
      expect(await readGitStatus(runFile, git!, plain, withCeiling(env, plain, os.homedir()))).toBeNull();
    } finally {
      rmSync(plain, { recursive: true, force: true });
    }
  });

  it('a repository whose parent folder is a repository too: its own state', async () => {
    expect(await readGitStatus(runFile, git!, repo, withCeiling(env, repo, os.homedir()))).toMatchObject({ branch: 'main' });
  });

  it('a home folder that is a repository: found when it is the workspace folder, not from folders below it', async () => {
    // A fake home folder that is a repository, with a project folder (no repository) inside.
    const home = mkdtempSync(path.join(tmpdir(), 'tw-home-'));
    const project = path.join(home, 'Desktop', 'project');
    try {
      expect((await runFile(git!, ['-C', home, 'init', '-q', '-b', 'dotfiles'], { timeoutMs: 20_000, env })).code).toBe(0);
      mkdirSync(project, { recursive: true });
      writeFileSync(path.join(project, 'big.txt'), 'x\n');
      expect(await readGitStatus(runFile, git!, project, withCeiling(env, project, home))).toBeNull();
      expect(await readGitStatus(runFile, git!, home, withCeiling(env, home, home))).toMatchObject({ branch: 'dotfiles', untracked: 1 });
      // Without the ceiling Git would have found it (the reason for it).
      expect(await readGitStatus(runFile, git!, project, env)).toMatchObject({ branch: 'dotfiles' });
    } finally {
      rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    }
  });
});
