import type { TaskProgress } from '../../../shared/tasks';
import { taskProgressText, wslDistroOf } from '../tasks/task-text';
import { useRef, type PointerEvent } from 'react';
import type { GitStatus, Workspace } from '../../../shared/types';
import { listPanes, listTerminalTabs } from '../../../shared/layout';
import { LIMITS } from '../../../shared/types';
import { Icon } from '../../components/Icon';
import { IconButton } from '../../components/IconButton';
import { shortcutLabel } from '../commands/shortcuts';
import { shellsRunningLabel } from '../terminal/shell-count';
import type { SidebarMode } from './chrome';
import { gitLabel } from './git-label';

interface Props {
  workspaces: Workspace[];
  activeId: string | null;
  mode: SidebarMode;
  width: number;
  maxWidth: number;
  liveCounts: Map<string, number>;
  /** AI agents per workspace: how many need the user / are working. */
  agentCounts: Map<string, { needs: number; maybe: number; working: number; total: number }>;
  missing: Set<string>;
  /** Git state per workspace (empty when the setting is off or a folder is not in a repository). */
  gitStatuses: ReadonlyMap<string, GitStatus>;
  onSelect(id: string): void;
  onAdd(): void;
  onRename(id: string): void;
  onRemove(id: string): void;
  /** Agent tasks (preview setting): a New task button on rows in a Git repository. */
  tasksEnabled: boolean;
  /** Each task's commits against its base branch. */
  taskProgress: ReadonlyMap<string, TaskProgress>;
  onNewTask(id: string): void;
  /** A task's Review dialog (its changes against its base branch). */
  onReviewTask(id: string): void;
  onWidthChange(width: number): void;
  onSettings(): void;
  onShortcuts(): void;
  onPalette(): void;
  /** The settings page is open: it gets a row under the workspaces (like a workspace). */
  settingsShown: boolean;
  /** …and it is the page on screen (the row is the selected one). */
  settingsActive: boolean;
  onShowSettings(): void;
  onCloseSettings(): void;
}

/**
 * "1 agent needs you · 2 working", or "" when no agent is busy or waiting. Estimated
 * "needs you" (a bell from an agent that doesn't report) reads "may need you".
 */
export function agentSummaryText(c: { needs: number; maybe?: number; working: number }): string {
  const maybe = c.maybe ?? 0;
  const parts = [
    c.needs > 0 ? `${c.needs} ${c.needs === 1 ? 'agent needs' : 'agents need'} you` : '',
    maybe > 0 ? (c.needs > 0 ? `${maybe} may` : `${maybe} ${maybe === 1 ? 'agent may need' : 'agents may need'} you`) : '',
    c.working > 0 ? (c.needs + maybe > 0 ? `${c.working} working` : `${c.working} ${c.working === 1 ? 'agent' : 'agents'} working`) : '',
  ].filter(Boolean);
  return parts.join(' · ');
}

function folderTail(p: string): string {
  const parts = p.split(/[\\/]/).filter(Boolean);
  return parts.length <= 2 ? p : `…\\${parts.slice(-2).join('\\')}`;
}

export function Sidebar(props: Props) {
  const { workspaces, activeId, mode } = props;
  const collapsed = mode === 'rail';

  // ------------------------------------------------------ width resizing
  const drag = useRef<{ startX: number; startWidth: number } | null>(null);
  const clampWidth = (w: number) => Math.round(Math.min(props.maxWidth, Math.max(LIMITS.sidebarWidth.min, w)));
  const onHandleDown = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { startX: e.clientX, startWidth: props.width };
    e.preventDefault();
  };
  const onHandleMove = (e: PointerEvent<HTMLDivElement>) => {
    if (drag.current) props.onWidthChange(clampWidth(drag.current.startWidth + e.clientX - drag.current.startX));
  };
  const onHandleUp = (e: PointerEvent<HTMLDivElement>) => {
    drag.current = null;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
  };

  return (
    <nav className={`sidebar${collapsed ? ' sidebar--collapsed' : ''}`} aria-label="Workspaces" hidden={mode === 'hidden'}>
      <div className="sidebar__section">
        {!collapsed && <h2 className="sidebar__heading">Workspaces</h2>}
        <IconButton
          icon="folderPlus"
          size="sm"
          label="New workspace from folder…"
          description="Pick a project folder. Files are never changed."
          shortcut={shortcutLabel('newWorkspace')}
          onClick={props.onAdd}
        />
      </div>

      <ul className="sidebar__list">
        {workspaces.map((w) => {
          // Running shell sessions only (background tabs included; not starting, failed, exited or editor tabs).
          const live = props.liveCounts.get(w.id) ?? 0;
          const panes = listPanes(w.layout).length;
          const terminals = listTerminalTabs(w.layout).length;
          const missing = props.missing.has(w.id);
          // While the settings page is on screen, it (not the workspace) is the selected row.
          const active = w.id === activeId && !props.settingsActive;
          const agents = props.agentCounts.get(w.id) ?? { needs: 0, maybe: 0, working: 0, total: 0 };
          const agentText = agentSummaryText(agents);
          const gitStatus = props.gitStatuses.get(w.id);
          const git = gitStatus ? gitLabel(gitStatus) : null;
          const description =
            `${panes} ${panes === 1 ? 'pane' : 'panes'}, ${terminals} ${terminals === 1 ? 'terminal' : 'terminals'}, ${shellsRunningLabel(live)}` +
            (agentText ? `, ${agentText}` : '') +
            (git ? `, ${git.summary}` : '') +
            (missing ? ', folder missing' : '');
          return (
            <li key={w.id} className={`ws-item${active ? ' ws-item--active' : ''}${w.task ? ' ws-item--task' : ''}`} data-task={w.task ? 'true' : undefined}>
              <button
                type="button"
                className="ws-item__main"
                aria-current={active ? 'page' : undefined}
                aria-label={collapsed ? `${w.name} (${description})` : undefined}
                aria-description={collapsed ? undefined : description}
                title={`${w.name}${active ? ' (current workspace)' : ''}\n${w.rootPath}\n${description}`}
                onClick={() => props.onSelect(w.id)}
              >
                {collapsed ? (
                  <span className="ws-item__badge" aria-hidden="true">
                    {w.name.slice(0, 2).toUpperCase()}
                    {live > 0 && <span className={`ws-item__live-dot${agents.needs > 0 ? ' ws-item__live-dot--needs' : ''}`} />}
                  </span>
                ) : (
                  <>
                    <span className="ws-item__name">
                      {missing && <Icon name="warning" size={14} className="ws-item__warn" />}
                      <span className="ws-item__label">{w.name}</span>
                    </span>
                    <span className="ws-item__path">{folderTail(w.rootPath)}</span>
                    {git && (
                      <span className="ws-item__git" title={git.tooltip}>
                        <Icon name="gitBranch" size={12} className="ws-item__git-icon" />
                        <span className="ws-item__git-branch">{git.branch}</span>
                        {git.lines && (
                          <span className="ws-item__git-lines">
                            <span className="ws-item__git-added">{git.lines.added}</span> <span className="ws-item__git-removed">{git.lines.removed}</span>
                          </span>
                        )}
                        {git.dot && <span className="ws-item__git-dot" aria-hidden="true" />}
                      </span>
                    )}
                    {w.task && <TaskLine progress={props.taskProgress.get(w.id)} />}
                    {live > 0 && <span className="ws-item__live">{shellsRunningLabel(live)}</span>}
                    {agentText && (
                      <span className={`ws-item__agents${agents.needs > 0 ? ' ws-item__agents--needs' : agents.maybe > 0 ? ' ws-item__agents--maybe' : ''}`}>{agentText}</span>
                    )}
                  </>
                )}
              </button>
              {!collapsed && (
                <span className="ws-item__actions">
                  {props.tasksEnabled && w.task && (
                    <IconButton icon="files" label={`Review changes in ${w.name}`} description="Files the task changed and their diffs." size="sm" onClick={() => props.onReviewTask(w.id)} />
                  )}
                  {props.tasksEnabled && !w.task && (gitStatus || wslDistroOf(w.rootPath)) && (
                    <IconButton
                      icon="gitBranch"
                      label={`New agent task from ${w.name}`}
                      description="A new folder and Git branch for an agent to work in."
                      size="sm"
                      onClick={() => props.onNewTask(w.id)}
                    />
                  )}
                  <IconButton icon="pencil" label={`Rename workspace ${w.name}`} size="sm" onClick={() => props.onRename(w.id)} />
                  <IconButton
                    icon="trash"
                    label={`Remove ${w.name} from the list`}
                    description="Files in the folder are not deleted."
                    size="sm"
                    onClick={() => props.onRemove(w.id)}
                  />
                </span>
              )}
            </li>
          );
        })}
      </ul>

      {props.settingsShown && (
        <>
          {!collapsed && <h2 className="sidebar__heading sidebar__heading--sub">Settings</h2>}
          <ul className="sidebar__list sidebar__list--pages">
            <li className={`ws-item ws-item--page${props.settingsActive ? ' ws-item--active' : ''}`}>
              <button
                type="button"
                className="ws-item__main"
                aria-current={props.settingsActive ? 'page' : undefined}
                aria-label={collapsed ? 'Settings' : undefined}
                title={props.settingsActive ? 'Settings (current page)' : 'Settings'}
                onClick={props.onShowSettings}
              >
                {collapsed ? (
                  <span className="ws-item__badge" aria-hidden="true">
                    <Icon name="settings" size={16} />
                  </span>
                ) : (
                  <span className="ws-item__name">
                    <Icon name="settings" size={16} className="ws-item__page-icon" />
                    <span className="ws-item__label">Settings</span>
                  </span>
                )}
              </button>
              {!collapsed && (
                <span className="ws-item__actions">
                  <IconButton icon="close" label="Close settings" size="sm" onClick={props.onCloseSettings} />
                </span>
              )}
            </li>
          </ul>
        </>
      )}

      <div className="sidebar__bottom">
        <IconButton icon="command" size="sm" label="Command palette" shortcut={shortcutLabel('palette')} onClick={props.onPalette} />
        <IconButton icon="keyboard" size="sm" label="Keyboard shortcuts" shortcut={shortcutLabel('shortcuts')} onClick={props.onShortcuts} />
        <IconButton icon="settings" size="sm" label="Settings" shortcut={shortcutLabel('settings')} onClick={props.onSettings} />
      </div>

      {mode === 'expanded' && (
        <div
          className="panel-handle"
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize workspace sidebar"
          aria-valuemin={LIMITS.sidebarWidth.min}
          aria-valuemax={props.maxWidth}
          aria-valuenow={props.width}
          title="Drag to resize the sidebar. Arrow keys also work when focused."
          tabIndex={0}
          onPointerDown={onHandleDown}
          onPointerMove={onHandleMove}
          onPointerUp={onHandleUp}
          onPointerCancel={onHandleUp}
          onKeyDown={(e) => {
            const step = e.shiftKey ? 40 : 10;
            if (e.key === 'ArrowLeft') props.onWidthChange(clampWidth(props.width - step));
            else if (e.key === 'ArrowRight') props.onWidthChange(clampWidth(props.width + step));
            else return;
            e.preventDefault();
          }}
        />
      )}
    </nav>
  );
}

function TaskLine({ progress }: { progress: TaskProgress | undefined }) {
  const text = taskProgressText(progress);
  return (
    <span className="ws-item__task" data-testid="task-progress">
      <span className="ws-item__task-tag">task</span>
      {text && <span className="ws-item__task-text">{text}</span>}
    </span>
  );
}
