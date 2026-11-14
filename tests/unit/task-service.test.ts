// TaskService with a scripted Git: failures real Git rarely produces (a failed or timed-out
// `worktree add`, Git not installed), older Git's output, and the order operations run in.
import { describe, expect, it } from 'vitest';
import type { GitResult, GitRunner } from '../../src/main/git-runner';
import { TaskService } from '../../src/main/task-service';

const BASE = 'a'.repeat(40);
const ok = (stdout = ''): GitResult => ({ code: 0, stdout, stderr: '', timedOut: false });
const err = (code = 128, stderr = ''): GitResult => ({ code, stdout: '', stderr, timedOut: false });

type Handler = (cwd: string, args: string[]) => GitResult | null | Promise<GitResult | null>;

function fakeGit(handler: Handler, version: [number, number, number] | null = [2, 39, 0]) {
  const calls: { cwd: string; args: string[] }[] = [];
  const git: GitRunner = {
    side: 'windows',
    version: async () => version,
    run: async (cwd, args) => {
      calls.push({ cwd, args });
      return handler(cwd, args);
    },
  };
  return { git, calls };
}

/** A repository at C:\fake\app on main, with only the main worktree; `add` decides how worktree add goes. */
function repoGit(add: Handler, nul = true): Handler {
  const list = nul ? ['worktree C:/fake/app', `HEAD ${BASE}`, 'branch refs/heads/main', '', ''].join('\0') : ['worktree C:/fake/app', `HEAD ${BASE}`, 'branch refs/heads/main', '', ''].join('\n');
  return (cwd, args) => {
    const a = args.join(' ');
    if (a === 'rev-parse --show-prefix') return ok('\n');
    if (a.startsWith('worktree list')) return ok(list);
    if (a === 'symbolic-ref --quiet --short HEAD') return ok('main\n');
    if (a === 'rev-parse --verify --quiet HEAD^{commit}') return ok(`${BASE}\n`);
    if (a.startsWith('for-each-ref')) return ok('refs/heads/main\n');
    if (a.startsWith('worktree add')) return add(cwd, args);
    if (a.startsWith('update-ref')) return ok();
    return err();
  };
}

const isDirectory = async (p: string) => /^C:\\fake\\app$/i.test(p);

describe('TaskService (scripted Git)', () => {
  it('creates with structured arguments: branch, folder next to the repository, base commit', async () => {
    const { git, calls } = fakeGit(repoGit(() => ok()));
    await new TaskService({ git, isDirectory }).create('C:\\fake\\app', 'Fix it');
    const add = calls.find((c) => c.args[0] === 'worktree' && c.args[1] === 'add')!;
    expect(add).toEqual({ cwd: 'C:\\fake\\app', args: ['worktree', 'add', '-b', 'splitnest/fix-it', 'C:\\fake\\app.worktrees\\fix-it', BASE] });
  });

  it('a failed worktree add deletes the new branch only while it is still the base commit', async () => {
    const { git, calls } = fakeGit(repoGit(() => err(128, 'fatal: something')));
    const r = await new TaskService({ git, isDirectory }).create('C:\\fake\\app', 'Fix it');
    expect(r).toMatchObject({ ok: false, error: { code: 'GIT_FAILED' } });
    expect(calls.at(-1)!.args).toEqual(['update-ref', '-d', 'refs/heads/splitnest/fix-it', BASE]);
    // No Git output in the message.
    if (!r.ok) expect(r.error.message).not.toMatch(/fatal|something|fix-it|fake/);
  });

  it('a timed-out worktree add says so', async () => {
    const { git } = fakeGit(repoGit(() => ({ code: null, stdout: '', stderr: '', timedOut: true })));
    expect(await new TaskService({ git, isDirectory }).create('C:\\fake\\app', 'x')).toMatchObject({ ok: false, error: { code: 'TIMEOUT' } });
  });

  it('Git not installed', async () => {
    const { git } = fakeGit(() => null, null);
    expect(await new TaskService({ git, isDirectory }).create('C:\\fake\\app', 'x')).toMatchObject({ ok: false, error: { code: 'GIT_NOT_FOUND' } });
    expect(await new TaskService({ git, isDirectory }).preview('C:\\fake\\app', 'x')).toMatchObject({ ok: false, error: { code: 'GIT_NOT_FOUND' } });
  });

  it('an invalid name is refused before Git runs', async () => {
    const { git, calls } = fakeGit(repoGit(() => ok()));
    const s = new TaskService({ git, isDirectory });
    for (const name of ['', '   ', '!!!', 'a\nb', 'x'.repeat(81), 42, null, { name: 'x' }]) expect(await s.create('C:\\fake\\app', name)).toMatchObject({ ok: false, error: { code: 'INVALID_NAME' } });
    expect(calls).toEqual([]);
  });

  it('Git before 2.36 lists worktrees without -z, and the lines are read the same way', async () => {
    const { git, calls } = fakeGit(repoGit(() => ok(), false), [2, 34, 1]);
    const r = await new TaskService({ git, isDirectory }).preview('C:\\fake\\app', 'x');
    expect(r).toMatchObject({ ok: true, preview: { repoRoot: 'C:\\fake\\app', baseBranch: 'main', branch: 'splitnest/x' } });
    expect(calls.filter((c) => c.args[0] === 'worktree').every((c) => !c.args.includes('-z'))).toBe(true);
  });

  it('operations on one repository wait for each other; another repository doesn’t wait', async () => {
    const order: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const handler: Handler = async (cwd, args) => {
      if (args[0] === 'worktree' && args[1] === 'add') {
        order.push(`start ${args[4]}`);
        if (String(args[4]).includes('first')) await gate;
        order.push(`end ${args[4]}`);
        return ok();
      }
      const base = repoGit(() => ok())(cwd, args);
      if (cwd.toLowerCase().startsWith('c:\\other') && args[0] === 'worktree' && args[1] === 'list') return ok(['worktree C:/other/lib', `HEAD ${BASE}`, 'branch refs/heads/main', '', ''].join('\0'));
      return base;
    };
    const { git } = fakeGit(handler);
    const s = new TaskService({ git, isDirectory: async (p) => /^C:\\(fake\\app|other\\lib)$/i.test(p) });
    const first = s.create('C:\\fake\\app', 'first');
    await new Promise((r) => setTimeout(r, 20));
    const second = s.create('C:\\FAKE\\APP', 'second'); // same repository, other spelling
    const other = s.create('C:\\other\\lib', 'other');
    await other;
    expect(order).toEqual(['start C:\\fake\\app.worktrees\\first', 'start C:\\other\\lib.worktrees\\other', 'end C:\\other\\lib.worktrees\\other']);
    release();
    await Promise.all([first, second]);
    expect(order.slice(3)).toEqual(['end C:\\fake\\app.worktrees\\first', 'start C:\\fake\\app.worktrees\\second', 'end C:\\fake\\app.worktrees\\second']);
  });

  it('a failure in one operation doesn’t block the next on the same repository', async () => {
    let n = 0;
    const { git } = fakeGit(repoGit(() => (n++ === 0 ? err() : ok())));
    const s = new TaskService({ git, isDirectory });
    const [a, b] = await Promise.all([s.create('C:\\fake\\app', 'a'), s.create('C:\\fake\\app', 'b')]);
    expect(a.ok).toBe(false);
    expect(b.ok).toBe(false); // the scripted list never shows the new worktree, so it isn't confirmed…
    if (!b.ok) expect(b.error.code).toBe('GIT_FAILED'); // …but it ran.
    expect(n).toBe(2);
  });
});

describe('Commit all fails closed', () => {
  const task = {
    repoRoot: 'C:\\fake\\app',
    subPath: '',
    baseBranch: 'main',
    baseCommit: BASE,
    branch: 'splitnest/t',
    worktreePath: 'C:\\fake\\app.worktrees\\t',
    taskRoot: 'C:\\fake\\app.worktrees\\t',
  };
  const list = ['worktree C:/fake/app', `HEAD ${BASE}`, 'branch refs/heads/main', '', 'worktree C:/fake/app.worktrees/t', `HEAD ${BASE}`, 'branch refs/heads/splitnest/t', '', ''].join('\0');

  it('when Git can’t list the unresolved files, nothing is staged or committed', async () => {
    const { git, calls } = fakeGit((_cwd, args) => {
      if (args[0] === 'worktree' && args[1] === 'list') return ok(list);
      if (args.includes('--diff-filter=U')) return err(128, 'fatal: something');
      return ok();
    });
    const s = new TaskService({ git, isDirectory: async () => true });
    expect(await s.commitAll(task, 'message')).toMatchObject({ ok: false, error: { code: 'GIT_FAILED' } });
    expect(calls.some((c) => c.args.includes('add') || c.args.includes('commit'))).toBe(false);
  });

  it('Bring in the base: when Git can’t tell whether conflicts are left, the task folder is left as it is (no abort)', async () => {
    const { git, calls } = fakeGit((_cwd, args) => {
      const a = args.join(' ');
      if (args[0] === 'worktree' && args[1] === 'list') return ok(list);
      if (a.includes('rev-parse --git-path')) return ok(''); // nothing in progress before
      if (a.includes('status --porcelain=v2')) return ok(''); // clean
      if (a.includes('rev-parse --verify --quiet refs/heads/')) return ok(`${BASE}\n`);
      if (args[0] === 'merge' && args[1] === '--no-edit') return err(1, 'CONFLICT');
      if (args.includes('--diff-filter=U')) return err(128, 'fatal');
      return ok();
    });
    const s = new TaskService({ git, isDirectory: async () => true });
    expect(await s.updateFromBase(task)).toMatchObject({ ok: false, error: { code: 'GIT_FAILED' } });
    expect(calls.some((c) => c.args.includes('--abort'))).toBe(false);
  });

  it('when Git lists an unresolved path that can’t be checked safely, nothing is committed', async () => {
    const { git, calls } = fakeGit((_cwd, args) => {
      if (args[0] === 'worktree' && args[1] === 'list') return ok(list);
      if (args.includes('--diff-filter=U')) return ok('../outside.txt\0');
      return ok();
    });
    const s = new TaskService({ git, isDirectory: async () => true });
    expect(await s.commitAll(task, 'message')).toMatchObject({ ok: false, error: { code: 'GIT_FAILED' } });
    expect(calls.some((c) => c.args.includes('commit'))).toBe(false);
  });
});
