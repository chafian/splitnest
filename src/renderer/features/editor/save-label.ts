// What the editor status bar says about saving (pure, so it can be tested).
import type { EditorSnapshot } from './editor-controller';

export interface SaveLabel {
  key: 'read-only' | 'saving' | 'failed' | 'deleted' | 'changed' | 'unsaved' | 'saved' | 'clean';
  text: string;
  tone: 'muted' | 'warning' | 'danger' | 'ok';
}

type SaveInput = Pick<EditorSnapshot, 'readOnly' | 'saveState' | 'dirty'> & Partial<Pick<EditorSnapshot, 'conflict'>>;

/**
 * "Saved" appears only right after a successful write, and never while the
 * disk no longer matches (file deleted or changed elsewhere). A read-only
 * file never shows save wording. A freshly opened, unchanged file shows nothing.
 */
export function editorSaveLabel(s: SaveInput): SaveLabel {
  if (s.readOnly) return { key: 'read-only', text: 'Read-only', tone: 'muted' };
  if (s.saveState === 'saving') return { key: 'saving', text: 'Saving…', tone: 'muted' };
  if (s.conflict === 'deleted') return { key: 'deleted', text: s.dirty ? 'Deleted on disk · edits kept' : 'Deleted on disk', tone: 'danger' };
  if (s.conflict === 'changed-on-disk') return { key: 'changed', text: 'Changed on disk · edits kept', tone: 'warning' };
  if (s.saveState === 'failed') return { key: 'failed', text: s.dirty ? 'Save failed · edits kept' : 'Save failed', tone: 'danger' };
  if (s.dirty) return { key: 'unsaved', text: 'Unsaved · Ctrl+S to save', tone: 'warning' };
  if (s.saveState === 'saved') return { key: 'saved', text: 'Saved', tone: 'ok' };
  return { key: 'clean', text: '', tone: 'muted' };
}
