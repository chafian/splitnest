import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';

export interface PaletteCommand {
  id: string;
  title: string;
  group: string;
  shortcut?: string;
  disabled?: boolean;
  run(): void;
}

export function filterCommands(commands: PaletteCommand[], query: string): PaletteCommand[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return commands;
  return commands.filter((c) => {
    const hay = `${c.group} ${c.title}`.toLowerCase();
    return words.every((w) => hay.includes(w));
  });
}

export function CommandPalette({ open, commands, onClose }: { open: boolean; commands: PaletteCommand[]; onClose(): void }) {
  const [query, setQuery] = useState('');
  const [index, setIndex] = useState(0);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const results = useMemo(() => filterCommands(commands, query), [commands, query]);

  // Every opening starts empty. The text is cleared when the palette closes, and again before the
  // first paint of an opening (layout effect): a passive effect ran after the input was already
  // shown with the previous text, so keys typed right after Ctrl+Shift+P were appended to it
  // ("split left/right wslnew terminal…" — seen in the E2E run).
  useLayoutEffect(() => {
    const el = dialogRef.current;
    setQuery('');
    setIndex(0);
    if (!el) return;
    if (open) {
      if (!el.open) el.showModal();
    } else if (el.open) {
      el.close();
    }
  }, [open]);

  useEffect(() => {
    listRef.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [index, results]);

  const run = (command: PaletteCommand | undefined) => {
    if (!command || command.disabled) return;
    onClose();
    // Let the dialog close and focus return before running the action.
    setTimeout(() => command.run(), 0);
  };

  const safeIndex = Math.min(index, Math.max(0, results.length - 1));
  return (
    <dialog
      ref={dialogRef}
      className="palette"
      aria-label="Command palette"
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      onMouseDown={(e) => {
        if (e.target === dialogRef.current) onClose();
      }}
    >
      {open && (
        <>
          <input
            className="palette__input"
            autoFocus
            placeholder="Type a command"
            aria-label="Command"
            role="combobox"
            aria-expanded="true"
            aria-controls="palette-list"
            aria-activedescendant={results[safeIndex] ? `palette-${results[safeIndex]!.id}` : undefined}
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setIndex(0);
            }}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') {
                e.preventDefault();
                setIndex((i) => Math.min(results.length - 1, i + 1));
              } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                setIndex((i) => Math.max(0, i - 1));
              } else if (e.key === 'Enter') {
                e.preventDefault();
                run(results[safeIndex]);
              }
            }}
          />
          <ul className="palette__list" role="listbox" id="palette-list" ref={listRef}>
            {results.length === 0 && <li className="palette__empty">No matching commands</li>}
            {results.map((c, i) => (
              <li
                key={c.id}
                id={`palette-${c.id}`}
                role="option"
                aria-selected={i === safeIndex}
                aria-disabled={c.disabled || undefined}
                className={`palette__item${i === safeIndex ? ' palette__item--selected' : ''}${c.disabled ? ' palette__item--disabled' : ''}`}
                onMouseMove={() => setIndex(i)}
                onClick={() => run(c)}
              >
                <span className="palette__group">{c.group}</span>
                <span className="palette__title">{c.title}</span>
                {c.shortcut && <kbd className="kbd">{c.shortcut}</kbd>}
              </li>
            ))}
          </ul>
        </>
      )}
    </dialog>
  );
}
