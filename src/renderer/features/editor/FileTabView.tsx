// File tabs inside a pane: the tab button and the editor body.
import { useLayoutEffect, useRef, useSyncExternalStore, type KeyboardEvent, type MouseEvent } from 'react';
import type { FileTab, Workspace } from '../../../shared/types';
import { Icon } from '../../components/Icon';
import { iconUrl } from '../explorer/icon-urls';
import { requestConfirm } from '../../components/confirm-service';
import { editorSaveLabel } from './save-label';
import { editors } from './editor-registry';

export const fileName = (path: string) => path.split('/').pop() ?? path;
export const parentName = (path: string) => path.split('/').slice(-2, -1)[0] ?? '';

export function FileTabButton(props: {
  tab: FileTab;
  workspace: Workspace;
  selected: boolean;
  paneActive: boolean;
  /** Show the parent folder too (another open tab has the same file name). */
  showParent: boolean;
  dropBefore: boolean;
  dropAfter: boolean;
  onActivate(): void;
  onClose(): void;
  onKeyDown(e: KeyboardEvent<HTMLDivElement>): void;
  onContextMenu(e: MouseEvent<HTMLDivElement>): void;
  onDragStart(e: React.DragEvent<HTMLDivElement>): void;
}) {
  const { tab, workspace } = props;
  const controller = editors.getOrCreate(tab.id, workspace.id, tab.path);
  const snap = useSyncExternalStore(controller.subscribe, controller.getSnapshot);
  const name = fileName(tab.path);
  const state = snap.status === 'error' ? 'Error' : snap.conflict === 'deleted' ? 'Deleted' : snap.readOnly ? 'Read-only' : null;
  const tooltip = [
    tab.path.replace(/\//g, '\\'),
    snap.dirty ? 'Unsaved changes (Ctrl+S to save)' : 'Saved',
    snap.readOnly ? `Read-only: ${snap.readOnly}` : null,
    'Right-click for more.',
  ]
    .filter(Boolean)
    .join('\n');
  return (
    <div
      role="tab"
      data-tab-id={tab.id}
      data-file-path={tab.path}
      data-dirty={snap.dirty ? 'true' : 'false'}
      aria-selected={props.selected}
      aria-label={`${name}${props.showParent ? ` in ${parentName(tab.path)}` : ''}, file${snap.dirty ? ', unsaved changes' : ''}${state ? `, ${state}` : ''}`}
      tabIndex={props.selected ? 0 : -1}
      draggable
      className={`tab tab--file${props.selected ? ' tab--selected' : ''}${props.selected && props.paneActive ? ' tab--focused' : ''}${props.dropBefore ? ' tab--drop-before' : ''}${props.dropAfter ? ' tab--drop-after' : ''}${snap.dirty ? ' tab--dirty' : ''}`}
      title={tooltip}
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
        {props.showParent && <span className="tab__shell">{parentName(tab.path)}</span>}
      </span>
      {state && <span className={`tab__state${snap.status === 'error' || snap.conflict === 'deleted' ? ' tab__state--failed' : ''}`}>{state}</span>}
      <button
        type="button"
        className="tab__close"
        tabIndex={-1}
        aria-label={snap.dirty ? `Close ${name} (unsaved changes)` : `Close ${name}`}
        title={snap.dirty ? 'Unsaved changes. Close (asks first)' : 'Close file (middle-click also works)'}
        onClick={(e) => {
          e.stopPropagation();
          props.onClose();
        }}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <span className="tab__dirty-dot" aria-hidden="true" />
        <Icon name="close" size={14} />
      </button>
    </div>
  );
}

export function FileTabView(props: { tab: FileTab; workspace: Workspace; visible: boolean; onClose(): void }) {
  const { tab, workspace } = props;
  const controller = editors.getOrCreate(tab.id, workspace.id, tab.path);
  const snap = useSyncExternalStore(controller.subscribe, controller.getSnapshot);
  const hostRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    if (hostRef.current) controller.attach(hostRef.current);
    return () => controller.detach();
  }, [controller]);

  const name = fileName(tab.path);
  const confirmOverwrite = () =>
    requestConfirm({
      title: 'Overwrite the file on disk?',
      message: `“${name}” was changed by another program after you opened it.`,
      detail: 'Saving now replaces that version with yours. The other changes are lost unless they exist elsewhere (for example in git).',
      confirmLabel: 'Overwrite file',
      danger: true,
      onConfirm: () => void controller.save(true),
    });
  const confirmReload = () =>
    requestConfirm({
      title: 'Discard your edits?',
      message: `Reload “${name}” from disk and discard your unsaved changes?`,
      confirmLabel: 'Discard and reload',
      danger: true,
      onConfirm: () => void controller.reload(),
    });

  const conflictBanner =
    snap.conflict === 'changed-on-disk' ? (
      <div className="editor-banner editor-banner--warning" role="alert">
        <Icon name="warning" size={14} />
        <span>
          This file was changed on disk after you opened it.{' '}
          {snap.dirty ? 'Your edits are kept until you choose.' : 'You have no unsaved edits.'}
        </span>
        {snap.dirty ? (
          <>
            <button type="button" className="button button--small" onClick={() => controller.keepLocalEdits()}>
              Keep my edits
            </button>
            <button type="button" className="button button--small" onClick={confirmReload}>
              Reload from disk…
            </button>
            <button type="button" className="button button--small button--danger-ghost" onClick={confirmOverwrite}>
              Overwrite file…
            </button>
          </>
        ) : (
          <button type="button" className="button button--small" onClick={() => void controller.reload()}>
            Reload from disk
          </button>
        )}
      </div>
    ) : snap.conflict === 'deleted' ? (
      <div className="editor-banner editor-banner--warning" role="alert">
        <Icon name="warning" size={14} />
        <span>This file no longer exists on disk. Saving is not possible; copy anything you need, then close the tab.</span>
        <button type="button" className="button button--small button--ghost" onClick={props.onClose}>
          Close file
        </button>
      </div>
    ) : null;

  const saveLabel = editorSaveLabel(snap);

  return (
    <div className="tabview tabview--file" hidden={!props.visible} data-tab-id={tab.id} role="tabpanel">
      {conflictBanner}
      {snap.readOnly && snap.status === 'ready' && (
        <div className="editor-banner" role="note">
          <Icon name="warning" size={14} />
          <span>{snap.readOnly}</span>
        </div>
      )}
      {snap.lastSaveError && snap.lastSaveError.code !== 'CONFLICT' && (
        <div className="editor-banner editor-banner--error" role="alert">
          <Icon name="warning" size={14} />
          <span>Not saved: {snap.lastSaveError.message}</span>
          <button type="button" className="button button--small" onClick={() => void controller.save()}>
            Try again
          </button>
        </div>
      )}
      <div className="editor-body" ref={hostRef} />
      {snap.status === 'loading' && (
        <div className="pane__overlay pane__overlay--quiet" aria-live="polite">
          Opening {fileName(tab.path)}…
        </div>
      )}
      {snap.status === 'error' && snap.error && (
        <div className="pane__overlay">
          <div className="placeholder placeholder--error" role="alert">
            <Icon name="warning" size={22} />
            <p className="placeholder__title">{snap.error.message}</p>
            <p className="placeholder__detail">{tab.path.replace(/\//g, '\\')}</p>
            <div className="placeholder__actions">
              <button type="button" className="button" onClick={() => void controller.reload()}>
                Try again
              </button>
              <button type="button" className="button button--ghost" onClick={props.onClose}>
                Close file
              </button>
            </div>
          </div>
        </div>
      )}
      {snap.status === 'ready' && (
        <div className="editor-status" aria-live="off">
          <span className={`editor-status__save editor-status__save--${saveLabel.tone}`} data-save-state={saveLabel.key} role="status">
            {saveLabel.text}
          </span>
          <span className="editor-status__path" title={tab.path.replace(/\//g, '\\')}>
            {tab.path.replace(/\//g, '\\')}
          </span>
          <span>
            Ln {snap.line}, Col {snap.column}
          </span>
          <span>{snap.language}</span>
          <span>{snap.encoding === 'utf16le' ? 'UTF-16 LE' : snap.encoding === 'utf8bom' ? 'UTF-8 BOM' : 'UTF-8'}</span>
          <span>{snap.eol}</span>
        </div>
      )}
    </div>
  );
}
