// File tree for a workspace folder: lazy loading, virtualised rows, keyboard
// navigation and a small context menu. Files open in the built-in editor;
// the tree itself never runs, renames, moves or deletes anything.
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import { LIMITS, type DirEntry, type Workspace } from '../../../shared/types';
import { api } from '../../api';
import { ContextMenu } from '../../components/ContextMenu';
import { Icon } from '../../components/Icon';
import { IconButton } from '../../components/IconButton';
import { shortcutLabel } from '../commands/shortcuts';
import { flushSave } from '../workspaces/persistence';
import { iconUrl } from './icon-urls';
import { buildRows, chainContinuation, peekCandidates, rowForPath, rowStart, type DirState, type Row } from './explorer-tree';
import { parentOf, toWindowsPath } from './paths';

const ROW_HEIGHT = 24;
const OVERSCAN = 12;
/** Indentation per tree level (px). Kept small so deep Java packages stay readable. */
const INDENT = 12;
/** Longest chain inspected below a collapsed folder (each step lists one folder). */
const MAX_CHAIN_PEEK = 24;
/** Most cached folders re-listed by one refresh. */
const MAX_REFRESH = 400;

interface Props {
  workspace: Workspace;
  width: number;
  /** Largest width that still leaves room for the terminals. */
  maxWidth: number;
  /** Show chains of single-folder directories as one row (src/main/java). */
  compactFolders: boolean;
  focusToken: number;
  onWidthChange(width: number): void;
  onHide(): void;
  onInsertPath(relativePath: string): void;
  onOpenFile(relativePath: string): void;
  notify(kind: 'info' | 'warning' | 'error', message: string): void;
}

export function Explorer({ workspace, width, maxWidth, compactFolders, focusToken, onWidthChange, onHide, onInsertPath, onOpenFile, notify }: Props) {
  const [dirs, setDirs] = useState<Map<string, DirState>>(() => new Map());
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set(['']));
  const [selected, setSelected] = useState<string | null>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewHeight, setViewHeight] = useState(400);
  const [menu, setMenu] = useState<{ x: number; y: number; path: string; kind: DirEntry['kind'] } | null>(null);
  const treeRef = useRef<HTMLDivElement>(null);
  const expandedRef = useRef(expanded);
  expandedRef.current = expanded;
  const compactRef = useRef(compactFolders);
  compactRef.current = compactFolders;

  const dirsRef = useRef(dirs);
  dirsRef.current = dirs;
  /** Bumped when the workspace folder changes, so late results from the old folder are dropped. */
  const generation = useRef(0);

  /**
   * Lists a folder. `show`: a folder the user sees (expanded); its child
   * folders are inspected so compact chains appear without expanding them.
   * `peek`: inspection only (one level), continued down a chain while each
   * folder holds exactly one real folder. Bounded per listing and per chain;
   * never follows links or junctions; errors simply end a chain.
   */
  const load = useCallback(
    async (path: string, mode: 'show' | 'peek' = 'show', chainDepth = 0) => {
      const gen = generation.current;
      if (mode === 'show') setDirs((m) => new Map(m).set(path, { status: 'loading', entries: m.get(path)?.entries ?? [] }));
      // Main must know about a just-created or relinked workspace first.
      await new Promise((resolve) => setTimeout(resolve, 0));
      await flushSave();
      const result = await api.listDirectory(workspace.id, path);
      if (gen !== generation.current) return;
      const state: DirState = result.ok
        ? { status: 'loaded', entries: result.entries, truncated: result.truncated }
        : { status: 'error', entries: [], error: result.error.message };
      dirsRef.current = new Map(dirsRef.current).set(path, state);
      setDirs((m) => new Map(m).set(path, state));
      if (!result.ok || !compactRef.current) return;
      const next = chainContinuation(path, result.entries, result.truncated);
      if (next && expandedRef.current.has(path)) {
        // An expanded folder whose only entry is a folder opens that one too,
        // so the whole chain (src/main/java) appears as one expanded row.
        setExpanded((s) => (s.has(next) ? s : new Set(s).add(next)));
        void loadRef.current(next, 'show');
      } else if (next && mode === 'peek' && chainDepth < MAX_CHAIN_PEEK && !dirsRef.current.has(next)) {
        void loadRef.current(next, 'peek', chainDepth + 1);
      }
      if (mode === 'show' && expandedRef.current.has(path)) {
        for (const child of peekCandidates(path, result.entries, (p) => dirsRef.current.has(p))) void loadRef.current(child, 'peek');
      }
    },
    [workspace.id],
  );

  const loadRef = useRef(load);
  loadRef.current = load;

  /** Re-lists expanded folders, and re-inspects cached ones so chains break or form when folders change. */
  const refreshAll = useCallback(() => {
    let budget = MAX_REFRESH;
    for (const path of dirsRef.current.keys()) {
      if (budget-- <= 0) break;
      void load(path, expandedRef.current.has(path) ? 'show' : 'peek');
    }
    for (const path of expandedRef.current) if (!dirsRef.current.has(path)) void load(path);
  }, [load]);

  // New or relinked workspace folder: start over.
  useEffect(() => {
    generation.current++;
    dirsRef.current = new Map();
    setDirs(new Map());
    setExpanded(new Set(['']));
    setSelected(null);
    void load('');
  }, [workspace.rootPath, load]);

  // There is no file watcher; refresh open folders when the window regains focus.
  useEffect(() => {
    let last = 0;
    const onFocus = () => {
      if (Date.now() - last < 1500) return;
      last = Date.now();
      refreshAll();
    };
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [refreshAll]);

  useEffect(() => {
    if (focusToken > 0) treeRef.current?.focus();
  }, [focusToken]);

  useLayoutEffect(() => {
    const el = treeRef.current;
    if (!el) return;
    const observer = new ResizeObserver(() => setViewHeight(el.clientHeight));
    observer.observe(el);
    setViewHeight(el.clientHeight);
    return () => observer.disconnect();
  }, []);

  const rows = useMemo(() => buildRows(dirs, expanded, compactFolders), [dirs, expanded, compactFolders]);

  const entryRows = useMemo(() => rows.filter((r): r is Extract<Row, { type: 'entry' }> => r.type === 'entry'), [rows]);
  // The selected path may be one segment of a compacted row; that row is then the selected one.
  const selectedRow = selected ? rowForPath(entryRows, selected) : undefined;
  const selectedRowPath = selectedRow?.path ?? null;

  const toggle = (path: string, open?: boolean) => {
    const isOpen = expanded.has(path);
    const next = open ?? !isOpen;
    if (next === isOpen) return;
    setExpanded((s) => {
      const copy = new Set(s);
      if (next) copy.add(path);
      else copy.delete(path);
      return copy;
    });
    // Also when already inspected: listing it as shown inspects its child folders for chains.
    if (next) void load(path, 'show');
  };

  const collapseAll = () => {
    setExpanded(new Set(['']));
    setSelected(null);
  };

  const scrollIntoView = (path: string) => {
    const target = rowForPath(rows, path);
    const index = target ? rows.indexOf(target) : -1;
    const el = treeRef.current;
    if (index < 0 || !el) return;
    const top = index * ROW_HEIGHT;
    if (top < el.scrollTop) el.scrollTop = top;
    else if (top + ROW_HEIGHT > el.scrollTop + el.clientHeight) el.scrollTop = top + ROW_HEIGHT - el.clientHeight;
  };

  const select = (path: string | null) => {
    setSelected(path);
    if (path) requestAnimationFrame(() => scrollIntoView(path));
  };

  const copyText = async (text: string, label: string) => {
    await api.writeClipboard(text);
    notify('info', `${label} copied.`);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (entryRows.length === 0) return;
    const index = selectedRow ? entryRows.indexOf(selectedRow) : -1;
    const current = index >= 0 ? entryRows[index] : undefined;
    const go = (i: number) => select(entryRows[Math.max(0, Math.min(entryRows.length - 1, i))]!.path);
    switch (event.key) {
      case 'ArrowDown':
        go(index + 1);
        break;
      case 'ArrowUp':
        go(index < 0 ? 0 : index - 1);
        break;
      case 'Home':
        go(0);
        break;
      case 'End':
        go(entryRows.length - 1);
        break;
      case 'PageDown':
        go(index + Math.floor(viewHeight / ROW_HEIGHT));
        break;
      case 'PageUp':
        go(index - Math.floor(viewHeight / ROW_HEIGHT));
        break;
      case 'ArrowRight':
        if (current?.kind === 'directory') {
          if (!expanded.has(current.path)) toggle(current.path, true);
          else go(index + 1);
        }
        break;
      case 'ArrowLeft':
        if (current?.kind === 'directory' && expanded.has(current.path)) toggle(current.path, false);
        else if (current && parentOf(rowStart(current))) select(rowForPath(entryRows, parentOf(rowStart(current)))?.path ?? null);
        break;
      case 'Enter':
      case ' ':
        if (current?.kind === 'directory') toggle(current.path);
        else if (current && event.key === 'Enter' && (event.ctrlKey || event.altKey)) onInsertPath(current.path);
        else if (current && event.key === 'Enter') onOpenFile(current.path);
        break;
      case 'ContextMenu':
      case 'F10':
        if (event.key === 'F10' && !event.shiftKey) return;
        if (current) {
          const row = treeRef.current?.querySelector(`[data-path="${CSS.escape(current.path)}"]`)?.getBoundingClientRect();
          setMenu({ x: (row?.left ?? 0) + 24, y: (row?.bottom ?? 0) + 2, path: current.path, kind: current.kind });
        }
        break;
      default:
        return;
    }
    event.preventDefault();
  };

  // ------------------------------------------------------ width resizing
  const drag = useRef<{ startX: number; startWidth: number } | null>(null);
  const clampWidth = (w: number) => Math.round(Math.min(maxWidth, Math.max(LIMITS.explorerWidth.min, w)));
  const onHandleDown = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { startX: e.clientX, startWidth: width };
    e.preventDefault();
  };
  const onHandleMove = (e: PointerEvent<HTMLDivElement>) => {
    if (drag.current) onWidthChange(clampWidth(drag.current.startWidth + e.clientX - drag.current.startX));
  };
  const onHandleUp = (e: PointerEvent<HTMLDivElement>) => {
    drag.current = null;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
  };

  const first = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN);
  const last = Math.min(rows.length, Math.ceil((scrollTop + viewHeight) / ROW_HEIGHT) + OVERSCAN);
  const rootName = workspace.rootPath.split(/[\\/]/).filter(Boolean).pop() ?? workspace.rootPath;
  const activeId = selectedRow ? `explorer-${workspace.id}-${rows.indexOf(selectedRow)}` : undefined;

  return (
    <aside className="explorer" style={{ width }} aria-label="File explorer">
      <div className="explorer__header">
        <span className="explorer__title" title={workspace.rootPath}>
          {rootName}
        </span>
        <IconButton icon="restart" label="Refresh file list" size="sm" onClick={refreshAll} />
        <IconButton icon="collapse" label="Collapse all folders" size="sm" onClick={collapseAll} />
        <IconButton icon="close" label="Hide file explorer" size="sm" shortcut={shortcutLabel('toggleExplorer')} onClick={onHide} />
      </div>
      <div
        ref={treeRef}
        className="explorer__tree"
        role="tree"
        aria-label={`Files in ${rootName}`}
        tabIndex={0}
        aria-activedescendant={activeId}
        onKeyDown={onKeyDown}
        onScroll={(e) => {
          setScrollTop(e.currentTarget.scrollTop);
          setMenu(null);
        }}
        onFocus={() => {
          if (!selected && entryRows[0]) setSelected(entryRows[0].path);
        }}
      >
        <div style={{ height: rows.length * ROW_HEIGHT, position: 'relative' }}>
          {rows.slice(first, last).map((row, i) => {
            const index = first + i;
            const style = { top: index * ROW_HEIGHT, paddingLeft: 8 + row.depth * INDENT };
            if (row.type === 'status') {
              return (
                <div key={row.id} className={`explorer__status${row.error ? ' explorer__status--error' : ''}`} style={style}>
                  {row.text}
                </div>
              );
            }
            const isDir = row.kind === 'directory';
            const isOpen = isDir && expanded.has(row.path);
            return (
              <div
                key={row.id}
                id={`explorer-${workspace.id}-${index}`}
                data-path={row.path}
                role="treeitem"
                aria-level={row.depth + 1}
                aria-expanded={isDir ? isOpen : undefined}
                aria-selected={selectedRowPath === row.path}
                aria-label={row.segments ? `Folders ${row.segments.map((s) => s.name).join(', then ')}` : undefined}
                className={`explorer__row${selectedRowPath === row.path ? ' explorer__row--selected' : ''}`}
                style={style}
                title={`${toWindowsPath(workspace.rootPath, row.path)}${row.symlink ? ' (link)' : ''}`}
                onClick={() => {
                  setSelected(row.path);
                  if (isDir) {
                    toggle(row.path);
                    treeRef.current?.focus();
                  } else {
                    onOpenFile(row.path);
                  }
                }}
                onContextMenu={(e) => {
                  e.preventDefault();
                  // A right-click on one segment of src/main/java acts on that real folder.
                  const segment = (e.target as HTMLElement).closest<HTMLElement>('[data-segment-path]')?.dataset.segmentPath;
                  const target = segment ?? row.path;
                  setSelected(target);
                  setMenu({ x: e.clientX, y: e.clientY, path: target, kind: row.kind });
                }}
              >
                {Array.from({ length: row.depth }, (_, d) => (
                  <span key={d} className="explorer__guide" style={{ left: 14 + d * INDENT }} aria-hidden="true" />
                ))}
                <span className="explorer__chevron" aria-hidden="true">
                  {isDir && <Icon name={isOpen ? 'chevronDown' : 'chevronRight'} size={14} />}
                </span>
                <img className="explorer__icon" src={iconUrl(row.kind, row.name)} alt="" width={16} height={16} draggable={false} />
                {row.segments ? (
                  <span className="explorer__name explorer__name--compact">
                    {row.segments.map((s, k) => (
                      <span key={s.path}>
                        {k > 0 && <span className="explorer__sep">/</span>}
                        <span className="explorer__segment" data-segment-path={s.path} title={toWindowsPath(workspace.rootPath, s.path)}>
                          {s.name}
                        </span>
                      </span>
                    ))}
                  </span>
                ) : (
                  <span className={`explorer__name${row.symlink ? ' explorer__name--link' : ''}`}>{row.name}</span>
                )}
              </div>
            );
          })}
        </div>
      </div>
      <div
        className="explorer__handle"
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize file explorer"
        aria-valuemin={LIMITS.explorerWidth.min}
        aria-valuemax={maxWidth}
        aria-valuenow={width}
        tabIndex={0}
        onPointerDown={onHandleDown}
        onPointerMove={onHandleMove}
        onPointerUp={onHandleUp}
        onPointerCancel={onHandleUp}
        onKeyDown={(e) => {
          const step = e.shiftKey ? 40 : 10;
          if (e.key === 'ArrowLeft') onWidthChange(clampWidth(width - step));
          else if (e.key === 'ArrowRight') onWidthChange(clampWidth(width + step));
          else return;
          e.preventDefault();
        }}
      />
      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          onClose={() => {
            setMenu(null);
            treeRef.current?.focus();
          }}
          items={[
            ...(menu.kind === 'file' ? [{ label: 'Open in editor', hint: 'Enter', run: () => onOpenFile(menu.path) }] : []),
            { label: 'Insert path into terminal', hint: menu.kind === 'file' ? 'Ctrl+Enter' : undefined, run: () => onInsertPath(menu.path) },
            { label: 'Copy path', run: () => void copyText(toWindowsPath(workspace.rootPath, menu.path), 'Path') },
            { label: 'Copy relative path', run: () => void copyText(menu.path.replace(/\//g, '\\'), 'Relative path') },
            {
              label: 'Reveal in File Explorer',
              run: () =>
                void api.revealPath(workspace.id, menu.path).then((ok) => {
                  if (!ok) notify('error', 'That item could not be shown.');
                }),
            },
          ]}
        />
      )}
    </aside>
  );
}
