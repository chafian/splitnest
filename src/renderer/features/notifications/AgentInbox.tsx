// The agent inbox: a title-bar button with the number of agents waiting for the user, and a
// dropdown that lists them (see "Inbox" in agent-notifier.ts for what is listed and in what
// order). Picking a row shows that agent's tab.
import { useEffect, useId, useRef, useState } from 'react';
import type { AgentId } from '../../../shared/agents';
import { isNeedsKind, type NoticeKind } from '../../../shared/notifications';
import { AgentIcon } from '../../components/AgentIcon';
import { Icon } from '../../components/Icon';

export interface InboxRow {
  tabId: string;
  kind: NoticeKind;
  agent: AgentId | null;
  /** "Claude Code needs permission". */
  title: string;
  /** "car-rental · Backend" (plus what the agent wrote, if the user allows that). */
  body: string;
  /** When it started waiting (ms since epoch). */
  since: number;
}

/** "now", "5 min", "2 h", "3 d": how long an agent has been waiting. */
export function waitedLabel(ms: number): string {
  const min = Math.floor(Math.max(0, ms) / 60_000);
  if (min < 1) return 'now';
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  return h < 24 ? `${h} h` : `${Math.floor(h / 24)} d`;
}

/** Accessible name of the button: what the number means. */
export function inboxLabel(rows: readonly Pick<InboxRow, 'kind'>[]): string {
  if (rows.length === 0) return 'Agent inbox: no agents are waiting';
  const needs = rows.filter((r) => isNeedsKind(r.kind)).length;
  const other = rows.length - needs;
  const parts = [needs ? `${needs} ${needs === 1 ? 'needs' : 'need'} you` : '', other ? `${other} to look at` : ''].filter(Boolean);
  return `Agent inbox: ${parts.join(', ')}`;
}

interface Props {
  rows: InboxRow[];
  open: boolean;
  onOpenChange(open: boolean): void;
  onPick(tabId: string): void;
  shortcut: string;
  nextShortcut: string;
}

export function AgentInbox({ rows, open, onOpenChange, onPick, shortcut, nextShortcut }: Props) {
  const rootRef = useRef<HTMLDivElement>(null);
  const menuId = useId();
  const [now, setNow] = useState(() => Date.now());
  const needs = rows.some((r) => isNeedsKind(r.kind));
  const label = inboxLabel(rows);

  useEffect(() => {
    if (!open) return;
    setNow(Date.now());
    const tick = window.setInterval(() => setNow(Date.now()), 20_000);
    const onDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) onOpenChange(false);
    };
    window.addEventListener('mousedown', onDown);
    const first = rootRef.current?.querySelector<HTMLButtonElement>('[role="menuitem"]');
    (first ?? rootRef.current?.querySelector<HTMLElement>('.inbox__empty'))?.focus();
    return () => {
      window.clearInterval(tick);
      window.removeEventListener('mousedown', onDown);
    };
    // onOpenChange is stable enough for a click-outside handler; rows are read at render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  return (
    <div
      className="inbox"
      ref={rootRef}
      onKeyDown={(e) => {
        if (!open) return;
        if (e.key === 'Escape') {
          e.stopPropagation();
          onOpenChange(false);
          rootRef.current?.querySelector<HTMLButtonElement>('.inbox__button')?.focus();
        } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
          e.preventDefault();
          const items = [...(rootRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') ?? [])];
          if (!items.length) return;
          const index = items.indexOf(document.activeElement as HTMLButtonElement);
          items[(index + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length]?.focus();
        }
      }}
    >
      <button
        type="button"
        className={`icon-button icon-button--md inbox__button${rows.length ? ' inbox__button--pending' : ''}${needs ? ' inbox__button--needs' : ''}`}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={menuId}
        aria-label={label}
        title={`${label} (${shortcut})\nNext waiting agent: ${nextShortcut}`}
        data-testid="inbox-button"
        data-count={rows.length}
        onClick={() => onOpenChange(!open)}
      >
        <Icon name="bell" size={16} />
        {rows.length > 0 && (
          <span className="inbox__count" aria-hidden="true">
            {rows.length > 9 ? '9+' : rows.length}
          </span>
        )}
      </button>
      {open && (
        <div className="menu inbox__menu" role="menu" id={menuId} aria-label="Agents waiting for you" data-testid="inbox-menu">
          <div className="menu__heading" aria-hidden="true">
            Agents waiting for you
          </div>
          {rows.length === 0 && (
            <div className="inbox__empty" tabIndex={-1}>
              No agents are waiting. An agent that needs you, finishes or stops with an error is listed here.
            </div>
          )}
          {rows.map((r) => (
            <button
              key={r.tabId}
              type="button"
              role="menuitem"
              className={`inbox__row inbox__row--${isNeedsKind(r.kind) ? 'needs' : r.kind}`}
              data-tab-id={r.tabId}
              data-kind={r.kind}
              title={`${r.title}\n${r.body}`}
              onClick={() => {
                onOpenChange(false);
                onPick(r.tabId);
              }}
            >
              <AgentIcon agent={r.agent} state={isNeedsKind(r.kind) ? 'needs-action' : r.kind === 'error' ? 'error' : 'done'} estimated={r.kind === 'maybe'} size={16} />
              <span className="inbox__text">
                <span className="inbox__title">{r.title}</span>
                <span className="inbox__body">{r.body}</span>
              </span>
              <span className="inbox__since">{waitedLabel(now - r.since)}</span>
            </button>
          ))}
          {rows.length > 0 && (
            <div className="inbox__foot" aria-hidden="true">
              <kbd className="kbd">{nextShortcut}</kbd> opens the next one
            </div>
          )}
        </div>
      )}
    </div>
  );
}
