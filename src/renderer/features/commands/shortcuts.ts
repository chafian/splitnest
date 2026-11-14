// Application shortcuts. Chosen to avoid keys shells and TUIs rely on:
// plain Ctrl+<letter> always reaches the terminal (Ctrl+C interrupts unless
// text is selected). App actions use Ctrl+Shift, Ctrl+Alt+Arrows, or Ctrl
// with punctuation.

export type CommandId =
  | 'palette'
  | 'newWorkspace'
  | 'newTerminal'
  | 'splitRight'
  | 'splitDown'
  | 'closePane'
  | 'find'
  | 'restartShell'
  | 'focusLeft'
  | 'focusRight'
  | 'focusUp'
  | 'focusDown'
  | 'nextWorkspace'
  | 'prevWorkspace'
  | 'toggleSidebar'
  | 'toggleExplorer'
  | 'toggleChanges'
  | 'toggleFocusMode'
  | 'toggleMaximize'
  | 'nextTab'
  | 'prevTab'
  | 'fontIncrease'
  | 'fontDecrease'
  | 'fontReset'
  | 'settings'
  | 'shortcuts'
  | 'inbox'
  | 'nextAgent';

export interface Binding {
  command: CommandId;
  ctrl: boolean;
  shift: boolean;
  alt: boolean;
  /** KeyboardEvent.code values (layout-independent position). */
  codes: string[];
  label: string;
}

const b = (command: CommandId, mods: string, codes: string[], label: string): Binding => ({
  command,
  ctrl: mods.includes('C'),
  shift: mods.includes('S'),
  alt: mods.includes('A'),
  codes,
  label,
});

export const BINDINGS: Binding[] = [
  b('palette', 'CS', ['KeyP'], 'Ctrl+Shift+P'),
  b('newWorkspace', 'CS', ['KeyO'], 'Ctrl+Shift+O'),
  b('newTerminal', 'CS', ['KeyT'], 'Ctrl+Shift+T'),
  b('splitRight', 'CS', ['KeyD'], 'Ctrl+Shift+D'),
  b('splitDown', 'CS', ['KeyS'], 'Ctrl+Shift+S'),
  b('closePane', 'CS', ['KeyW'], 'Ctrl+Shift+W'),
  b('nextTab', 'C', ['Tab'], 'Ctrl+Tab'),
  b('prevTab', 'CS', ['Tab'], 'Ctrl+Shift+Tab'),
  b('find', 'CS', ['KeyF'], 'Ctrl+Shift+F'),
  b('restartShell', 'CS', ['KeyR'], 'Ctrl+Shift+R'),
  b('focusLeft', 'CA', ['ArrowLeft'], 'Ctrl+Alt+←'),
  b('focusRight', 'CA', ['ArrowRight'], 'Ctrl+Alt+→'),
  b('focusUp', 'CA', ['ArrowUp'], 'Ctrl+Alt+↑'),
  b('focusDown', 'CA', ['ArrowDown'], 'Ctrl+Alt+↓'),
  b('nextWorkspace', 'CS', ['PageDown'], 'Ctrl+Shift+PgDn'),
  b('prevWorkspace', 'CS', ['PageUp'], 'Ctrl+Shift+PgUp'),
  b('toggleSidebar', 'CS', ['KeyB'], 'Ctrl+Shift+B'),
  b('toggleExplorer', 'CS', ['KeyE'], 'Ctrl+Shift+E'),
  // Shells see the same Ctrl+G as without Shift, so nothing is lost there.
  b('toggleChanges', 'CS', ['KeyG'], 'Ctrl+Shift+G'),
  // xterm.js sends the same byte for Enter and Ctrl+Shift+Enter, so shells lose nothing.
  b('toggleFocusMode', 'CS', ['Enter', 'NumpadEnter'], 'Ctrl+Shift+Enter'),
  // Not used by shells, PSReadLine, bash/readline or common TUIs (they see plain Ctrl+M = Enter).
  b('toggleMaximize', 'CS', ['KeyM'], 'Ctrl+Shift+M'),
  b('fontIncrease', 'C', ['Equal', 'NumpadAdd'], 'Ctrl+='),
  b('fontDecrease', 'C', ['Minus', 'NumpadSubtract'], 'Ctrl+−'),
  b('fontReset', 'C', ['Digit0', 'Numpad0'], 'Ctrl+0'),
  b('settings', 'C', ['Comma'], 'Ctrl+,'),
  b('shortcuts', 'CS', ['Slash'], 'Ctrl+Shift+/'),
  // Neither is used by SplitNest, PSReadLine, bash/readline or xterm.js (which sends plain Ctrl+A / Ctrl+U for them).
  b('inbox', 'CS', ['KeyA'], 'Ctrl+Shift+A'),
  b('nextAgent', 'CS', ['KeyU'], 'Ctrl+Shift+U'),
];

export interface KeyLike {
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  metaKey: boolean;
  code: string;
}

export function matchShortcut(event: KeyLike): CommandId | null {
  if (event.metaKey) return null;
  for (const binding of BINDINGS) {
    if (
      binding.ctrl === event.ctrlKey &&
      binding.shift === event.shiftKey &&
      binding.alt === event.altKey &&
      binding.codes.includes(event.code)
    ) {
      return binding.command;
    }
  }
  return null;
}

export function shortcutLabel(command: CommandId): string | undefined {
  return BINDINGS.find((x) => x.command === command)?.label;
}

/** Terminal keys handled by the pane itself (documented, not rebindable here). */
export const TERMINAL_KEYS: { keys: string; action: string }[] = [
  { keys: 'Ctrl+C', action: 'Copy when text is selected; otherwise sent to the shell (interrupt)' },
  { keys: 'Ctrl+Shift+C', action: 'Copy selection' },
  { keys: 'Ctrl+V / Ctrl+Shift+V', action: 'Paste' },
  { keys: 'Right-click', action: 'Copy selection, or paste when nothing is selected' },
  { keys: 'Ctrl+click', action: 'Open an http(s) link in your browser' },
];

/** Keys that work while a terminal tab (not the terminal itself) has focus. */
export const TAB_KEYS: { keys: string; action: string }[] = [
  { keys: '← → Home End', action: 'Move between tabs in the pane' },
  { keys: 'Enter', action: 'Focus the terminal' },
  { keys: 'F2', action: 'Rename terminal' },
  { keys: 'Shift+F10 / Menu key', action: 'Tab actions (rename, restart, close)' },
  { keys: 'Delete', action: 'Close tab' },
];
