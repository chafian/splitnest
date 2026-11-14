// Git state of workspace folders for the sidebar: branch and changed lines.
//
// Read-only. Git runs with structured arguments (no shell), a timeout and an output cap, and:
//   --no-optional-locks       status does not refresh (write) the index
//   core.fsmonitor=false      no file-system monitor hook (a command a repository can configure)
//   --no-ext-diff/--no-textconv  no external diff or text-conversion programs
// One more kind of program can run: a clean filter (`filter.<name>.clean` or `.process`), which
// `git diff` (and `git status`, when file times are ambiguous) starts to compare a working-tree
// file that `.gitattributes` assigns to it; --no-textconv does not prevent that. A filter set
// in the repository's own configuration (its .git/config, files it includes, worktree config)
// could come with the repository from anywhere, so then only the branch is read (commands that do
// not look at files) and the tooltip says that changes were not checked. Filters the user set up
// globally or system-wide (e.g. Git LFS) are the user's choice and apply as in any Git tool.
// Submodules are not looked into (--ignore-submodules=all): Git would check each one with its own
// configuration, including filters it sets; their changes are therefore not counted.
// Git otherwise uses the user's own configuration, like any Git tool; it refuses repositories
// owned by another user unless the user allowed them (`safe.directory`), and that is not
// overridden. Nothing is logged: no paths, branch names or Git messages.
//
// When it runs (only while the setting is on):
//   - right away when the user looks at a workspace: selects it, comes back to the window, or
//     saves a file in it. Not twice within a second: a request inside that second schedules one
//     check for the moment it ends (further requests meanwhile join it);
//   - after terminal output in that workspace, once output has been quiet for a moment, at most
//     every few seconds; while output never stops (a development server), at most every 30 s;
//   - once for every workspace when the list is loaded or a workspace is added.
// One Git check runs at a time, for all workspaces together.
//
// Git looks for a repository in the folder and then upwards. It is not allowed to go up into the
// user's home folder or a drive root (GIT_CEILING_DIRECTORIES): a repository there (some users keep
// dotfiles in one) would otherwise be shown for every project folder below it that is not a
// repository itself, with its whole home folder scanned on each check. A workspace that is the
// home folder, or any repository inside it, works as usual.
//
// Workspaces whose folder is inside WSL (\\wsl$\..., \\wsl.localhost\...) are skipped in this
// version: Windows Git over that share is slow and usually refuses those repositories as owned by
// another user. A workspace on a Windows drive is checked whatever its terminals run, WSL included.
import type { GitStatus } from '../shared/types';
import type { Runner } from './exec';

/** Output quiet for this long: the command has probably finished (a branch switch, a commit). */
export const OUTPUT_QUIET_MS = 800;
/** Checks caused by output are at least this far apart. */
export const OUTPUT_MIN_GAP_MS = 3000;
/** Output that never goes quiet (a development server's log) causes a check at most this often. */
export const OUTPUT_BUSY_MAX_MS = 30_000;
/** Requests (select, window focus, save) within this time after a check are not repeated. */
export const REQUEST_MIN_GAP_MS = 1000;
const STATUS_TIMEOUT_MS = 10_000;
const DIFF_TIMEOUT_MS = 15_000;

/** An object id: 40 hex digits (SHA-1 repositories) or 64 (SHA-256). */
const OBJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

/** Folders inside WSL, reached from Windows through its file share. */
export function isWslRoot(rootPath: string): boolean {
  return /^[\\/]{2}(wsl\$|wsl\.localhost)([\\/]|$)/i.test(rootPath);
}

/** `git status --porcelain=v2 --branch -z` output, or null when it is not that format. */
export function parseStatus(stdout: string): Omit<GitStatus, 'added' | 'removed'> | null {
  const s: Omit<GitStatus, 'added' | 'removed'> = { branch: null, detached: null, initial: false, upstream: null, ahead: 0, behind: 0, changedFiles: 0, untracked: 0, changesNotChecked: false };
  let oid: string | null = null;
  let head: string | null = null;
  const fields = stdout.split('\0');
  for (let i = 0; i < fields.length; i++) {
    const f = fields[i]!;
    if (f.startsWith('# branch.oid ')) oid = f.slice(13);
    else if (f.startsWith('# branch.head ')) head = f.slice(14);
    else if (f.startsWith('# branch.upstream ')) s.upstream = f.slice(18);
    else if (f.startsWith('# branch.ab ')) {
      const m = /^\+(\d+) -(\d+)$/.exec(f.slice(12));
      if (m) {
        s.ahead = Number(m[1]);
        s.behind = Number(m[2]);
      }
    } else if (f.startsWith('1 ') || f.startsWith('u ')) s.changedFiles++;
    else if (f.startsWith('2 ')) {
      // Renamed or copied: the original path follows as its own field.
      s.changedFiles++;
      i++;
    } else if (f.startsWith('? ')) s.untracked++;
  }
  if (oid === null || head === null) return null;
  s.initial = oid === '(initial)';
  if (head === '(detached)') s.detached = oid.slice(0, 7);
  else s.branch = head;
  return s;
}

/** `git diff --shortstat` output (English: Git runs with LC_ALL=C), as line totals. */
export function parseShortstat(stdout: string): { added: number; removed: number } {
  const added = /(\d+) insertions?\(\+\)/.exec(stdout);
  const removed = /(\d+) deletions?\(-\)/.exec(stdout);
  return { added: added ? Number(added[1]) : 0, removed: removed ? Number(removed[1]) : 0 };
}

/** Variables that would point Git somewhere else than the workspace folder; never passed on. */
const REDIRECTING = ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_NAMESPACE', 'GIT_COMMON_DIR', 'GIT_EXTERNAL_DIFF', 'GIT_PAGER'];

export function gitEnv(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(base)) if (!REDIRECTING.includes(k.toUpperCase())) env[k] = v;
  // English output (parsed), no prompts, no optional locks.
  env.LC_ALL = 'C';
  env.LANGUAGE = 'C';
  env.GIT_TERMINAL_PROMPT = '0';
  env.GIT_OPTIONAL_LOCKS = '0';
  return env;
}

/**
 * `env` with the user's home folder and the drive root of `root` added to GIT_CEILING_DIRECTORIES
 * (directories Git does not go up into while looking for a repository).
 */
export function withCeiling(env: NodeJS.ProcessEnv, root: string, home: string): NodeJS.ProcessEnv {
  const key = Object.keys(env).find((k) => k.toUpperCase() === 'GIT_CEILING_DIRECTORIES') ?? 'GIT_CEILING_DIRECTORIES';
  const drive = /^[A-Za-z]:/.test(root) ? `${root.slice(0, 2)}\\` : null;
  const dirs = [env[key], home, drive].filter((d): d is string => !!d && d.length > 0);
  return { ...env, [key]: dirs.join(';') };
}

/** Filter programs Git would start during `git status`. */
export const FILTER_KEYS = '^filter\\..*\\.(clean|process)$';

/**
 * From `git config --show-scope --includes --null --get-regexp`: the filter keys set by the
 * repository itself (scope local or worktree; included files report the scope that includes them).
 */
export function repositoryFilterKeys(stdout: string): string[] {
  const f = stdout.split('\0');
  const keys: string[] = [];
  for (let i = 0; i + 1 < f.length; i += 2) {
    const scope = f[i]!;
    const key = f[i + 1]!.split('\n')[0]!;
    if (scope === 'local' || scope === 'worktree') keys.push(key);
  }
  return keys;
}

/** Reads the Git state of `root`, or null when it is not in a repository (or Git refuses it). */
export async function readGitStatus(run: Runner, git: string, root: string, env: NodeJS.ProcessEnv): Promise<GitStatus | null> {
  const common = ['--no-optional-locks', '-c', 'core.fsmonitor=false', '-c', 'core.quotepath=off', '-C', root];
  // Filter programs from the repository's own configuration: exit 0 = some, 1 = none.
  const cfg = await run(git, [...common, 'config', '--show-scope', '--includes', '--null', '--get-regexp', FILTER_KEYS], { timeoutMs: STATUS_TIMEOUT_MS, env });
  if (cfg.code !== 0 && cfg.code !== 1) return null; // not a repository, refused, or Git failed
  if (cfg.code === 0 && repositoryFilterKeys(cfg.stdout.toString('utf8')).length > 0) return branchOnly(run, git, common, env);
  // Submodules are not looked into: Git would check them with their own configuration (and its
  // filters), which the check above does not cover. Their changes are not counted.
  const status = await run(git, [...common, 'status', '--porcelain=v2', '--branch', '--untracked-files=normal', '--ignore-submodules=all', '-z'], { timeoutMs: STATUS_TIMEOUT_MS, env });
  if (status.code !== 0) return null;
  const parsed = parseStatus(status.stdout.toString('utf8'));
  if (!parsed) return null;
  if (parsed.changedFiles === 0) return { ...parsed, added: 0, removed: 0 };
  const diff = ['diff', '--shortstat', '--no-ext-diff', '--no-textconv', '--no-color', '--ignore-submodules=all'];
  // The working copy of tracked files against the last commit, staged and unstaged changes
  // together: one diff, so a line staged and then changed again counts once. Before the first
  // commit the base is the empty tree (a staged file deleted again counts nothing). Untracked
  // files are not part of either diff.
  let base = 'HEAD';
  if (parsed.initial) {
    // The empty tree's id depends on the repository's object format (SHA-1 or SHA-256): Git
    // computes it from empty input (`hash-object` without -w writes nothing).
    const tree = await run(git, [...common, 'hash-object', '-t', 'tree', '--stdin'], { timeoutMs: STATUS_TIMEOUT_MS, env, input: '' });
    const id = tree.stdout.toString('utf8').trim();
    if (tree.code !== 0 || !OBJECT_ID.test(id)) return { ...parsed, added: null, removed: null };
    base = id;
  }
  const runs = [[...common, ...diff, base]];
  let added = 0;
  let removed = 0;
  for (const args of runs) {
    const r = await run(git, args, { timeoutMs: DIFF_TIMEOUT_MS, env });
    if (r.code !== 0) return { ...parsed, added: null, removed: null };
    const t = parseShortstat(r.stdout.toString('utf8'));
    added += t.added;
    removed += t.removed;
  }
  return { ...parsed, added, removed };
}

/** The branch without looking at any file (no filters can run): for repositories that set their own. */
async function branchOnly(run: Runner, git: string, common: string[], env: NodeJS.ProcessEnv): Promise<GitStatus | null> {
  const s: GitStatus = { branch: null, detached: null, initial: false, upstream: null, ahead: 0, behind: 0, changedFiles: 0, untracked: 0, changesNotChecked: true, added: null, removed: null };
  const sym = await run(git, [...common, 'symbolic-ref', '--quiet', '--short', 'HEAD'], { timeoutMs: STATUS_TIMEOUT_MS, env });
  if (sym.code === 0) {
    s.branch = sym.stdout.toString('utf8').trim();
    const head = await run(git, [...common, 'rev-parse', '--verify', '--quiet', 'HEAD'], { timeoutMs: STATUS_TIMEOUT_MS, env });
    s.initial = head.code !== 0;
    return s;
  }
  const head = await run(git, [...common, 'rev-parse', '--short=7', 'HEAD'], { timeoutMs: STATUS_TIMEOUT_MS, env });
  if (head.code !== 0) return null;
  s.detached = head.stdout.toString('utf8').trim();
  return s;
}

const same = (a: GitStatus | null, b: GitStatus | null) => JSON.stringify(a) === JSON.stringify(b);

export interface GitStatusDeps {
  run: Runner;
  /** Path of git.exe, or null when Git is not installed (looked up once). */
  findGit(): Promise<string | null>;
  /** The workspaces as main has them (roots are main's own, never taken from the page). */
  workspaces(): { id: string; rootPath: string }[];
  enabled(): boolean;
  /** A workspace's state changed (null: not shown). */
  publish(workspaceId: string, status: GitStatus | null): void;
  /** A check of this workspace just finished (also for WSL folders, whose status isn't read here). */
  afterCheck?(workspaceId: string): void;
  env?: NodeJS.ProcessEnv;
  /** The user's home folder: Git does not look for a repository there from folders below it. */
  home?: string;
  now?: () => number;
}

interface Entry {
  status: GitStatus | null;
  /** When the last check started (0: never). */
  lastRunAt: number;
  running: boolean;
  /** Asked again (select, focus, save) while a check was running: request() once it ends. */
  again: boolean;
  /** A request arrived within a second of the last check: one more check when the second ends. */
  followUp: NodeJS.Timeout | null;
  /** Terminal output since the last check that has not been handled yet. */
  outputAt: number;
  burstStart: number;
  outputTimer: NodeJS.Timeout | null;
}

export class GitStatusService {
  private readonly entries = new Map<string, Entry>();
  private readonly queue: string[] = [];
  private busy = false;
  private git: Promise<string | null> | null = null;
  private disposed = false;
  private readonly now: () => number;
  private readonly env: NodeJS.ProcessEnv;
  private readonly home: string;
  /** Checks run so far (tests and diagnostics). */
  runs = 0;

  constructor(private readonly deps: GitStatusDeps) {
    this.now = deps.now ?? Date.now;
    this.env = gitEnv(deps.env ?? process.env);
    this.home = deps.home ?? '';
  }

  /** The state of every workspace checked so far. */
  statuses(): Record<string, GitStatus> {
    const out: Record<string, GitStatus> = {};
    for (const [id, e] of this.entries) if (e.status) out[id] = e.status;
    return out;
  }

  /**
   * The workspace list or the setting changed (state loaded or saved): forget removed workspaces,
   * check new ones, clear everything when the setting is off.
   */
  sync(): void {
    if (this.disposed) return;
    const list = this.deps.workspaces();
    const ids = new Set(list.map((w) => w.id));
    for (const id of [...this.entries.keys()]) if (!ids.has(id)) this.forget(id);
    if (!this.deps.enabled()) {
      for (const id of [...this.entries.keys()]) {
        const had = this.entries.get(id)!.status;
        this.forget(id);
        if (had) this.deps.publish(id, null);
      }
      return;
    }
    for (const w of list) if (!this.entries.has(w.id)) this.enqueue(w.id);
  }

  /**
   * The user is looking at this workspace, or saved a file in it: check now. Within a second of
   * the last check, one check is scheduled for the moment that second ends instead (requests in
   * between join it), so a save right after a check is still seen.
   */
  request(workspaceId: string): void {
    if (this.disposed || !this.deps.enabled() || !this.root(workspaceId)) return;
    const e = this.entry(workspaceId);
    if (e.running) {
      e.again = true;
      return;
    }
    const wait = e.lastRunAt > 0 ? e.lastRunAt + REQUEST_MIN_GAP_MS - this.now() : 0;
    if (wait > 0) {
      e.followUp ??= setTimeout(() => {
        e.followUp = null;
        if (!this.disposed && this.entries.get(workspaceId) === e) this.request(workspaceId);
      }, wait);
      return;
    }
    this.enqueue(workspaceId);
  }

  /** Terminal output in this workspace (called for every chunk: only notes the time). */
  noteOutput(workspaceId: string): void {
    if (this.disposed || !this.deps.enabled()) return;
    const e = this.entry(workspaceId);
    const now = this.now();
    e.outputAt = now;
    if (e.outputTimer) return;
    e.burstStart = now;
    this.armOutputTimer(workspaceId, e, OUTPUT_QUIET_MS);
  }

  dispose(): void {
    this.disposed = true;
    for (const e of this.entries.values()) {
      if (e.outputTimer) clearTimeout(e.outputTimer);
      if (e.followUp) clearTimeout(e.followUp);
    }
    this.entries.clear();
    this.queue.length = 0;
  }

  // ------------------------------------------------------------------ internals

  private armOutputTimer(id: string, e: Entry, delay: number): void {
    e.outputTimer = setTimeout(() => {
      e.outputTimer = null;
      if (this.disposed || this.entries.get(id) !== e) return;
      const now = this.now();
      const quietFor = now - e.outputAt;
      const busyFor = now - e.burstStart;
      if (quietFor < OUTPUT_QUIET_MS && busyFor < OUTPUT_BUSY_MAX_MS) {
        // Still printing: wait for a pause, but not longer than the busy limit.
        this.armOutputTimer(id, e, Math.min(OUTPUT_QUIET_MS - quietFor, OUTPUT_BUSY_MAX_MS - busyFor));
        return;
      }
      const gap = e.lastRunAt + OUTPUT_MIN_GAP_MS - now;
      if (gap > 0) {
        this.armOutputTimer(id, e, gap);
        return;
      }
      if (e.running) {
        // A check is running: look again later (the gap then counts from its start).
        this.armOutputTimer(id, e, OUTPUT_MIN_GAP_MS);
        return;
      }
      // Output that goes on after this check starts a new round (and its own busy limit).
      e.burstStart = now;
      this.enqueue(id);
      if (now - e.outputAt < OUTPUT_QUIET_MS) this.armOutputTimer(id, e, OUTPUT_QUIET_MS);
    }, Math.max(0, delay));
  }

  private entry(id: string): Entry {
    let e = this.entries.get(id);
    if (!e) {
      e = { status: null, lastRunAt: 0, running: false, again: false, followUp: null, outputAt: 0, burstStart: 0, outputTimer: null };
      this.entries.set(id, e);
    }
    return e;
  }

  private forget(id: string): void {
    const e = this.entries.get(id);
    if (e?.outputTimer) clearTimeout(e.outputTimer);
    if (e?.followUp) clearTimeout(e.followUp);
    this.entries.delete(id);
    const i = this.queue.indexOf(id);
    if (i >= 0) this.queue.splice(i, 1);
  }

  private root(id: string): string | null {
    return this.deps.workspaces().find((w) => w.id === id)?.rootPath ?? null;
  }

  private enqueue(id: string): void {
    this.entry(id);
    if (!this.queue.includes(id)) this.queue.push(id);
    void this.pump();
  }

  private async pump(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      while (this.queue.length > 0 && !this.disposed) {
        const id = this.queue.shift()!;
        const e = this.entries.get(id);
        const root = this.root(id);
        if (!e || !root || !this.deps.enabled()) continue;
        e.running = true;
        e.again = false;
        e.lastRunAt = this.now();
        // This check starts after every request so far: a follow-up waiting for it is not needed.
        if (e.followUp) {
          clearTimeout(e.followUp);
          e.followUp = null;
        }
        let status: GitStatus | null = null;
        if (!isWslRoot(root)) {
          this.git ??= this.deps.findGit().catch(() => null);
          const git = await this.git;
          if (git) {
            this.runs++;
            status = await readGitStatus(this.deps.run, git, root, withCeiling(this.env, root, this.home)).catch(() => null);
          }
        }
        e.running = false;
        // The workspace may have been removed or the setting turned off meanwhile.
        if (this.disposed || this.entries.get(id) !== e || !this.deps.enabled()) continue;
        if (!same(e.status, status)) {
          e.status = status;
          this.deps.publish(id, status);
        }
        this.deps.afterCheck?.(id);
        if (e.again) {
          // Asked again while this check ran (a save): through request(), so the one-second limit
          // counts from the start of this check (one follow-up for all such requests).
          e.again = false;
          this.request(id);
        }
      }
    } finally {
      this.busy = false;
    }
  }
}
