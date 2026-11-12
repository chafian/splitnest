// One controller per file tab. Owns the CodeMirror view and the file's saved
// version outside React, so splitting, moving the tab or switching
// workspaces never loses unsaved text or undo history.
import { autocompletion, closeBrackets, closeBracketsKeymap, completionKeymap } from '@codemirror/autocomplete';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { bracketMatching, foldGutter, foldKeymap, indentOnInput, indentUnit } from '@codemirror/language';
import { highlightSelectionMatches, openSearchPanel, search, searchKeymap } from '@codemirror/search';
import { Compartment, EditorState, Prec, Text, type Extension } from '@codemirror/state';
import {
  crosshairCursor,
  drawSelection,
  dropCursor,
  EditorView,
  highlightActiveLine,
  highlightActiveLineGutter,
  highlightSpecialChars,
  keymap,
  lineNumbers,
  rectangularSelection,
} from '@codemirror/view';
import type { AppError, TextEncoding } from '../../../shared/types';
import { api } from '../../api';
import { languageFor } from './editor-languages';
import { detectEol, detectIndent } from './text-format';
import { editorHighlighting, editorTheme } from './editor-theme';

export type EditorStatus = 'loading' | 'ready' | 'error';

export interface EditorSnapshot {
  status: EditorStatus;
  error: AppError | null;
  dirty: boolean;
  saving: boolean;
  /**
   * Result of the last save attempt: `saved` only right after a successful
   * write (cleared by the next edit), `failed` after a write error. `idle`
   * otherwise, including a file that was just opened.
   */
  saveState: 'idle' | 'saving' | 'saved' | 'failed';
  /** Reason the file cannot be saved (shown in a banner), or null. */
  readOnly: string | null;
  /** The file changed on disk; with `dirty` the user chooses what to keep. */
  conflict: 'changed-on-disk' | 'deleted' | null;
  line: number;
  column: number;
  language: string;
  encoding: TextEncoding;
  eol: 'LF' | 'CRLF';
  lastSaveError: AppError | null;
}

export interface EditorHooks {
  onFocus(tabId: string): void;
  /** App shortcuts (Ctrl+Shift+…) that should still work inside the editor. */
  onShortcut(event: KeyboardEvent): boolean;
  /** Ensures main knows about the workspace before reading files. */
  beforeLoad(): Promise<void>;
  onDirtyChange(): void;
  /** Starts or stops the main-process watcher for this file. */
  watch(on: boolean): void;
}

export class EditorController {
  readonly tabId: string;
  readonly workspaceId: string;
  readonly path: string;
  readonly element: HTMLDivElement;
  private view: EditorView | null = null;
  private readonly hooks: EditorHooks;
  private snapshot: EditorSnapshot;
  private readonly listeners = new Set<() => void>();
  private readonly languageSlot = new Compartment();
  private readonly readOnlySlot = new Compartment();
  /** Document as last loaded or saved (immutable; compared structurally). */
  private savedDoc: Text = Text.empty;
  /** Content hash of the disk version this buffer is based on (last load, reload or successful save). */
  private diskHash = '';
  private checking: Promise<void> | null = null;
  private recheck = false;
  private disposed = false;
  private resizeObserver: ResizeObserver | null = null;
  private loading: Promise<void> | null = null;
  private wantFocus = false;
  /** On-disk version the user chose to keep their edits over ("Keep my edits"); not re-reported. */
  private acknowledgedDiskHash: string | null = null;

  constructor(options: { tabId: string; workspaceId: string; path: string; hooks: EditorHooks }) {
    this.tabId = options.tabId;
    this.workspaceId = options.workspaceId;
    this.path = options.path;
    this.hooks = options.hooks;
    this.element = document.createElement('div');
    this.element.className = 'editor-host';
    const name = this.path.split('/').pop() ?? this.path;
    this.snapshot = {
      status: 'loading',
      error: null,
      dirty: false,
      saving: false,
      saveState: 'idle',
      readOnly: null,
      conflict: null,
      line: 1,
      column: 1,
      language: languageFor(name).label,
      encoding: 'utf8',
      eol: 'LF',
      lastSaveError: null,
    };
  }

  // ---------------------------------------------------------------- state

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = (): EditorSnapshot => this.snapshot;

  private update(patch: Partial<EditorSnapshot>): void {
    const wasDirty = this.snapshot.dirty;
    this.snapshot = { ...this.snapshot, ...patch };
    for (const l of this.listeners) l();
    if (wasDirty !== this.snapshot.dirty) this.hooks.onDirtyChange();
  }

  get isDirty(): boolean {
    return this.snapshot.dirty;
  }

  get fileName(): string {
    return this.path.split('/').pop() ?? this.path;
  }

  // -------------------------------------------------------------- DOM life

  attach(container: HTMLElement): void {
    if (this.disposed) return;
    if (this.element.parentElement !== container) container.appendChild(this.element);
    if (!this.resizeObserver) {
      this.resizeObserver = new ResizeObserver(() => this.view?.requestMeasure());
      this.resizeObserver.observe(this.element);
    }
    this.view?.requestMeasure();
    if (!this.view && !this.loading) this.loading = this.load();
  }

  detach(): void {
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
  }

  /** Focuses the editor, or does so as soon as the file has loaded. */
  focus(): void {
    if (this.view) this.view.focus();
    else this.wantFocus = true;
  }

  openSearch(): void {
    if (this.view) openSearchPanel(this.view);
  }

  /** Text for test automation only. */
  text(): string {
    return this.view?.state.doc.toString() ?? '';
  }

  // ------------------------------------------------------------- loading

  private async load(): Promise<void> {
    this.update({ status: 'loading', error: null });
    await this.hooks.beforeLoad();
    const result = await api.readFile(this.workspaceId, this.path);
    if (this.disposed) return;
    this.loading = null;
    if (!result.ok) {
      this.update({ status: 'error', error: result.error });
      return;
    }
    const eol = detectEol(result.content);
    const text = result.content.replace(/\r\n?/g, '\n');
    this.diskHash = result.hash;
    this.hooks.watch(true);
    const language = languageFor(this.fileName);
    this.view = new EditorView({
      parent: this.element,
      state: EditorState.create({ doc: text, extensions: this.extensions(detectIndent(text), !!result.readOnly) }),
    });
    this.savedDoc = this.view.state.doc;
    if (this.wantFocus) {
      this.wantFocus = false;
      this.view.focus();
    }
    this.update({ status: 'ready', readOnly: result.readOnly, encoding: result.encoding, eol, conflict: null, dirty: false, language: language.label });
    this.updateCursor();
    try {
      const ext = await language.load();
      if (!this.disposed && this.view) this.view.dispatch({ effects: this.languageSlot.reconfigure(ext) });
    } catch {
      // Highlighting is optional; the file stays editable as plain text.
    }
  }

  /** Re-reads the file from disk, dropping unsaved changes (user-confirmed by the caller). */
  async reload(): Promise<void> {
    const result = await api.readFile(this.workspaceId, this.path);
    if (this.disposed) return;
    if (!result.ok) {
      this.update({ status: this.view ? 'ready' : 'error', error: result.error, conflict: result.error.code === 'FILE_NOT_FOUND' ? 'deleted' : this.snapshot.conflict });
      return;
    }
    const text = result.content.replace(/\r\n?/g, '\n');
    this.diskHash = result.hash;
    if (!this.view) {
      void this.load();
      return;
    }
    // Keep the cursor/selection (clamped to the new length) and the scroll position where practical.
    const view = this.view;
    const scrollTop = view.scrollDOM.scrollTop;
    const scrollLeft = view.scrollDOM.scrollLeft;
    const clamp = (n: number) => Math.min(n, text.length);
    const sel = view.state.selection.main;
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: text },
      selection: { anchor: clamp(sel.anchor), head: clamp(sel.head) },
      effects: this.readOnlySlot.reconfigure(EditorState.readOnly.of(!!result.readOnly)),
    });
    view.requestMeasure({
      read: () => null,
      write: () => {
        view.scrollDOM.scrollTop = scrollTop;
        view.scrollDOM.scrollLeft = scrollLeft;
      },
    });
    this.savedDoc = view.state.doc;
    this.acknowledgedDiskHash = null;
    this.update({
      readOnly: result.readOnly,
      encoding: result.encoding,
      eol: detectEol(result.content),
      conflict: null,
      dirty: false,
      error: null,
      lastSaveError: null,
      saveState: 'idle',
    });
  }

  /**
   * "Keep my edits": hides the changed-on-disk notice and keeps the buffer.
   * The disk version is not touched; saving later still reports the
   * conflict, so overwriting it always needs an explicit confirmation.
   */
  keepLocalEdits(): void {
    // Only silences the notice for the disk version seen now. The buffer's base
    // version is unchanged, so the next save still fails with CONFLICT and an
    // overwrite needs its own confirmation.
    void api.statFile(this.workspaceId, this.path).then((info) => {
      if (info.ok) this.acknowledgedDiskHash = info.hash;
    });
    this.update({ conflict: null, lastSaveError: null });
  }

  /**
   * Re-checks the file on disk. Called by the file watcher (changes from any
   * program, including SplitNest's own terminals) and when the window
   * regains focus. Compares content hashes, so SplitNest's own saves and
   * timestamp-only changes are not reported. A clean editor reloads; a dirty
   * one keeps its text and shows a conflict notice.
   */
  checkDisk(): Promise<void> {
    // One check at a time; a request during a check or a save runs right after it.
    if (this.checking) {
      this.recheck = true;
      return this.checking;
    }
    this.checking = this.runCheck().finally(() => {
      this.checking = null;
      if (this.recheck && !this.disposed) {
        this.recheck = false;
        void this.checkDisk();
      }
    });
    return this.checking;
  }

  private async runCheck(): Promise<void> {
    if (!this.view || this.disposed) return;
    if (this.snapshot.saving) {
      this.recheck = true;
      return;
    }
    const info = await api.statFile(this.workspaceId, this.path);
    if (this.disposed || this.snapshot.saving) {
      this.recheck = !this.disposed;
      return;
    }
    if (!info.ok) {
      if (info.error.code === 'FILE_NOT_FOUND') this.update({ conflict: 'deleted' });
      return;
    }
    if (info.hash !== null && info.hash === this.diskHash) {
      // Same content as our base version (our own save, or only the timestamp changed).
      if (this.snapshot.conflict) this.update({ conflict: null });
      return;
    }
    if (this.snapshot.dirty) {
      if (info.hash === null || info.hash !== this.acknowledgedDiskHash) this.update({ conflict: 'changed-on-disk' });
    } else {
      await this.reload();
    }
  }

  // -------------------------------------------------------------- saving

  async save(overwrite = false): Promise<boolean> {
    if (!this.view || this.snapshot.readOnly || this.snapshot.saving) return false;
    const doc = this.view.state.doc;
    const text = doc.toString();
    const content = this.snapshot.eol === 'CRLF' ? text.replace(/\n/g, '\r\n') : text;
    this.update({ saving: true, saveState: 'saving', lastSaveError: null });
    let result: Awaited<ReturnType<typeof api.writeFile>>;
    try {
      result = await api.writeFile({
        workspaceId: this.workspaceId,
        path: this.path,
        content,
        encoding: this.snapshot.encoding,
        expectedHash: this.diskHash,
        overwrite,
      });
    } catch {
      result = { ok: false, error: { code: 'INTERNAL', message: 'The file could not be saved.' } };
    }
    if (this.disposed) return false;
    if (!result.ok) {
      // The buffer is untouched and stays dirty; the tab stays open.
      this.update({
        saving: false,
        saveState: 'failed',
        lastSaveError: result.error,
        conflict: result.error.code === 'CONFLICT' ? 'changed-on-disk' : result.error.code === 'FILE_NOT_FOUND' ? 'deleted' : this.snapshot.conflict,
      });
      return false;
    }
    this.diskHash = result.hash;
    this.acknowledgedDiskHash = null;
    this.savedDoc = doc;
    const dirty = !this.view.state.doc.eq(doc);
    this.update({ saving: false, saveState: dirty ? 'idle' : 'saved', dirty, conflict: null, lastSaveError: null });
    return true;
  }

  // ------------------------------------------------------------- internals

  private extensions(indent: string, readOnly: boolean): Extension[] {
    return [
      lineNumbers(),
      highlightActiveLineGutter(),
      foldGutter({ openText: '⌄', closedText: '›' }),
      highlightSpecialChars(),
      history(),
      drawSelection(),
      dropCursor(),
      EditorState.allowMultipleSelections.of(true),
      indentOnInput(),
      indentUnit.of(indent),
      EditorState.tabSize.of(4),
      bracketMatching(),
      closeBrackets(),
      autocompletion({ activateOnTyping: true }),
      rectangularSelection(),
      crosshairCursor(),
      highlightActiveLine(),
      highlightSelectionMatches(),
      search({ top: true }),
      this.languageSlot.of([]),
      this.readOnlySlot.of(EditorState.readOnly.of(readOnly)),
      editorTheme,
      editorHighlighting,
      keymap.of([
        { key: 'Mod-s', preventDefault: true, run: () => (void this.save(), true) },
        ...closeBracketsKeymap,
        ...defaultKeymap,
        ...searchKeymap,
        ...historyKeymap,
        ...foldKeymap,
        ...completionKeymap,
        indentWithTab,
      ]),
      Prec.highest(
        EditorView.domEventHandlers({
          keydown: (event) => {
            // App shortcuts (Ctrl+Shift+…, Ctrl+Alt+arrows) win over editor key bindings.
            if (this.hooks.onShortcut(event)) {
              event.preventDefault();
              return true;
            }
            return false;
          },
        }),
      ),
      EditorView.domEventHandlers({
        focus: () => {
          this.hooks.onFocus(this.tabId);
          return false;
        },
      }),
      EditorView.updateListener.of((u) => {
        if (u.docChanged) {
          const dirty = !u.state.doc.eq(this.savedDoc);
          // "Saved" describes the last write only until the next edit.
          const saveState = this.snapshot.saveState === 'saved' && dirty ? 'idle' : this.snapshot.saveState;
          if (dirty !== this.snapshot.dirty || saveState !== this.snapshot.saveState) this.update({ dirty, saveState });
        }
        if (u.selectionSet || u.docChanged) this.updateCursor();
      }),
    ];
  }

  private updateCursor(): void {
    if (!this.view) return;
    const head = this.view.state.selection.main.head;
    const line = this.view.state.doc.lineAt(head);
    const column = head - line.from + 1;
    if (line.number !== this.snapshot.line || column !== this.snapshot.column) this.update({ line: line.number, column });
  }

  dispose(): void {
    if (this.disposed) return;
    const wasDirty = this.snapshot.dirty;
    this.disposed = true;
    if (this.diskHash) this.hooks.watch(false);
    this.resizeObserver?.disconnect();
    this.view?.destroy();
    this.view = null;
    this.element.remove();
    this.listeners.clear();
    if (wasDirty) this.hooks.onDirtyChange();
  }
}
