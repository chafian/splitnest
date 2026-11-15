// The docked panel of a normal workspace in a Git repository: Source Control. What changed, staged
// and not; each file's diff as a tab; stage, unstage and discard (confirmed); commit; push and pull
// (fast-forward only). Main runs every Git command (main/source-control.ts); the page sends the
// workspace id, paths from main's own listing and the message. Read again after each action, when
// a Git status check of the workspace finishes (select, focus, save, settled output, the folder
// watch while this panel is shown), and on Refresh; nothing here polls.
import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import { api } from '../../api';
import { Icon } from '../../components/Icon';
import { IconButton } from '../../components/IconButton';
import type { ConfirmRequest } from '../../components/Dialog';
import { shortcutLabel } from '../commands/shortcuts';
import { SC_LIMITS, type ScError, type ScFile, type ScResult, type ScStatus } from '../../../shared/source-control';
import { LIMITS, type Workspace } from '../../../shared/types';
import { changeCounts } from './diff-lines';

const KIND_LABEL: Record<ScFile['kind'], string> = { added: 'A', modified: 'M', deleted: 'D', renamed: 'R', copied: 'C', typechange: 'T', untracked: 'U', conflicted: '!' };
const KIND_TITLE: Record<ScFile['kind'], string> = {
  added: 'Added',
  modified: 'Modified',
  deleted: 'Deleted',
  renamed: 'Renamed',
  copied: 'Copied',
  typechange: 'Type changed',
  untracked: 'New, not tracked by Git yet',
  conflicted: 'Conflict: resolve it, then stage it',
};

interface Props {
  workspace: Workspace;
  width: number;
  maxWidth: number;
  /** Increments when the panel should take the keyboard (opened by shortcut or palette). */
  focusToken: number;
  onWidthChange(width: number): void;
  onClose(): void;
  /** A file was chosen: show its staged or unstaged changes (`here`: as a tab in the active pane). */
  onOpenDiff(path: string, staged: boolean, here: boolean): void;
  /** The repository changed (open diff tabs read again). */
  onChanged(): void;
  /** Check Git now. */
  onRefresh(): void;
  confirm(request: ConfirmRequest): void;
  /** Escape: back to the terminal. */
  onEscape(): void;
}

type Row = { file: ScFile; staged: boolean };
const rowKey = (r: Row) => `${r.staged ? 's' : 'u'}:${r.file.path}`;

export function SourceControlPanel(props: Props) {
  const { workspace, width, maxWidth } = props;
  const [status, setStatus] = useState<ScStatus | null>(null);
  const [error, setError] = useState<ScError | null>(null);
  const [actionError, setActionError] = useState<ScError | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState('');
  const [selected, setSelected] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLElement>(null);
  const onChanged = props.onChanged;

  const load = useCallback(async () => {
    const r = await api.scStatus(workspace.id);
    if (r.ok) {
      setStatus(r.status);
      setError(null);
    } else {
      setStatus(null);
      setError(r.error);
    }
  }, [workspace.id]);

  useEffect(() => {
    void load();
    return api.onGitChecked((id) => {
      if (id === workspace.id) void load();
    });
  }, [load, workspace.id]);

  /** Runs one action; its result's status replaces the list, an error is shown under the commit box. */
  const act = async <T extends { status: ScStatus }>(label: string, run: () => Promise<ScResult<T>>, done?: (r: T) => string | null) => {
    if (busy) return;
    setBusy(label);
    setActionError(null);
    setNotice(null);
    try {
      const r = await run();
      if (r.ok) {
        setStatus(r.status);
        setError(null);
        setNotice(done ? done(r) : null);
        onChanged();
      } else {
        setActionError(r.error);
        void load();
      }
    } finally {
      setBusy(null);
    }
  };

  const staged = status?.staged ?? [];
  const unstaged = status?.unstaged ?? [];
  const rows: Row[] = [...staged.map((file) => ({ file, staged: true })), ...unstaged.map((file) => ({ file, staged: false }))];
  const current = rows.find((r) => rowKey(r) === selected) ?? rows[0] ?? null;

  const commit = () => {
    const text = message.trim();
    if (!text || busy) return;
    const all = staged.length === 0;
    void act('Committing', () => api.scCommit(workspace.id, text, all), (r) => {
      setMessage('');
      return `Committed ${(r as { commit?: string }).commit ?? ''}.`.replace(' .', '.');
    });
  };

  const push = async () => {
    if (!status || busy) return;
    if (status.upstream) {
      void act('Pushing', () => api.scPush(workspace.id), () => 'Pushed.');
      return;
    }
    const t = await api.scPushTarget(workspace.id);
    if (!t.ok) {
      setActionError(t.error);
      return;
    }
    props.confirm({
      title: 'Push and track this branch?',
      message: `“${t.target.branch}” has no upstream branch yet. Push it to “${t.target.remote}” and track it there?`,
      detail: `git push -u ${t.target.remote} ${t.target.branch}`,
      confirmLabel: 'Push',
      onConfirm: () => void act('Pushing', () => api.scPush(workspace.id, t.target), () => `Pushed and tracking ${t.target.remote}/${t.target.branch}.`),
    });
  };

  const discard = async (f: ScFile) => {
    const p = await api.scDiscardPreview(workspace.id, f.path);
    if (!p.ok) {
      setActionError(p.error);
      return;
    }
    const remove = p.preview.action === 'delete';
    props.confirm({
      title: remove ? 'Delete this new file?' : 'Discard changes?',
      message: remove
        ? `“${f.path}” isn’t tracked by Git. Discarding deletes the file. This can’t be undone.`
        : `Undo the changes to “${f.path}” that aren’t staged? The file goes back to its staged (or last committed) version. This can’t be undone.`,
      confirmLabel: remove ? 'Delete file' : 'Discard changes',
      danger: true,
      onConfirm: () => void act('Discarding', () => api.scDiscard(workspace.id, f.path, p.preview.key)),
    });
  };

  // Taking the keyboard waits until there is something to focus.
  const [wantFocus, setWantFocus] = useState(false);
  useEffect(() => {
    if (props.focusToken > 0) setWantFocus(true);
  }, [props.focusToken]);
  useEffect(() => {
    if (!wantFocus || (!status && !error)) return;
    const el = listRef.current?.querySelector<HTMLElement>('[aria-selected="true"]') ?? panelRef.current?.querySelector<HTMLElement>('.sc__message') ?? panelRef.current;
    el?.focus();
    setWantFocus(false);
  }, [wantFocus, status, error]);

  const onKey = (e: KeyboardEvent<HTMLElement>, r: Row) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      props.onOpenDiff(r.file.path, r.staged, e.ctrlKey);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      props.onEscape();
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'Home' || e.key === 'End') {
      e.preventDefault();
      const i = rows.findIndex((x) => rowKey(x) === rowKey(r));
      const next = e.key === 'Home' ? 0 : e.key === 'End' ? rows.length - 1 : Math.max(0, Math.min(rows.length - 1, i + (e.key === 'ArrowDown' ? 1 : -1)));
      const n = rows[next];
      if (n) {
        setSelected(rowKey(n));
        listRef.current?.querySelector<HTMLElement>(`[data-row="${CSS.escape(rowKey(n))}"]`)?.focus();
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

  const fileRow = (r: Row) => {
    const f = r.file;
    const key = rowKey(r);
    const isCurrent = current !== null && rowKey(current) === key;
    return (
      <li key={key} className="sc__row" role="none">
        <button
          type="button"
          role="option"
          aria-selected={isCurrent}
          tabIndex={isCurrent ? 0 : -1}
          className="changes__file"
          data-row={key}
          data-path={f.path}
          data-staged={r.staged ? 'true' : 'false'}
          title={`${KIND_TITLE[f.kind]}${f.oldPath ? ` from ${f.oldPath}` : ''}${r.staged ? ' · staged' : ''}\nEnter: show changes beside the terminal · Ctrl+Enter: in this pane`}
          onClick={(e) => {
            setSelected(key);
            props.onOpenDiff(f.path, r.staged, e.ctrlKey);
          }}
          onFocus={() => setSelected(key)}
          onKeyDown={(e) => onKey(e, r)}
        >
          <span className={`review__kind review__kind--${f.kind}`}>{KIND_LABEL[f.kind]}</span>
          <span className="review__path">
            <span className="review__name">{f.path.split('/').pop()}</span>
            {(f.oldPath || f.path.includes('/')) && <span className="review__dir">{f.oldPath ? `from ${f.oldPath}` : f.path.slice(0, f.path.lastIndexOf('/'))}</span>}
          </span>
          <span className="review__counts">{changeCounts({ ...f, kind: f.kind === 'conflicted' ? 'modified' : f.kind })}</span>
        </button>
        <span className="sc__row-actions">
          {r.staged ? (
            <IconButton icon="minus" size="sm" label={`Unstage ${f.path}`} disabled={!!busy} onClick={() => void act('Unstaging', () => api.scUnstage(workspace.id, [f.path]))} />
          ) : (
            <>
              {f.kind !== 'conflicted' && <IconButton icon="discard" size="sm" label={`Discard changes to ${f.path}`} disabled={!!busy} onClick={() => void discard(f)} />}
              <IconButton icon="plus" size="sm" label={`Stage ${f.path}`} disabled={!!busy} onClick={() => void act('Staging', () => api.scStage(workspace.id, [f.path]))} />
            </>
          )}
        </span>
      </li>
    );
  };

  const total = staged.length + unstaged.length;
  const where = status ? (status.branch ?? (status.head ? `detached at ${status.head}` : 'no branch')) : null;

  return (
    <aside
      className="changes sc"
      style={{ width }}
      aria-label={`Source control for ${workspace.name}`}
      data-testid="sc-panel"
      ref={panelRef}
      tabIndex={-1}
      onKeyDown={(e) => {
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
        aria-label="Resize source control panel"
        aria-valuemin={LIMITS.changesWidth.min}
        aria-valuemax={maxWidth}
        aria-valuenow={width}
        tabIndex={0}
        onPointerDown={onHandleDown}
        onPointerMove={onHandleMove}
        onPointerUp={onHandleUp}
        onPointerCancel={onHandleUp}
        onKeyDown={(e) => {
          const step = e.shiftKey ? 40 : 10;
          if (e.key === 'ArrowLeft') props.onWidthChange(clampWidth(width + step));
          else if (e.key === 'ArrowRight') props.onWidthChange(clampWidth(width - step));
          else return;
          e.preventDefault();
        }}
      />
      <header className="changes__header">
        <div className="changes__title">
          <span className="changes__heading">Source control</span>
          {total > 0 && <span className="changes__count">{total}</span>}
          <span className="changes__actions">
            <IconButton icon="restart" size="sm" label="Check for changes now" onClick={props.onRefresh} />
            <IconButton icon="close" size="sm" label="Hide source control panel" shortcut={shortcutLabel('toggleChanges')} onClick={props.onClose} />
          </span>
        </div>
        {status && (
          <div className="changes__meta" data-testid="sc-branch">
            <Icon name="gitBranch" size={12} className="ws-item__git-icon" />
            <span className="changes__base">{where}</span>
            {status.upstream ? (
              <span className="sc__sync" title={`Upstream: ${status.upstream}. ${status.ahead} to push, ${status.behind} to pull (as of the last fetch).`}>
                ↑{status.ahead} ↓{status.behind}
              </span>
            ) : (
              status.branch && <span className="changes__fact changes__fact--muted">not pushed yet</span>
            )}
            {status.operation && <span className="changes__fact changes__fact--warn">{status.operation} in progress</span>}
          </div>
        )}
      </header>

      {error ? (
        <p className="changes__note task-dialog__error" data-testid="sc-error">
          {error.message}
        </p>
      ) : !status ? (
        <p className="changes__note settings__hint">Reading…</p>
      ) : (
        <>
          <div className="sc__commit">
            <textarea
              className="input sc__message"
              rows={2}
              maxLength={SC_LIMITS.maxMessage}
              placeholder="Message (Ctrl+Enter to commit)"
              aria-label="Commit message"
              data-testid="sc-message"
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && e.ctrlKey) {
                  e.preventDefault();
                  commit();
                } else if (e.key === 'Escape') {
                  e.preventDefault();
                  props.onEscape();
                }
              }}
            />
            <div className="sc__buttons">
              <button
                type="button"
                className="button button--primary button--small sc__commit-button"
                data-testid="sc-commit"
                disabled={!!busy || !message.trim() || (total === 0 && status.operation !== 'merge')}
                title={staged.length ? 'Commit the staged changes (Ctrl+Enter)' : 'Stage every change and commit it (Ctrl+Enter)'}
                onClick={commit}
              >
                {staged.length || total === 0 ? 'Commit' : 'Stage all and commit'}
              </button>
              <button type="button" className="button button--small" data-testid="sc-push" disabled={!!busy || !status.branch} onClick={() => void push()} title={status.upstream ? `Push to ${status.upstream}` : 'Push this branch (asks where first)'}>
                <Icon name="push" size={13} /> Push{status.ahead > 0 ? ` ${status.ahead}` : ''}
              </button>
              <button
                type="button"
                className="button button--small"
                data-testid="sc-pull"
                disabled={!!busy || !status.upstream}
                onClick={() => void act('Pulling', () => api.scPull(workspace.id), () => 'Pulled.')}
                title={status.upstream ? `Pull from ${status.upstream} (fast-forward only)` : 'No upstream branch to pull from'}
              >
                <Icon name="pull" size={13} /> Pull{status.behind > 0 ? ` ${status.behind}` : ''}
              </button>
            </div>
            <div aria-live="polite" className="sc__feedback">
              {busy && <p className="settings__hint" data-testid="sc-busy">{busy}…</p>}
              {actionError && (
                <div className="task-dialog__error" data-testid="sc-action-error">
                  <p>{actionError.message}</p>
                  {actionError.detail && <pre className="sc__detail">{actionError.detail}</pre>}
                </div>
              )}
              {notice && !busy && (
                <p className="settings__hint" data-testid="sc-notice">
                  {notice}
                </p>
              )}
            </div>
          </div>

          <div className="sc__lists" ref={listRef} role="listbox" aria-label="Changed files" tabIndex={-1} data-testid="sc-files">
            {total === 0 && (
              <p className="changes__note settings__hint" data-testid="sc-clean">
                No changes: the folder matches the last commit.
              </p>
            )}
            {staged.length > 0 && (
              <section className="sc__group" data-testid="sc-staged">
                <h3 className="sc__group-title">
                  Staged <span className="changes__count">{staged.length}</span>
                  <button type="button" className="sc__group-action" disabled={!!busy} onClick={() => void act('Unstaging', () => api.scUnstage(workspace.id, 'all'))}>
                    Unstage all
                  </button>
                </h3>
                <ul className="changes__list" role="group" aria-label="Staged changes">
                  {staged.map((file) => fileRow({ file, staged: true }))}
                </ul>
              </section>
            )}
            {unstaged.length > 0 && (
              <section className="sc__group" data-testid="sc-unstaged">
                <h3 className="sc__group-title">
                  Changes <span className="changes__count">{unstaged.length}</span>
                  <button type="button" className="sc__group-action" disabled={!!busy} onClick={() => void act('Staging', () => api.scStage(workspace.id, 'all'))}>
                    Stage all
                  </button>
                </h3>
                <ul className="changes__list" role="group" aria-label="Changes not staged">
                  {unstaged.map((file) => fileRow({ file, staged: false }))}
                </ul>
              </section>
            )}
            {(status.truncated || status.unlisted > 0) && <p className="settings__hint changes__more">More files changed than are listed here.</p>}
          </div>
        </>
      )}
    </aside>
  );
}
