// Pasting images and dropping files into a terminal. A clipboard image is saved as a PNG in a
// folder of our own under the temp directory and its path is typed at the prompt (never Enter),
// so a terminal agent (Claude Code, Codex, Gemini CLI) can read it as an attached image. Dropped
// or copied files type their paths. WSL tabs get Linux paths from the distribution's wslpath.
// Nothing is uploaded; pasted images are removed after a day and when SplitNest quits.
import path from 'node:path';
import type { PasteResult } from '../shared/types';
import type { Runner } from './exec';
import { decodeWslOutput, wslEnv } from './wsl';

/** Larger images are refused rather than written (an 8K screenshot is well below this). */
export const MAX_PASTE_IMAGE_BYTES = 64 * 1024 * 1024;
export const MAX_DROP_PATHS = 64;
export const PASTE_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const WSLPATH_TIMEOUT_MS = 15000;
const FILE_RE = /^shot-\d{8}-\d{6}-\d+\.png$/;

/** Converts every argument with `wslpath -u`; NUL-separated, positional parameters only. */
export const WSLPATH_SCRIPT = 'for p; do wslpath -u "$p" || exit 3; printf "\\0"; done';

export interface PasteDeps {
  /** The folder for pasted images (created when needed). */
  dir: string;
  /** The clipboard's image as PNG bytes, null when it holds none, 'too-large' over the limit. */
  readImagePng(): Promise<Buffer | null | 'too-large'>;
  mkdir(dir: string): Promise<void>;
  writeFile(file: string, data: Buffer): Promise<void>;
  list(dir: string): Promise<string[]>;
  mtimeMs(file: string): Promise<number | null>;
  remove(file: string): Promise<void>;
  now(): number;
  /** The WSL distribution of a known shell profile, '' for a Windows shell, null when unknown. */
  distroOf(profileId: string): Promise<string | null>;
  run: Runner;
  wslExe: string;
  env: NodeJS.ProcessEnv;
}

const pad = (n: number, w = 2) => String(n).padStart(w, '0');

export function pasteFileName(at: Date, n: number): string {
  const d = `${at.getFullYear()}${pad(at.getMonth() + 1)}${pad(at.getDate())}`;
  const t = `${pad(at.getHours())}${pad(at.getMinutes())}${pad(at.getSeconds())}`;
  return `shot-${d}-${t}-${n}.png`;
}

/**
 * A path as typed at the prompt, quoted only when it isn't plain: Windows shells in double quotes
 * (as Windows Terminal types a dropped file), Linux shells in single quotes.
 */
export function quotePath(p: string, linux: boolean): string {
  if (linux) return /^[A-Za-z0-9_./-]+$/.test(p) ? p : `'${p.replace(/'/g, `'\\''`)}'`;
  if (/^[A-Za-z0-9_.\\:-]+$/.test(p)) return p;
  // PowerShell expands $ and ` inside double quotes; single quotes keep them literal.
  return /[$`]/.test(p) ? `'${p.replace(/'/g, "''")}'` : `"${p}"`;
}

/** An absolute Windows path (drive or UNC) without characters a file name can't have. */
export function isWindowsPath(p: unknown): p is string {
  return (
    typeof p === 'string' &&
    p.length > 2 &&
    p.length <= 4096 &&
    /^(?:[A-Za-z]:\\|\\\\[^\\]+\\)/.test(p) &&
    !/[\u0000-\u001f"<>|*?]/.test(p.slice(2))
  );
}

export function createPasteService(deps: PasteDeps) {
  let counter = 0;

  async function shellText(profileId: string, windowsPaths: string[]): Promise<PasteResult> {
    const distro = await deps.distroOf(profileId);
    if (distro === null) return { ok: false, reason: 'failed', message: 'This terminal’s shell is not available.' };
    if (!distro) return { ok: true, text: windowsPaths.map((p) => quotePath(p, false)).join(' ') };
    const r = await deps.run(deps.wslExe, ['--distribution', distro, '--exec', 'sh', '-c', WSLPATH_SCRIPT, 'splitnest-paste', ...windowsPaths], {
      timeoutMs: WSLPATH_TIMEOUT_MS,
      env: wslEnv(deps.env),
    });
    const out = r.code === 0 && !r.timedOut ? r.stdout.toString('utf8').split('\0').slice(0, -1) : [];
    if (out.length !== windowsPaths.length || out.some((p) => !p.startsWith('/') || /[\n\r]/.test(p))) {
      const detail = decodeWslOutput(r.stderr).trim().split(/\r?\n/)[0]?.slice(0, 200);
      return {
        ok: false,
        reason: 'failed',
        message: r.timedOut ? `${distro} did not respond in time.` : `${distro} could not convert the path to a Linux path.`,
        ...(detail ? { detail } : {}),
      };
    }
    return { ok: true, text: out.map((p) => quotePath(p, true)).join(' ') };
  }

  return {
    /** Saves the clipboard's image and returns its path as typed in that shell. */
    async pasteImage(profileId: string): Promise<PasteResult> {
      if ((await deps.distroOf(profileId)) === null) return { ok: false, reason: 'failed', message: 'This terminal’s shell is not available.' };
      const png = await deps.readImagePng().catch(() => null);
      if (!png || png.length === 0) return { ok: false, reason: 'no-image', message: 'The clipboard has no text or image.' };
      if (png === 'too-large' || png.length > MAX_PASTE_IMAGE_BYTES) {
        return { ok: false, reason: 'too-large', message: `The image is too large to paste (over ${MAX_PASTE_IMAGE_BYTES / 1024 / 1024} MB).` };
      }
      try {
        await deps.mkdir(deps.dir);
        const file = path.win32.join(deps.dir, pasteFileName(new Date(deps.now()), ++counter));
        await deps.writeFile(file, png);
        return await shellText(profileId, [file]);
      } catch {
        return { ok: false, reason: 'failed', message: 'The image could not be saved.' };
      }
    },

    /** Dropped or copied files: their paths as typed in that shell. */
    async filePaths(profileId: string, paths: unknown): Promise<PasteResult> {
      if (!Array.isArray(paths) || paths.length === 0 || paths.length > MAX_DROP_PATHS || !paths.every(isWindowsPath)) {
        return { ok: false, reason: 'failed', message: 'These items have no file path to insert.' };
      }
      return shellText(profileId, paths);
    },

    /** Removes pasted images older than maxAgeMs (all of them with 0). Only our own file names. */
    async cleanup(maxAgeMs: number): Promise<number> {
      let removed = 0;
      for (const name of await deps.list(deps.dir)) {
        if (!FILE_RE.test(name)) continue;
        const file = path.win32.join(deps.dir, name);
        const m = await deps.mtimeMs(file);
        if (m === null || deps.now() - m < maxAgeMs) continue;
        await deps.remove(file).then(
          () => removed++,
          () => undefined,
        );
      }
      return removed;
    },
  };
}

export type PasteService = ReturnType<typeof createPasteService>;
