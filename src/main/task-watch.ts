// Watches the folder of the task whose Changes panel is on screen, so the panel follows an agent's
// edits while its terminal output never settles (a spinner keeps Git status's output trigger at its
// 30-second maximum). At most one folder is watched at a time, only while the page asks for it.
//
// - Windows folders only: changes inside a WSL folder aren't reported reliably through the
//   \\wsl.localhost share; WSL tasks rely on the usual triggers and the panel's Refresh.
// - Ignored: `.git` and everything Git ignores there (node_modules, build output…), as listed when
//   the watch starts and again after each change it reports.
// - Each burst of changes becomes one Git status check once nothing changed for QUIET_MS, and checks
//   from here are at least MIN_GAP_MS apart. The check then updates the summary as usual.
// - Nothing is read or logged: only which file name changed, to apply the ignore list.
import { watch as fsWatch, type FSWatcher } from 'node:fs';
import { isWslRoot } from './git-status';

export const QUIET_MS = 500;
export const MIN_GAP_MS = 3000;

export interface TaskWatchDeps {
  /** Something in the watched task's folder changed (debounced): check its Git status now. */
  changed(workspaceId: string): void;
  /** Entries Git ignores in the folder (`dir/` for a folder), relative and `/`-separated. */
  ignored(folder: string): Promise<string[]>;
  watch?: (folder: string, onChange: (file: string | null) => void) => { close(): void };
  now?: () => number;
}

const defaultWatch = (folder: string, onChange: (file: string | null) => void): { close(): void } => {
  const w: FSWatcher = fsWatch(folder, { recursive: true, persistent: false }, (_event, file) => onChange(typeof file === 'string' ? file : null));
  w.on('error', () => w.close());
  return w;
};

/** Whether a change to this relative path (either separator) can matter to Git's view of the task. */
export function relevant(file: string | null, ignored: readonly string[]): boolean {
  if (file === null) return true; // unknown file: better one check too many
  const p = file.replace(/\\/g, '/');
  if (p === '.git' || p.startsWith('.git/')) return false;
  const lower = p.toLowerCase();
  for (const i of ignored) {
    const l = i.toLowerCase();
    if (l.endsWith('/') ? lower.startsWith(l) || `${lower}/` === l : lower === l) return false;
  }
  return true;
}

export class TaskFolderWatcher {
  private current: { workspaceId: string; folder: string; handle: { close(): void } } | null = null;
  private ignored: string[] = [];
  private quiet: NodeJS.Timeout | null = null;
  private gap: NodeJS.Timeout | null = null;
  private lastFired = Number.NEGATIVE_INFINITY;
  private readonly now: () => number;

  constructor(private readonly deps: TaskWatchDeps) {
    this.now = deps.now ?? Date.now;
  }

  /** Watches this task's folder from now on (null: none). Asking again for the same one changes nothing. */
  set(target: { workspaceId: string; folder: string } | null): void {
    if (target && this.current && this.current.workspaceId === target.workspaceId && this.current.folder === target.folder) return;
    this.stop();
    if (!target || isWslRoot(target.folder)) return;
    const id = target.workspaceId;
    try {
      const handle = (this.deps.watch ?? defaultWatch)(target.folder, (file) => this.onChange(id, file));
      this.current = { workspaceId: id, folder: target.folder, handle };
    } catch {
      return; // can't be watched (folder gone): the other triggers remain
    }
    void this.refreshIgnored(target.folder);
  }

  /** Folders watched right now: 0 or 1 (tests). */
  get count(): number {
    return this.current ? 1 : 0;
  }

  dispose(): void {
    this.stop();
  }

  private stop(): void {
    this.current?.handle.close();
    this.current = null;
    this.ignored = [];
    if (this.quiet) clearTimeout(this.quiet);
    if (this.gap) clearTimeout(this.gap);
    this.quiet = this.gap = null;
  }

  private async refreshIgnored(folder: string): Promise<void> {
    const list = await this.deps.ignored(folder).catch(() => null);
    if (list && this.current?.folder === folder) this.ignored = list;
  }

  private onChange(workspaceId: string, file: string | null): void {
    if (this.current?.workspaceId !== workspaceId || !relevant(file, this.ignored)) return;
    if (this.quiet) clearTimeout(this.quiet);
    this.quiet = setTimeout(() => {
      this.quiet = null;
      this.fire(workspaceId);
    }, QUIET_MS);
  }

  private fire(workspaceId: string): void {
    if (this.current?.workspaceId !== workspaceId) return;
    const wait = this.lastFired + MIN_GAP_MS - this.now();
    if (wait > 0) {
      this.gap ??= setTimeout(() => {
        this.gap = null;
        this.fire(workspaceId);
      }, wait);
      return;
    }
    this.lastFired = this.now();
    this.deps.changed(workspaceId);
    void this.refreshIgnored(this.current.folder);
  }
}
