// Source Control for any workspace in a Git repository: status (staged, unstaged, new, conflicts),
// diffs, and the actions the user clicks: stage, unstage, commit, push, pull (fast-forward only)
// and discard (confirmed with a key, refused when the file changed since). Everything runs in the
// repository's top folder with the Git of that folder: Windows' git.exe, or a WSL distribution's
// own Git for repositories inside WSL. Commands that change the repository run its hooks, as the
// same command typed in a terminal would; nothing is forced. Paths come from Git's own listing and
// go back as literal pathspecs. Sign-in for push and pull is Git's own credential helper; Git never
// waits on a terminal prompt (GIT_TERMINAL_PROMPT=0), and its error text is shown with any
// credentials in URLs hidden.
import { createHash } from 'node:crypto';
import { FILTER_KEYS, isWslRoot, repositoryFilterKeys } from './git-status';
import type { GitResult, GitRunner } from './git-runner';
import { isSafeRelative, parseNumstat, parseWslUnc } from './git-worktree';
import { capDiff, untrackedDiff } from './task-service';
import type { TaskDiff } from '../shared/tasks';
import { SC_LIMITS, type ScDiscardPreview, type ScError, type ScErrorCode, type ScFile, type ScFileKind, type ScPushTarget, type ScResult, type ScStatus } from '../shared/source-control';

export const SC_WRITE_TIMEOUT_MS = 5 * 60_000;

const MESSAGES: Record<ScErrorCode, string> = {
  NOT_A_REPOSITORY: 'This folder isn’t in a Git repository.',
  GIT_NOT_FOUND: 'Git wasn’t found. Install Git for Windows (git.exe on PATH), or Git inside WSL for a repository stored there.',
  WSL_UNAVAILABLE: 'This repository is inside WSL, and that distribution’s Git can’t be used.',
  CHANGES_NOT_CHECKED: 'This repository’s Git settings name filter programs (for example Git LFS), so SplitNest doesn’t compare its files. Use Git in a terminal.',
  NOT_CHANGED: 'This file has no changes there any more.',
  STALE: 'The file changed since you were asked. Look at it again before discarding.',
  NOTHING_STAGED: 'Nothing is staged to commit.',
  INVALID_MESSAGE: 'Write a commit message (up to 1000 characters).',
  COMMIT_FAILED: 'Git couldn’t commit. Check that your Git name and email are set (git config user.name / user.email) and that no commit hook refused it.',
  NO_UPSTREAM: 'This branch has no upstream branch to pull from yet.',
  NO_REMOTE: 'This repository has no remote to push to. Add one in a terminal (git remote add origin <url>).',
  DETACHED: 'No branch is checked out (detached HEAD), so there is nothing to push or pull.',
  PUSH_FAILED: 'Git couldn’t push.',
  PULL_DIVERGED: 'Your branch and its upstream both have new commits, so a fast-forward isn’t possible. Merge or rebase in a terminal.',
  PULL_FAILED: 'Git couldn’t pull.',
  OPERATION_IN_PROGRESS: 'A merge, rebase, cherry-pick or revert is in progress. Finish or abort it in a terminal first.',
  TIMEOUT: 'Git didn’t finish in time.',
  GIT_FAILED: 'Git couldn’t complete the operation.',
};

const fail = (code: ScErrorCode, detail?: string): { ok: false; error: ScError } => ({ ok: false, error: { code, message: MESSAGES[code], ...(detail ? { detail } : {}) } });

/** The last lines of Git's error output, without credentials in URLs (`https://user:token@host`). */
export function gitDetail(stderr: string): string | undefined {
  const lines = stderr
    .replace(/(\w+:\/\/)[^/\s@]+@/g, '$1***@')
    .split(/\r?\n/)
    .map((l) => l.replace(/[\u0000-\u001f\u007f]/g, ' ').trimEnd())
    .filter((l) => l.trim() && !/^(remote: )?(Counting|Compressing|Writing|Enumerating|Total|Delta|Unpacking|Receiving|Resolving) /.test(l));
  const text = lines.slice(-6).join('\n').slice(0, 800);
  return text || undefined;
}

const failed = (r: GitResult | null, code: ScErrorCode = 'GIT_FAILED') =>
  r === null ? fail('GIT_NOT_FOUND') : r.timedOut ? fail('TIMEOUT') : fail(code, gitDetail(r.stderr));

const lit = (p: string) => `:(literal)${p}`;

function kindOf(letter: string): ScFileKind {
  switch (letter) {
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

export interface PorcelainV2 {
  branch: string | null;
  head: string | null;
  upstream: string | null;
  ahead: number;
  behind: number;
  unborn: boolean;
  staged: { path: string; oldPath?: string; kind: ScFileKind }[];
  unstaged: { path: string; kind: ScFileKind }[];
}

/** `git status --porcelain=v2 -z --branch --untracked-files=all` output. */
export function parsePorcelainV2(stdout: string): PorcelainV2 {
  const out: PorcelainV2 = { branch: null, head: null, upstream: null, ahead: 0, behind: 0, unborn: false, staged: [], unstaged: [] };
  const f = stdout.split('\0');
  for (let i = 0; i < f.length; i++) {
    const e = f[i]!;
    if (!e) continue;
    if (e.startsWith('# ')) {
      const [, key, ...rest] = e.split(' ');
      const value = rest.join(' ');
      if (key === 'branch.oid') {
        if (value === '(initial)') out.unborn = true;
        else out.head = value.slice(0, 7);
      } else if (key === 'branch.head') out.branch = value === '(detached)' ? null : value;
      else if (key === 'branch.upstream') out.upstream = value;
      else if (key === 'branch.ab') {
        const m = /^\+(\d+) -(\d+)$/.exec(value);
        if (m) {
          out.ahead = Number(m[1]);
          out.behind = Number(m[2]);
        }
      }
      continue;
    }
    const type = e[0];
    if (type === '?') {
      out.unstaged.push({ path: e.slice(2), kind: 'untracked' });
    } else if (type === '1' || type === '2') {
      // 1 XY sub mH mI mW hH hI path / 2 XY sub mH mI mW hH hI Xscore path (then origPath)
      const parts = e.split(' ');
      const xy = parts[1] ?? '..';
      const path = parts.slice(type === '1' ? 8 : 9).join(' ');
      const oldPath = type === '2' ? f[++i] : undefined;
      if (!path) continue;
      if (xy[0] !== '.') out.staged.push({ path, ...(oldPath ? { oldPath } : {}), kind: kindOf(xy[0]!) });
      if (xy[1] !== '.') out.unstaged.push({ path, kind: kindOf(xy[1]!) });
    } else if (type === 'u') {
      const path = e.split(' ').slice(10).join(' ');
      if (path) out.unstaged.push({ path, kind: 'conflicted' });
    }
  }
  return out;
}

export interface SourceControlDeps {
  git: GitRunner;
  wslGit?: (distro: string, host: string) => GitRunner;
}

export class SourceControlService {
  private readonly chains = new Map<string, Promise<unknown>>();
  private readonly wslRunners = new Map<string, GitRunner>();

  constructor(private readonly deps: SourceControlDeps) {}

  /** What changed in the repository of `root`, staged and not. Read-only. */
  async status(root: string): Promise<ScResult<{ status: ScStatus }>> {
    const top = await this.top(root);
    if (!top.ok) return top;
    return this.statusAt(top.git, top.top);
  }

  /** One file's changes: staged (index against HEAD) or not (working tree against the index). */
  async diff(root: string, file: unknown, staged: boolean): Promise<ScResult<{ diff: TaskDiff }>> {
    const s = await this.status(root);
    if (!s.ok) return s;
    const entry = (staged ? s.status.staged : s.status.unstaged).find((f) => f.path === file);
    if (!entry) return fail('NOT_CHANGED');
    if (entry.kind === 'untracked') return { ok: true, diff: await untrackedDiff(s.status.top, entry.path) };
    if (entry.binary) return { ok: true, diff: { text: '', binary: true, truncated: false } };
    const git = this.gitFor(root)!;
    const paths = entry.oldPath !== undefined ? [entry.oldPath, entry.path] : [entry.path];
    const r = await git.run(s.status.top, [
      '--no-optional-locks',
      'diff',
      ...(staged ? ['--cached', '-M'] : []),
      '-U3',
      '--no-color',
      '--no-ext-diff',
      '--no-textconv',
      '--ignore-submodules=all',
      '--',
      ...paths.map(lit),
    ]);
    if (r === null || (r.code !== 0 && !r.overflow)) return failed(r);
    return { ok: true, diff: capDiff(r.stdout, !!r.overflow) };
  }

  /** Stages these files (from the unstaged list), or everything with `all`. */
  async stage(root: string, paths: unknown): Promise<ScResult<{ status: ScStatus }>> {
    return this.write(root, async (git, s) => {
      if (paths === 'all') return git.run(s.top, ['add', '-A']);
      const files = this.pick(s.unstaged, paths);
      if (!files) return 'NOT_CHANGED';
      return git.run(s.top, ['add', '-A', '--', ...files.map((f) => lit(f.path))]);
    });
  }

  /** Unstages these files (from the staged list), or everything with `all`. Their changes stay in the folder. */
  async unstage(root: string, paths: unknown): Promise<ScResult<{ status: ScStatus }>> {
    return this.write(root, async (git, s) => {
      const files = paths === 'all' ? s.staged : this.pick(s.staged, paths);
      if (!files) return 'NOT_CHANGED';
      if (files.length === 0) return null;
      const specs = files.flatMap((f) => (f.oldPath !== undefined ? [f.oldPath, f.path] : [f.path])).map(lit);
      // No commit yet: there is no HEAD to reset to; taking them out of the index is the same.
      const r = await git.run(s.top, s.unborn ? ['rm', '--cached', '-q', '-r', '--', ...specs] : ['reset', '-q', 'HEAD', '--', ...specs]);
      // `reset` exits 1 when files stay modified in the folder ("Unstaged changes after reset").
      return r && r.code === 1 && !s.unborn ? { ...r, code: 0 } : r;
    });
  }

  /** What Discard will do to this file, and its confirmation key. Read-only. */
  async discardPreview(root: string, file: unknown): Promise<ScResult<{ preview: ScDiscardPreview }>> {
    const s = await this.status(root);
    if (!s.ok) return s;
    const entry = s.status.unstaged.find((f) => f.path === file);
    if (!entry || entry.kind === 'conflicted') return fail('NOT_CHANGED');
    const key = await this.discardKey(this.gitFor(root)!, s.status.top, entry);
    return { ok: true, preview: { path: entry.path, action: entry.kind === 'untracked' ? 'delete' : 'restore', key } };
  }

  /** Discards one file's unstaged changes (a new file is deleted), if it is as it was when confirmed. */
  async discard(root: string, file: unknown, confirmedKey: unknown): Promise<ScResult<{ status: ScStatus }>> {
    return this.write(root, async (git, s) => {
      const entry = s.unstaged.find((f) => f.path === file);
      if (!entry || entry.kind === 'conflicted') return 'NOT_CHANGED';
      if (typeof confirmedKey !== 'string' || confirmedKey !== (await this.discardKey(git, s.top, entry))) return 'STALE';
      return entry.kind === 'untracked' ? git.run(s.top, ['clean', '-f', '-q', '--', lit(entry.path)]) : git.run(s.top, ['checkout', '-q', '--', lit(entry.path)]);
    });
  }

  /** Commits what is staged (with `all`, stages everything first). Hooks run. */
  async commit(root: string, message: unknown, all: boolean): Promise<ScResult<{ commit: string; status: ScStatus }>> {
    if (typeof message !== 'string' || !message.trim() || message.length > SC_LIMITS.maxMessage) return fail('INVALID_MESSAGE');
    let commit = '';
    const r = await this.write(
      root,
      async (git, s) => {
        if (all) {
          const add = await git.run(s.top, ['add', '-A']);
          if (!add || add.code !== 0) return add;
        }
        const merging = s.operation === 'merge';
        const staged = await git.run(s.top, ['--no-optional-locks', 'diff', '--cached', '--quiet', '--ignore-submodules=all']);
        if (staged === null) return null;
        if (staged.code === 0 && !merging) return 'NOTHING_STAGED';
        const c = await git.run(s.top, ['commit', '-q', '-m', message], { timeoutMs: SC_WRITE_TIMEOUT_MS });
        if (c && c.code === 0) {
          const h = await git.run(s.top, ['rev-parse', '--short', 'HEAD']);
          commit = h?.stdout.trim() ?? '';
        }
        return c;
      },
      'COMMIT_FAILED',
    );
    return r.ok ? { ok: true, commit, status: r.status } : r;
  }

  /** Where a branch without an upstream would be pushed (asked before pushing and tracking it). */
  async pushTarget(root: string): Promise<ScResult<{ target: ScPushTarget }>> {
    const s = await this.status(root);
    if (!s.ok) return s;
    if (!s.status.branch) return fail('DETACHED');
    const remote = await this.defaultRemote(this.gitFor(root)!, s.status.top, s.status.branch);
    return remote ? { ok: true, target: { remote, branch: s.status.branch } } : fail('NO_REMOTE');
  }

  /**
   * Pushes the branch to its upstream. Without one, only with `setUpstream` naming the remote and
   * branch the user confirmed (checked again here): `push -u <remote> <branch>`. Never forced.
   */
  async push(root: string, setUpstream?: unknown): Promise<ScResult<{ status: ScStatus }>> {
    return this.write(
      root,
      async (git, s) => {
        if (!s.branch) return 'DETACHED';
        if (s.upstream) return git.run(s.top, ['push', '--quiet'], { timeoutMs: SC_WRITE_TIMEOUT_MS });
        const t = setUpstream as Partial<ScPushTarget> | undefined;
        if (!t || t.branch !== s.branch || t.remote !== (await this.defaultRemote(git, s.top, s.branch))) return 'NO_UPSTREAM';
        return git.run(s.top, ['push', '--quiet', '-u', '--', t.remote!, `refs/heads/${s.branch}:refs/heads/${s.branch}`], { timeoutMs: SC_WRITE_TIMEOUT_MS });
      },
      'PUSH_FAILED',
    );
  }

  /** Pulls from the upstream, fast-forward only: never creates a merge or rebases. */
  async pull(root: string): Promise<ScResult<{ status: ScStatus }>> {
    return this.write(
      root,
      async (git, s) => {
        if (!s.branch) return 'DETACHED';
        if (!s.upstream) return 'NO_UPSTREAM';
        if (s.operation) return 'OPERATION_IN_PROGRESS';
        const r = await git.run(s.top, ['pull', '--quiet', '--ff-only', '--no-rebase'], { timeoutMs: SC_WRITE_TIMEOUT_MS });
        if (r && r.code !== 0 && /not possible to fast-forward|diverg/i.test(r.stderr)) return 'PULL_DIVERGED';
        return r;
      },
      'PULL_FAILED',
    );
  }

  // ------------------------------------------------------------------ internals

  private async statusAt(git: GitRunner, top: string): Promise<ScResult<{ status: ScStatus }>> {
    const cfg = await git.run(top, ['--no-optional-locks', 'config', '--show-scope', '--includes', '--null', '--get-regexp', FILTER_KEYS]);
    if (cfg === null) return fail('GIT_NOT_FOUND');
    if (cfg.code !== 0 && cfg.code !== 1) return failed(cfg);
    if (cfg.code === 0 && repositoryFilterKeys(cfg.stdout).length > 0) return fail('CHANGES_NOT_CHECKED');
    const quiet = ['--no-optional-locks'];
    const numstat = ['diff', '-M', '-z', '--numstat', '--no-color', '--no-ext-diff', '--no-textconv', '--ignore-submodules=all'];
    const rs = await git.runMany(top, [
      [...quiet, 'status', '--porcelain=v2', '-z', '--branch', '--untracked-files=all', '--ignore-submodules=all'],
      [...quiet, ...numstat, '--cached'],
      [...quiet, ...numstat],
      [...quiet, 'rev-parse', '-q', '--verify', 'MERGE_HEAD'],
      [...quiet, 'rev-parse', '-q', '--verify', 'REBASE_HEAD'],
      [...quiet, 'rev-parse', '-q', '--verify', 'CHERRY_PICK_HEAD'],
      [...quiet, 'rev-parse', '-q', '--verify', 'REVERT_HEAD'],
    ]);
    if (rs === null) return fail('GIT_NOT_FOUND');
    const [st, cached, work, merge, rebase, pick, revert] = rs;
    if (!st || st.code !== 0) return failed(st ?? null);
    const p = parsePorcelainV2(st.stdout);
    const stagedCounts = cached?.code === 0 ? parseNumstat(cached.stdout) : new Map<string, { added: number | null; removed: number | null }>();
    const workCounts = work?.code === 0 ? parseNumstat(work.stdout) : new Map<string, { added: number | null; removed: number | null }>();
    let unlisted = 0;
    const list = (entries: { path: string; oldPath?: string; kind: ScFileKind }[], counts: Map<string, { added: number | null; removed: number | null }>): ScFile[] => {
      const files: ScFile[] = [];
      for (const e of entries) {
        if (!isSafeRelative(e.path) || (e.oldPath !== undefined && !isSafeRelative(e.oldPath))) {
          unlisted++;
          continue;
        }
        const c = counts.get(e.path);
        const counted = e.kind !== 'untracked' && e.kind !== 'conflicted';
        files.push({
          ...e,
          added: counted ? (c?.added ?? null) : null,
          removed: counted ? (c?.removed ?? null) : null,
          binary: counted && !!c && c.added === null && c.removed === null && e.kind !== 'deleted',
        });
      }
      return files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    };
    const staged = list(p.staged, stagedCounts);
    const unstaged = list(p.unstaged, workCounts);
    const operation = merge?.code === 0 ? 'merge' : rebase?.code === 0 ? 'rebase' : pick?.code === 0 ? 'cherry-pick' : revert?.code === 0 ? 'revert' : null;
    return {
      ok: true,
      status: {
        top,
        branch: p.branch,
        head: p.head,
        upstream: p.upstream,
        ahead: p.ahead,
        behind: p.behind,
        unborn: p.unborn,
        staged: staged.slice(0, SC_LIMITS.maxFiles),
        unstaged: unstaged.slice(0, SC_LIMITS.maxFiles),
        truncated: staged.length > SC_LIMITS.maxFiles || unstaged.length > SC_LIMITS.maxFiles || !!st.overflow,
        unlisted,
        operation,
      },
    };
  }

  /** The repository's top folder of `root` and the Git that works there. */
  private async top(root: string): Promise<ScResult<{ top: string; git: GitRunner }>> {
    const git = this.gitFor(root);
    if (!git) return fail('WSL_UNAVAILABLE');
    const r = await git.run(root, ['--no-optional-locks', 'rev-parse', '--show-toplevel']);
    if (r === null) return fail('GIT_NOT_FOUND');
    if (r.timedOut) return fail('TIMEOUT');
    const top = r.stdout.trim();
    if (r.code !== 0 || !top) return fail('NOT_A_REPOSITORY');
    return { ok: true, top: git.toWindows(top), git };
  }

  /** Files of `list` named in `paths` (all must be there), or null. */
  private pick(list: ScFile[], paths: unknown): ScFile[] | null {
    if (!Array.isArray(paths) || paths.length === 0 || paths.length > SC_LIMITS.maxPaths) return null;
    const files: ScFile[] = [];
    for (const p of paths) {
      const f = typeof p === 'string' ? list.find((x) => x.path === p) : undefined;
      if (!f) return null;
      files.push(f);
    }
    return files;
  }

  /** The file as it is now: its kind and the hash of its content (a file deleted from the folder: none). */
  private async discardKey(git: GitRunner, top: string, f: ScFile): Promise<string> {
    const h = f.kind === 'deleted' ? null : await git.run(top, ['--no-optional-locks', 'hash-object', '--no-filters', '--', f.path]);
    const id = h?.code === 0 ? h.stdout.trim() : 'none';
    return createHash('sha256').update(`${f.path}\0${f.kind}\0${id}`).digest('hex').slice(0, 32);
  }

  /** The remote a new branch is pushed to: its pushRemote, remote.pushDefault, `origin`, or the only remote. */
  private async defaultRemote(git: GitRunner, top: string, branch: string): Promise<string | null> {
    const [remotes, own, def] = await Promise.all([
      git.run(top, ['--no-optional-locks', 'remote']),
      git.run(top, ['--no-optional-locks', 'config', '--get', `branch.${branch}.pushRemote`]),
      git.run(top, ['--no-optional-locks', 'config', '--get', 'remote.pushDefault']),
    ]);
    const names = (remotes?.code === 0 ? remotes.stdout : '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
    for (const c of [own?.stdout.trim(), def?.stdout.trim(), 'origin']) if (c && names.includes(c)) return c;
    return names.length === 1 ? names[0]! : null;
  }

  /**
   * One change to the repository, one at a time per repository, and the status after it. `act`
   * returns Git's result, an error code, or null for "nothing to do".
   */
  private async write(
    root: string,
    act: (git: GitRunner, s: ScStatus) => Promise<GitResult | ScErrorCode | null>,
    otherwise: ScErrorCode = 'GIT_FAILED',
  ): Promise<ScResult<{ status: ScStatus }>> {
    const t = await this.top(root);
    if (!t.ok) return t;
    return this.serial(t.top, async () => {
      const before = await this.statusAt(t.git, t.top);
      if (!before.ok) return before;
      const r = await act(t.git, before.status);
      if (typeof r === 'string') return fail(r);
      if (r && (r.code !== 0 || r.timedOut)) return failed(r, otherwise);
      return this.statusAt(t.git, t.top);
    });
  }

  private serial<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const k = key.toLowerCase();
    const prev = this.chains.get(k) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    this.chains.set(
      k,
      next.catch(() => undefined),
    );
    return next;
  }

  private gitFor(folder: string): GitRunner | null {
    if (!isWslRoot(folder)) return this.deps.git;
    const loc = parseWslUnc(folder);
    if (!loc || !this.deps.wslGit) return null;
    const key = `${loc.host}|${loc.distro.toLowerCase()}`;
    let g = this.wslRunners.get(key);
    if (!g) this.wslRunners.set(key, (g = this.deps.wslGit(loc.distro, loc.host)));
    return g;
  }
}
