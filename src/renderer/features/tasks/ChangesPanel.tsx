// The docked Changes panel of a task workspace (right side): what the task changed against where it
// left its base branch, next to the terminals. The list is read again only when main's summary of
// the task changes (after a Git status check: select, focus, save, settled output, or the folder
// watch while this panel is shown); nothing here polls. Read-only: Finish does the rest.
import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import { api } from '../../api';
import { Icon } from '../../components/Icon';
import { IconButton } from '../../components/IconButton';
import { shortcutLabel } from '../commands/shortcuts';
import type { TaskChange, TaskChanges, TaskError, TaskSummary } from '../../../shared/tasks';
import { LIMITS, type Workspace } from '../../../shared/types';
import { changeCounts } from './diff-lines';
import { taskFacts } from './task-text';

const KIND_LABEL: Record<TaskChange['kind'], string> = { added: 'A', modified: 'M', deleted: 'D', renamed: 'R', copied: 'C', typechange: 'T', untracked: 'U' };
const KIND_TITLE: Record<TaskChange['kind'], string> = {
  added: 'Added',
  modified: 'Modified',
  deleted: 'Deleted',
  renamed: 'Renamed',
  copied: 'Copied',
  typechange: 'Type changed',
  untracked: 'New, not tracked by Git yet',
};

interface Props {
  workspace: Workspace;
  summary: TaskSummary | undefined;
  width: number;
  maxWidth: number;
  /** Increments when the panel should take the keyboard (opened by shortcut, palette or the sidebar). */
  focusToken: number;
  onWidthChange(width: number): void;
  onClose(): void;
  /** A file was chosen: show its changes. */
  onOpenDiff(path: string): void;
  onFinish(): void;
  /** Check Git now (for WSL tasks, which have no folder watch). */
  onRefresh(): void;
  /** Escape: back to the terminal. */
  onEscape(): void;
}

export function ChangesPanel(props: Props) {
  const { workspace, summary, width, maxWidth } = props;
  const task = workspace.task!;
  const [changes, setChanges] = useState<TaskChanges | null>(null);
  const [error, setError] = useState<TaskError | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const version = summary?.version ?? null;

  // The list, again whenever the summary says it changed (and once when shown).
  useEffect(() => {
    let alive = true;
    void api.taskChanges(workspace.id).then((r) => {
      if (!alive) return;
      if (r.ok) {
        setChanges(r.changes);
        setError(null);
      } else {
        setChanges(null);
        setError(r.error);
      }
    });
    return () => {
      alive = false;
    };
  }, [workspace.id, version]);

  // Taking the keyboard waits until there is something to focus (the list loads after the panel shows).
  const [wantFocus, setWantFocus] = useState(false);
  const panelRef = useRef<HTMLElement>(null);
  useEffect(() => {
    if (props.focusToken > 0) setWantFocus(true);
  }, [props.focusToken]);
  useEffect(() => {
    if (!wantFocus || (!changes && !error)) return;
    const el = listRef.current?.querySelector<HTMLElement>('[aria-selected="true"]') ?? listRef.current?.querySelector<HTMLElement>('[role="option"]') ?? panelRef.current;
    el?.focus();
    setWantFocus(false);
  }, [wantFocus, changes, error]);

  const files = changes?.files ?? [];
  const current = files.find((f) => f.path === selected) ?? null;

  const onKey = (e: KeyboardEvent<HTMLElement>, f: TaskChange) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      props.onOpenDiff(f.path);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      props.onEscape();
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'Home' || e.key === 'End') {
      e.preventDefault();
      const i = files.findIndex((x) => x.path === f.path);
      const next = e.key === 'Home' ? 0 : e.key === 'End' ? files.length - 1 : Math.max(0, Math.min(files.length - 1, i + (e.key === 'ArrowDown' ? 1 : -1)));
      const n = files[next];
      if (n) {
        setSelected(n.path);
        listRef.current?.querySelector<HTMLElement>(`[data-path="${CSS.escape(n.path)}"]`)?.focus();
      }
    }
  };

  // ------------------------------------------------------ width (the handle is on the panel's left edge)
  const drag = useRef<{ startX: number; startWidth: number } | null>(null);
  const clampWidth = (w: number) => Math.round(Math.min(maxWidth, Math.max(LIMITS.changesWidth.min, w)));
  const onHandleDown = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { startX: e.clientX, startWidth: width };
    e.preventDefault();
  };
  const onHandleMove = (e: PointerEvent<HTMLDivElement>) => {
    if (drag.current) props.onWidthChange(clampWidth(drag.current.startWidth - (e.clientX - drag.current.startX)));
  };
  const onHandleUp = (e: PointerEvent<HTMLDivElement>) => {
    drag.current = null;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
  };

  const facts = taskFacts(summary, task.baseBranch);
  const totals = summary && summary.files > 0 ? `${summary.approximate ? '≥' : ''}+${summary.added.toLocaleString('en-US')} −${summary.removed.toLocaleString('en-US')} in ${summary.files} ${summary.files === 1 ? 'file' : 'files'}` : null;

  return (
    <aside
      className="changes"
      style={{ width }}
      aria-label={`Changes in ${workspace.name}`}
      data-testid="changes-panel"
      ref={panelRef}
      tabIndex={-1}
      onKeyDown={(e) => {
        // Escape anywhere in the panel (not only on a file) returns to the terminal.
        if (e.key === 'Escape' && e.target === e.currentTarget) {
          e.preventDefault();
          props.onEscape();
        }
      }}
    >
      <div
        className="changes__handle"
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize changes panel"
        aria-valuemin={LIMITS.changesWidth.min}
        aria-valuemax={maxWidth}
        aria-valuenow={width}
        tabIndex={0}
        data-testid="changes-handle"
        onPointerDown={onHandleDown}
        onPointerMove={onHandleMove}
        onPointerUp={onHandleUp}
        onPointerCancel={onHandleUp}
        onKeyDown={(e) => {
          const step = e.shiftKey ? 40 : 10;
          // The panel grows to the left.
          if (e.key === 'ArrowLeft') props.onWidthChange(clampWidth(width + step));
          else if (e.key === 'ArrowRight') props.onWidthChange(clampWidth(width - step));
          else return;
          e.preventDefault();
        }}
      />
      <header className="changes__header">
        <div className="changes__title">
          <span className="changes__heading">Changes</span>
          <span className="changes__actions">
            <IconButton icon="restart" size="sm" label="Check for changes now" onClick={props.onRefresh} />
            <IconButton icon="close" size="sm" label="Hide changes panel" shortcut={shortcutLabel('toggleChanges')} onClick={props.onClose} />
          </span>
        </div>
        <div className="changes__branch" title={`${task.branch} → ${task.baseBranch}`}>
          <Icon name="gitBranch" size={12} />
          <code>{task.branch}</code>
          <span className="changes__arrow" aria-hidden="true">
            →
          </span>
          <code>{task.baseBranch}</code>
        </div>
        <div className="changes__facts" data-testid="changes-facts">
          {facts.map((f) => (
            <span key={f.text} className={`changes__fact changes__fact--${f.tone}`}>
              {f.text}
            </span>
          ))}
        </div>
        {totals && (
          <div className="changes__totals" data-testid="changes-totals">
            {totals}
          </div>
        )}
        <button type="button" className="button button--small button--primary changes__finish" data-testid="changes-finish" onClick={props.onFinish}>
          Finish task…
        </button>
      </header>
      {error ? (
        <p className="changes__note task-dialog__error" data-testid="changes-error">
          {error.message}
        </p>
      ) : !changes ? (
        <p className="changes__note settings__hint">Comparing…</p>
      ) : files.length === 0 ? (
        <p className="changes__note settings__hint" data-testid="changes-empty">
          No changes yet: the task folder matches {changes.baseBranch} where the task started.
        </p>
      ) : (
        <ul className="changes__list" role="listbox" aria-label="Changed files" ref={listRef} data-testid="changes-files" tabIndex={-1}>
          {files.map((f) => (
            <li key={f.path} role="none">
              <button
                type="button"
                role="option"
                aria-selected={f.path === (current?.path ?? files[0]!.path)}
                tabIndex={f.path === (current?.path ?? files[0]!.path) ? 0 : -1}
                className="changes__file"
                data-path={f.path}
                title={`${KIND_TITLE[f.kind]}${f.oldPath ? ` from ${f.oldPath}` : ''}${f.uncommitted ? ' · not committed yet' : ''}\nEnter: show changes`}
                onClick={() => {
                  setSelected(f.path);
                  props.onOpenDiff(f.path);
                }}
                onFocus={() => setSelected(f.path)}
                onKeyDown={(e) => onKey(e, f)}
              >
                <span className={`review__kind review__kind--${f.kind}`}>{KIND_LABEL[f.kind]}</span>
                <span className="review__path">
                  <span className="review__name">{f.path.split('/').pop()}</span>
                  {(f.oldPath || f.path.includes('/')) && <span className="review__dir">{f.oldPath ? `from ${f.oldPath}` : f.path.slice(0, f.path.lastIndexOf('/'))}</span>}
                </span>
                {f.uncommitted && <span className="review__dot" aria-label="not committed yet" />}
                <span className="review__counts">{changeCounts(f)}</span>
              </button>
            </li>
          ))}
          {(changes.truncated || changes.unlisted > 0) && <li className="settings__hint changes__more">More files changed than are listed here.</li>}
        </ul>
      )}
    </aside>
  );
}
