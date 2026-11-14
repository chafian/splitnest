// Focuses whatever a tab holds: a terminal, a file editor, or a diff (its scrollable view).
import { editors } from '../editor/editor-registry';
import { registry } from './terminal-registry';

export function focusTab(tabId: string): void {
  const terminal = registry.get(tabId);
  if (terminal) terminal.focus();
  else if (editors.get(tabId)) editors.get(tabId)!.focus();
  else document.querySelector<HTMLElement>(`[data-diff-tab-id="${CSS.escape(tabId)}"]`)?.focus();
}
