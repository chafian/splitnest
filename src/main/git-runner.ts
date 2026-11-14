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
import { fromGitPath, parseGitVersion, parseWslUnc, wslUnc } from './git-worktree';
import { decodeWslOutput } from './wsl';

export interface GitResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  /** Output went past 1 MB and was cut off. */
  overflow?: boolean;
}

export interface GitRunner {
  /** Which Git this is: Windows' git.exe, or a WSL distribution's own Git. */
  readonly side: 'windows' | 'wsl';
  /** Runs `git -C <cwd> <args>`; `cwd` is a Windows path (a WSL one is mapped). Null when Git isn't installed. */
  run(cwd: string, args: string[], options?: { timeoutMs?: number }): Promise<GitResult | null>;
  /** A Windows path as this Git takes it in an argument. */
  toGit(windowsPath: string): string;
  /** A path as this Git prints it, in Windows form. */
  toWindows(gitPath: string): string;
  /** The installed version, e.g. [2, 39, 0] (null: unknown). Read once. */
  version(): Promise<[number, number, number] | null>;
  /**
   * Several read-only commands in the same folder, results in order (stdout only). In WSL they run in
   * one wsl.exe start (each costs ~130 ms otherwise). Null when Git isn't installed.
   */
  runMany(cwd: string, commands: string[][]): Promise<GitResult[] | null>;
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
    return { code: r.code, stdout: r.stdout.toString('utf8'), stderr: r.stderr.toString('utf8'), timedOut: r.timedOut, ...(r.overflow ? { overflow: true } : {}) };
  };

  return {
    side: 'windows',
    run,
    runMany: async (cwd, commands) => {
      const out: GitResult[] = [];
      for (const args of commands) {
        const r = await run(cwd, args);
        if (r === null) return null;
        out.push(r);
      }
      return out;
    },
    toGit: (p) => p,
    toWindows: fromGitPath,
    version: () =>
      (version ??= (async () => {
        const file = await exe();
        if (!file) return null;
        const r = await deps.run(file, ['--version'], { timeoutMs: GIT_TIMEOUT_MS, env: base });
        return r.code === 0 ? parseGitVersion(r.stdout.toString('utf8')) : null;
      })()),
  };
}

export interface WslGitDeps {
  run: Runner;
  wslExe: string;
  distro: string;
  /** `wsl.localhost` or `wsl$`: how the workspace folder spells it (paths read back use the same). */
  host: string;
}

/**
 * A WSL distribution's own Git, for repositories stored inside it: `wsl.exe --distribution <d>
 * --exec env LC_ALL=C … git -C <linux path> …`, structured arguments only (no shell). Windows
 * variables aren't passed into Linux (WSLENV is not extended), so nothing can point Git elsewhere;
 * English messages and no prompts are set with `env`. A worktree made here holds Linux paths, so
 * Windows Git never works on these tasks (and the other way round).
 */
export function createWslGitRunner(deps: WslGitDeps): GitRunner {
  let version: Promise<[number, number, number] | null> | null = null;
  const toGit = (p: string): string => {
    const loc = parseWslUnc(p);
    // Only folders of this distribution; anything else becomes a path Git can't find.
    return loc && loc.distro.toLowerCase() === deps.distro.toLowerCase() ? loc.linuxPath : '/nonexistent/splitnest';
  };
  const exec = async (args: string[], timeoutMs: number): Promise<GitResult> => {
    // Stopping wsl.exe doesn't stop the Git inside Linux, so Git runs under coreutils `timeout` there
    // (TERM, then KILL 10 s later), and wsl.exe gets a little longer than that.
    const seconds = Math.max(1, Math.ceil(timeoutMs / 1000));
    const r = await deps.run(
      deps.wslExe,
      ['--distribution', deps.distro, '--exec', 'env', 'LC_ALL=C', 'LANGUAGE=C', 'GIT_TERMINAL_PROMPT=0', 'GIT_OPTIONAL_LOCKS=0', 'timeout', '-k', '10', String(seconds), 'git', ...args],
      { timeoutMs: timeoutMs + 20_000, env: { ...process.env, WSL_UTF8: '1' } },
    );
    // 124: `timeout` stopped it; 137: it had to be killed.
    if (r.code === 124 || r.code === 137) return { code: r.code, stdout: r.stdout.toString('utf8'), stderr: decodeWslOutput(r.stderr), timedOut: true };
    // Git's own output is UTF-8; wsl.exe's messages (no such distribution…) may be UTF-16.
    return { code: r.code, stdout: r.stdout.toString('utf8'), stderr: decodeWslOutput(r.stderr), timedOut: r.timedOut, ...(r.overflow ? { overflow: true } : {}) };
  };
  const missing = (r: GitResult) =>
    // Git (or bash, for batches) isn't installed in the distribution: `timeout`/`env` can't run it (126/127); or no such distribution.
    ((r.code === 126 || r.code === 127) && /^(env|timeout): .*(git|bash)/m.test(r.stderr)) || /WSL_E_DISTRO_NOT_FOUND/.test(r.stderr);
  const run: GitRunner['run'] = async (cwd, args, options) => {
    const r = await exec(['-c', 'core.fsmonitor=false', '-c', 'core.quotepath=off', '-C', toGit(cwd), ...args], options?.timeoutMs ?? GIT_TIMEOUT_MS);
    return missing(r) ? null : r;
  };
  let noBash = false;
  return {
    side: 'wsl',
    toGit,
    toWindows: (p) => (p.startsWith('/') ? wslUnc(deps.host, deps.distro, p) : fromGitPath(p)),
    run,
    runMany: async (cwd, commands) => {
      const sequential = async () => {
        const out: GitResult[] = [];
        for (const args of commands) {
          const r = await run(cwd, args);
          if (r === null) return null;
          out.push(r);
        }
        return out;
      };
      if (noBash || commands.length < 2) return sequential();
      // One bash in the distribution runs each command (arguments passed as positional parameters,
      // never through a shell string) and frames its exit code and output by length.
      const argv: string[] = [toGit(cwd)];
      for (const c of commands) argv.push(String(c.length), ...c);
      const timeoutMs = GIT_TIMEOUT_MS * commands.length;
      const seconds = Math.ceil(timeoutMs / 1000);
      const r = await deps.run(
        deps.wslExe,
        ['--distribution', deps.distro, '--exec', 'env', 'LC_ALL=C', 'LANGUAGE=C', 'GIT_TERMINAL_PROMPT=0', 'GIT_OPTIONAL_LOCKS=0', 'timeout', '-k', '10', String(seconds), 'bash', '-c', BATCH_SCRIPT, 'bash', ...argv],
        { timeoutMs: timeoutMs + 20_000, env: { ...process.env, WSL_UTF8: '1' } },
      );
      const stderr = decodeWslOutput(r.stderr);
      if ((r.code === 126 || r.code === 127) && /bash/.test(stderr)) {
        noBash = true; // a distribution without bash: one wsl.exe start per command from now on
        return sequential();
      }
      if (/WSL_E_DISTRO_NOT_FOUND/.test(stderr) || /^(env|timeout): .*git/m.test(stderr)) return null;
      const timedOut = r.timedOut || r.code === 124 || r.code === 137;
      return parseBatch(r.stdout, commands.length, timedOut, !!r.overflow);
    },
    version: () =>
      (version ??= exec(['--version'], GIT_TIMEOUT_MS).then((r) => (r.code === 0 ? parseGitVersion(r.stdout) : null))),
  };
}

/** Runs `git -C <dir>` once per command given as `<count> <args…>`; prints `<exit code> <bytes>\n` and the output. */
export const BATCH_SCRIPT = [
  'dir=$1; shift',
  'tmp=$(mktemp) || exit 90',
  "trap 'rm -f \"$tmp\"' EXIT",
  'while [ "$#" -gt 0 ]; do',
  '  n=$1; shift',
  '  git -c core.fsmonitor=false -c core.quotepath=off -C "$dir" "${@:1:$n}" >"$tmp" 2>/dev/null',
  '  code=$?',
  '  shift "$n"',
  '  printf \'%s %s\n\' "$code" "$(( $(wc -c <"$tmp") ))"',
  '  cat "$tmp"',
  'done',
].join('\n');

/** The batch script's output: one result per command (missing ones, after a stop or a cut, failed). */
export function parseBatch(stdout: Buffer, count: number, timedOut: boolean, overflow: boolean): GitResult[] {
  const out: GitResult[] = [];
  let pos = 0;
  while (out.length < count && pos < stdout.length) {
    const nl = stdout.indexOf(10, pos);
    if (nl < 0) break;
    const m = /^(\d+) (\d+)$/.exec(stdout.subarray(pos, nl).toString('latin1'));
    if (!m) break;
    const size = Number(m[2]);
    const end = nl + 1 + size;
    if (end > stdout.length) {
      // Cut off by the output limit: what there is, marked.
      out.push({ code: Number(m[1]), stdout: stdout.subarray(nl + 1).toString('utf8'), stderr: '', timedOut: false, overflow: true });
      break;
    }
    out.push({ code: Number(m[1]), stdout: stdout.subarray(nl + 1, end).toString('utf8'), stderr: '', timedOut: false });
    pos = end;
  }
  while (out.length < count) out.push({ code: null, stdout: '', stderr: '', timedOut, ...(overflow ? { overflow: true } : {}) });
  return out;
}
