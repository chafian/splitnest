// A diff tab: a task's changes to one file, as a normal tab (move, split, maximise, close). It
// reads the diff from main when shown and again whenever the task's summary says the changes moved
// on (no polling); the scroll position stays. Never saved (see withoutDiffTabs). Text only: the
// diff is rendered as rows, never as HTML.
import { createContext, useContext, useEffect, useMemo, useState, type KeyboardEvent, type MouseEvent } from 'react';
import { api } from '../../api';
import { Icon } from '../../components/Icon';
import type { TaskDiff, TaskError, TaskSummary } from '../../../shared/tasks';
import type { DiffTab, Workspace } from '../../../shared/types';
import { iconUrl } from '../explorer/icon-urls';
import { diffRows } from './diff-lines';

/** Each task's summary, from App: diff tabs read their file again when its version changes. */
export const TaskSummaryContext = createContext<ReadonlyMap<string, TaskSummary>>(new Map());

const nameOf = (path: string) => path.slice(path.lastIndexOf('/') + 1);

export function DiffTabButton(props: {
  tab: DiffTab;
  selected: boolean;
  paneActive: boolean;
  dropBefore: boolean;
  dropAfter: boolean;
  onActivate(): void;
  onClose(): void;
  onKeyDown(e: KeyboardEvent<HTMLDivElement>): void;
  onContextMenu(e: MouseEvent<HTMLDivElement>): void;
  onDragStart(e: React.DragEvent<HTMLDivElement>): void;
}) {
  const { tab } = props;
  const name = nameOf(tab.path);
  return (
    <div
      role="tab"
      data-tab-id={tab.id}
      data-diff-path={tab.path}
      aria-selected={props.selected}
      aria-label={`${name}, changes in this task`}
      tabIndex={props.selected ? 0 : -1}
      draggable
      className={`tab tab--file tab--diff${props.selected ? ' tab--selected' : ''}${props.selected && props.paneActive ? ' tab--focused' : ''}${props.dropBefore ? ' tab--drop-before' : ''}${props.dropAfter ? ' tab--drop-after' : ''}`}
      title={`${tab.path.replace(/\//g, '\\')}\nChanges in this task (not saved with the layout). Right-click for more.`}
      onMouseDown={(e) => {
        if (e.button === 1) {
          e.preventDefault();
          props.onClose();
        }
      }}
      onClick={props.onActivate}
      onKeyDown={props.onKeyDown}
      onContextMenu={props.onContextMenu}
      onDragStart={props.onDragStart}
    >
      <img className="tab__file-icon" src={iconUrl('file', name)} alt="" width={16} height={16} draggable={false} />
      <span className="tab__label">
        <span className="tab__name">{name}</span>
        <span className="tab__shell">changes</span>
      </span>
      <button
        type="button"
        className="tab__close"
        tabIndex={-1}
        aria-label={`Close changes of ${name}`}
        title="Close (middle-click also works)"
        onClick={(e) => {
          e.stopPropagation();
          props.onClose();
        }}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <Icon name="close" size={14} />
      </button>
    </div>
  );
}

export function DiffTabView(props: { tab: DiffTab; workspace: Workspace; visible: boolean }) {
  const { tab, workspace } = props;
  const summaries = useContext(TaskSummaryContext);
  const version = summaries.get(workspace.id)?.version ?? null;
  const [state, setState] = useState<{ diff: TaskDiff } | { error: TaskError } | null>(null);

  // Read when first shown, then again when the task's changes moved on (only while shown: a
  // background tab catches up when it is selected).
  useEffect(() => {
    if (!props.visible) return;
    let alive = true;
    void api.taskDiff(workspace.id, tab.path).then((r) => {
      if (alive) setState(r.ok ? { diff: r.diff } : { error: r.error });
    });
    return () => {
      alive = false;
    };
  }, [workspace.id, tab.path, version, props.visible]);

  const rows = useMemo(() => (state && 'diff' in state ? diffRows(state.diff.text) : null), [state]);
  const counts = useMemo(() => {
    if (!rows) return null;
    let added = 0;
    let removed = 0;
    for (const r of rows.rows) {
      if (r.kind === 'add') added++;
      else if (r.kind === 'del') removed++;
    }
    return { added, removed };
  }, [rows]);

  return (
    <div className="tabview diffview" data-tab-id={tab.id} data-diff-tab-id={tab.id} hidden={!props.visible} tabIndex={-1} aria-label={`Changes in ${tab.path}`}>
      <div className="diffview__head">
        <span className="diffview__path" title={tab.path}>
          {tab.path}
        </span>
        {counts && (counts.added > 0 || counts.removed > 0) && (
          <span className="diffview__counts">
            <span className="ws-item__git-added">+{counts.added}</span> <span className="ws-item__git-removed">−{counts.removed}</span>
          </span>
        )}
        {workspace.task && (
          <span className="diffview__base">
            against where the task left <code>{workspace.task.baseBranch}</code>
          </span>
        )}
      </div>
      <div className="diffview__body" data-testid="diff-body">
        {!state ? (
          <p className="settings__hint review__pad">Loading…</p>
        ) : 'error' in state ? (
          <p className={`review__pad ${state.error.code === 'NOT_CHANGED' ? 'settings__hint' : 'task-dialog__error'}`} data-testid="diff-note">
            {state.error.code === 'NOT_CHANGED' ? 'This file has no changes in the task anymore (they were undone, or the file is back as it was).' : state.error.message}
          </p>
        ) : state.diff.binary ? (
          <p className="settings__hint review__pad" data-testid="diff-note">
            A binary file or a link: no text to compare.
          </p>
        ) : state.diff.text === '' && state.diff.truncated ? (
          <p className="settings__hint review__pad" data-testid="diff-note">
            This file is too large to show here.
          </p>
        ) : (
          <>
            <table className="diff">
              <tbody>
                {rows!.rows.map((r, i) => (
                  <tr key={i} className={`diff__row diff__row--${r.kind}`}>
                    <td className="diff__no">{r.oldNo ?? ''}</td>
                    <td className="diff__no">{r.newNo ?? ''}</td>
                    <td className="diff__sign">{r.kind === 'add' ? '+' : r.kind === 'del' ? '−' : ''}</td>
                    <td className="diff__text">{r.text}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {(state.diff.truncated || rows!.hidden > 0) && (
              <p className="settings__hint review__pad" data-testid="diff-note">
                The rest of this file’s changes is too long to show here.
              </p>
            )}
          </>
        )}
      </div>
    </div>
  );
}
