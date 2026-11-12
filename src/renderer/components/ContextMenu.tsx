// Small positioned menu used for right-click / Shift+F10 actions.
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

export interface ContextMenuItem {
  label: string;
  hint?: string;
  disabled?: boolean;
  danger?: boolean;
  /** Draw a separator above this item. */
  separator?: boolean;
  run(): void;
}

export function ContextMenu({
  x,
  y,
  items,
  label,
  onClose,
}: {
  x: number;
  y: number;
  items: ContextMenuItem[];
  label?: string;
  onClose(): void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ x, y });
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    setPos({ x: Math.max(8, Math.min(x, window.innerWidth - r.width - 8)), y: Math.max(8, Math.min(y, window.innerHeight - r.height - 8)) });
    el.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus();
  }, [x, y]);
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose();
    };
    window.addEventListener('mousedown', onDown);
    window.addEventListener('blur', onClose);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('blur', onClose);
    };
  }, [onClose]);
  // Portalled: panes use CSS containment, which would otherwise clip or offset a fixed menu.
  return createPortal(
    <div
      ref={ref}
      className="menu menu--context"
      role="menu"
      aria-label={label}
      style={{ left: pos.x, top: pos.y }}
      onKeyDown={(e) => {
        const buttons = [...(ref.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? [])];
        const i = buttons.indexOf(document.activeElement as HTMLButtonElement);
        if (e.key === 'Escape' || e.key === 'Tab') onClose();
        else if (e.key === 'ArrowDown') buttons[(i + 1) % buttons.length]?.focus();
        else if (e.key === 'ArrowUp') buttons[(i - 1 + buttons.length) % buttons.length]?.focus();
        else if (e.key === 'Home') buttons[0]?.focus();
        else if (e.key === 'End') buttons[buttons.length - 1]?.focus();
        else return;
        e.preventDefault();
        e.stopPropagation();
      }}
    >
      {items.map((item) => (
        <button
          key={item.label}
          type="button"
          role="menuitem"
          className={`menu__item${item.separator ? ' menu__item--separated' : ''}${item.danger ? ' menu__item--danger' : ''}`}
          disabled={item.disabled}
          onClick={() => {
            onClose();
            item.run();
          }}
        >
          <span className="menu__label">{item.label}</span>
          {item.hint && <span className="menu__hint">{item.hint}</span>}
        </button>
      ))}
    </div>,
    document.body,
  );
}
