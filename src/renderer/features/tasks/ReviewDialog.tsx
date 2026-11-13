// Review a task: the files it changed against the point where its branch left the base branch (what
// merging it would bring), committed or not, and each file's diff. Read-only; main runs Git.
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Dialog } from '../../components/Dialog';
import { api } from '../../api';
import type { TaskChange, TaskChanges, TaskDiff, TaskError } from '../../../shared/tasks';
import type { Workspace } from '../../../shared/types';
import { changeCounts, diffRows } from './diff-lines';

const KIND_LABEL: Record<TaskChange['kind'], string> = {
  added: 'A',
  modified: 'M',
  deleted: 'D',
  renamed: 'R',
  copied: 'C',
  typechange: 'T',
  untracked: 'U',
};
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
  open: boolean;
  workspace: Workspace | null;
  onClose(): void;
}

export function ReviewDialog({ open, workspace, onClose }: Props) {
  const [changes, setChanges] = useState<TaskChanges | null>(null);
  const [error, setError] = useState<TaskError | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [diff, setDiff] = useState<{ path: string; diff: TaskDiff } | { path: string; error: TaskError } | null>(null);
  const [loading, setLoading] = useState(false);
  const id = workspace?.id ?? null;

  const load = useCallback(async () => {
    if (!id) return;
    setLoading(true);
    const r = await api.taskChanges(id);
    setLoading(false);
    if (!r.ok) {
      setError(r.error);
      setChanges(null);
      return;
    }
    setError(null);
    setChanges(r.changes);
    setSelected((cur) => (cur && r.changes.files.some((f) => f.path === cur) ? cur : (r.changes.files[0]?.path ?? null)));
    setDiff(null);
  }, [id]);

  useEffect(() => {
    if (!open) return;
    setChanges(null);
    setError(null);
    setSelected(null);
    setDiff(null);
    void load();
  }, [open, load]);

  useEffect(() => {
    if (!open || !id || !selected) return;
    let alive = true;
    void api.taskDiff(id, selected).then((r) => {
      if (!alive) return;
      setDiff(r.ok ? { path: selected, diff: r.diff } : { path: selected, error: r.error });
    });
    return () => {
      alive = false;
    };
  }, [open, id, selected, changes]);

  const totals = useMemo(() => {
    if (!changes) return null;
    let added = 0;
    let removed = 0;
    for (const f of changes.files) {
      added += f.added ?? 0;
      removed += f.removed ?? 0;
    }
    return { files: changes.files.length, added, removed, uncommitted: changes.files.filter((f) => f.uncommitted).length };
  }, [changes]);

  const file = changes?.files.find((f) => f.path === selected) ?? null;
  const shown = diff && diff.path === selected ? diff : null;
  const rows = useMemo(() => (shown && 'diff' in shown ? diffRows(shown.diff.text) : null), [shown]);
  const task = workspace?.task;

  return (
    <Dialog
      title={`Review: ${workspace?.name ?? 'task'}`}
      open={open}
      onClose={onClose}
      width={1180}
      className="review-dialog"
      footer={
        <>
          <span className="review__footnote">Read-only. Merging a task from SplitNest comes in a later version.</span>
          <button type="button" className="button" data-testid="review-refresh" onClick={() => void load()} disabled={loading}>
            {loading ? 'Refreshing…' : 'Refresh'}
          </button>
          <button type="button" className="button button--primary" onClick={onClose}>
            Close
          </button>
        </>
      }
    >
      <div className="review__summary" data-testid="review-summary">
        {task && (
          <>
            <code>{task.branch}</code> against <code>{changes?.baseBranch ?? task.baseBranch}</code>
            {changes && <> (since {changes.mergeBase.slice(0, 7)})</>}
          </>
        )}
        {totals && (
          <span className="review__totals">
            {totals.files === 0
              ? 'No changes yet.'
              : `${totals.files} ${totals.files === 1 ? 'file' : 'files'} · +${totals.added} −${totals.removed}` +
                (totals.uncommitted ? ` · ${totals.uncommitted} not committed` : '')}
          </span>
        )}
      </div>
      {error ? (
        <p className="task-dialog__error" data-testid="review-error">
          {error.message}
        </p>
      ) : !changes ? (
        <p className="settings__hint">Comparing…</p>
      ) : changes.files.length === 0 ? (
        <p className="settings__hint" data-testid="review-empty">
          The task has no changes yet: its folder matches {changes.baseBranch} where the task started.
        </p>
      ) : (
        <div className="review">
          <ul className="review__files" role="listbox" aria-label="Changed files" data-testid="review-files">
            {changes.files.map((f) => (
              <li key={f.path} role="none">
                <button
                  type="button"
                  role="option"
                  aria-selected={f.path === selected}
                  className={`review__file${f.path === selected ? ' review__file--on' : ''}`}
                  data-path={f.path}
                  title={`${KIND_TITLE[f.kind]}${f.oldPath ? ` from ${f.oldPath}` : ''}${f.uncommitted ? ' · not committed yet' : ''}`}
                  onClick={() => setSelected(f.path)}
                  onKeyDown={(e) => {
                    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
                    e.preventDefault();
                    const i = changes.files.findIndex((x) => x.path === f.path) + (e.key === 'ArrowDown' ? 1 : -1);
                    const next = changes.files[Math.max(0, Math.min(changes.files.length - 1, i))];
                    if (next) {
                      setSelected(next.path);
                      (e.currentTarget.parentElement?.parentElement?.querySelector(`[data-path="${CSS.escape(next.path)}"]`) as HTMLElement | null)?.focus();
                    }
                  }}
                >
                  <span className={`review__kind review__kind--${f.kind}`}>{KIND_LABEL[f.kind]}</span>
                  <span className="review__path">
                    <span className="review__name">{f.path.split('/').pop()}</span>
                    {f.path.includes('/') && <span className="review__dir">{f.path.slice(0, f.path.lastIndexOf('/'))}</span>}
                  </span>
                  {f.uncommitted && <span className="review__dot" aria-label="not committed yet" />}
                  <span className="review__counts">{changeCounts(f)}</span>
                </button>
              </li>
            ))}
            {changes.truncated && <li className="settings__hint review__more">More files changed than are listed.</li>}
          </ul>
          <div className="review__diff" data-testid="review-diff" tabIndex={0} aria-label={file ? `Changes in ${file.path}` : 'Changes'}>
            {file && (
              <div className="review__diff-head">
                <span>{file.path}</span>
                {file.oldPath && <span className="settings__hint"> (from {file.oldPath})</span>}
              </div>
            )}
            {!shown ? (
              <p className="settings__hint review__pad">Loading…</p>
            ) : 'error' in shown ? (
              <p className="task-dialog__error review__pad">{shown.error.message}</p>
            ) : shown.diff.binary ? (
              <p className="settings__hint review__pad">A binary file or a link: no text to compare.</p>
            ) : shown.diff.text === '' && shown.diff.truncated ? (
              <p className="settings__hint review__pad">This file is too large to show here.</p>
            ) : (
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
            )}
            {shown && 'diff' in shown && (shown.diff.truncated || (rows?.hidden ?? 0) > 0) && shown.diff.text !== '' && (
              <p className="settings__hint review__pad">The rest of this file’s changes is too long to show here.</p>
            )}
          </div>
        </div>
      )}
    </Dialog>
  );
}
