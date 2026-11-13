// A split pane: a tab bar on top and one terminal or file editor per tab.
// Inactive tabs stay mounted (hidden) so their shells keep running and keep
// their scrollback, and editors keep unsaved text and undo history.
import { RESUME_LABEL, resumeCommand, resumeFallbackText, resumeForShell } from '../../../shared/agent-resume';
import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type DragEvent, type KeyboardEvent, type MouseEvent } from 'react';
import type { PaneLeaf, SessionStatus, ShellDiscovery, StartLocation, TerminalTab, Workspace } from '../../../shared/types';
import { isFileTab, isTerminalTab, LIMITS } from '../../../shared/types';
import { api } from '../../api';
import { ContextMenu, type ContextMenuItem } from '../../components/ContextMenu';
import { Icon, type IconName } from '../../components/Icon';
import { IconButton } from '../../components/IconButton';
import { ProfileMenu } from '../../components/ProfileMenu';
import { shortcutLabel } from '../commands/shortcuts';
import { editors } from '../editor/editor-registry';
import { fileName, FileTabButton, FileTabView } from '../editor/FileTabView';
import { toWindowsPath } from '../explorer/paths';
import { focusTab } from './tab-focus';
import { AgentIcon } from '../../components/AgentIcon';
import { AGENT_STATE_TEXT, agentStateText } from './agent-status';
import { tabLabel } from './tab-label';
import { registry } from './terminal-registry';
import type { ControllerSnapshot, TerminalController } from './terminal-controller';

const NO_TERMINAL = { subscribe: () => () => undefined, getSnapshot: (): ControllerSnapshot | null => null };

export const TAB_MIME = 'application/x-splitnest-tab';

interface Props {
  workspace: Workspace;
  pane: PaneLeaf;
  active: boolean;
  discovery: ShellDiscovery | null;
  defaultProfileId: string | null;
  searchOpen: boolean;
  /** Tab whose name is being edited (anywhere in the app), if any. */
  renamingTabId: string | null;
  /** This pane currently fills the layout area. */
  maximized: boolean;
  /** More than one pane exists, so maximising makes sense. */
  canMaximize: boolean;
  onToggleMaximize(): void;
  isFresh(tabId: string): boolean;
  onFocus(paneId: string): void;
  onActivateTab(tabId: string): void;
  onNewTab(paneId: string, profileId: string): void;
  onCloseTab(tabId: string): void;
  onMoveTab(tabId: string, toPaneId: string, toIndex: number): void;
  onSplit(paneId: string, direction: 'row' | 'column', profileId?: string): void;
  onClosePane(paneId: string): void;
  onRestart(tabId: string): void;
  onChangeProfile(tabId: string, profileId: string): void;
  onToggleSearch(paneId: string, open: boolean): void;
  onRenameStart(tabId: string | null): void;
  onRename(tabId: string, name: string): void;
}

const STATUS: Record<SessionStatus, { label: string; icon: IconName }> = {
  idle: { label: 'Not started', icon: 'dot' },
  starting: { label: 'Starting', icon: 'dot' },
  running: { label: 'Running', icon: 'dot' },
  exited: { label: 'Exited', icon: 'stop' },
  failed: { label: 'Failed', icon: 'warning' },
};

function statusText(status: SessionStatus, exitCode: number | null): string {
  return status === 'exited' && exitCode !== null ? `Exited (${exitCode})` : STATUS[status].label;
}

function lastSegment(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path;
}

type MenuState = { x: number; y: number; kind: 'tab'; tabId: string } | { x: number; y: number; kind: 'pane' };

export function TerminalPane(props: Props) {
  const { workspace, pane, active, discovery } = props;
  const activeTab = pane.tabs.find((t) => t.id === pane.activeTabId) ?? pane.tabs[0]!;
  const activeController = isTerminalTab(activeTab) ? registry.getOrCreate(activeTab.id, workspace.id, props.isFresh(activeTab.id)) : null;
  const activeStore = activeController ?? NO_TERMINAL;
  const activeSnap = useSyncExternalStore(activeStore.subscribe, activeStore.getSnapshot);
  const activeProfileId = isTerminalTab(activeTab) ? activeTab.profileId : (props.defaultProfileId ?? '');
  // File names shared by two open tabs in this pane show their folder too.
  const fileNames = pane.tabs.filter(isFileTab).map((t) => fileName(t.path).toLowerCase());
  const [drop, setDrop] = useState<number | null>(null);
  const [menu, setMenu] = useState<MenuState | null>(null);
  const tablistRef = useRef<HTMLDivElement>(null);
  const moreRef = useRef<HTMLButtonElement>(null);
  // A mousedown on the More button closes the open menu before its click; don't reopen it then.
  const menuClosedAt = useRef(0);

  // Keep the active tab visible when the strip scrolls.
  useEffect(() => {
    tablistRef.current?.querySelector(`[data-tab-id="${activeTab.id}"]`)?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [activeTab.id, pane.tabs.length]);

  const insertionIndex = (event: DragEvent<HTMLElement>): number => {
    const tabs = [...(tablistRef.current?.querySelectorAll<HTMLElement>('[role="tab"]') ?? [])];
    const x = event.clientX;
    for (let i = 0; i < tabs.length; i++) {
      const r = tabs[i]!.getBoundingClientRect();
      if (x < r.left + r.width / 2) return i;
    }
    return tabs.length;
  };

  const onDragOver = (event: DragEvent<HTMLElement>) => {
    if (!event.dataTransfer.types.includes(TAB_MIME)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
    setDrop(insertionIndex(event));
  };

  const onDrop = (event: DragEvent<HTMLElement>) => {
    const raw = event.dataTransfer.getData(TAB_MIME);
    setDrop(null);
    if (!raw) return;
    event.preventDefault();
    const { tabId, workspaceId } = JSON.parse(raw) as { tabId: string; workspaceId: string };
    if (workspaceId !== workspace.id) return;
    let index = insertionIndex(event);
    const current = pane.tabs.findIndex((t) => t.id === tabId);
    if (current >= 0 && current < index) index -= 1; // index in the list without the moved tab
    props.onMoveTab(tabId, pane.id, index);
  };

  const tabElement = (tabId: string) => tablistRef.current?.querySelector<HTMLElement>(`[data-tab-id="${tabId}"]`) ?? null;

  const openTabMenu = (tabId: string, at?: { x: number; y: number }) => {
    const r = tabElement(tabId)?.getBoundingClientRect();
    setMenu({ kind: 'tab', tabId, x: at?.x ?? (r ? r.left + 12 : 0), y: at?.y ?? (r ? r.bottom + 2 : 0) });
  };

  const onTabKeyDown = (event: KeyboardEvent<HTMLDivElement>, index: number) => {
    const tab = pane.tabs[index]!;
    let next = -1;
    if (event.key === 'ArrowRight') next = (index + 1) % pane.tabs.length;
    else if (event.key === 'ArrowLeft') next = (index - 1 + pane.tabs.length) % pane.tabs.length;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = pane.tabs.length - 1;
    else if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      focusTab(activeTab.id);
      return;
    } else if (event.key === 'Delete') {
      event.preventDefault();
      props.onCloseTab(tab.id);
      return;
    } else if (event.key === 'F2' && isTerminalTab(tab)) {
      event.preventDefault();
      props.onRenameStart(tab.id);
      return;
    } else if (event.key === 'ContextMenu' || (event.key === 'F10' && event.shiftKey)) {
      event.preventDefault();
      openTabMenu(tab.id);
      return;
    } else return;
    event.preventDefault();
    const target = pane.tabs[next]!;
    props.onActivateTab(target.id);
    requestAnimationFrame(() => tabElement(target.id)?.focus());
  };

  const closeMenu = () => setMenu(null);

  const tabMenuItems = (tabId: string): ContextMenuItem[] => {
    const tab = pane.tabs.find((t) => t.id === tabId);
    if (!tab) return [];
    if (isFileTab(tab)) return fileMenuItems(tab.id, tab.path);
    const status = registry.get(tabId)?.getSnapshot().status ?? 'idle';
    return [
      { label: 'Rename terminal…', hint: 'F2', run: () => props.onRenameStart(tabId) },
      {
        label: status === 'running' ? 'Restart shell' : 'Start shell',
        hint: tabId === activeTab.id ? shortcutLabel('restartShell') : undefined,
        disabled: status === 'starting',
        run: () => props.onRestart(tabId),
      },
      { label: 'Split left/right with this shell', separator: true, run: () => props.onSplit(pane.id, 'row', tab.profileId) },
      { label: 'Split top/bottom with this shell', run: () => props.onSplit(pane.id, 'column', tab.profileId) },
      {
        label: 'Close terminal',
        hint: tabId === activeTab.id ? shortcutLabel('closePane') : 'Middle-click',
        separator: true,
        danger: true,
        run: () => props.onCloseTab(tabId),
      },
    ];
  };

  const copy = (text: string) => void api.writeClipboard(text);

  const fileMenuItems = (tabId: string, path: string): ContextMenuItem[] => {
    const editor = editors.get(tabId);
    const snap = editor?.getSnapshot();
    return [
      { label: 'Save', hint: 'Ctrl+S', disabled: !snap || !!snap.readOnly || snap.status !== 'ready', run: () => void editor?.save() },
      { label: 'Find in file', hint: 'Ctrl+F', disabled: snap?.status !== 'ready', run: () => editor?.openSearch() },
      { label: 'Copy path', separator: true, run: () => copy(toWindowsPath(workspace.rootPath, path)) },
      { label: 'Copy relative path', run: () => copy(path.replace(/\//g, '\\')) },
      { label: 'Reveal in File Explorer', run: () => void api.revealPath(workspace.id, path) },
      {
        label: snap?.dirty ? 'Close file (unsaved changes)…' : 'Close file',
        hint: tabId === activeTab.id ? shortcutLabel('closePane') : 'Middle-click',
        separator: true,
        danger: true,
        run: () => props.onCloseTab(tabId),
      },
    ];
  };

  const maximizeItem: ContextMenuItem[] =
    props.maximized || props.canMaximize
      ? [{ label: props.maximized ? 'Restore layout' : 'Maximise pane', hint: shortcutLabel('toggleMaximize'), separator: true, run: props.onToggleMaximize }]
      : [];

  const paneMenuItems = (): ContextMenuItem[] => {
    const closePane: ContextMenuItem = {
      label: pane.tabs.length > 1 ? `Close pane (all ${pane.tabs.length} tabs)` : 'Close pane',
      danger: true,
      run: () => props.onClosePane(pane.id),
    };
    if (isFileTab(activeTab)) return [...fileMenuItems(activeTab.id, activeTab.path), ...maximizeItem, closePane];
    return [
      { label: 'Find in terminal', hint: shortcutLabel('find'), run: () => props.onToggleSearch(pane.id, !props.searchOpen) },
      {
        label: activeSnap?.status === 'running' ? 'Restart shell' : 'Start shell',
        hint: shortcutLabel('restartShell'),
        disabled: activeSnap?.status === 'starting',
        run: () => props.onRestart(activeTab.id),
      },
      { label: 'Rename terminal…', hint: 'F2 on tab', run: () => props.onRenameStart(activeTab.id) },
      ...maximizeItem,
      { label: 'Close terminal', hint: shortcutLabel('closePane'), separator: true, run: () => props.onCloseTab(activeTab.id) },
      closePane,
    ];
  };

  const activeProfile = discovery?.profiles.find((p) => p.id === activeProfileId);
  const sameShell = activeProfile ? (activeProfile.kind === 'wsl' ? `WSL · ${activeProfile.label}` : activeProfile.label) : 'the same shell';

  return (
    <section
      className={`pane${active ? ' pane--active' : ''}${props.maximized ? ' pane--maximized' : ''}`}
      data-pane-id={pane.id}
      data-active-tab={activeTab.id}
      data-status={activeSnap?.status ?? 'file'}
      aria-label={active ? 'Pane (current)' : 'Pane'}
      onMouseDown={() => props.onFocus(pane.id)}
    >
      <header className="pane__bar">
        <div
          className="tabs"
          role="tablist"
          aria-label="Tabs in this pane"
          ref={tablistRef}
          onDragOver={onDragOver}
          onDragLeave={(e) => {
            if (!e.currentTarget.contains(e.relatedTarget as Node)) setDrop(null);
          }}
          onDrop={onDrop}
          onDoubleClick={(e) => {
            if (e.target === e.currentTarget && activeProfileId) props.onNewTab(pane.id, activeProfileId);
          }}
        >
          {pane.tabs.map((tab, index) =>
            isFileTab(tab) ? (
              <FileTabButton
                key={tab.id}
                tab={tab}
                workspace={workspace}
                selected={tab.id === activeTab.id}
                paneActive={active}
                showParent={fileNames.filter((n) => n === fileName(tab.path).toLowerCase()).length > 1}
                dropBefore={drop === index}
                dropAfter={drop === pane.tabs.length && index === pane.tabs.length - 1}
                onActivate={() => {
                  props.onActivateTab(tab.id);
                  requestAnimationFrame(() => focusTab(tab.id));
                }}
                onClose={() => props.onCloseTab(tab.id)}
                onKeyDown={(e) => onTabKeyDown(e, index)}
                onContextMenu={(e) => {
                  e.preventDefault();
                  props.onActivateTab(tab.id);
                  openTabMenu(tab.id, { x: e.clientX, y: e.clientY });
                }}
                onDragStart={(e) => {
                  e.dataTransfer.setData(TAB_MIME, JSON.stringify({ tabId: tab.id, workspaceId: workspace.id }));
                  e.dataTransfer.effectAllowed = 'move';
                }}
              />
            ) : (
            <TabButton
              key={tab.id}
              tab={tab}
              workspace={workspace}
              discovery={discovery}
              selected={tab.id === activeTab.id}
              paneActive={active}
              isFresh={props.isFresh(tab.id)}
              editing={props.renamingTabId === tab.id}
              dropBefore={drop === index}
              dropAfter={drop === pane.tabs.length && index === pane.tabs.length - 1}
              onActivate={() => {
                props.onActivateTab(tab.id);
                requestAnimationFrame(() => registry.get(tab.id)?.focus());
              }}
              onClose={() => props.onCloseTab(tab.id)}
              onKeyDown={(e) => onTabKeyDown(e, index)}
              onContextMenu={(e) => {
                e.preventDefault();
                props.onActivateTab(tab.id);
                openTabMenu(tab.id, { x: e.clientX, y: e.clientY });
              }}
              onRenameStart={() => props.onRenameStart(tab.id)}
              onRenameEnd={(name, refocus) => {
                if (name !== null) props.onRename(tab.id, name);
                props.onRenameStart(null);
                if (refocus) requestAnimationFrame(() => registry.get(tab.id)?.focus());
              }}
            />
            ),
          )}
        </div>
        <ProfileMenu
          discovery={discovery}
          defaultProfileId={activeProfileId || null}
          label="New terminal in this pane"
          description={`Opens another tab here with ${sameShell}. Use the arrow to choose a different shell.`}
          heading="New terminal in this pane"
          defaultHint="current shell"
          icon="plus"
          compact
          onPick={(profileId) => props.onNewTab(pane.id, profileId)}
          className="pane__newtab"
        />
        <span className="pane__actions">
          <IconButton
            className="pane__optional"
            icon="splitRight"
            label="Split left/right"
            description="Adds a pane to the right of this one."
            size="sm"
            shortcut={active ? shortcutLabel('splitRight') : undefined}
            onClick={() => props.onSplit(pane.id, 'row')}
          />
          <IconButton
            className="pane__optional"
            icon="splitDown"
            label="Split top/bottom"
            description="Adds a pane below this one."
            size="sm"
            shortcut={active ? shortcutLabel('splitDown') : undefined}
            onClick={() => props.onSplit(pane.id, 'column')}
          />
          {(props.canMaximize || props.maximized) && (
            <IconButton
              className={props.maximized ? 'icon-button--on' : 'pane__optional'}
              icon={props.maximized ? 'restoreLayout' : 'maximize'}
              label={props.maximized ? 'Restore layout' : 'Maximise pane'}
              description={props.maximized ? 'Shows all panes again with their previous sizes.' : 'Temporarily fills the layout with this pane. Other panes keep running.'}
              size="sm"
              shortcut={active ? shortcutLabel('toggleMaximize') : undefined}
              aria-pressed={props.maximized}
              onClick={props.onToggleMaximize}
            />
          )}
          <IconButton
            ref={moreRef}
            icon="more"
            label="More pane actions"
            description={isFileTab(activeTab) ? 'Save, find, copy path, close.' : 'Find, start or restart, rename, close.'}
            size="sm"
            aria-haspopup="menu"
            aria-expanded={menu?.kind === 'pane'}
            onClick={() => {
              if (menu?.kind === 'pane' || Date.now() - menuClosedAt.current < 300) return closeMenu();
              const r = moreRef.current?.getBoundingClientRect();
              setMenu({ kind: 'pane', x: r ? r.right - 240 : 0, y: r ? r.bottom + 4 : 0 });
            }}
          />
        </span>
      </header>
      {props.searchOpen && activeController && (
        <SearchBar key={activeTab.id} controller={activeController} onClose={() => props.onToggleSearch(pane.id, false)} />
      )}
      <div className="pane__body">
        {pane.tabs.map((tab) =>
          isFileTab(tab) ? (
            <FileTabView key={tab.id} tab={tab} workspace={workspace} visible={tab.id === activeTab.id} onClose={() => props.onCloseTab(tab.id)} />
          ) : (
          <TabView
            key={tab.id}
            tab={tab}
            workspace={workspace}
            visible={tab.id === activeTab.id}
            autoStart={props.isFresh(tab.id)}
            discovery={discovery}
            onChangeProfile={(profileId) => props.onChangeProfile(tab.id, profileId)}
            onRestart={() => props.onRestart(tab.id)}
            onClose={() => props.onCloseTab(tab.id)}
          />
          ),
        )}
      </div>
      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          label={menu.kind === 'tab' ? 'Tab actions' : 'Pane actions'}
          items={menu.kind === 'tab' ? tabMenuItems(menu.tabId) : paneMenuItems()}
          onClose={() => {
            menuClosedAt.current = Date.now();
            closeMenu();
            if (menu.kind === 'tab') tabElement(menu.tabId)?.focus();
            else moreRef.current?.focus();
          }}
        />
      )}
    </section>
  );
}

function TabButton(props: {
  tab: TerminalTab;
  workspace: Workspace;
  discovery: ShellDiscovery | null;
  selected: boolean;
  paneActive: boolean;
  isFresh: boolean;
  editing: boolean;
  dropBefore: boolean;
  dropAfter: boolean;
  onActivate(): void;
  onClose(): void;
  onKeyDown(e: KeyboardEvent<HTMLDivElement>): void;
  onContextMenu(e: MouseEvent<HTMLDivElement>): void;
  onRenameStart(): void;
  /** `name` null = cancelled. */
  onRenameEnd(name: string | null, refocusTerminal: boolean): void;
}) {
  const { tab, workspace } = props;
  const controller = registry.getOrCreate(tab.id, workspace.id, props.isFresh);
  const snap = useSyncExternalStore(controller.subscribe, controller.getSnapshot);
  const profile = props.discovery?.profiles.find((p) => p.id === tab.profileId);
  const shell = snap.profileLabel ?? profile?.label ?? tab.profileId;
  const agent = snap.agent;
  const label = tabLabel({
    customName: tab.name,
    profileId: tab.profileId,
    shellLabel: shell,
    shellTitle: snap.shellTitle,
    agentLabel: agent?.label,
    agentTitle: agent?.title,
  });
  const agentText = agent ? agentStateText(agent) : null;
  // Guessed states (agent doesn't report) look different from reported ones: "?", dashed, hollow.
  const estimated = agent?.source === 'heuristic';
  const estimateBasis = !estimated || !agent ? '' : agent.state === 'needs-action' ? ' (estimated from a terminal bell)' : agent.state === 'working' ? ' (estimated from output activity)' : ' (estimated)';
  const cwd = snap.cwdLabel ?? workspace.rootPath;
  // The folder is shown only for unnamed tabs, and only when it differs from the workspace root (e.g. home).
  const cwdName = lastSegment(cwd);
  const showCwd = !label.secondary && cwdName !== lastSegment(workspace.rootPath);
  const status = statusText(snap.status, snap.exitCode);
  const showStatusText = snap.status !== 'running';
  const shellKind = profile?.kind === 'wsl' ? `${shell} (WSL)` : shell;
  const tooltip = [
    label.full,
    `Shell: ${shellKind}`,
    `Status: ${status}`,
    agent ? `Agent: ${agent.label} · ${agentText}${estimated ? estimateBasis : ' (reported by the agent)'}` : null,
    agent?.attention ? 'New notification (bell) — clears when you open this tab' : null,
    agent?.title ? `Session: ${agent.title}` : null,
    agent?.message ? agent.message : null,
    `Starting directory: ${cwd} (does not follow later cd commands)`,
    label.titleLine && !agent ? `Title set by the shell: ${label.titleLine}` : null,
    'Double-click or F2 to rename. Right-click for more.',
  ]
    .filter(Boolean)
    .join('\n');

  return (
    <div
      role="tab"
      data-tab-id={tab.id}
      data-tab-name={tab.name ?? ''}
      aria-selected={props.selected}
      data-agent={agent?.id ?? (agent ? 'other' : '')}
      data-agent-state={agent?.state ?? ''}
      data-agent-source={agent?.source ?? ''}
      data-agent-attention={agent?.attention ? 'true' : undefined}
      aria-label={`${label.secondary ? `${label.primary}, ${label.secondary} terminal` : `${label.primary} terminal`}, ${agent ? `${agent.label} ${agentText}${estimated ? ', estimated' : ''}` : status}`}
      tabIndex={props.selected ? 0 : -1}
      draggable={!props.editing}
      className={`tab${props.selected ? ' tab--selected' : ''}${props.selected && props.paneActive ? ' tab--focused' : ''}${props.dropBefore ? ' tab--drop-before' : ''}${props.dropAfter ? ' tab--drop-after' : ''}${props.editing ? ' tab--editing' : ''}`}
      title={props.editing ? undefined : tooltip}
      onMouseDown={(e) => {
        if (e.button === 1) {
          e.preventDefault();
          props.onClose();
        }
      }}
      onClick={props.editing ? undefined : props.onActivate}
      onDoubleClick={(e) => {
        e.stopPropagation();
        if (!props.editing) props.onRenameStart();
      }}
      onKeyDown={props.editing ? undefined : props.onKeyDown}
      onContextMenu={props.onContextMenu}
      onDragStart={(e) => {
        e.dataTransfer.setData(TAB_MIME, JSON.stringify({ tabId: tab.id, workspaceId: workspace.id }));
        e.dataTransfer.effectAllowed = 'move';
      }}
    >
      {agent ? (
        <AgentIcon agent={agent.id} state={agent.state} estimated={estimated} />
      ) : (
        <span className={`status status--${snap.status}`} aria-hidden="true">
          <Icon name={STATUS[snap.status].icon} size={10} />
        </span>
      )}
      {props.editing ? (
        <TabNameEditor initial={tab.name ?? ''} placeholder={label.defaultName} onDone={props.onRenameEnd} />
      ) : (
        <span className="tab__label">
          <span className="tab__name">{label.primary}</span>
          {label.secondary && (
            // Separator and shell shrink (and disappear) together, never leaving a lone "·".
            <span className="tab__secondary">
              <span className="tab__sep" aria-hidden="true">
                ·
              </span>
              <span className="tab__shell">{label.secondary}</span>
            </span>
          )}
          {showCwd && <span className="tab__cwd">{cwdName}</span>}
        </span>
      )}
      {showStatusText && !props.editing && <span className={`tab__state tab__state--${snap.status}`}>{status}</span>}
      {!showStatusText && agent && agent.state !== 'idle' && !props.editing && (
        // Short on the tab ("Needs you"); the reason ("Needs permission") is in the tooltip.
        <span className={`tab__state tab__state--agent-${agent.state}${estimated ? ' tab__state--estimated' : ''}`}>
          {AGENT_STATE_TEXT[agent.state]}
          {estimated ? '?' : ''}
        </span>
      )}
      <button
        type="button"
        className="tab__close"
        tabIndex={-1}
        aria-label={`Close terminal ${label.primary}`}
        title="Close terminal (middle-click also works)"
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

/** Inline rename: Enter saves, Escape cancels, blank resets to the shell's name. */
function TabNameEditor({ initial, placeholder, onDone }: { initial: string; placeholder: string; onDone(name: string | null, refocus: boolean): void }) {
  const [value, setValue] = useState(initial);
  const done = useRef(false);
  const inputRef = useRef<HTMLInputElement>(null);
  useLayoutEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);
  const finish = (name: string | null, refocus: boolean) => {
    if (done.current) return;
    done.current = true;
    onDone(name, refocus);
  };
  return (
    <input
      ref={inputRef}
      className="tab__input"
      value={value}
      placeholder={placeholder}
      maxLength={LIMITS.maxTabNameLength}
      aria-label="Terminal name (leave empty for the shell’s name)"
      spellCheck={false}
      onChange={(e) => setValue(e.target.value)}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === 'Enter') {
          e.preventDefault();
          finish(value, true);
        } else if (e.key === 'Escape') {
          e.preventDefault();
          finish(null, true);
        }
      }}
      onBlur={() => finish(value, false)}
      onMouseDown={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
    />
  );
}

function TabView(props: {
  tab: TerminalTab;
  workspace: Workspace;
  visible: boolean;
  autoStart: boolean;
  discovery: ShellDiscovery | null;
  onChangeProfile(profileId: string): void;
  onRestart(): void;
  onClose(): void;
}) {
  const { tab, workspace, discovery } = props;
  const controller = registry.getOrCreate(tab.id, workspace.id, props.autoStart);
  const snap = useSyncExternalStore(controller.subscribe, controller.getSnapshot);
  const hostRef = useRef<HTMLDivElement>(null);
  const profile = discovery?.profiles.find((p) => p.id === tab.profileId);
  const profileKnown = !discovery || !!profile;
  const shellName = profile?.label ?? 'shell';

  useLayoutEffect(() => {
    if (hostRef.current) controller.attach(hostRef.current, tab.profileId);
    return () => controller.detach();
    // tab.profileId is read only for the initial auto-start.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [controller]);

  const start = (startIn: StartLocation) => void controller.start(tab.profileId, startIn);
  // The exact conversation only in the kind of shell it ran in (a WSL record in WSL); else the agent's own list.
  const resume = tab.resume ? resumeForShell(tab.resume, tab.profileId.startsWith('wsl:')) : null;
  const resumeLabel = resume ? RESUME_LABEL[resume.agent] : '';

  return (
    <div className="tabview" hidden={!props.visible} data-tab-id={tab.id} role="tabpanel">
      <div className="pane__terminal" ref={hostRef} />
      {snap.status === 'idle' && (
        <div className="pane__overlay">
          <div className="ready" role="group" aria-label="Terminal not started">
            <p className="ready__title">{resume ? `${resumeLabel} was running here` : 'Ready to start'}</p>
            {resume?.title && (
              <p className="ready__subtitle" data-testid="resume-title" title={resume.title}>
                “{resume.title}”
              </p>
            )}
            {resume && (
              <p className="ready__detail" data-testid="resume-detail">
                {resume.sessionId
                  ? `Resume reopens that conversation: a new ${shellName} in ${resume.cwd}, then “${resumeCommand(resume)}”.`
                  : resumeFallbackText(resume.agent, resume.cwd)}
              </p>
            )}
            <div className="ready__row">
              <ProfileSelect discovery={discovery} value={tab.profileId} onChange={props.onChangeProfile} />
              {resume && (
                <button
                  type="button"
                  className="button button--primary"
                  data-testid="resume-agent"
                  onClick={() => void controller.resume(tab.profileId, resume)}
                  disabled={!profileKnown}
                  title={`Starts ${shellName} in ${resume.cwd} and types “${resumeCommand(resume)}” at its prompt. Nothing else runs.`}
                >
                  <Icon name="play" size={14} /> Resume {resumeLabel}
                </button>
              )}
              <button
                type="button"
                className={resume ? 'button' : 'button button--primary'}
                onClick={() => start('workspace-root')}
                disabled={!profileKnown}
                title={`Starts a new ${shellName} session in the saved folder. Earlier processes are not resumed.`}
              >
                {!resume && <Icon name="play" size={14} />} {resume ? `Start ${shellName} only` : `Start ${shellName}`}
              </button>
            </div>
          </div>
        </div>
      )}
      {snap.status === 'starting' && !snap.hasStarted && (
        <div className="pane__overlay pane__overlay--quiet" aria-live="polite">
          Starting {shellName}…
        </div>
      )}
      {snap.status === 'failed' && snap.error && (
        <div className="pane__overlay">
          <div className="placeholder placeholder--error" role="alert">
            <Icon name="warning" size={22} />
            <p className="placeholder__title">{snap.error.message}</p>
            {snap.error.detail && <p className="placeholder__detail">{snap.error.detail}</p>}
            {(snap.error.code === 'UNKNOWN_PROFILE' || snap.error.code === 'SHELL_NOT_FOUND') && (
              <ProfileSelect discovery={discovery} value={tab.profileId} onChange={props.onChangeProfile} />
            )}
            <div className="placeholder__actions">
              <button type="button" className="button button--primary" onClick={() => start(snap.startIn)} disabled={!profileKnown}>
                Try again
              </button>
              {snap.error.fallback === 'start-in-home' && (
                <button type="button" className="button" onClick={() => start('home')}>
                  <Icon name="home" size={14} /> Start in home directory instead
                </button>
              )}
              <button type="button" className="button button--ghost" onClick={props.onClose}>
                Close terminal
              </button>
            </div>
          </div>
        </div>
      )}
      {snap.resuming?.phase === 'not-started' && snap.status === 'running' && (
        <div className="pane__exitbar" role="status" data-testid="resume-not-started">
          <span>{RESUME_LABEL[snap.resuming.agent]} didn't start. The shell is ready; its output above says why.</span>
          <button type="button" className="button button--small button--ghost" onClick={() => controller.dismissResuming()}>
            Dismiss
          </button>
        </div>
      )}
      {snap.status === 'exited' && (
        <div className="pane__exitbar" role="status">
          <span>{snap.exitReason ?? (snap.exitCode === null ? 'The shell ended.' : `The shell exited with code ${snap.exitCode}.`)}</span>
          <button type="button" className="button button--small" onClick={props.onRestart}>
            <Icon name="restart" size={14} /> Restart
          </button>
          <button type="button" className="button button--small button--ghost" onClick={props.onClose}>
            Close terminal
          </button>
        </div>
      )}
    </div>
  );
}

function ProfileSelect({ discovery, value, onChange }: { discovery: ShellDiscovery | null; value: string; onChange(id: string): void }) {
  const profiles = discovery?.profiles ?? [];
  const known = profiles.some((p) => p.id === value);
  return (
    <select className="select" value={value} aria-label="Shell" title="Shell to start" onChange={(e) => onChange(e.target.value)}>
      {!known && <option value={value}>{value} (not available)</option>}
      {profiles.map((p) => (
        <option key={p.id} value={p.id}>
          {p.kind === 'wsl' ? `WSL · ${p.label}` : p.label}
        </option>
      ))}
    </select>
  );
}

function SearchBar({ controller, onClose }: { controller: TerminalController; onClose(): void }) {
  const [query, setQuery] = useState('');
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [found, setFound] = useState<boolean | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    inputRef.current?.focus();
    return () => controller.clearSearch();
  }, [controller]);
  const run = (backwards: boolean) => {
    if (!query) return;
    setFound(backwards ? controller.findPrevious(query, caseSensitive) : controller.findNext(query, caseSensitive));
  };
  const close = () => {
    onClose();
    controller.focus();
  };
  return (
    <div className="searchbar" role="search">
      <input
        ref={inputRef}
        className="input searchbar__input"
        placeholder="Find in terminal"
        aria-label="Find in terminal"
        value={query}
        onChange={(e) => {
          setQuery(e.target.value);
          setFound(null);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            run(e.shiftKey);
          } else if (e.key === 'Escape') {
            e.preventDefault();
            e.stopPropagation();
            close();
          }
        }}
      />
      <span className="searchbar__result" aria-live="polite">
        {found === false ? 'No matches' : ''}
      </span>
      <label className="searchbar__toggle" title="Match case">
        <input type="checkbox" checked={caseSensitive} onChange={(e) => setCaseSensitive(e.target.checked)} /> Aa
      </label>
      <IconButton icon="chevronUp" label="Previous match" size="sm" shortcut="Shift+Enter" onClick={() => run(true)} />
      <IconButton icon="chevronDown" label="Next match" size="sm" shortcut="Enter" onClick={() => run(false)} />
      <IconButton icon="close" label="Close find" size="sm" shortcut="Esc" onClick={close} />
    </div>
  );
}
