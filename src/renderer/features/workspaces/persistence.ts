// Debounced persistence from the renderer. Main validates and writes atomically.
import type { AppError, PersistedState } from '../../../shared/types';
import { api } from '../../api';
import { withoutDiffTabs } from '../../../shared/layout';

let pending: PersistedState | null = null;
let timer: ReturnType<typeof setTimeout> | null = null;
let chain: Promise<void> = Promise.resolve();
let errorHandler: ((error: AppError) => void) | null = null;

export function onSaveError(handler: (error: AppError) => void): void {
  errorHandler = handler;
}

export function scheduleSave(state: PersistedState, delayMs = 250): void {
  // Diff tabs are never saved (see withoutDiffTabs).
  pending = withoutDiffTabs(state);
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => void flushSave(), delayMs);
}

/** Sends any pending state now; resolves once main has accepted it. */
export function flushSave(): Promise<void> {
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
  if (!pending) return chain;
  const state = pending;
  pending = null;
  chain = chain
    .then(() => api.saveState(state))
    .then((result) => {
      if (!result.ok) errorHandler?.(result.error);
    })
    .catch(() => errorHandler?.({ code: 'INTERNAL', message: 'Saving workspace state failed.' }));
  return chain;
}

window.addEventListener('beforeunload', () => void flushSave());
