// What happens when the window is closed or the app is asked to quit while
// shells are running or files have unsaved changes. Kept free of Electron so
// it can be tested directly.

export type QuitChoice = 'save' | 'discard' | 'cancel';

export interface QuitPrompt {
  liveSessions: number;
  unsavedFiles: number;
}

export interface SaveAllResult {
  ok: boolean;
  /** Files that could not be written (error, or still in conflict with the disk version). */
  failed: number;
}

export interface QuitDeps {
  liveSessions(): number;
  unsavedFiles(): number;
  /** Shows the dialog. `save` is only offered when there are unsaved files. */
  ask(prompt: QuitPrompt): Promise<QuitChoice>;
  /** Asks the renderer to save every dirty editor and waits for the outcome. */
  saveAll(): Promise<SaveAllResult>;
  /** Called when saving did not fully succeed; the app stays open. */
  onSaveFailed(result: SaveAllResult): void;
  /** Really closes (the coordinator lets the next close request through). */
  proceed(): void;
}

export class QuitCoordinator {
  private busy = false;
  private confirmed = false;

  constructor(private readonly deps: QuitDeps) {}

  /** True while a dialog or a save-all is in progress. */
  get inProgress(): boolean {
    return this.busy;
  }

  /**
   * Call from the window's `close` handler. Returns true when the close may
   * go ahead immediately; otherwise the caller must cancel it (the
   * coordinator closes again later if the user confirms). Repeated requests
   * while a dialog or save is pending are absorbed, so only one dialog ever
   * shows.
   */
  requestClose(): boolean {
    if (this.confirmed) return true;
    if (this.busy) return false;
    const prompt = { liveSessions: this.deps.liveSessions(), unsavedFiles: this.deps.unsavedFiles() };
    if (prompt.liveSessions === 0 && prompt.unsavedFiles === 0) return true;
    this.busy = true;
    void this.run(prompt).finally(() => {
      this.busy = false;
    });
    return false;
  }

  private async run(prompt: QuitPrompt): Promise<void> {
    let choice: QuitChoice;
    try {
      choice = await this.deps.ask(prompt);
    } catch {
      choice = 'cancel';
    }
    if (choice === 'cancel') return;
    if (choice === 'save' && prompt.unsavedFiles > 0) {
      let result: SaveAllResult;
      try {
        result = await this.deps.saveAll();
      } catch {
        result = { ok: false, failed: prompt.unsavedFiles };
      }
      // Files may have become dirty again while saving; only a clean state quits.
      if (!result.ok || this.deps.unsavedFiles() > 0) {
        this.deps.onSaveFailed(result.ok ? { ok: false, failed: this.deps.unsavedFiles() } : result);
        return;
      }
    }
    this.confirmed = true;
    this.deps.proceed();
  }
}

/** Dialog text and buttons for a prompt (shared by the real dialog and tests). */
export function quitDialogModel(p: QuitPrompt): { message: string; detail: string; buttons: string[]; choices: QuitChoice[] } {
  const parts = [
    p.liveSessions > 0 ? (p.liveSessions === 1 ? '1 terminal session is still running.' : `${p.liveSessions} terminal sessions are still running.`) : '',
    p.unsavedFiles > 0 ? (p.unsavedFiles === 1 ? '1 file has unsaved changes.' : `${p.unsavedFiles} files have unsaved changes.`) : '',
  ].filter(Boolean);
  const detail =
    (p.liveSessions > 0 ? 'Quitting ends these shells and the programs running in them; SplitNest cannot tell whether a shell is idle. ' : '') +
    (p.unsavedFiles > 0 ? 'Save all writes the files first and stays open if any save fails. Discard loses the changes.' : '');
  if (p.unsavedFiles > 0) {
    const end = p.liveSessions > 0 ? ', end sessions' : '';
    return {
      message: parts.join(' '),
      detail,
      buttons: [`Save all${end} and quit`, `Discard${end} and quit`, 'Cancel'],
      choices: ['save', 'discard', 'cancel'],
    };
  }
  return { message: parts.join(' '), detail, buttons: ['End sessions and quit', 'Cancel'], choices: ['discard', 'cancel'] };
}
