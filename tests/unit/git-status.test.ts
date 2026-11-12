import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RunResult, Runner } from '../../src/main/exec';
import {
  gitEnv,
  GitStatusService,
  isWslRoot,
  OUTPUT_BUSY_MAX_MS,
  OUTPUT_MIN_GAP_MS,
  OUTPUT_QUIET_MS,
  parseShortstat,
  parseStatus,
  readGitStatus,
  repositoryFilterKeys,
  withCeiling,
} from '../../src/main/git-status';
import type { GitStatus } from '../../src/shared/types';

const ok = (stdout: string, code = 0): RunResult => ({ code, stdout: Buffer.from(stdout), stderr: Buffer.alloc(0), timedOut: false, notFound: false });
const z = (...fields: string[]) => fields.map((f) => `${f}\0`).join('');

describe('parsing git output', () => {
  it('reads branch, upstream, ahead/behind, changed, renamed, conflicted and untracked entries', () => {
    const out = z(
      '# branch.oid 1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b',
      '# branch.head main',
      '# branch.upstream origin/main',
      '# branch.ab +2 -1',
      '1 .M N... 100644 100644 100644 aaa bbb src/a.ts',
      '2 R. N... 100644 100644 100644 aaa bbb R100 docs/new name.md',
      'docs/old name.md',
      'u UU N... 100644 100644 100644 100644 aaa bbb ccc conflict.ts',
      '? notes.txt',
      '? tmp/x.log',
    );
    expect(parseStatus(out)).toEqual({ branch: 'main', detached: null, initial: false, upstream: 'origin/main', ahead: 2, behind: 1, changedFiles: 3, untracked: 2, changesNotChecked: false });
  });

  it('a renamed file whose original path looks like an entry is not counted twice', () => {
    const out = z('# branch.oid abc', '# branch.head main', '2 R. N... 100644 100644 100644 aaa bbb R100 b.txt', '1 looks-like-an-entry.txt');
    expect(parseStatus(out)?.changedFiles).toBe(1);
  });

  it('detached HEAD, a branch without commits, and output that is not status', () => {
    expect(parseStatus(z('# branch.oid 0123456789abcdef', '# branch.head (detached)'))).toMatchObject({ branch: null, detached: '0123456' });
    expect(parseStatus(z('# branch.oid (initial)', '# branch.head main', '? a.txt'))).toMatchObject({ branch: 'main', initial: true, untracked: 1 });
    expect(parseStatus('fatal: not a git repository')).toBeNull();
  });

  it('reads line totals from --shortstat (any combination)', () => {
    expect(parseShortstat(' 3 files changed, 120 insertions(+), 6 deletions(-)\n')).toEqual({ added: 120, removed: 6 });
    expect(parseShortstat(' 1 file changed, 1 insertion(+)\n')).toEqual({ added: 1, removed: 0 });
    expect(parseShortstat(' 1 file changed, 1 deletion(-)\n')).toEqual({ added: 0, removed: 1 });
    expect(parseShortstat(' 1 file changed, 0 insertions(+), 0 deletions(-)\n')).toEqual({ added: 0, removed: 0 });
    expect(parseShortstat('')).toEqual({ added: 0, removed: 0 });
  });

  it('recognises folders inside WSL only', () => {
    for (const p of ['\\\\wsl$\\Ubuntu\\home\\me\\app', '\\\\wsl.localhost\\Ubuntu-22.04\\srv', '//wsl$/Ubuntu/x', '\\\\WSL.LOCALHOST\\Debian']) expect(isWslRoot(p), p).toBe(true);
    for (const p of ['C:\\Users\\me\\app', '\\\\server\\share\\wsl$', 'D:\\wsl$\\x', '\\\\wslhost\\x']) expect(isWslRoot(p), p).toBe(false);
  });

  it('git runs in English, without prompts or optional locks, and nothing redirects it elsewhere', () => {
    const env = gitEnv({ PATH: 'C:\\x', GIT_DIR: 'C:\\elsewhere\\.git', git_work_tree: 'C:\\y', GIT_EXTERNAL_DIFF: 'evil.exe', HOME: 'C:\\h' });
    expect(env).toMatchObject({ PATH: 'C:\\x', HOME: 'C:\\h', LC_ALL: 'C', GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' });
    expect(Object.keys(env).map((k) => k.toUpperCase())).not.toContain('GIT_DIR');
    expect(Object.keys(env).map((k) => k.toUpperCase())).not.toContain('GIT_WORK_TREE');
    expect(Object.keys(env).map((k) => k.toUpperCase())).not.toContain('GIT_EXTERNAL_DIFF');
  });
});

/** A fake Git: the filter query finds nothing (exit 1) unless `filters` is given. */
const fakeGit = (calls: string[][], status: string, diff = '', filters?: string): Runner =>
  async (_file, args) => {
    calls.push(args);
    if (args.includes('config')) return filters === undefined ? ok('', 1) : ok(filters);
    return args.includes('status') ? ok(status) : ok(diff);
  };

describe('readGitStatus: the commands it runs', () => {
  it("first the repository's filter settings, then status; changes add a diff against HEAD; options that run programs are off", async () => {
    const calls: string[][] = [];
    const run = fakeGit(calls, z('# branch.oid abc', '# branch.head main', '1 .M N... 1 1 1 a b f.txt'), ' 1 file changed, 4 insertions(+), 1 deletion(-)\n');
    expect(await readGitStatus(run, 'git.exe', 'C:\\repo', {})).toMatchObject({ branch: 'main', changedFiles: 1, added: 4, removed: 1, changesNotChecked: false });
    expect(calls).toHaveLength(3);
    for (const args of calls) {
      expect(args.slice(0, 7)).toEqual(['--no-optional-locks', '-c', 'core.fsmonitor=false', '-c', 'core.quotepath=off', '-C', 'C:\\repo']);
    }
    expect(calls[0]).toEqual(expect.arrayContaining(['config', '--show-scope', '--includes', '--null', '--get-regexp']));
    expect(calls[1]).toEqual(expect.arrayContaining(['status', '--ignore-submodules=all']));
    expect(calls[2]).toEqual(expect.arrayContaining(['diff', '--shortstat', '--no-ext-diff', '--no-textconv', '--ignore-submodules=all', 'HEAD']));

    calls.length = 0;
    expect(await readGitStatus(fakeGit(calls, z('# branch.oid abc', '# branch.head main')), 'git.exe', 'C:\\repo', {})).toMatchObject({ added: 0, removed: 0, changedFiles: 0 });
    expect(calls).toHaveLength(2);
  });

  it('filter programs set by the repository itself: no status or diff (no file is compared), only the branch', async () => {
    const calls: string[][] = [];
    const filters = 'local\0filter.evil.clean\nrun-me.cmd\0';
    const run: Runner = async (_f, args) => {
      calls.push(args);
      if (args.includes('config')) return ok(filters);
      if (args.includes('symbolic-ref')) return ok('main\n');
      if (args.includes('rev-parse')) return ok('1a2b3c4d\n');
      return ok(z('# branch.oid abc', '# branch.head main'));
    };
    expect(await readGitStatus(run, 'git.exe', 'C:\\repo', {})).toMatchObject({ branch: 'main', changesNotChecked: true, changedFiles: 0, added: null, removed: null });
    expect(calls.some((a) => a.includes('status') || a.includes('diff'))).toBe(false);
  });

  it("the user's own filters (global, system: e.g. Git LFS) do not stop the check", async () => {
    const calls: string[][] = [];
    const filters = 'system\0filter.lfs.clean\ngit-lfs clean -- %f\0global\0filter.lfs.process\ngit-lfs filter-process\0';
    expect(await readGitStatus(fakeGit(calls, z('# branch.oid abc', '# branch.head main'), '', filters), 'git.exe', 'C:\\repo', {})).toMatchObject({ changesNotChecked: false });
    expect(calls.some((a) => a.includes('status'))).toBe(true);
  });

  it('reads the scope of each filter key', () => {
    expect(repositoryFilterKeys('system\0filter.lfs.clean\ngit-lfs clean\0local\0filter.a.clean\nx\0worktree\0filter.b.process\ny\0global\0filter.c.clean\nz\0')).toEqual(['filter.a.clean', 'filter.b.process']);
    expect(repositoryFilterKeys('')).toEqual([]);
  });

  it('not a repository (or refused): null; a failed diff: totals unknown, not zero', async () => {
    expect(await readGitStatus(async () => ok('', 128), 'git.exe', 'C:\\x', {})).toBeNull();
    const run: Runner = async (_f, args) =>
      args.includes('config') ? ok('', 1) : args.includes('status') ? ok(z('# branch.oid abc', '# branch.head main', '1 .M N... 1 1 1 a b f')) : { ...ok(''), code: null, timedOut: true };
    expect(await readGitStatus(run, 'git.exe', 'C:\\x', {})).toMatchObject({ changedFiles: 1, added: null, removed: null });
  });
});

// ------------------------------------------------------------------ scheduling

const CLEAN = z('# branch.oid abc', '# branch.head main');

function setup(opts: { roots?: Record<string, string>; enabled?: boolean; git?: string | null; status?: () => string } = {}) {
  const roots = opts.roots ?? { w1: 'C:\\one', w2: 'C:\\two' };
  let enabled = opts.enabled ?? true;
  const ran: string[] = [];
  const published: { id: string; status: GitStatus | null }[] = [];
  const run: Runner = async (_file, args) => {
    if (args.includes('config')) return ok('', 1);
    if (args.includes('status')) ran.push(args[args.indexOf('-C') + 1]!);
    return ok(opts.status ? opts.status() : CLEAN);
  };
  const service = new GitStatusService({
    run,
    findGit: async () => (opts.git === undefined ? 'C:\\Git\\cmd\\git.exe' : opts.git),
    workspaces: () => Object.entries(roots).map(([id, rootPath]) => ({ id, rootPath })),
    enabled: () => enabled,
    publish: (id, status) => published.push({ id, status }),
    env: {},
  });
  return { service, ran, published, roots, setEnabled: (v: boolean) => (enabled = v) };
}
const flush = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};

describe('GitStatusService: when it checks', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('checks every workspace once when the list is loaded, then only new ones', async () => {
    const t = setup();
    t.service.sync();
    await flush();
    expect(t.ran).toEqual(['C:\\one', 'C:\\two']);
    expect(t.published.map((p) => p.id)).toEqual(['w1', 'w2']);
    t.roots.w3 = 'C:\\three';
    t.service.sync();
    await flush();
    expect(t.ran).toEqual(['C:\\one', 'C:\\two', 'C:\\three']);
  });

  it('selecting a workspace or coming back to the window checks right away; a second request within a second waits for it', async () => {
    const t = setup();
    t.service.request('w1');
    await flush();
    expect(t.ran).toEqual(['C:\\one']);
    t.service.request('w1'); // e.g. window focus right after selecting
    await flush();
    expect(t.ran).toHaveLength(1); // not at once...
    vi.advanceTimersByTime(1000);
    await flush();
    expect(t.ran).toHaveLength(2); // ...but once the second has passed
    vi.advanceTimersByTime(1000);
    t.service.request('w1'); // a second after that check: right away again
    await flush();
    expect(t.ran).toHaveLength(3);
  });

  it('saves inside the one-second limit: one follow-up check at the earliest allowed time, with the latest state', async () => {
    let out = CLEAN;
    const t = setup({ status: () => out });
    t.service.request('w1'); // a check completes at 0 ms
    await flush();
    expect(t.ran).toHaveLength(1);
    vi.advanceTimersByTime(200);
    t.service.request('w1'); // save at 200 ms
    vi.advanceTimersByTime(300);
    out = z('# branch.oid abc', '# branch.head after-save');
    t.service.request('w1'); // save at 500 ms
    await flush();
    vi.advanceTimersByTime(499); // 999 ms: not yet allowed
    await flush();
    expect(t.ran).toHaveLength(1);
    vi.advanceTimersByTime(1); // 1000 ms
    await flush();
    expect(t.ran).toHaveLength(2);
    expect(t.published.at(-1)).toMatchObject({ id: 'w1', status: { branch: 'after-save' } });
    vi.advanceTimersByTime(60_000); // no more events: nothing else runs
    await flush();
    expect(t.ran).toHaveLength(2);
  });

  describe('saves while a check is still running', () => {
    /** A service whose `git status` stays open until release() is called; times are relative to t0. */
    function held() {
      let out = CLEAN;
      const t0 = Date.now();
      const starts: number[] = [];
      const published: (string | null)[] = [];
      let release: () => void = () => undefined;
      let active = 0;
      let maxActive = 0;
      const service = new GitStatusService({
        run: (async (_f, args) => {
          if (args.includes('config')) return ok('', 1);
          if (!args.includes('status')) return ok('');
          starts.push(Date.now() - t0);
          active++;
          maxActive = Math.max(maxActive, active);
          await new Promise<void>((r) => (release = r));
          active--;
          return ok(out); // what is on disk when the check reads it
        }) as Runner,
        findGit: async () => 'git.exe',
        workspaces: () => [{ id: 'w1', rootPath: 'C:\\one' }],
        enabled: () => true,
        publish: (_id, s) => published.push(s?.branch ?? null),
        env: {},
      });
      return {
        service,
        starts,
        published,
        maxActive: () => maxActive,
        finish: async () => {
          release();
          await flush();
        },
        setOut: (branch: string) => (out = z('# branch.oid abc', `# branch.head ${branch}`)),
      };
    }
    const at = async (ms: number, t0: number) => {
      vi.advanceTimersByTime(ms - (Date.now() - t0));
      await flush();
    };

    it('saves at 200 and 300 ms during a check that ends at 350 ms: one follow-up at 1000 ms with the latest state', async () => {
      const h = held();
      const t0 = Date.now();
      h.service.request('w1'); // first check starts at 0 ms
      await flush();
      await at(200, t0);
      h.setOut('save-1');
      h.service.request('w1'); // save at 200 ms (check still running)
      await at(300, t0);
      h.setOut('save-2');
      h.service.request('w1'); // save at 300 ms
      await at(350, t0);
      await h.finish(); // first check ends at 350 ms (it read save-2's state)
      expect(h.starts).toEqual([0]);
      h.setOut('latest'); // changed again before the follow-up reads it
      await at(999, t0);
      expect(h.starts).toEqual([0]); // the interval counts from the start of the first check
      await at(1000, t0);
      expect(h.starts).toEqual([0, 1000]);
      await h.finish();
      expect(h.published.at(-1)).toBe('latest');
      await at(61_000, t0); // no other event: nothing else runs
      expect(h.starts).toEqual([0, 1000]);
      expect(h.maxActive()).toBe(1);
    });

    it('a check that ends after 1000 ms: the waiting follow-up starts as soon as it ends, never alongside it', async () => {
      const h = held();
      const t0 = Date.now();
      h.service.request('w1');
      await flush();
      await at(200, t0);
      h.service.request('w1'); // save at 200 ms
      await at(1200, t0);
      h.setOut('latest');
      await h.finish(); // first check ends at 1200 ms
      expect(h.starts).toEqual([0, 1200]);
      await h.finish();
      expect(h.published.at(-1)).toBe('latest');
      await at(61_000, t0);
      expect(h.starts).toEqual([0, 1200]);
      expect(h.maxActive()).toBe(1);
    });
  });

  it('a follow-up check waiting for the one-second limit is cancelled when Git status is turned off', async () => {
    const t = setup();
    t.service.request('w1');
    await flush();
    vi.advanceTimersByTime(200);
    t.service.request('w1');
    t.setEnabled(false);
    t.service.sync();
    vi.advanceTimersByTime(5000);
    await flush();
    expect(t.ran).toHaveLength(1);
  });

  it('a follow-up check waiting for the one-second limit is cancelled when the workspace is removed', async () => {
    const t = setup();
    t.service.request('w1');
    await flush();
    vi.advanceTimersByTime(200);
    t.service.request('w1');
    delete t.roots.w1;
    t.service.sync();
    vi.advanceTimersByTime(5000);
    await flush();
    // (sync() checks w2 for the first time; w1 must not be checked again.)
    expect(t.ran.filter((r) => r === 'C:\\one')).toHaveLength(1);
    expect(t.published.filter((p) => p.id === 'w1')).toHaveLength(1); // only the first check
  });

  it('a short burst of output (git checkout) gives one check, shortly after the output stops', async () => {
    const t = setup();
    t.service.request('w1');
    await flush();
    vi.advanceTimersByTime(OUTPUT_MIN_GAP_MS);
    t.ran.length = 0;
    for (let i = 0; i < 5; i++) {
      t.service.noteOutput('w1');
      vi.advanceTimersByTime(40);
    }
    await flush();
    expect(t.ran).toHaveLength(0);
    vi.advanceTimersByTime(OUTPUT_QUIET_MS);
    await flush();
    expect(t.ran).toEqual(['C:\\one']);
    vi.advanceTimersByTime(10_000);
    await flush();
    expect(t.ran).toHaveLength(1);
  });

  it('output right after a check waits for the minimum gap, then checks once', async () => {
    const t = setup();
    t.service.request('w1');
    await flush();
    t.ran.length = 0;
    t.service.noteOutput('w1');
    vi.advanceTimersByTime(OUTPUT_QUIET_MS);
    await flush();
    expect(t.ran).toHaveLength(0); // 0.8 s after the last check: too soon
    vi.advanceTimersByTime(OUTPUT_MIN_GAP_MS);
    await flush();
    expect(t.ran).toHaveLength(1);
  });

  it('output that never stops (a development server) checks at most every 30 s, and once more when it stops', async () => {
    const t = setup();
    const minutes = 3;
    for (let ms = 0; ms < minutes * 60_000; ms += 100) {
      t.service.noteOutput('w1');
      vi.advanceTimersByTime(100);
      if (ms % 5000 === 0) await flush();
    }
    await flush();
    const during = t.ran.length;
    expect(during).toBeGreaterThanOrEqual(minutes * 2 - 1);
    expect(during).toBeLessThanOrEqual(minutes * 2 + 1);
    vi.advanceTimersByTime(OUTPUT_BUSY_MAX_MS);
    await flush();
    expect(t.ran.length).toBe(during + 1); // the log stopped: one final check
    vi.advanceTimersByTime(5 * 60_000);
    await flush();
    expect(t.ran.length).toBe(during + 1);
  });

  it('output in one workspace does not check another', async () => {
    const t = setup();
    t.service.noteOutput('w2');
    vi.advanceTimersByTime(OUTPUT_QUIET_MS + 10);
    await flush();
    expect(t.ran).toEqual(['C:\\two']);
  });

  it('publishes only when something changed', async () => {
    let out = CLEAN;
    const t = setup({ status: () => out });
    t.service.request('w1');
    await flush();
    vi.advanceTimersByTime(2000);
    t.service.request('w1');
    await flush();
    expect(t.published).toHaveLength(1);
    out = z('# branch.oid abc', '# branch.head feature');
    vi.advanceTimersByTime(2000);
    t.service.request('w1');
    await flush();
    expect(t.published.map((p) => p.status?.branch)).toEqual(['main', 'feature']);
  });

  it('a folder inside WSL is never given to Git, also when its terminals print output', async () => {
    const t = setup({ roots: { w1: '\\\\wsl$\\Ubuntu\\home\\me\\app', w2: '\\\\wsl.localhost\\Ubuntu\\srv' } });
    t.service.sync();
    t.service.request('w1');
    t.service.noteOutput('w2');
    vi.advanceTimersByTime(60_000);
    await flush();
    expect(t.ran).toEqual([]);
    expect(t.published).toEqual([]);
    expect(t.service.runs).toBe(0);
  });

  it('without Git installed nothing is shown and nothing fails', async () => {
    const t = setup({ git: null });
    t.service.sync();
    await flush();
    expect(t.ran).toEqual([]);
    expect(t.published).toEqual([]);
  });

  it('turning the setting off clears what is shown and stops checking', async () => {
    const t = setup();
    t.service.sync();
    await flush();
    t.setEnabled(false);
    t.service.sync();
    expect(t.published.slice(-2)).toEqual([
      { id: 'w1', status: null },
      { id: 'w2', status: null },
    ]);
    t.ran.length = 0;
    t.service.request('w1');
    t.service.noteOutput('w1');
    vi.advanceTimersByTime(60_000);
    await flush();
    expect(t.ran).toEqual([]);
    expect(t.service.statuses()).toEqual({});
  });

  it('one Git check at a time; a request during a check runs once more after it', async () => {
    let release: () => void = () => undefined;
    let active = 0;
    let maxActive = 0;
    const ran: string[] = [];
    const service = new GitStatusService({
      run: (async (_f, args) => {
        if (args.includes('config')) return ok('', 1);
        active++;
        maxActive = Math.max(maxActive, active);
        ran.push(args[args.indexOf('-C') + 1]!);
        await new Promise<void>((r) => (release = r));
        active--;
        return ok(CLEAN);
      }) as Runner,
      findGit: async () => 'git.exe',
      workspaces: () => [
        { id: 'w1', rootPath: 'C:\\one' },
        { id: 'w2', rootPath: 'C:\\two' },
      ],
      enabled: () => true,
      publish: () => undefined,
      env: {},
    });
    service.request('w1');
    service.request('w2');
    await flush();
    service.request('w1'); // while w1 runs
    for (let i = 0; i < 2; i++) {
      release();
      await flush();
    }
    expect(ran).toEqual(['C:\\one', 'C:\\two']);
    // The request made during w1's check runs once the one-second limit (from its start) allows.
    vi.advanceTimersByTime(1000);
    await flush();
    release();
    await flush();
    expect(maxActive).toBe(1);
    expect(ran).toEqual(['C:\\one', 'C:\\two', 'C:\\one']);
  });
});

describe('where Git may look for a repository', () => {
  it('not up into the home folder or the drive root; an existing ceiling list is kept', () => {
    expect(withCeiling({}, 'C:\\Users\\me\\Desktop\\app', 'C:\\Users\\me').GIT_CEILING_DIRECTORIES).toBe('C:\\Users\\me;C:\\');
    expect(withCeiling({ GIT_CEILING_DIRECTORIES: 'D:\\work' }, 'D:\\work\\x', 'C:\\Users\\me').GIT_CEILING_DIRECTORIES).toBe('D:\\work;C:\\Users\\me;D:\\');
    expect(withCeiling({}, '\\\\server\\share\\app', 'C:\\Users\\me').GIT_CEILING_DIRECTORIES).toBe('C:\\Users\\me');
  });

  it('the service runs Git with that ceiling for each workspace', async () => {
    const envs: NodeJS.ProcessEnv[] = [];
    const service = new GitStatusService({
      run: (async (_f, a, o) => (envs.push(o.env ?? {}), a.includes('config') ? ok('', 1) : ok(CLEAN))) as Runner,
      findGit: async () => 'git.exe',
      workspaces: () => [{ id: 'w1', rootPath: 'D:\\code\\app' }],
      enabled: () => true,
      publish: () => undefined,
      env: { PATH: 'x' },
      home: 'C:\\Users\\me',
    });
    service.request('w1');
    await flush();
    expect(envs[0]).toMatchObject({ GIT_CEILING_DIRECTORIES: 'C:\\Users\\me;D:\\', LC_ALL: 'C', GIT_OPTIONAL_LOCKS: '0' });
  });
});
