// A select styled like the rest of SplitNest: a button showing the choice and a list that opens in
// the top layer (the Popover API), so no dialog or scroll area can clip it. Keyboard as with a native
// select: Enter, Space or ↑/↓ open it; ↑/↓, Home/End and the first letter move; Enter or Space picks;
// Escape or Tab closes. ARIA: a button with a listbox popup, options with aria-selected.
import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react';
import { Icon } from './Icon';

export interface SelectOption {
  value: string;
  label: string;
  disabled?: boolean;
}

interface Props {
  value: string;
  options: SelectOption[];
  onChange(value: string): void;
  'aria-label': string;
  title?: string;
  className?: string;
  'data-testid'?: string;
  disabled?: boolean;
}

export function Select(props: Props) {
  const { value, options } = props;
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const listId = useId();
  /** When the list last closed by itself (click outside): a click on the button right after must not reopen it. */
  const dismissedAt = useRef(0);
  const current = options.find((o) => o.value === value);
  const selectable = (i: number) => !!options[i] && !options[i]!.disabled;

  const show = () => {
    if (props.disabled || options.length === 0) return;
    // On the current choice, or the first one that can be picked (the current may be disabled).
    const i = options.findIndex((o) => o.value === value && !o.disabled);
    setActive(i >= 0 ? i : options.findIndex((o) => !o.disabled));
    setOpen(true);
  };
  const close = (refocus = true) => {
    setOpen(false);
    if (refocus) buttonRef.current?.focus();
  };
  const pick = (i: number) => {
    const o = options[i];
    if (!o || o.disabled) return;
    if (o.value !== value) props.onChange(o.value);
    close();
  };

  // Open in the top layer, under (or above, when there is no room) the button, at least its width.
  useLayoutEffect(() => {
    const list = listRef.current;
    const button = buttonRef.current;
    if (!list || !button) return;
    if (!open) {
      if (list.matches(':popover-open')) list.hidePopover();
      return;
    }
    const r = button.getBoundingClientRect();
    list.style.minWidth = `${Math.round(r.width)}px`;
    list.style.left = `${Math.round(r.left)}px`;
    list.style.top = `${Math.round(r.bottom + 4)}px`;
    if (!list.matches(':popover-open')) list.showPopover();
    const h = list.getBoundingClientRect().height;
    if (r.bottom + 4 + h > window.innerHeight - 8 && r.top - 4 - h > 8) list.style.top = `${Math.round(r.top - 4 - h)}px`;
    const maxLeft = window.innerWidth - list.getBoundingClientRect().width - 8;
    if (r.left > maxLeft) list.style.left = `${Math.max(8, Math.round(maxLeft))}px`;
    list.focus();
  }, [open]);

  // Light dismiss (click outside, Escape) closes the popover by itself: keep the state in step.
  useEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const onToggle = (e: Event) => {
      if ((e as ToggleEvent).newState === 'closed') {
        dismissedAt.current = Date.now();
        setOpen(false);
      }
    };
    list.addEventListener('toggle', onToggle);
    return () => list.removeEventListener('toggle', onToggle);
  }, []);

  useEffect(() => {
    if (open) listRef.current?.querySelector<HTMLElement>(`[data-index="${active}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [open, active]);

  const move = (from: number, step: number) => {
    for (let i = from + step; i >= 0 && i < options.length; i += step) if (selectable(i)) return i;
    return from;
  };

  const onButtonKey = (e: KeyboardEvent<HTMLButtonElement>) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      show();
    }
  };

  const onListKey = (e: KeyboardEvent<HTMLUListElement>) => {
    if (e.key === 'ArrowDown') setActive((a) => move(a, 1));
    else if (e.key === 'ArrowUp') setActive((a) => move(a, -1));
    else if (e.key === 'Home') setActive(move(-1, 1));
    else if (e.key === 'End') setActive(move(options.length, -1));
    else if (e.key === 'Enter' || e.key === ' ') pick(active);
    else if (e.key === 'Escape') close();
    else if (e.key === 'Tab') {
      close(false);
      return; // focus moves on as usual
    } else if (e.key.length === 1 && /\S/.test(e.key)) {
      // The next option starting with that letter, after the current one.
      const k = e.key.toLowerCase();
      for (let n = 1; n <= options.length; n++) {
        const i = (active + n) % options.length;
        if (selectable(i) && options[i]!.label.toLowerCase().startsWith(k)) {
          setActive(i);
          break;
        }
      }
    } else return;
    e.preventDefault();
  };

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        className={`select${props.className ? ` ${props.className}` : ''}`}
        aria-label={props['aria-label']}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={listId}
        title={props.title}
        disabled={props.disabled}
        data-testid={props['data-testid']}
        data-value={value}
        onClick={() => {
          if (open) close();
          else if (Date.now() - dismissedAt.current > 250) show();
        }}
        onKeyDown={onButtonKey}
      >
        <span className="select__label">{current?.label ?? value}</span>
        <Icon name="chevronDown" size={14} className="select__chevron" />
      </button>
      <ul
        ref={listRef}
        id={listId}
        popover="auto"
        role="listbox"
        aria-label={props['aria-label']}
        aria-activedescendant={open ? `${listId}-${active}` : undefined}
        tabIndex={-1}
        className="select__list"
        onKeyDown={onListKey}
      >
        {options.map((o, i) => (
          <li
            key={o.value}
            id={`${listId}-${i}`}
            role="option"
            data-index={i}
            data-value={o.value}
            aria-selected={o.value === value}
            aria-disabled={o.disabled || undefined}
            className={`select__option${i === active ? ' select__option--active' : ''}${o.value === value ? ' select__option--selected' : ''}`}
            onMouseEnter={() => !o.disabled && setActive(i)}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => pick(i)}
          >
            <span className="select__check" aria-hidden="true">
              {o.value === value && <Icon name="check" size={13} />}
            </span>
            {o.label}
          </li>
        ))}
      </ul>
    </>
  );
}
