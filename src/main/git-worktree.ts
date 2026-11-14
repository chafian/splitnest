// Pure helpers for agent tasks: names, folders and Git's worktree output. Nothing here runs Git
// or touches the disk (see task-service.ts).
import path from 'node:path';
import { TASK_BRANCH_PREFIX, TASK_LIMITS } from '../shared/tasks';

const win = path.win32;

/** Device names Windows reserves in every folder (`con`, `nul`, `com1`…), with or without an extension. */
const RESERVED = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])$/i;

/**
 * The folder and branch part of a task name: lowercase ASCII letters, digits and single hyphens,
 * at most 40 characters ("Fix the login form!" → "fix-the-login-form"). Accents are dropped
 * (é → e); a name with nothing usable becomes null.
 */
export function taskSlug(name: string): string | null {
  const ascii = name
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
  let slug = ascii.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  if (slug.length > TASK_LIMITS.maxSlugLength) slug = slug.slice(0, TASK_LIMITS.maxSlugLength).replace(/-+$/, '');
  if (!slug) return null;
  return RESERVED.test(slug) ? `${slug}-task` : slug;
}

/** `fix-login` with suffix 1 → `fix-login`; with 2 → `fix-login-2`. */
export function suffixed(slug: string, n: number): string {
  return n <= 1 ? slug : `${slug}-${n}`;
}

export const taskBranch = (name: string): string => `${TASK_BRANCH_PREFIX}${name}`;

/**
 * Where a repository's task folders go: next to its main worktree, `C:\code\app` →
 * `C:\code\app.worktrees`. Null for a repository at a drive or share root (no folder next to it).
 */
export function worktreesDir(repoRoot: string): string | null {
  const root = trimSeparators(win.normalize(repoRoot));
  const parsed = win.parse(root);
  if (!parsed.base || trimSeparators(parsed.root) === root) return null;
  return win.join(parsed.dir, `${parsed.base}.worktrees`);
}

/** A path as Git for Windows prints it (`C:/a/b`, `//server/share/x`) in Windows form. */
export function fromGitPath(p: string): string {
  return trimSeparators(win.normalize(p.replace(/\//g, '\\')));
}

function trimSeparators(p: string): string {
  // Keep `C:\` and `\\server\share\` roots as they are.
  const { root } = win.parse(p);
  let out = p;
  while (out.length > root.length && /[\\/]$/.test(out)) out = out.slice(0, -1);
  return out;
}

/** Same folder on Windows: separators, trailing separators and letter case don't matter. */
export function samePath(a: string, b: string): boolean {
  return fromGitPath(a).toLowerCase() === fromGitPath(b).toLowerCase();
}

/** `child` is strictly inside `parent` (Windows paths). */
export function isStrictlyInside(child: string, parent: string): boolean {
  const c = fromGitPath(child).toLowerCase();
  const p = fromGitPath(parent).toLowerCase();
  const prefix = p.endsWith('\\') ? p : `${p}\\`;
  return c.length > prefix.length && c.startsWith(prefix);
}

export interface WorktreeEntry {
  /** Windows form. */
  path: string;
  head: string | null;
  /** Short branch name (`main`, `splitnest/fix`), or null when detached or bare. */
  branch: string | null;
  bare: boolean;
  detached: boolean;
  locked: boolean;
  /** Git would prune it: its folder is gone. */
  prunable: boolean;
}

/**
 * `git worktree list --porcelain` output. With `-z` (Git 2.36+) fields end with NUL and records
 * with an empty field; without it, lines and blank lines. The first entry is the main worktree.
 */
export function parseWorktreeList(stdout: string, nul: boolean, toWindows: (p: string) => string = fromGitPath): WorktreeEntry[] {
  const fields = stdout.split(nul ? '\0' : /\r?\n/);
  const out: WorktreeEntry[] = [];
  let cur: WorktreeEntry | null = null;
  for (const f of fields) {
    if (f === '') {
      if (cur) out.push(cur);
      cur = null;
      continue;
    }
    const space = f.indexOf(' ');
    const key = space < 0 ? f : f.slice(0, space);
    const value = space < 0 ? '' : f.slice(space + 1);
    if (key === 'worktree') {
      if (cur) out.push(cur);
      cur = { path: toWindows(value), head: null, branch: null, bare: false, detached: false, locked: false, prunable: false };
      continue;
    }
    if (!cur) continue;
    if (key === 'HEAD') cur.head = value;
    else if (key === 'branch') cur.branch = value.startsWith('refs/heads/') ? value.slice(11) : value;
    else if (key === 'bare') cur.bare = true;
    else if (key === 'detached') cur.detached = true;
    else if (key === 'locked') cur.locked = true;
    else if (key === 'prunable') cur.prunable = true;
  }
  if (cur) out.push(cur);
  return out;
}

/** `git version 2.39.0.windows.2` → [2, 39, 0]. */
export function parseGitVersion(text: string): [number, number, number] | null {
  const m = /git version (\d+)\.(\d+)(?:\.(\d+))?/.exec(text);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3] ?? 0)] : null;
}

export function versionAtLeast(v: readonly number[] | null, min: readonly number[]): boolean {
  if (!v) return false;
  for (let i = 0; i < min.length; i++) {
    const a = v[i] ?? 0;
    const b = min[i] ?? 0;
    if (a !== b) return a > b;
  }
  return true;
}

/** Why `git worktree remove` refused (Git runs with LC_ALL=C, so its messages are English). */
export function removeRefusal(stderr: string): 'dirty' | 'locked' | null {
  if (/contains modified or untracked files/i.test(stderr)) return 'dirty';
  if (/locked working tree/i.test(stderr)) return 'locked';
  return null;
}

/** `git rev-list --left-right --count A...B` → [only in A, only in B]. */
export function parseLeftRight(stdout: string): [number, number] | null {
  const m = /^(\d+)\s+(\d+)\s*$/.exec(stdout.trim());
  return m ? [Number(m[1]), Number(m[2])] : null;
}

// ------------------------------------------------------------------ review

export interface NameStatus {
  /** First letter of Git's status (A, M, D, R, C, T, U…). */
  status: string;
  path: string;
  oldPath?: string;
}

/** `git diff --name-status -z` output (renames and copies carry two paths). */
export function parseNameStatus(stdout: string): NameStatus[] {
  const f = stdout.split('\0');
  const out: NameStatus[] = [];
  for (let i = 0; i < f.length; ) {
    const s = f[i++];
    if (!s) continue;
    const status = s[0]!;
    if (status === 'R' || status === 'C') {
      const oldPath = f[i++];
      const path = f[i++];
      if (oldPath !== undefined && path) out.push({ status, path, oldPath });
    } else {
      const path = f[i++];
      if (path) out.push({ status, path });
    }
  }
  return out;
}

/** `git diff --numstat -z` output: lines added/removed per path (null for binary files). */
export function parseNumstat(stdout: string): Map<string, { added: number | null; removed: number | null }> {
  const f = stdout.split('\0');
  const out = new Map<string, { added: number | null; removed: number | null }>();
  for (let i = 0; i < f.length; ) {
    const s = f[i++];
    if (!s) continue;
    const m = /^(-|\d+)\t(-|\d+)\t(.*)$/s.exec(s);
    if (!m) continue;
    const added = m[1] === '-' ? null : Number(m[1]);
    const removed = m[2] === '-' ? null : Number(m[2]);
    // A rename or copy: the path field is empty and the old and new paths follow.
    let path = m[3]!;
    if (path === '') {
      i++; // old path
      path = f[i++] ?? '';
    }
    if (path) out.set(path, { added, removed });
  }
  return out;
}

/** NUL-separated paths (`--name-only -z`, `ls-files -z`). */
export const parsePaths = (stdout: string): string[] => stdout.split('\0').filter((p) => p.length > 0);

/** A path from Git's own listing that is safe to pass back as a literal pathspec and to join to the folder. */
export function isSafeRelative(p: string): boolean {
  if (!p || p.length > 4096 || p.startsWith('/') || /^[A-Za-z]:/.test(p) || p.includes('\\') || p.includes('\0') || p.includes(':')) return false;
  return p.split('/').every((part) => part !== '' && part !== '.' && part !== '..');
}

// ------------------------------------------------------------------ WSL

/** A folder inside a WSL distribution, as Windows reaches it (`\\wsl.localhost\Ubuntu\home\me\app`). */
export interface WslLocation {
  /** `wsl.localhost` or `wsl$`, as the path was written. */
  host: string;
  distro: string;
  /** The Linux path (`/home/me/app`). */
  linuxPath: string;
}

/** `\\wsl.localhost\<distro>\…` or `\\wsl$\<distro>\…`, else null. No `..`, no odd characters. */
export function parseWslUnc(p: string): WslLocation | null {
  const m = /^[\\/]{2}(wsl\$|wsl\.localhost)[\\/]([A-Za-z0-9._-]+)([\\/].*)?$/i.exec(p);
  if (!m) return null;
  const rest = (m[3] ?? '').replace(/\\/g, '/').replace(/\/+$/, '');
  const linuxPath = rest === '' ? '/' : rest;
  if (linuxPath.split('/').some((part) => part === '..' || part === '.') || /[\0\r\n]/.test(linuxPath)) return null;
  return { host: m[1]!.toLowerCase() === 'wsl$' ? 'wsl$' : 'wsl.localhost', distro: m[2]!, linuxPath };
}

/** A Linux path of that distribution as Windows reaches it. */
export function wslUnc(host: string, distro: string, linuxPath: string): string {
  const rest = linuxPath.replace(/\/+$/, '').replace(/\//g, '\\');
  return `\\\\${host}\\${distro}${rest || '\\'}`;
}

/** `git status --porcelain=v2 -z`: how many tracked entries changed, and the untracked entries (a new folder ends with `/`). */
export function parseStatusEntries(stdout: string): { tracked: number; untracked: string[] } {
  const f = stdout.split('\0');
  let tracked = 0;
  const untracked: string[] = [];
  for (let i = 0; i < f.length; i++) {
    const e = f[i]!;
    if (e.startsWith('1 ') || e.startsWith('u ')) tracked++;
    else if (e.startsWith('2 ')) {
      tracked++;
      i++; // the original path of a rename or copy
    } else if (e.startsWith('? ')) untracked.push(e.slice(2));
  }
  return { tracked, untracked };
}
