// Focuses whatever a tab holds: a terminal or a file editor.
import { editors } from '../editor/editor-registry';
import { registry } from './terminal-registry';

export function focusTab(tabId: string): void {
  const terminal = registry.get(tabId);
  if (terminal) terminal.focus();
  else editors.get(tabId)?.focus();
}
