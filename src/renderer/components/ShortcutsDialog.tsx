import { BINDINGS, TAB_KEYS, TERMINAL_KEYS, type CommandId } from '../features/commands/shortcuts';
import { Dialog } from './Dialog';

const DESCRIPTIONS: Record<CommandId, string> = {
  palette: 'Command palette',
  newWorkspace: 'New workspace from folder',
  newTerminal: 'New terminal in the current pane',
  splitRight: 'Split left/right (new pane on the right)',
  splitDown: 'Split top/bottom (new pane below)',
  closePane: 'Close terminal (closes the pane with its last terminal)',
  nextTab: 'Next terminal in pane',
  prevTab: 'Previous terminal in pane',
  find: 'Find in terminal',
  restartShell: 'Start / restart shell',
  focusLeft: 'Focus pane to the left',
  focusRight: 'Focus pane to the right',
  focusUp: 'Focus pane above',
  focusDown: 'Focus pane below',
  nextWorkspace: 'Next workspace',
  prevWorkspace: 'Previous workspace',
  toggleSidebar: 'Collapse / expand workspace sidebar',
  toggleExplorer: 'Show / hide file explorer',
  toggleChanges: 'Show / hide a task’s changes panel',
  toggleFocusMode: 'Focus terminals (hide both sidebars / restore them)',
  toggleMaximize: 'Maximise pane / restore layout',
  fontIncrease: 'Increase terminal font size',
  fontDecrease: 'Decrease terminal font size',
  fontReset: 'Reset terminal font size',
  settings: 'Settings',
  shortcuts: 'This list',
  inbox: 'Agent inbox (agents waiting for you)',
  nextAgent: 'Go to the next waiting agent',
};

function KeyTable({ rows }: { rows: { keys: string; action: string }[] }) {
  return (
    <table className="shortcuts__table">
      <tbody>
        {rows.map((k) => (
          <tr key={k.keys + k.action}>
            <td>{k.action}</td>
            <td>
              <kbd className="kbd">{k.keys}</kbd>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function ShortcutsDialog({ open, onClose }: { open: boolean; onClose(): void }) {
  return (
    <Dialog title="Keyboard shortcuts" open={open} onClose={onClose} width={580}>
      <div className="shortcuts">
        <h3>Workspace and panes</h3>
        <KeyTable rows={BINDINGS.map((b) => ({ keys: b.label, action: DESCRIPTIONS[b.command] }))} />
        <h3>Inside a terminal</h3>
        <KeyTable rows={TERMINAL_KEYS} />
        <h3>On a focused terminal tab</h3>
        <KeyTable rows={TAB_KEYS} />
        <h3>File explorer</h3>
        <KeyTable
          rows={[
            { keys: '↑ ↓ ← →', action: 'Move / open / close folders' },
            { keys: 'Enter', action: 'Insert the file’s path at the active terminal prompt (not run)' },
            { keys: 'Right-click / Shift+F10', action: 'Actions: copy path, reveal in File Explorer' },
          ]}
        />
        <p className="settings__hint">
          All other keys, including plain Ctrl+letter combinations and F-keys inside a terminal, go to the shell. Dividers and sidebar edges can be
          focused with Tab and moved with the arrow keys (Shift for larger steps).
        </p>
      </div>
    </Dialog>
  );
}
