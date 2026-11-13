// "New agent task": a name, the agent to start and the shell. Before anything is created it shows
// what will be made (branch, folder, base), asked from main with the workspace id and the name only.
import { useEffect, useRef, useState } from 'react';
import { Dialog } from '../../components/Dialog';
import { api } from '../../api';
import { agentById } from '../../../shared/agents';
import { TASK_AGENTS, TASK_LIMITS, isTaskName, type TaskAgent, type TaskError, type TaskPreview } from '../../../shared/tasks';
import type { GitStatus, ShellProfile, Workspace } from '../../../shared/types';
import { uncommittedNote } from './task-text';

export interface NewTaskChoice {
  name: string;
  agent: TaskAgent | null;
  profileId: string;
}

interface Props {
  open: boolean;
  workspace: Workspace | null;
  gitStatus: GitStatus | null;
  /** Shells a task can start in (PowerShell profiles; WSL comes later). */
  profiles: ShellProfile[];
  defaultProfileId: string | null;
  /** Creates the task; resolves with an error to show, or null when it was created. */
  onCreate(choice: NewTaskChoice): Promise<TaskError | null>;
  onClose(): void;
}

/** The base commit, shortened as Git shows it. */
const short = (commit: string) => commit.slice(0, 7);

export function NewTaskDialog(props: Props) {
  const { open, workspace } = props;
  const [name, setName] = useState('');
  const [agent, setAgent] = useState<TaskAgent | null>('claude');
  const [profileId, setProfileId] = useState('');
  const [preview, setPreview] = useState<TaskPreview | null>(null);
  const [problem, setProblem] = useState<TaskError | null>(null);
  const [busy, setBusy] = useState(false);
  const seq = useRef(0);

  useEffect(() => {
    if (!open) return;
    setName('');
    setPreview(null);
    setProblem(null);
    setBusy(false);
    const preferred = props.profiles.find((p) => p.id === props.defaultProfileId) ?? props.profiles[0];
    setProfileId(preferred?.id ?? '');
    // Only when the dialog opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // What would be created, asked shortly after typing stops (main derives every name and path).
  useEffect(() => {
    if (!open || !workspace) return;
    const n = ++seq.current;
    const typed = name.trim();
    const timer = setTimeout(
      () => {
        void api.previewTask(workspace.id, typed || 'task').then((r) => {
          if (n !== seq.current) return;
          if (r.ok) {
            setPreview(r.preview);
            setProblem(null);
          } else {
            setPreview(null);
            // An unusable name is shown at the field; anything else (not a repository…) blocks creating.
            setProblem(r.error.code === 'INVALID_NAME' ? null : r.error);
          }
        });
      },
      typed ? 250 : 0,
    );
    return () => clearTimeout(timer);
  }, [open, workspace, name]);

  const typed = name.trim();
  const nameOk = isTaskName(typed) && /[A-Za-z0-9]/.test(typed.normalize('NFKD'));
  const canCreate = !!workspace && nameOk && !!profileId && !!preview && !problem && !busy;
  const submit = async () => {
    if (!canCreate) return;
    setBusy(true);
    const error = await props.onCreate({ name: typed, agent, profileId });
    setBusy(false);
    if (error) setProblem(error);
    else props.onClose();
  };
  const note = preview ? uncommittedNote(props.gitStatus, preview.baseBranch) : null;

  return (
    <Dialog
      title="New agent task"
      open={open}
      onClose={() => !busy && props.onClose()}
      width={520}
      className="task-dialog"
      footer={
        <>
          <button type="button" className="button" onClick={props.onClose} disabled={busy}>
            Cancel
          </button>
          <button type="button" className="button button--primary" data-testid="task-create" onClick={() => void submit()} disabled={!canCreate}>
            {busy ? 'Creating…' : 'Create task'}
          </button>
        </>
      }
    >
      <p className="settings__hint task-dialog__intro">
        A task gets its own folder and Git branch, so an agent can work on it while you or other agents work on {workspace?.name ?? 'this workspace'}.
      </p>
      <label className="field">
        <span className="field__label">Task name</span>
        <input
          className="input"
          autoFocus
          data-testid="task-name"
          maxLength={TASK_LIMITS.maxNameLength}
          placeholder="Fix the login form"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              void submit();
            }
          }}
        />
      </label>
      {typed && !nameOk && <p className="task-dialog__error">Use at least one letter or digit.</p>}

      <div className="field">
        <span className="field__label" id="task-agent-label">
          Agent
        </span>
        <div className="segmented" role="radiogroup" aria-labelledby="task-agent-label">
          {[...TASK_AGENTS, null].map((a) => (
            <button
              key={a ?? 'none'}
              type="button"
              role="radio"
              aria-checked={agent === a}
              data-testid={`task-agent-${a ?? 'none'}`}
              className={`segmented__item${agent === a ? ' segmented__item--on' : ''}`}
              onClick={() => setAgent(a)}
            >
              {a ? (agentById(a)?.label ?? a) : 'None'}
            </button>
          ))}
        </div>
      </div>

      <label className="field">
        <span className="field__label">Shell</span>
        <select className="select" data-testid="task-shell" value={profileId} onChange={(e) => setProfileId(e.target.value)}>
          {props.profiles.map((p) => (
            <option key={p.id} value={p.id}>
              {p.label}
            </option>
          ))}
        </select>
      </label>
      {props.profiles.length === 0 && <p className="task-dialog__error">Tasks start in PowerShell, which wasn’t found. WSL support for tasks comes in a later version.</p>}

      <div className="task-dialog__preview" data-testid="task-preview" aria-live="polite">
        {problem ? (
          <p className="task-dialog__error" data-testid="task-problem">
            {problem.message}
          </p>
        ) : preview ? (
          <dl className="task-dialog__facts">
            <dt>Branch</dt>
            <dd>
              <code>{typed ? preview.branch : 'splitnest/…'}</code> from <code>{preview.baseBranch}</code> ({short(preview.baseCommit)})
            </dd>
            <dt>Folder</dt>
            <dd>
              <code>{typed ? preview.taskRoot : `${preview.repoRoot}.worktrees\\…`}</code>
            </dd>
            <dt>Starts</dt>
            <dd>
              {props.profiles.find((p) => p.id === profileId)?.label ?? 'A shell'}
              {agent ? (
                <>
                  , then {agentById(agent)?.label ?? agent} (types <code>{agent}</code>)
                </>
              ) : (
                ', nothing else'
              )}
            </dd>
          </dl>
        ) : (
          <p className="settings__hint">Checking the repository…</p>
        )}
        {note && (
          <p className="task-dialog__note" data-testid="task-uncommitted">
            {note}
          </p>
        )}
        {preview && <p className="settings__hint">Files Git ignores (such as node_modules or .env) aren’t in the new folder; set them up there if the task needs them.</p>}
      </div>
    </Dialog>
  );
}
