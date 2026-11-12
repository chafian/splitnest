// Button + popup menu for picking a shell profile.
import { useEffect, useId, useRef, useState } from 'react';
import type { ShellDiscovery } from '../../shared/types';
import { Icon, type IconName } from './Icon';

interface Props {
  discovery: ShellDiscovery | null;
  defaultProfileId: string | null;
  label: string;
  icon: IconName;
  shortcut?: string;
  onPick(profileId: string): void;
  disabled?: boolean;
  className?: string;
  /** Icon-only main button (used in pane tab bars). */
  compact?: boolean;
  /** Tooltip for the main button; says where the terminal will be created. */
  description?: string;
  /** First line of the menu, e.g. "New terminal in the current pane". */
  heading?: string;
  /** Hint next to the profile the main button uses (default: "default"). */
  defaultHint?: string;
}

export function wslGuidance(discovery: ShellDiscovery | null): string | null {
  if (!discovery) return null;
  const wsl = discovery.wsl;
  if (wsl.state === 'available') return null;
  if (wsl.state === 'no-distributions') return 'WSL is installed but has no Linux distributions.';
  if (wsl.state === 'not-installed') return 'WSL is not installed.';
  return `WSL is not available: ${wsl.message}`;
}

export function ProfileMenu({ discovery, defaultProfileId, label, icon, shortcut, onPick, disabled, className, compact, description, heading, defaultHint = 'default' }: Props) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const menuId = useId();
  const profiles = discovery?.profiles ?? [];
  const guidance = wslGuidance(discovery);
  const defaultProfile = profiles.find((p) => p.id === defaultProfileId);
  const defaultName = defaultProfile ? (defaultProfile.kind === 'wsl' ? `WSL · ${defaultProfile.label}` : defaultProfile.label) : null;
  const head = shortcut ? `${label} (${shortcut})` : label;
  const mainTitle = [head, description, defaultName ? `Shell: ${defaultName}` : null].filter(Boolean).join('\n');

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener('mousedown', onDown);
    rootRef.current?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus();
    return () => window.removeEventListener('mousedown', onDown);
  }, [open]);

  const pick = (id: string) => {
    setOpen(false);
    onPick(id);
  };

  return (
    <div
      className={`profile-menu${className ? ` ${className}` : ''}`}
      ref={rootRef}
      onKeyDown={(e) => {
        if (e.key === 'Escape' && open) {
          e.stopPropagation();
          setOpen(false);
          rootRef.current?.querySelector<HTMLButtonElement>('.profile-menu__toggle')?.focus();
        }
        if (open && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
          e.preventDefault();
          const items = [...(rootRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)') ?? [])];
          const index = items.indexOf(document.activeElement as HTMLButtonElement);
          const next = items[(index + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length];
          next?.focus();
        }
      }}
    >
      <div className={`split-button${compact ? ' split-button--compact' : ''}`}>
        <button
          type="button"
          className="button button--ghost split-button__main"
          disabled={disabled || !defaultProfileId}
          onClick={() => defaultProfileId && onPick(defaultProfileId)}
          title={mainTitle}
          aria-label={compact ? label : undefined}
          aria-description={description}
        >
          <Icon name={icon} size={16} />
          {!compact && <span>{label}</span>}
        </button>
        <button
          type="button"
          className="button button--ghost split-button__toggle profile-menu__toggle"
          aria-haspopup="menu"
          aria-expanded={open}
          aria-controls={menuId}
          aria-label={`${label}: choose shell`}
          title={`${label}: choose shell`}
          disabled={disabled}
          onClick={() => setOpen((v) => !v)}
        >
          <Icon name="chevronDown" size={14} />
        </button>
      </div>
      {open && (
        <div className="menu" role="menu" id={menuId} aria-label={heading ?? 'Shells'}>
          {heading && (
            <div className="menu__heading" aria-hidden="true">
              {heading}
            </div>
          )}
          {profiles.length === 0 && <div className="menu__note">No shells were found.</div>}
          {profiles.map((p) => (
            <button key={p.id} type="button" role="menuitem" className="menu__item" onClick={() => pick(p.id)}>
              <span className="menu__label">{p.kind === 'wsl' ? `WSL · ${p.label}` : p.label}</span>
              {p.id === defaultProfileId && <span className="menu__hint">{shortcut ? `${defaultHint} · ${shortcut}` : defaultHint}</span>}
            </button>
          ))}
          {guidance && (
            <div className="menu__note" role="note">
              <Icon name="warning" size={14} /> {guidance} See Settings for details.
            </div>
          )}
        </div>
      )}
    </div>
  );
}
