// Finish a task: commit what is left, merge the task branch into the branch it came from, and delete
// the task's folder and branch. Each step says what stops it and offers the way out; nothing is
// forced except Discard, which lists what is lost and asks first. Main runs Git and re-checks
// everything; this dialog only shows main's answers.
import { useCallback, useEffect, useState } from 'react';
import { Dialog } from '../../components/Dialog';
import { api } from '../../api';
import type { TaskError, TaskFinishCheck } from '../../../shared/tasks';
import type { Workspace } from '../../../shared/types';
import { finishPlan } from './finish-plan';

export type FinishOutcome = 'merged' | 'removed' | 'kept-branch' | 'discarded';
/** What happened to the task branch (from main; the toast says it as it is). */
export type BranchResult = 'deleted' | 'kept' | 'unmerged' | 'missing';

interface Props {
  open: boolean;
  workspace: Workspace | null;
  /** Editor tabs with unsaved changes in the task's workspace. */
  dirtyEditors: number;
  onSaveEditors(): Promise<void>;
  /** Ends the task workspace's terminals (before its folder is deleted). */
  onEndTerminals(): void;
  /** The task's folder is gone: remove its workspace from the list. */
  onDone(outcome: FinishOutcome, branch: BranchResult): void;
  onClose(): void;
}

const list = (files: string[], more: number) => files.slice(0, 6).join(', ') + (more > 6 ? ` and ${more - 6} more` : '');
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function FinishTaskDialog({ open, workspace, dirtyEditors, onSaveEditors, onEndTerminals, onDone, onClose }: Props) {
  const [check, setCheck] = useState<TaskFinishCheck | null>(null);
  const [error, setError] = useState<TaskError | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState('');
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const id = workspace?.id ?? null;
  const task = workspace?.task ?? null;

  const load = useCallback(async () => {
    if (!id) return;
    const r = await api.taskFinishCheck(id);
    if (r.ok) {
      setCheck(r.check);
      setError(null);
    } else {
      setCheck(null);
      setError(r.error);
    }
  }, [id]);

  useEffect(() => {
    if (!open) return;
    setCheck(null);
    setError(null);
    setNote(null);
    setBusy(null);
    setConfirmDiscard(false);
    setMessage(workspace?.name ?? '');
    void load();
    // Only when it opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, id]);

  /** Runs an action with the dialog busy; shows main's refusal, then reads the state again. */
  const run = async (label: string, fn: () => Promise<string | null>) => {
    setBusy(label);
    setNote(null);
    let result: string | null = null;
    try {
      result = await fn();
    } finally {
      // The steps first, then the note, so the two never disagree.
      await load();
      setBusy(null);
      setNote(result);
    }
  };

  /**
   * Deletes the folder. Main first refuses what would fail anyway (uncommitted files, a changed task);
   * only then are the terminals ended, and it is retried until main sees none running.
   */
  const removeFolder = async <T extends object>(fn: () => Promise<({ ok: true } & T) | { ok: false; error: TaskError }>): Promise<({ ok: true } & T) | { ok: false; error: TaskError }> => {
    let ended = false;
    for (let i = 0; ; i++) {
      const r = await fn();
      if (r.ok || r.error.code !== 'TERMINALS_RUNNING' || i >= 20) return r;
      if (!ended) {
        onEndTerminals();
        ended = true;
      }
      await pause(500);
    }
  };

  const base = task?.baseBranch ?? 'the base branch';
  const plan = check && task ? finishPlan(check, dirtyEditors, base) : null;

  const commit = () =>
    run('Committing…', async () => {
      const r = await api.taskCommit(id!, message);
      return r.ok ? `Committed ${r.commit.slice(0, 7)}.` : r.error.message;
    });
  const update = () =>
    run(`Bringing in ${base}…`, async () => {
      const r = await api.taskUpdate(id!);
      if (!r.ok) return r.error.message;
      if (r.result.outcome === 'conflicts') return `Conflicts are now in the task folder, in ${list(r.result.conflicts, r.result.conflicts.length)}. Resolve them there (or ask the agent), then Commit all.`;
      return r.result.outcome === 'updated' ? `Brought in the newer commits from ${base}.` : `${base} has nothing new.`;
    });
  const toMerge = check?.commitsToMerge ?? 0;
  const mergeAndClean = () =>
    run('Merging…', async () => {
      if (toMerge > 0) {
        const m = await api.taskMerge(id!);
        if (!m.ok) return m.error.message;
        if (m.result.outcome === 'conflicts') return `Merging would conflict in ${list(m.result.conflicts, m.result.conflicts.length)}, so it was undone: ${base} is exactly as before. Bring in ${base} to resolve the conflicts in the task first.`;
      }
      setBusy('Cleaning up…');
      const r = await removeFolder(() => api.taskRemove(id!, true));
      if (!r.ok) return `${toMerge > 0 ? `Merged into ${base}. ` : ''}The task folder wasn’t deleted: ${r.error.message}`;
      onDone(toMerge > 0 ? 'merged' : 'removed', r.branch === 'kept' ? 'kept' : r.branch);
      return null;
    });
  const keepBranch = () =>
    run('Removing the folder…', async () => {
      const r = await removeFolder(() => api.taskRemove(id!, false));
      if (!r.ok) return r.error.message;
      onDone('kept-branch', 'kept');
      return null;
    });
  /** The task's folder is already gone: tidy up (the branch is deleted only if merged). */
  const removeMissing = () =>
    run('Removing the task…', async () => {
      const r = await removeFolder(() => api.taskRemove(id!, true));
      if (!r.ok) return r.error.message;
      onDone('removed', r.branch === 'kept' ? 'kept' : r.branch);
      return null;
    });
  const discard = () =>
    run('Discarding…', async () => {
      const r = await removeFolder(() => api.taskDiscard(id!, check?.discardKey ?? ''));
      setConfirmDiscard(false);
      if (!r.ok) return r.error.code === 'STALE' ? `${r.error.message} The list below is up to date now.` : r.error.message;
      onDone('discarded', r.branch);
      return null;
    });

  return (
    <Dialog
      title={`Finish: ${workspace?.name ?? 'task'}`}
      open={open}
      onClose={() => !busy && onClose()}
      width={640}
      className="finish-dialog"
      footer={
        confirmDiscard ? (
          <>
            <button type="button" className="button" onClick={() => setConfirmDiscard(false)} disabled={!!busy}>
              Keep the task
            </button>
            <button type="button" className="button button--danger" data-testid="finish-discard-confirm" onClick={() => void discard()} disabled={!!busy}>
              Discard everything
            </button>
          </>
        ) : (
          <>
            <button type="button" className="button button--danger-ghost finish__discard" data-testid="finish-discard" onClick={() => setConfirmDiscard(true)} disabled={!!busy || !check}>
              Discard task…
            </button>
            <button type="button" className="button" onClick={onClose} disabled={!!busy}>
              Close
            </button>
            <button type="button" className="button" data-testid="finish-keep-branch" onClick={() => void keepBranch()} disabled={!!busy || !plan?.canRemove}>
              Remove folder, keep branch
            </button>
            <button type="button" className="button button--primary" data-testid="finish-merge" onClick={() => void mergeAndClean()} disabled={!!busy || !plan?.canMerge}>
              {busy ?? (check && check.commitsToMerge === 0 ? 'Clean up' : `Merge into ${base} and clean up`)}
            </button>
          </>
        )
      }
    >
      {error ? (
        <>
          <p className="task-dialog__error" data-testid="finish-error">
            {error.message}
          </p>
          {error.code === 'TASK_FOLDER_MISSING' && (
            <button type="button" className="button" data-testid="finish-remove-missing" onClick={() => void removeMissing()} disabled={!!busy}>
              Remove the task
            </button>
          )}
        </>
      ) : !check || !task || !plan ? (
        <p className="settings__hint">Checking the task…</p>
      ) : confirmDiscard ? (
        <div className="finish__discard-box" data-testid="finish-discard-box">
          <p className="dialog__message">Discard “{workspace?.name}”? This can’t be undone.</p>
          <ul className="finish__list">
            <li>
              The folder <code>{task.worktreePath}</code> is deleted
              {check.uncommittedCount > 0 ? <>, with {check.uncommittedCount} uncommitted {check.uncommittedCount === 1 ? 'file' : 'files'}: {list(check.uncommitted, check.uncommittedCount)}</> : check.hasUncommitted ? <>, with uncommitted changes (not all can be listed)</> : null}
              {check.ignoredCount > 0 ? <>, and files Git ignores there ({list(check.ignored, check.ignoredCount)})</> : null}.
            </li>
            <li>
              The branch <code>{task.branch}</code> is deleted
              {check.commitsToMerge === null ? (
                check.branchCommits > 0 ? (
                  <>
                    , with {check.branchCommits} {check.branchCommits === 1 ? 'commit' : 'commits'} made since the task started (whether {base} has them can’t be told)
                  </>
                ) : null
              ) : check.commitsToMerge > 0 ? (
                <>
                  , with {check.commitsToMerge} {check.commitsToMerge === 1 ? 'commit' : 'commits'} that {base} doesn’t have
                </>
              ) : null}
              .
            </li>
            {check.runningTerminals > 0 && <li>The task’s {check.runningTerminals === 1 ? 'terminal is' : `${check.runningTerminals} terminals are`} ended.</li>}
          </ul>
        </div>
      ) : (
        <ol className="finish__steps">
          <li className={`finish__step finish__step--${plan.commit.state}`} data-testid="finish-step-commit">
            <strong>Commit</strong>
            <p>{plan.commit.text}</p>
            {check.uncommittedCount > 0 && <p className="finish__files">{list(check.uncommitted, check.uncommittedCount)}</p>}
            {plan.commit.canCommit && (
              <div className="finish__commit">
                <input className="input" data-testid="finish-message" aria-label="Commit message" value={message} maxLength={1000} onChange={(e) => setMessage(e.target.value)} />
                <button type="button" className="button" data-testid="finish-commit" onClick={() => void commit()} disabled={!!busy || !message.trim()}>
                  Commit all
                </button>
              </div>
            )}
          </li>
          <li className={`finish__step finish__step--${plan.merge.state}`} data-testid="finish-step-merge">
            <strong>Merge into {base}</strong>
            <p>{plan.merge.text}</p>
            {check.preview === 'conflicts' && <p className="finish__files">{list(check.conflicts, check.conflicts.length)}</p>}
            {plan.merge.canUpdate && (
              <button type="button" className="button" data-testid="finish-update" onClick={() => void update()} disabled={!!busy}>
                Bring in latest {base}
              </button>
            )}
          </li>
          <li className={`finish__step finish__step--${plan.clean.state}`} data-testid="finish-step-clean">
            <strong>Clean up</strong>
            <p>
              Deletes the task folder <code>{task.worktreePath}</code> and, once merged, the branch <code>{task.branch}</code>.
            </p>
            {check.ignoredCount > 0 && (
              <p className="task-dialog__note" data-testid="finish-ignored">
                Also deleted: files Git ignores there ({list(check.ignored, check.ignoredCount)}).
              </p>
            )}
            {check.runningTerminals > 0 && (
              <p className="settings__hint">
                {check.runningTerminals === 1 ? 'Its terminal is' : `Its ${check.runningTerminals} terminals are`} ended first.
              </p>
            )}
            {dirtyEditors > 0 && (
              <p className="task-dialog__error">
                {dirtyEditors} {dirtyEditors === 1 ? 'file has' : 'files have'} unsaved changes in this task.{' '}
                <button type="button" className="button button--small" onClick={() => void onSaveEditors().then(load)}>
                  Save all
                </button>
              </p>
            )}
          </li>
        </ol>
      )}
      {busy && <p className="settings__hint" aria-live="polite">{busy}</p>}
      {note && (
        <p className="finish__note" role="status" data-testid="finish-note">
          {note}
        </p>
      )}
    </Dialog>
  );
}
