// Watches files that are open in the editor, so changes made by anything,
// including commands run in SplitNest's own terminals, are noticed while the
// window stays focused.
//
// Each open file's parent directory is watched (not the file itself): a
// directory watch keeps working through atomic replacement (write a temp file,
// rename it over the original) and delete + re-create, where a per-file watch
// would silently stop. Events are only hints; the renderer re-reads the file's
// content hash to decide whether anything changed, which also filters out
// SplitNest's own saves.
import { watch as fsWatch, type FSWatcher } from 'node:fs';
import path from 'node:path';

export interface WatchTarget {
  /** Renderer that asked (webContents id); its watches end with it. */
  ownerId: number;
  workspaceId: string;
  /** Workspace-relative path, `/`-separated (as the renderer knows it). */
  relativePath: string;
  /** Absolute path, already resolved inside the workspace root. */
  absolutePath: string;
}

type WatchFn = (dir: string, listener: (event: string, filename: string | Buffer | null) => void) => FSWatcher;

interface DirWatch {
  watcher: FSWatcher;
  /** lower-case file name -> subscriptions */
  files: Map<string, Map<string, WatchTarget>>;
}

export interface FileWatchOptions {
  /** Coalesce bursts (editors and tools often write in several steps). */
  debounceMs?: number;
  /** Upper bound on watched files across all owners. */
  maxFiles?: number;
  watchImpl?: WatchFn;
  onError?(message: string): void;
}

const keyOf = (t: Pick<WatchTarget, 'ownerId' | 'workspaceId' | 'relativePath'>) => `${t.ownerId}\u0000${t.workspaceId}\u0000${t.relativePath.toLowerCase()}`;

export class OpenFileWatcher {
  private readonly dirs = new Map<string, DirWatch>();
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly debounceMs: number;
  private readonly maxFiles: number;
  private readonly watchImpl: WatchFn;
  private count = 0;

  constructor(
    private readonly notify: (target: WatchTarget) => void,
    private readonly options: FileWatchOptions = {},
  ) {
    this.debounceMs = options.debounceMs ?? 150;
    this.maxFiles = options.maxFiles ?? 256;
    this.watchImpl = options.watchImpl ?? ((dir, listener) => fsWatch(dir, { persistent: false }, listener));
  }

  get size(): number {
    return this.count;
  }

  /** Starts watching; returns false when the limit is reached or the folder can't be watched. */
  watch(target: WatchTarget): boolean {
    const dir = path.win32.dirname(target.absolutePath).toLowerCase();
    const name = path.win32.basename(target.absolutePath).toLowerCase();
    let entry = this.dirs.get(dir);
    if (entry?.files.get(name)?.has(keyOf(target))) return true;
    if (this.count >= this.maxFiles) return false;
    if (!entry) {
      let watcher: FSWatcher;
      try {
        watcher = this.watchImpl(path.win32.dirname(target.absolutePath), (_event, filename) => this.onEvent(dir, filename));
      } catch (error) {
        this.options.onError?.(`file watch failed: ${(error as NodeJS.ErrnoException).code ?? 'error'}`);
        return false;
      }
      // The folder itself went away (or access was lost): tell every subscriber once, then stop.
      watcher.on('error', () => this.dropDir(dir, true));
      entry = { watcher, files: new Map() };
      this.dirs.set(dir, entry);
    }
    const subs = entry.files.get(name) ?? new Map<string, WatchTarget>();
    subs.set(keyOf(target), target);
    entry.files.set(name, subs);
    this.count++;
    return true;
  }

  unwatch(target: Pick<WatchTarget, 'ownerId' | 'workspaceId' | 'relativePath' | 'absolutePath'>): void {
    const dir = path.win32.dirname(target.absolutePath).toLowerCase();
    const name = path.win32.basename(target.absolutePath).toLowerCase();
    const entry = this.dirs.get(dir);
    const subs = entry?.files.get(name);
    if (!entry || !subs?.delete(keyOf(target))) return;
    this.count--;
    this.clearTimer(keyOf(target));
    if (subs.size === 0) entry.files.delete(name);
    if (entry.files.size === 0) this.dropDir(dir, false);
  }

  /** Ends every watch of one renderer (page reload, window closed). */
  unwatchOwner(ownerId: number): void {
    for (const entry of [...this.dirs.values()]) {
      for (const subs of [...entry.files.values()]) {
        for (const t of [...subs.values()]) if (t.ownerId === ownerId) this.unwatch(t);
      }
    }
  }

  dispose(): void {
    for (const dir of [...this.dirs.keys()]) this.dropDir(dir, false);
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
  }

  private onEvent(dir: string, filename: string | Buffer | null): void {
    const entry = this.dirs.get(dir);
    if (!entry) return;
    const name = filename == null ? null : String(filename).toLowerCase();
    // Without a file name (possible on some file systems) every file in the folder may have changed.
    const affected = name === null ? [...entry.files.values()] : [entry.files.get(name)].filter((s): s is Map<string, WatchTarget> => !!s);
    for (const subs of affected) for (const t of subs.values()) this.schedule(t);
  }

  private schedule(target: WatchTarget): void {
    const key = keyOf(target);
    this.clearTimer(key);
    this.timers.set(
      key,
      setTimeout(() => {
        this.timers.delete(key);
        this.notify(target);
      }, this.debounceMs),
    );
  }

  private clearTimer(key: string): void {
    const t = this.timers.get(key);
    if (t) clearTimeout(t);
    this.timers.delete(key);
  }

  private dropDir(dir: string, notifyAll: boolean): void {
    const entry = this.dirs.get(dir);
    if (!entry) return;
    this.dirs.delete(dir);
    try {
      entry.watcher.close();
    } catch {
      // already closed
    }
    for (const subs of entry.files.values()) {
      for (const t of subs.values()) {
        this.count--;
        this.clearTimer(keyOf(t));
        if (notifyAll) this.notify(t);
      }
    }
  }
}
