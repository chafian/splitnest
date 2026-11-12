// One notice per restored workspace instead of an explanation in every pane.
// Restoring brings back the layout only; starting creates new shells.
import { useSyncExternalStore } from 'react';
import { listTerminalTabs } from '../../../shared/layout';
import type { ShellDiscovery, Workspace } from '../../../shared/types';
import { Icon } from '../../components/Icon';
import { IconButton } from '../../components/IconButton';
import { summarizeRestore, type RestoredTerminal } from '../terminal/bulk-start';
import { tabLabel } from '../terminal/tab-label';
import { registry } from '../terminal/terminal-registry';

interface Props {
  workspace: Workspace;
  restoredTabIds: ReadonlySet<string>;
  discovery: ShellDiscovery | null;
  /** Set while "Start all shells" runs for this workspace. */
  progress: { total: number; settled: number } | null;
  onStartAll(): void;
  /** Resume the agent conversations of the restored terminals that had one (PowerShell only). */
  onResumeAll(): void;
  onRetry(tabId: string): void;
  onShow(tabId: string): void;
  onDismiss(): void;
}

export function restoredTerminals(workspace: Workspace, restoredTabIds: ReadonlySet<string>, discovery: ShellDiscovery | null): RestoredTerminal[] {
  return listTerminalTabs(workspace.layout)
    .filter((t) => restoredTabIds.has(t.id))
    .flatMap((t) => {
      const c = registry.get(t.id);
      if (!c) return [];
      const snap = c.getSnapshot();
      const profile = discovery?.profiles.find((p) => p.id === t.profileId);
      const shell = profile?.label ?? t.profileId;
      const l = tabLabel({ customName: t.name, profileId: t.profileId, shellLabel: shell });
      return [
        {
          tabId: t.id,
          label: l.secondary ? `${l.primary} (${l.secondary})` : l.primary,
          status: snap.status,
          hasStarted: snap.hasStarted,
          errorMessage: snap.error?.message ?? null,
        },
      ];
    });
}

export function RestoreNotice(props: Props) {
  // Re-render on session status changes (coarse; never per output chunk).
  useSyncExternalStore(registry.subscribe, registry.getVersion);
  const summary = summarizeRestore(restoredTerminals(props.workspace, props.restoredTabIds, props.discovery));
  if (!summary.visible) return null;
  const { pending, starting, failed } = summary;
  const busy = props.progress !== null;
  const pendingIds = new Set(pending.map((t) => t.tabId));
  const resumable = listTerminalTabs(props.workspace.layout).filter((t) => pendingIds.has(t.id) && t.resume);

  return (
    <div className="notice" role="region" aria-label="Restored layout">
      <div className="notice__row">
        <Icon name="restart" size={16} className="notice__icon" />
        <span className="notice__text">
          Layout restored. Start new shells to continue.
          <span className="notice__meta" aria-live="polite">
            {busy
              ? ` Starting shells… ${props.progress!.settled} of ${props.progress!.total} done.`
              : starting.length > 0
                ? ` ${starting.length} starting…`
                : pending.length > 0
                  ? ` ${pending.length} not started${failed.length ? `, ${failed.length} failed` : ''}.`
                  : ` ${failed.length} could not start.`}
          </span>
        </span>
        {resumable.length > 0 && (
          <button
            type="button"
            className="button button--small button--primary"
            data-testid="resume-all"
            onClick={props.onResumeAll}
            disabled={busy}
            title="Reopens the agent conversation that was running in each of these terminals: a new PowerShell in the agent's folder, with the resume command typed at its prompt. Other terminals are not touched."
          >
            <Icon name="play" size={14} /> {`Resume agents (${resumable.length})`}
          </button>
        )}
        {pending.length > 0 && (
          <button
            type="button"
            className={`button button--small${resumable.length ? '' : ' button--primary'}`}
            onClick={props.onStartAll}
            disabled={busy}
            title="Starts a new shell in each terminal of this workspace that has not started, including background tabs. Running terminals are not touched. Earlier processes are not resumed."
          >
            <Icon name="play" size={14} /> {busy ? 'Starting…' : `Start all shells (${pending.length})`}
          </button>
        )}
        <IconButton
          icon="close"
          size="sm"
          label="Dismiss notice"
          description="Terminals stay as they are; nothing is started or closed."
          onClick={props.onDismiss}
        />
      </div>
      {failed.length > 0 && (
        <ul className="notice__failures" aria-label="Terminals that could not start">
          {failed.map((t) => (
            <li key={t.tabId}>
              <Icon name="warning" size={14} className="notice__warn" />
              <span className="notice__failure-name">{t.label}</span>
              <span className="notice__failure-msg" title={t.errorMessage ?? undefined}>
                {t.errorMessage ?? 'Could not start.'}
              </span>
              <button type="button" className="button button--small" onClick={() => props.onRetry(t.tabId)}>
                Retry
              </button>
              <button type="button" className="button button--small button--ghost" onClick={() => props.onShow(t.tabId)}>
                Show
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
