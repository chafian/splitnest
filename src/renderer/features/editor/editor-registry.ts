// Keeps editor controllers alive independently of React (like terminals) and
// reports how many have unsaved changes, so quitting can warn about them.
import { api } from '../../api';
import { flushSave } from '../workspaces/persistence';
import { EditorController } from './editor-controller';
import { saveAllDirty, type SaveAllOutcome } from './save-all';

export class EditorRegistry {
  private readonly controllers = new Map<string, EditorController>();
  private shortcutHandler: (event: KeyboardEvent) => boolean = () => false;
  private focusHandler: (tabId: string) => void = () => undefined;
  private readonly listeners = new Set<() => void>();
  private version = 0;
  private lastDirty = -1;

  setShortcutHandler(handler: (event: KeyboardEvent) => boolean): void {
    this.shortcutHandler = handler;
  }

  setFocusHandler(handler: (tabId: string) => void): void {
    this.focusHandler = handler;
  }

  get(tabId: string): EditorController | undefined {
    return this.controllers.get(tabId);
  }

  getOrCreate(tabId: string, workspaceId: string, path: string): EditorController {
    const existing = this.controllers.get(tabId);
    if (existing) return existing;
    const controller = new EditorController({
      tabId,
      workspaceId,
      path,
      hooks: {
        onFocus: (id) => this.focusHandler(id),
        onShortcut: (event) => this.shortcutHandler(event),
        beforeLoad: () => new Promise<void>((resolve) => setTimeout(resolve, 0)).then(() => flushSave()),
        onDirtyChange: () => this.notify(),
        watch: (on) => api.watchFile(workspaceId, path, on),
      },
    });
    this.controllers.set(tabId, controller);
    return controller;
  }

  dispose(tabId: string): void {
    const controller = this.controllers.get(tabId);
    if (!controller) return;
    this.controllers.delete(tabId);
    controller.dispose();
    this.notify();
  }

  dirtyCount(tabIds?: Iterable<string>): number {
    const ids = tabIds ? [...tabIds] : [...this.controllers.keys()];
    return ids.filter((id) => this.controllers.get(id)?.isDirty).length;
  }

  constructor() {
    // Main's watcher: something touched an open file (or its folder entry).
    api.onFileChanged((event) => {
      const path = event.path.toLowerCase();
      for (const c of this.controllers.values()) {
        if (c.workspaceId === event.workspaceId && c.path.toLowerCase() === path) void c.checkDisk();
      }
    });
  }

  /** Checks every open file for changes made on disk (also done when the window regains focus). */
  checkDisk(): void {
    for (const c of this.controllers.values()) void c.checkDisk();
  }

  /** Saves every dirty editor (used before quitting). */
  saveAll(): Promise<SaveAllOutcome> {
    return saveAllDirty(this.controllers.values());
  }

  /** Dirty editors, for pointing the user at what is left after a failed save-all. */
  dirtyControllers(): EditorController[] {
    return [...this.controllers.values()].filter((c) => c.isDirty);
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getVersion = (): number => this.version;

  private notify(): void {
    this.version++;
    for (const l of this.listeners) l();
    const dirty = this.dirtyCount();
    if (dirty !== this.lastDirty) {
      this.lastDirty = dirty;
      api.setUnsavedEditors(dirty);
    }
  }
}

export const editors = new EditorRegistry();

if (new URLSearchParams(window.location.search).get('e2e') === '1') {
  const w = window as unknown as Record<string, Record<string, unknown>>;
  w.__twEditor = {
    text: (tabId: string) => editors.get(tabId)?.text() ?? null,
    state: (tabId: string) => editors.get(tabId)?.getSnapshot() ?? null,
  };
}
