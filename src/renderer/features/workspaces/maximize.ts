// "Maximise pane": one pane temporarily fills the layout area. The split tree
// is not changed (other panes stay mounted, hidden), so restoring brings back
// the exact proportions and selected tabs, and hidden shells keep running.
import { findPane, listPanes } from '../../../shared/layout';
import type { Workspace } from '../../../shared/types';

/**
 * The pane to show maximised, or null. A maximised pane ends when it closes,
 * when the layout has only one pane, or when focus moves to another pane
 * (opening a file next to it, Ctrl+Alt+arrow, clicking elsewhere), so there
 * is never a hidden pane with keyboard focus.
 */
export function effectiveMaximized(workspace: Workspace, requested: string | null | undefined): string | null {
  if (!requested || !workspace.layout) return null;
  if (!findPane(workspace.layout, requested)) return null;
  if (listPanes(workspace.layout).length < 2) return null;
  return workspace.activePaneId === requested ? requested : null;
}
