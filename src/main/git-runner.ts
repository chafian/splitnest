// Runs Git for agent tasks. One interface so tasks in WSL (M5) can use the distribution's own Git:
// a worktree made by Windows Git stores Windows paths that Linux Git can't follow, and the other
// way round, so each task is handled by one Git only.
//
// Windows: git.exe found on PATH once, structured arguments (no shell), a timeout, and the same
// environment as the Git status check (git-status.ts): English messages (they are matched), no
// prompts, no variables that point Git at another repository, and no search for a repository in
// the user's home folder or a drive root from a folder below it. Unlike the status check, task
// commands change the repository (worktree add/remove, branches), so the repository's hooks run as
// they would for the same command typed in a terminal.
import type { Runner } from './exec';
import { gitEnv, withCeiling } from './git-status';
import { parseGitVersion } from './git-worktree';

export interface GitResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export interface GitRunner {
  /** Which Git this is; paths passed and returned are in that side's form. */
  readonly side: 'windows';
  /** Runs `git -C <cwd> <args>`. Null when Git isn't installed. */
  run(cwd: string, args: string[], options?: { timeoutMs?: number }): Promise<GitResult | null>;
  /** The installed version, e.g. [2, 39, 0] (null: unknown). Read once. */
  version(): Promise<[number, number, number] | null>;
}

export const GIT_TIMEOUT_MS = 20_000;

export interface WindowsGitDeps {
  run: Runner;
  /** git.exe's path, or null (looked up once). */
  findGit(): Promise<string | null>;
  env: NodeJS.ProcessEnv;
  home: string;
}

export function createWindowsGitRunner(deps: WindowsGitDeps): GitRunner {
  let git: Promise<string | null> | null = null;
  let version: Promise<[number, number, number] | null> | null = null;
  const base = gitEnv(deps.env);
  const exe = () => (git ??= deps.findGit().catch(() => null));

  const run: GitRunner['run'] = async (cwd, args, options) => {
    const file = await exe();
    if (!file) return null;
    const r = await deps.run(file, ['-c', 'core.fsmonitor=false', '-c', 'core.quotepath=off', '-C', cwd, ...args], {
      timeoutMs: options?.timeoutMs ?? GIT_TIMEOUT_MS,
      env: withCeiling(base, cwd, deps.home),
    });
    return { code: r.code, stdout: r.stdout.toString('utf8'), stderr: r.stderr.toString('utf8'), timedOut: r.timedOut };
  };

  return {
    side: 'windows',
    run,
    version: () =>
      (version ??= (async () => {
        const file = await exe();
        if (!file) return null;
        const r = await deps.run(file, ['--version'], { timeoutMs: GIT_TIMEOUT_MS, env: base });
        return r.code === 0 ? parseGitVersion(r.stdout.toString('utf8')) : null;
      })()),
  };
}
