import type { PaneLeaf, ShellDiscovery, SplitDirection, Workspace } from '../../../shared/types';
import { Icon } from '../../components/Icon';
import { ProfileMenu } from '../../components/ProfileMenu';
import { shortcutLabel } from '../commands/shortcuts';
import { Explorer } from '../explorer/Explorer';
import { TerminalPane } from '../terminal/TerminalPane';
import { RestoreNotice } from './RestoreNotice';
import { SplitView } from './SplitView';

interface Props {
  workspace: Workspace;
  active: boolean;
  discovery: ShellDiscovery | null;
  defaultProfileId: string | null;
  folderMissing: boolean;
  /** Tabs created in this session (start immediately). */
  freshTabs: Set<string>;
  startOnRestore: boolean;
  /** Tabs that came from the saved layout and have not been started by the user. */
  restoredTabIds: ReadonlySet<string>;
  restoreNoticeDismissed: boolean;
  bulkProgress: { total: number; settled: number } | null;
  searchPaneId: string | null;
  renamingTabId: string | null;
  /** Pane shown maximised (others stay mounted but hidden), or null. */
  maximizedPaneId: string | null;
  onToggleMaximize(paneId: string): void;
  onNewTerminal(profileId: string): void;
  onNewTab(paneId: string, profileId: string): void;
  onActivateTab(tabId: string): void;
  onCloseTab(tabId: string): void;
  onMoveTab(tabId: string, toPaneId: string, toIndex: number): void;
  onSplit(paneId: string | null, direction: SplitDirection, profileId?: string): void;
  onClosePane(paneId: string): void;
  onRestartTab(tabId: string): void;
  onFocusPane(paneId: string): void;
  onChangeProfile(tabId: string, profileId: string): void;
  onResize(splitId: string, sizes: number[]): void;
  onToggleSearch(paneId: string, open: boolean): void;
  onRenameStart(tabId: string | null): void;
  onRenameTab(tabId: string, name: string): void;
  onStartAll(): void;
  onResumeAll(): void;
  onRetryStart(tabId: string): void;
  onShowTab(tabId: string): void;
  onDismissRestoreNotice(): void;
  onRelink(): void;
  onRemove(): void;
  explorerVisible: boolean;
  explorerWidth: number;
  explorerMaxWidth: number;
  compactFolders: boolean;
  explorerFocusToken: number;
  onExplorerWidth(width: number): void;
  onToggleExplorer(): void;
  onInsertPath(relativePath: string): void;
  onOpenFile(relativePath: string): void;
  notify(kind: 'info' | 'warning' | 'error', message: string): void;
}

export function WorkspaceView(props: Props) {
  const { workspace, discovery } = props;

  const renderPane = (pane: PaneLeaf) => (
    <TerminalPane
      key={pane.id}
      workspace={workspace}
      pane={pane}
      active={pane.id === workspace.activePaneId}
      isFresh={(tabId) => props.freshTabs.has(tabId) || (props.startOnRestore && !props.restoredTabIds.has(tabId))}
      discovery={discovery}
      defaultProfileId={props.defaultProfileId}
      searchOpen={props.searchPaneId === pane.id}
      renamingTabId={props.renamingTabId}
      maximized={props.maximizedPaneId === pane.id}
      canMaximize={!!workspace.layout && workspace.layout.type === 'split'}
      onToggleMaximize={() => props.onToggleMaximize(pane.id)}
      onFocus={props.onFocusPane}
      onActivateTab={props.onActivateTab}
      onNewTab={props.onNewTab}
      onCloseTab={props.onCloseTab}
      onMoveTab={props.onMoveTab}
      onSplit={(id, direction, profileId) => props.onSplit(id, direction, profileId)}
      onClosePane={props.onClosePane}
      onRestart={props.onRestartTab}
      onChangeProfile={props.onChangeProfile}
      onToggleSearch={props.onToggleSearch}
      onRenameStart={props.onRenameStart}
      onRename={props.onRenameTab}
    />
  );

  return (
    <div className="workspace" hidden={!props.active} aria-label={`Workspace ${workspace.name}`} role="region">
      {props.folderMissing && (
        <div className="banner banner--warning" role="alert">
          <Icon name="warning" />
          <span>
            The folder <code>{workspace.rootPath}</code> was not found. Terminals cannot start there until it is available again.
          </span>
          <button type="button" className="button button--small" onClick={props.onRelink}>
            Choose folder…
          </button>
          <button type="button" className="button button--small button--ghost" onClick={props.onRemove}>
            Remove workspace
          </button>
        </div>
      )}

      <div className="workspace__main">
        {props.explorerVisible && (
          <Explorer
            workspace={workspace}
            width={props.explorerWidth}
            maxWidth={props.explorerMaxWidth}
            compactFolders={props.compactFolders}
            focusToken={props.explorerFocusToken}
            onWidthChange={props.onExplorerWidth}
            onHide={props.onToggleExplorer}
            onInsertPath={props.onInsertPath}
            onOpenFile={props.onOpenFile}
            notify={props.notify}
          />
        )}
        <div className="workspace__column">
          {!props.restoreNoticeDismissed && props.restoredTabIds.size > 0 && (
            <RestoreNotice
              workspace={workspace}
              restoredTabIds={props.restoredTabIds}
              discovery={discovery}
              progress={props.bulkProgress}
              onStartAll={props.onStartAll}
              onResumeAll={props.onResumeAll}
              onRetry={props.onRetryStart}
              onShow={props.onShowTab}
              onDismiss={props.onDismissRestoreNotice}
            />
          )}
          <div className={`workspace__body${props.maximizedPaneId ? ' workspace__body--maximized' : ''}`}>
            {workspace.layout ? (
              <SplitView node={workspace.layout} renderPane={renderPane} onResize={props.onResize} />
            ) : (
              <div className="empty">
                <Icon name="terminal" size={28} />
                <p className="empty__title">No terminals in this workspace</p>
                <p className="empty__text">Start a shell in {workspace.name}. You can split it into more panes afterwards.</p>
                <ProfileMenu
                  discovery={discovery}
                  defaultProfileId={props.defaultProfileId}
                  label="New terminal"
                  description={`Opens a terminal in ${workspace.name}.`}
                  icon="plus"
                  shortcut={shortcutLabel('newTerminal')}
                  onPick={props.onNewTerminal}
                  className="profile-menu--center"
                />
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
