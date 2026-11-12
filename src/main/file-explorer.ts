// Read-only directory listing for the file explorer. Paths are relative to a
// workspace root and may not escape it lexically (no `..`, drive letters,
// alternate data streams or absolute paths). Only names and types are returned.
import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { LIMITS, type DirEntry, type ListDirectoryResult } from '../shared/types';

const collator = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });

/** Resolves a `/`- or `\`-separated relative path inside `root`, or returns null if it is not allowed. */
export function resolveInsideRoot(root: string, relativePath: unknown): string | null {
  if (typeof relativePath !== 'string' || relativePath.length > LIMITS.maxPathLength) return null;
  // Control characters, drive/stream colons, wildcards, and anything that looks absolute (`\x`, `\\server`).
  if (/[\x00-\x1f:*?"<>|]/.test(relativePath) || /^[\\/]/.test(relativePath)) return null;
  const segments = relativePath.split(/[\\/]+/).filter(Boolean);
  if (segments.some((s) => s === '..' || s === '.')) return null;
  const absolute = path.win32.join(root, ...segments);
  const back = path.win32.relative(root, absolute);
  if (back.startsWith('..') || path.win32.isAbsolute(back)) return null;
  return absolute;
}

export function sortEntries(entries: DirEntry[]): DirEntry[] {
  return [...entries].sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === 'directory' ? -1 : 1;
    return collator.compare(a.name, b.name);
  });
}

export async function listDirectory(root: string, relativePath: unknown): Promise<ListDirectoryResult> {
  const absolute = resolveInsideRoot(root, relativePath);
  if (!absolute) return { ok: false, error: { code: 'FORBIDDEN', message: 'That path is outside the workspace folder.' } };
  let dirents;
  try {
    dirents = await readdir(absolute, { withFileTypes: true });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      return { ok: false, error: { code: 'FOLDER_MISSING', message: 'This folder no longer exists.' } };
    }
    if (code === 'EACCES' || code === 'EPERM') {
      return { ok: false, error: { code: 'ACCESS_DENIED', message: 'Access to this folder was denied.' } };
    }
    return { ok: false, error: { code: 'INTERNAL', message: 'The folder could not be read.', detail: code } };
  }
  const truncated = dirents.length > LIMITS.maxDirectoryEntries;
  const entries = await Promise.all(
    dirents.slice(0, LIMITS.maxDirectoryEntries).map(async (d): Promise<DirEntry> => {
      if (!d.isSymbolicLink()) return { name: d.name, kind: d.isDirectory() ? 'directory' : 'file', symlink: false };
      try {
        const target = await stat(path.win32.join(absolute, d.name));
        return { name: d.name, kind: target.isDirectory() ? 'directory' : 'file', symlink: true };
      } catch {
        return { name: d.name, kind: 'file', symlink: true }; // broken link
      }
    }),
  );
  return { ok: true, entries: sortEntries(entries), truncated };
}
