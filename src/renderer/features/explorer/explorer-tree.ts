// Builds the visible rows of the file tree (pure; no DOM). With "compact
// folders", a chain of directories that each contain exactly one entry, a
// directory, is shown as one row such as `src/main/java`. Nothing on disk
// changes: the row is just a view of real paths, and each segment keeps its
// own real path.
import { LIMITS, type DirEntry } from '../../../shared/types';
import { joinRelative } from './paths';

export interface DirState {
  status: 'loading' | 'loaded' | 'error';
  entries: DirEntry[];
  truncated?: boolean;
  error?: string;
}

export interface Segment {
  name: string;
  /** Real workspace-relative path of this directory. */
  path: string;
}

export type Row =
  | {
      type: 'entry';
      id: string;
      /** Real path of the row's target: the deepest directory of a compacted chain. */
      path: string;
      /** Display text, e.g. `src/main/java` for a compacted chain. */
      name: string;
      kind: DirEntry['kind'];
      symlink: boolean;
      depth: number;
      /** For compacted directories: one segment per real directory, outermost first. */
      segments?: Segment[];
    }
  | { type: 'status'; id: string; depth: number; text: string; error?: boolean };

/**
 * Follows a directory down while it is loaded and holds exactly one entry
 * that is a (non-link) directory. Links are never folded in, so a junction
 * always stays a visible, separate row.
 */
export function compactChain(dirs: ReadonlyMap<string, DirState>, start: string, startName: string): Segment[] {
  const chain: Segment[] = [{ name: startName, path: start }];
  for (let guard = 0; guard < 64; guard++) {
    const state = dirs.get(chain[chain.length - 1]!.path);
    if (!state || state.status !== 'loaded' || state.truncated || state.entries.length !== 1) break;
    const only = state.entries[0]!;
    if (only.kind !== 'directory' || only.symlink) break;
    chain.push({ name: only.name, path: joinRelative(chain[chain.length - 1]!.path, only.name) });
  }
  return chain;
}

export function buildRows(dirs: ReadonlyMap<string, DirState>, expanded: ReadonlySet<string>, compact: boolean): Row[] {
  const out: Row[] = [];
  const walk = (path: string, depth: number) => {
    const state = dirs.get(path);
    if (!state || (state.status === 'loading' && state.entries.length === 0)) {
      out.push({ type: 'status', id: `status:${path}`, depth, text: 'Loading…' });
      return;
    }
    if (state.status === 'error') {
      out.push({ type: 'status', id: `status:${path}`, depth, text: state.error ?? 'Could not read folder', error: true });
      return;
    }
    if (state.entries.length === 0 && depth > 0) out.push({ type: 'status', id: `status:${path}`, depth, text: 'Empty folder' });
    for (const entry of state.entries) {
      const child = joinRelative(path, entry.name);
      if (entry.kind === 'directory' && compact && !entry.symlink) {
        const chain = compactChain(dirs, child, entry.name);
        const end = chain[chain.length - 1]!.path;
        out.push({
          type: 'entry',
          id: `entry:${child}`,
          path: end,
          name: chain.map((s) => s.name).join('/'),
          kind: 'directory',
          symlink: false,
          depth,
          ...(chain.length > 1 ? { segments: chain } : {}),
        });
        if (expanded.has(end)) walk(end, depth + 1);
        continue;
      }
      out.push({ type: 'entry', id: `entry:${child}`, path: child, name: entry.name, kind: entry.kind, symlink: entry.symlink, depth });
      if (entry.kind === 'directory' && expanded.has(child)) walk(child, depth + 1);
    }
    if (state.truncated) {
      out.push({ type: 'status', id: `status-trunc:${path}`, depth, text: `Showing the first ${LIMITS.maxDirectoryEntries.toLocaleString()} items` });
    }
  };
  walk('', 0);
  return out;
}

/** Most child folders inspected ("peeked") for one listing, to keep big folders cheap. */
export const MAX_PEEKS_PER_LISTING = 48;

/**
 * Child folders of a just-listed folder whose own listing is needed to know
 * whether they start a compact chain. Links/junctions are never inspected,
 * folders already in the cache are skipped, and at most `limit` are returned.
 * Nothing is scanned recursively: each peek inspects one level.
 */
export function peekCandidates(parent: string, entries: readonly DirEntry[], isCached: (path: string) => boolean, limit = MAX_PEEKS_PER_LISTING): string[] {
  const out: string[] = [];
  for (const e of entries) {
    if (out.length >= limit) break;
    if (e.kind !== 'directory' || e.symlink) continue;
    const child = joinRelative(parent, e.name);
    if (!isCached(child)) out.push(child);
  }
  return out;
}

/** The single child folder that continues a chain, or null (exactly one entry, a real folder). */
export function chainContinuation(parent: string, entries: readonly DirEntry[], truncated = false): string | null {
  if (truncated || entries.length !== 1) return null;
  const only = entries[0]!;
  return only.kind === 'directory' && !only.symlink ? joinRelative(parent, only.name) : null;
}

type EntryRow = Extract<Row, { type: 'entry' }>;

/** The row that shows `path`: the row itself, or the compacted row containing it as a segment. */
export function rowForPath(rows: readonly Row[], path: string): EntryRow | undefined {
  for (const r of rows) {
    if (r.type !== 'entry') continue;
    if (r.path === path || r.segments?.some((s) => s.path === path)) return r;
  }
  return undefined;
}

/** First real path shown by a row (the outermost segment of a compacted row). */
export function rowStart(row: EntryRow): string {
  return row.segments?.[0]?.path ?? row.path;
}
