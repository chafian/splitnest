// Text file access for the built-in editor. Files are read and written only
// inside a workspace folder, only when they already exist, and only when the
// user saves explicitly. Contents are never logged or kept in app state.
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { access, readFile, realpath, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  LIMITS,
  type ReadFileResult,
  type StatFileResult,
  type TextEncoding,
  type WriteFileRequest,
  type WriteFileResult,
} from '../shared/types';
import { resolveInsideRoot } from './file-explorer';

const BINARY_SNIFF_BYTES = 8000;

const fail = (code: Extract<ReadFileResult, { ok: false }>['error']['code'], message: string, detail?: string) =>
  ({ ok: false, error: detail ? { code, message, detail } : { code, message } }) as const;

function errnoResult(error: unknown) {
  const code = (error as NodeJS.ErrnoException).code;
  if (code === 'ENOENT' || code === 'ENOTDIR') return fail('FILE_NOT_FOUND', 'This file no longer exists.');
  if (code === 'EACCES' || code === 'EPERM') return fail('ACCESS_DENIED', 'Access to this file was denied.');
  if (code === 'EBUSY') return fail('ACCESS_DENIED', 'The file is locked by another program.');
  if (code === 'EISDIR') return fail('NOT_A_FILE', 'This is a folder, not a file.');
  return fail('INTERNAL', 'The file could not be accessed.', code);
}

/** True when `target` (after resolving links and junctions) is still inside `root`. */
async function realInside(root: string, target: string): Promise<boolean> {
  try {
    const [r, t] = await Promise.all([realpath(root), realpath(target)]);
    const rel = path.win32.relative(r.toLowerCase(), t.toLowerCase());
    return rel !== '' && !rel.startsWith('..') && !path.win32.isAbsolute(rel);
  } catch {
    return false;
  }
}

/** Decodes file bytes. Returns null for content that looks binary. */
export function decodeText(buf: Buffer): { content: string; encoding: TextEncoding; valid: boolean } | null {
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) {
    return { content: buf.subarray(2).toString('utf16le'), encoding: 'utf16le', valid: true };
  }
  const bom = buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf;
  const body = bom ? buf.subarray(3) : buf;
  if (body.subarray(0, BINARY_SNIFF_BYTES).includes(0)) return null;
  try {
    const content = new TextDecoder('utf-8', { fatal: true }).decode(body);
    return { content, encoding: bom ? 'utf8bom' : 'utf8', valid: true };
  } catch {
    // Another 8-bit encoding (e.g. Windows-1252). Shown with replacement characters, never saved.
    return { content: new TextDecoder('utf-8').decode(body), encoding: bom ? 'utf8bom' : 'utf8', valid: false };
  }
}

export function encodeText(content: string, encoding: TextEncoding): Buffer {
  if (encoding === 'utf16le') return Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(content, 'utf16le')]);
  const body = Buffer.from(content, 'utf8');
  return encoding === 'utf8bom' ? Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), body]) : body;
}

export async function readTextFile(root: string, relativePath: unknown): Promise<ReadFileResult> {
  const absolute = resolveInsideRoot(root, relativePath);
  if (!absolute) return fail('FORBIDDEN', 'That path is outside the workspace folder.');
  try {
    const info = await stat(absolute);
    if (!info.isFile()) return fail('NOT_A_FILE', 'Only files can be opened in the editor.');
    if (info.size > LIMITS.maxEditorFileBytes) {
      return fail('FILE_TOO_LARGE', `This file is larger than ${LIMITS.maxEditorFileBytes / 1024 / 1024} MB, so it is not opened in the editor.`);
    }
    const buf = await readFile(absolute);
    const decoded = decodeText(buf);
    if (!decoded) return fail('BINARY_FILE', 'This looks like a binary file, so it is not opened in the editor.');
    let readOnly: string | null = null;
    if (!decoded.valid) readOnly = 'The file is not valid UTF-8 or UTF-16, so it is opened read-only to avoid changing its encoding.';
    else if (!(await realInside(root, absolute))) readOnly = 'This item links to a location outside the workspace folder, so it is opened read-only.';
    else {
      try {
        await access(absolute, constants.W_OK);
      } catch {
        readOnly = 'The file is read-only.';
      }
    }
    return { ok: true, content: decoded.content, encoding: decoded.encoding, mtimeMs: info.mtimeMs, size: info.size, hash: contentHash(buf), readOnly };
  } catch (error) {
    return errnoResult(error);
  }
}

/** Version of a file's content. Timestamps alone can miss changes (coarse resolution, tools that restore mtimes). */
export function contentHash(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** Current version of a file on disk (reads it to hash; files above the editor limit get `hash: null`). */
export async function statTextFile(root: string, relativePath: unknown): Promise<StatFileResult> {
  const absolute = resolveInsideRoot(root, relativePath);
  if (!absolute) return fail('FORBIDDEN', 'That path is outside the workspace folder.');
  try {
    const info = await stat(absolute);
    if (!info.isFile()) return fail('NOT_A_FILE', 'Only files can be opened in the editor.');
    const hash = info.size <= LIMITS.maxEditorFileBytes ? contentHash(await readFile(absolute)) : null;
    return { ok: true, mtimeMs: info.mtimeMs, size: info.size, hash };
  } catch (error) {
    return errnoResult(error);
  }
}

/**
 * Saves an existing file in place (keeping its permissions, links and
 * identity). Refuses new files, files outside the workspace (also through
 * links), and files whose current bytes differ from the version the editor
 * last loaded or saved, unless the user confirmed an overwrite.
 *
 * Remaining race: another program can still change the file in the short
 * window between this check and the write. Windows offers no portable
 * compare-and-swap for in-place writes, so this narrows the window to a few
 * milliseconds rather than closing it.
 */
export async function writeTextFile(root: string, request: Omit<WriteFileRequest, 'workspaceId'>): Promise<WriteFileResult> {
  const absolute = resolveInsideRoot(root, request.path);
  if (!absolute) return fail('FORBIDDEN', 'That path is outside the workspace folder.');
  if (typeof request.content !== 'string') return fail('INVALID_REQUEST', 'Invalid content.');
  if (request.encoding !== 'utf8' && request.encoding !== 'utf8bom' && request.encoding !== 'utf16le') {
    return fail('INVALID_REQUEST', 'Invalid encoding.');
  }
  if (typeof request.expectedHash !== 'string' || !/^[0-9a-f]{64}$/.test(request.expectedHash)) return fail('INVALID_REQUEST', 'Invalid file version.');
  const data = encodeText(request.content, request.encoding);
  if (data.length > LIMITS.maxEditorFileBytes) return fail('FILE_TOO_LARGE', 'The file is too large to save from the editor.');
  try {
    const info = await stat(absolute);
    if (!info.isFile()) return fail('NOT_A_FILE', 'Only existing files can be saved.');
    if (!(await realInside(root, absolute))) return fail('READ_ONLY', 'This item links outside the workspace folder, so it is not saved.');
    if (request.overwrite !== true) {
      // Independent of any watcher event: compare what is on disk right now.
      const current = info.size > LIMITS.maxEditorFileBytes ? null : contentHash(await readFile(absolute));
      if (current !== request.expectedHash) return fail('CONFLICT', 'The file was changed on disk after it was opened.');
    }
    await writeFile(absolute, data); // in place: truncate + write (flag 'w')
    const after = await stat(absolute);
    return { ok: true, mtimeMs: after.mtimeMs, size: after.size, hash: contentHash(data) };
  } catch (error) {
    return errnoResult(error);
  }
}
