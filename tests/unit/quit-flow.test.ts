import { describe, expect, it } from 'vitest';
import { QuitCoordinator, quitDialogModel, type QuitChoice, type QuitDeps, type SaveAllResult } from '../../src/main/quit-flow';
import { saveAllDirty, type Savable } from '../../src/renderer/features/editor/save-all';

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

/** A fake app: N dirty files that save via the real saveAllDirty, some of which fail. */
function setup(opts: { live?: number; files?: { fails?: boolean; conflict?: boolean }[]; choice?: QuitChoice | Promise<QuitChoice> }) {
  const files = (opts.files ?? []).map((f) => {
    const file = {
      isDirty: true,
      writes: 0,
      save: async () => {
        if (f.fails || f.conflict) return false; // write error, or the disk version changed (CONFLICT)
        file.writes++;
        file.isDirty = false;
        return true;
      },
    };
    return file;
  });
  const log = { asks: 0, proceeded: 0, failures: [] as SaveAllResult[] };
  const deps: QuitDeps = {
    liveSessions: () => opts.live ?? 0,
    unsavedFiles: () => files.filter((f) => f.isDirty).length,
    ask: () => {
      log.asks++;
      return Promise.resolve(opts.choice ?? 'cancel');
    },
    saveAll: () => saveAllDirty(files as Savable[]),
    onSaveFailed: (r) => log.failures.push(r),
    proceed: () => log.proceeded++,
  };
  return { quit: new QuitCoordinator(deps), files, log };
}

const settle = () => new Promise((r) => setTimeout(r, 0));

describe('quitting with unsaved files', () => {
  it('Save all and quit: waits for every save, then quits', async () => {
    const { quit, files, log } = setup({ files: [{}, {}, {}], choice: 'save' });
    expect(quit.requestClose()).toBe(false); // the close is held while asking and saving
    await settle();
    await settle();
    expect(files.map((f) => f.writes)).toEqual([1, 1, 1]);
    expect(log.proceeded).toBe(1);
    expect(quit.requestClose()).toBe(true); // the follow-up close goes through
  });

  it('a failed save or an unresolved conflict keeps the app open with the edits', async () => {
    for (const bad of [{ fails: true }, { conflict: true }]) {
      const { quit, files, log } = setup({ files: [{}, bad, {}], choice: 'save' });
      quit.requestClose();
      await settle();
      await settle();
      expect(log.proceeded).toBe(0);
      expect(log.failures).toEqual([{ ok: false, saved: 2, failed: 1 }]);
      expect(files[1]!.isDirty).toBe(true); // still there to fix or retry
      expect(quit.inProgress).toBe(false); // the user can try again
    }
  });

  it('Discard and quit writes nothing; Cancel changes nothing', async () => {
    const discard = setup({ files: [{}, {}], choice: 'discard' });
    discard.quit.requestClose();
    await settle();
    expect(discard.files.every((f) => f.writes === 0)).toBe(true);
    expect(discard.log.proceeded).toBe(1);

    const cancel = setup({ live: 2, files: [{}], choice: 'cancel' });
    expect(cancel.quit.requestClose()).toBe(false);
    await settle();
    expect(cancel.log.proceeded).toBe(0);
    expect(cancel.files[0]!.isDirty).toBe(true);
  });

  it('shows one dialog even if close/quit is requested again while it is open', async () => {
    const answer = deferred<QuitChoice>();
    const { quit, log } = setup({ files: [{}], choice: answer.promise });
    quit.requestClose();
    quit.requestClose(); // e.g. Alt+F4 again, or app.quit() from the taskbar
    quit.requestClose();
    expect(log.asks).toBe(1);
    answer.resolve('cancel');
    await settle();
    expect(log.proceeded).toBe(0);
    quit.requestClose();
    expect(log.asks).toBe(2); // a new attempt after Cancel asks again
  });

  it('closes without asking when nothing is running or unsaved', () => {
    const { quit, log } = setup({});
    expect(quit.requestClose()).toBe(true);
    expect(log.asks).toBe(0);
  });

  it('offers Save all / Discard / Cancel when files are unsaved, and keeps the session warning', () => {
    expect(quitDialogModel({ liveSessions: 0, unsavedFiles: 2 }).buttons).toEqual(['Save all and quit', 'Discard and quit', 'Cancel']);
    const both = quitDialogModel({ liveSessions: 3, unsavedFiles: 1 });
    expect(both.buttons).toEqual(['Save all, end sessions and quit', 'Discard, end sessions and quit', 'Cancel']);
    expect(both.message).toBe('3 terminal sessions are still running. 1 file has unsaved changes.');
    expect(quitDialogModel({ liveSessions: 1, unsavedFiles: 0 }).choices).toEqual(['discard', 'cancel']);
  });
});
