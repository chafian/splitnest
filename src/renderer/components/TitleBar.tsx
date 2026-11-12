// The window's title bar. Empty areas drag the window; Windows draws the
// native minimize / maximize / close buttons in the reserved area on the right.
import { PRODUCT } from '../../shared/product';
import type { ShellDiscovery, Workspace } from '../../shared/types';
import { shortcutLabel } from '../features/commands/shortcuts';
import type { SidebarMode } from '../features/workspaces/chrome';
import { Icon } from './Icon';
import { IconButton } from './IconButton';
import { ProfileMenu } from './ProfileMenu';
import { AgentInbox, type InboxRow } from '../features/notifications/AgentInbox';

interface Props {
  workspace: Workspace | null;
  /** A page shown instead of the workspace (e.g. "Settings"): its name replaces the workspace's. */
  pageTitle?: string | null;
  hasPanes: boolean;
  sidebar: SidebarMode;
  explorerVisible: boolean;
  focusMode: boolean;
  discovery: ShellDiscovery | null;
  defaultProfileId: string | null;
  onToggleSidebar(): void;
  onToggleExplorer(): void;
  onToggleFocusMode(): void;
  onOpenPalette(): void;
  onNewTab(profileId: string): void;
  onSplit(direction: 'row' | 'column'): void;
  inbox: InboxRow[];
  inboxOpen: boolean;
  onInboxOpenChange(open: boolean): void;
  onInboxPick(tabId: string): void;
}

export function TitleBar(props: Props) {
  const { workspace, focusMode } = props;
  const sidebarLabel = focusMode ? 'Show workspace sidebar' : props.sidebar === 'rail' ? 'Expand workspace sidebar' : 'Collapse workspace sidebar';
  return (
    <header className="titlebar">
      <div className="titlebar__left">
        <img className="titlebar__logo" src={logoUrl} alt="" width={16} height={16} draggable={false} />
        <IconButton
          icon="sidebar"
          label={sidebarLabel}
          description={focusMode ? 'Leaves focus mode and restores both sidebars.' : undefined}
          shortcut={shortcutLabel('toggleSidebar')}
          aria-pressed={props.sidebar === 'expanded'}
          onClick={props.onToggleSidebar}
        />
        <IconButton
          icon="files"
          label={props.explorerVisible ? 'Hide file explorer' : 'Show file explorer'}
          shortcut={shortcutLabel('toggleExplorer')}
          aria-pressed={props.explorerVisible}
          onClick={props.onToggleExplorer}
          disabled={!workspace}
        />
        <IconButton
          icon="focus"
          className={focusMode ? 'icon-button--on' : undefined}
          label={focusMode ? 'Exit focus mode' : 'Focus terminals'}
          description={focusMode ? 'Restores the sidebars as they were.' : 'Hides both sidebars. Use again to restore them.'}
          shortcut={shortcutLabel('toggleFocusMode')}
          aria-pressed={focusMode}
          onClick={props.onToggleFocusMode}
        />
        {props.pageTitle ? (
          <div className="titlebar__title">
            <span className="titlebar__name">{props.pageTitle}</span>
          </div>
        ) : workspace ? (
          <div className="titlebar__title" title={`${workspace.name}\n${workspace.rootPath}`}>
            <span className="titlebar__name">{workspace.name}</span>
            <span className="titlebar__path">{workspace.rootPath}</span>
          </div>
        ) : (
          <div className="titlebar__title">
            <span className="titlebar__name">{PRODUCT.name}</span>
          </div>
        )}
      </div>

      <button
        type="button"
        className="titlebar__search"
        onClick={props.onOpenPalette}
        aria-label="Search commands, workspaces and shells"
        title={`Command palette (${shortcutLabel('palette')})`}
      >
        <Icon name="search" size={16} />
        <span className="titlebar__search-text">Search commands, workspaces, shells…</span>
        <kbd className="kbd">{shortcutLabel('palette')}</kbd>
      </button>

      <div className="titlebar__right">
        <AgentInbox
          rows={props.inbox}
          open={props.inboxOpen}
          onOpenChange={props.onInboxOpenChange}
          onPick={props.onInboxPick}
          shortcut={shortcutLabel('inbox') ?? ''}
          nextShortcut={shortcutLabel('nextAgent') ?? ''}
        />
        <ProfileMenu
          discovery={props.discovery}
          defaultProfileId={props.defaultProfileId}
          label="New terminal"
          description="Opens a new terminal tab in the current pane."
          heading="New terminal in the current pane"
          icon="plus"
          shortcut={shortcutLabel('newTerminal')}
          onPick={props.onNewTab}
          disabled={!workspace}
          className="titlebar__newtab"
        />
        <IconButton
          icon="splitRight"
          label="Split left/right"
          description="Adds a pane to the right of the current pane."
          shortcut={shortcutLabel('splitRight')}
          onClick={() => props.onSplit('row')}
          disabled={!props.hasPanes}
        />
        <IconButton
          icon="splitDown"
          label="Split top/bottom"
          description="Adds a pane below the current pane."
          shortcut={shortcutLabel('splitDown')}
          onClick={() => props.onSplit('column')}
          disabled={!props.hasPanes}
        />
      </div>
      <div className="titlebar__controls-space" aria-hidden="true" />
    </header>
  );
}

const logoUrl = new URL('../../../assets/icon.png', import.meta.url).href;
