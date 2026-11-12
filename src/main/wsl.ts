// WSL discovery and Windows-to-Linux directory mapping using wsl.exe and
// wslpath with structured arguments. Never starts, stops or shuts down
// distributions on its own beyond running a short query inside one.
import type { AppError, WslStatus } from '../shared/types';
import type { Runner } from './exec';

export interface WslDistro {
  name: string;
  isDefault: boolean;
  version: number;
}

/** Internal Docker Desktop distributions have no usable interactive shell. */
export const HIDDEN_DISTROS = new Set(['docker-desktop', 'docker-desktop-data']);

export const WSL_LIST_TIMEOUT_MS = 8000;
export const WSL_RESOLVE_TIMEOUT_MS = 25000;

/**
 * wsl.exe writes its own messages as UTF-16LE unless WSL_UTF8=1 is honoured
 * (newer releases). Commands run inside Linux write UTF-8.
 */
export function decodeWslOutput(buffer: Buffer): string {
  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) {
    return buffer.subarray(2).toString('utf16le');
  }
  const sample = Math.min(buffer.length, 256);
  let oddNuls = 0;
  for (let i = 1; i < sample; i += 2) if (buffer[i] === 0) oddNuls++;
  if (sample >= 4 && oddNuls >= (sample / 2) * 0.6) return buffer.toString('utf16le');
  return buffer.toString('utf8').replace(/^﻿/, '');
}

/** Parses `wsl --list --verbose`. The header row is skipped because its last column is not numeric. */
export function parseWslList(text: string): WslDistro[] {
  const distros: WslDistro[] = [];
  for (const line of text.replace(/\0/g, '').split(/\r?\n/)) {
    const match = /^\s*(\*)?\s*([A-Za-z0-9._-]+)\s+(\S+)\s+(\d+)\s*$/.exec(line);
    if (!match) continue;
    distros.push({ name: match[2]!, isDefault: match[1] === '*', version: Number(match[4]) });
  }
  return distros;
}

function firstLine(text: string): string {
  return (
    text
      .replace(/\0/g, '')
      .split(/\r?\n/)
      .map((l) => l.trim())
      .find((l) => l.length > 0)
      ?.slice(0, 240) ?? ''
  );
}

export function wslEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return { ...env, WSL_UTF8: '1' };
}

export interface WslDiscovery {
  status: WslStatus;
  distros: WslDistro[];
}

export async function discoverWsl(
  run: Runner,
  wslExe: string | null,
  env: NodeJS.ProcessEnv,
): Promise<WslDiscovery> {
  if (!wslExe) {
    return { status: { state: 'not-installed', message: 'wsl.exe was not found on this system.' }, distros: [] };
  }
  const result = await run(wslExe, ['--list', '--verbose'], { timeoutMs: WSL_LIST_TIMEOUT_MS, env: wslEnv(env) });
  if (result.notFound) {
    return { status: { state: 'not-installed', message: 'wsl.exe could not be started.' }, distros: [] };
  }
  if (result.timedOut) {
    return { status: { state: 'error', message: 'WSL did not respond in time while listing distributions.' }, distros: [] };
  }
  const text = decodeWslOutput(result.stdout) + '\n' + decodeWslOutput(result.stderr);
  const distros = parseWslList(text).filter((d) => !HIDDEN_DISTROS.has(d.name.toLowerCase()));
  if (result.code !== 0) {
    const message = firstLine(text) || `wsl.exe exited with code ${result.code}`;
    if (/no installed distributions/i.test(text)) return { status: { state: 'no-distributions', message }, distros: [] };
    return { status: { state: 'error', message }, distros: [] };
  }
  if (distros.length === 0) {
    return { status: { state: 'no-distributions', message: 'No WSL distributions are installed.' }, distros: [] };
  }
  return { status: { state: 'available' }, distros };
}

/**
 * Converts a Windows directory to the distribution's Linux path with
 * `wslpath -u` and confirms it is a directory. The path is passed as a
 * positional parameter ("$1"), never interpolated into the script.
 */
export const RESOLVE_SCRIPT = 'p="$(wslpath -u "$1")" || exit 3; [ -d "$p" ] || exit 4; printf "%s" "$p"';

export type ResolveResult = { ok: true; linuxPath: string } | { ok: false; error: AppError };

export async function resolveWslDirectory(
  run: Runner,
  wslExe: string,
  distro: string,
  windowsPath: string,
  env: NodeJS.ProcessEnv,
  timeoutMs = WSL_RESOLVE_TIMEOUT_MS,
): Promise<ResolveResult> {
  const result = await run(
    wslExe,
    ['--distribution', distro, '--exec', 'sh', '-c', RESOLVE_SCRIPT, 'wsl-path-check', windowsPath],
    { timeoutMs, env: wslEnv(env) },
  );
  if (result.timedOut) {
    return {
      ok: false,
      error: {
        code: 'WSL_TIMEOUT',
        message: `${distro} did not respond within ${Math.round(timeoutMs / 1000)} seconds while mapping the folder.`,
        fallback: 'start-in-home',
      },
    };
  }
  if (result.code !== 0) {
    const detail = firstLine(decodeWslOutput(result.stderr)) || firstLine(decodeWslOutput(result.stdout));
    const message =
      result.code === 3
        ? `${distro} could not convert this Windows folder to a Linux path.`
        : result.code === 4
          ? `The folder maps to a Linux path that is not accessible inside ${distro}.`
          : `${distro} could not be queried for the folder location.`;
    return { ok: false, error: { code: 'WSL_PATH_UNMAPPED', message, detail: detail || undefined, fallback: 'start-in-home' } };
  }
  const linuxPath = result.stdout.toString('utf8');
   
  if (!linuxPath.startsWith('/') || /[\u0000\n\r]/.test(linuxPath)) {
    return {
      ok: false,
      error: { code: 'WSL_PATH_UNMAPPED', message: `${distro} returned an unexpected path.`, fallback: 'start-in-home' },
    };
  }
  return { ok: true, linuxPath };
}
