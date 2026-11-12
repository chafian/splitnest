// Visibility and widths of the two side panels (workspace sidebar and file
// explorer). Pure functions so the rules are testable without a DOM.
//
// Saved preferences are never rewritten when the window is small: widths are
// only clamped for display, so they come back when the window grows again.
import { LIMITS, type AppSettings } from '../../../shared/types';

export type SidebarMode = 'expanded' | 'rail' | 'hidden';

export interface Chrome {
  sidebar: SidebarMode;
  /** Rendered sidebar width in px (0 when hidden). */
  sidebarWidth: number;
  explorer: boolean;
  /** Rendered explorer width in px (0 when hidden). */
  explorerWidth: number;
  /** Largest width the explorer can be dragged to right now. */
  explorerMax: number;
  /** Largest width the expanded sidebar can be dragged to right now. */
  sidebarMax: number;
}

type ChromeSettings = Pick<AppSettings, 'sidebarCollapsed' | 'sidebarWidth' | 'explorerVisible' | 'explorerWidth' | 'focusMode'>;

const clamp = (v: number, min: number, max: number) => Math.round(Math.min(max, Math.max(min, v)));

/**
 * Works out what to render for a window of `windowWidth` px. When both panels
 * don't fit next to `LIMITS.minTerminalAreaWidth` of terminals, the explorer
 * shrinks first, then the sidebar, never below their minimum widths.
 * `hasWorkspace` is false on the welcome screen (no explorer to show).
 */
export function computeChrome(settings: ChromeSettings, windowWidth: number, hasWorkspace = true): Chrome {
  const sidebar: SidebarMode = settings.focusMode ? 'hidden' : settings.sidebarCollapsed ? 'rail' : 'expanded';
  const explorer = !settings.focusMode && settings.explorerVisible && hasWorkspace;
  const rail = sidebar === 'rail' ? LIMITS.sidebarRailWidth : 0;
  const budget = Math.max(0, windowWidth - LIMITS.minTerminalAreaWidth - rail);

  let sw = sidebar === 'expanded' ? clamp(settings.sidebarWidth, LIMITS.sidebarWidth.min, LIMITS.sidebarWidth.max) : 0;
  let ew = explorer ? clamp(settings.explorerWidth, LIMITS.explorerWidth.min, LIMITS.explorerWidth.max) : 0;
  let overflow = sw + ew - budget;
  if (overflow > 0 && explorer) {
    const cut = Math.min(overflow, ew - LIMITS.explorerWidth.min);
    ew -= cut;
    overflow -= cut;
  }
  if (overflow > 0 && sidebar === 'expanded') {
    const cut = Math.min(overflow, sw - LIMITS.sidebarWidth.min);
    sw -= cut;
  }

  const explorerMax = Math.max(LIMITS.explorerWidth.min, Math.min(LIMITS.explorerWidth.max, budget - sw));
  const sidebarMax = Math.max(LIMITS.sidebarWidth.min, Math.min(LIMITS.sidebarWidth.max, budget - ew));
  return {
    sidebar,
    sidebarWidth: sidebar === 'expanded' ? sw : rail,
    explorer,
    explorerWidth: ew,
    explorerMax,
    sidebarMax,
  };
}

/** Ctrl+Shift+B. In focus mode it leaves focus mode, restoring the sidebar as it was. */
export function toggleSidebar(s: ChromeSettings): Partial<AppSettings> {
  if (s.focusMode) return { focusMode: false };
  return { sidebarCollapsed: !s.sidebarCollapsed };
}

/** Ctrl+Shift+E. In focus mode it leaves focus mode and makes sure the explorer is shown. */
export function toggleExplorer(s: ChromeSettings): Partial<AppSettings> {
  if (s.focusMode) return { focusMode: false, explorerVisible: true };
  return { explorerVisible: !s.explorerVisible };
}

/** "Focus terminals" only flips one flag; the panels' own settings stay untouched. */
export function toggleFocusMode(s: ChromeSettings): Partial<AppSettings> {
  return { focusMode: !s.focusMode };
}
