// Shell profile discovery and launch construction. Executables are located
// here in the privileged backend; the renderer only ever sees profile IDs.
import { lstat } from 'node:fs/promises';
import path from 'node:path';
import type { ShellDiscovery, ShellProfile, StartLocation } from '../shared/types';
import type { Runner } from './exec';
import { discoverWsl } from './wsl';

export type ExistsFn = (file: string) => Promise<boolean>;

export const fileExists: ExistsFn = async (file) => {
  try {
    // lstat also succeeds for App Execution Aliases (reparse points) under WindowsApps.
    const info = await lstat(file);
    return info.isFile() || info.isSymbolicLink();
  } catch {
    return false;
  }
};

export interface ShellEnvironment {
  env: NodeJS.ProcessEnv;
  exists: ExistsFn;
  run: Runner;
}

export interface DiscoveredShells {
  discovery: ShellDiscovery;
  /** Profile ID to executable path. WSL profiles map to wsl.exe. */
  executables: Map<string, string>;
}

function envValue(env: NodeJS.ProcessEnv, key: string): string | undefined {
  const match = Object.keys(env).find((k) => k.toLowerCase() === key.toLowerCase());
  return match ? env[match] : undefined;
}

export async function findOnPath(exe: string, env: NodeJS.ProcessEnv, exists: ExistsFn): Promise<string | null> {
  const dirs = (envValue(env, 'PATH') ?? '').split(';').map((d) => d.trim().replace(/^"|"$/g, '')).filter(Boolean);
  for (const dir of dirs) {
    if (!path.win32.isAbsolute(dir)) continue;
    const candidate = path.win32.join(dir, exe);
    if (await exists(candidate)) return candidate;
  }
  return null;
}

export async function findPwsh(env: NodeJS.ProcessEnv, exists: ExistsFn): Promise<string | null> {
  const onPath = await findOnPath('pwsh.exe', env, exists);
  if (onPath) return onPath;
  const programFiles = envValue(env, 'ProgramFiles') ?? 'C:\\Program Files';
  for (const sub of ['7', '7-preview']) {
    const candidate = path.win32.join(programFiles, 'PowerShell', sub, 'pwsh.exe');
    if (await exists(candidate)) return candidate;
  }
  return null;
}

export async function discoverShells({ env, exists, run }: ShellEnvironment): Promise<DiscoveredShells> {
  const systemRoot = envValue(env, 'SystemRoot') ?? 'C:\\Windows';
  const profiles: ShellProfile[] = [];
  const executables = new Map<string, string>();

  const pwsh = await findPwsh(env, exists);
  if (pwsh) {
    profiles.push({ id: 'pwsh', kind: 'pwsh', label: 'PowerShell 7' });
    executables.set('pwsh', pwsh);
  }
  const winPs = path.win32.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  if (await exists(winPs)) {
    profiles.push({ id: 'windows-powershell', kind: 'windows-powershell', label: 'Windows PowerShell' });
    executables.set('windows-powershell', winPs);
  }

  const wslCandidate = path.win32.join(systemRoot, 'System32', 'wsl.exe');
  const wslExe = (await exists(wslCandidate)) ? wslCandidate : null;
  const wsl = await discoverWsl(run, wslExe, env);
  for (const distro of wsl.distros) {
    const id = `wsl:${distro.name}`;
    profiles.push({ id, kind: 'wsl', label: distro.name, distro: distro.name, isDefaultDistro: distro.isDefault });
    if (wslExe) executables.set(id, wslExe);
  }

  const fallbackProfileId = profiles.find((p) => p.kind !== 'wsl')?.id ?? profiles[0]?.id ?? null;
  return { discovery: { profiles, wsl: wsl.status, fallbackProfileId }, executables };
}

export interface LaunchInput {
  profile: ShellProfile;
  executable: string;
  workspaceRoot: string;
  startIn: StartLocation;
  homeDir: string;
  /** Required for WSL profiles that start in the workspace root. */
  linuxPath?: string;
  /** Show only the current folder in default prompts (see SHORT_PROMPT_*). */
  shortPrompt?: boolean;
  /** Test runs only: don't use the user's PowerShell history file (see ISOLATE_HISTORY_POWERSHELL). */
  isolateHistory?: boolean;
  /** PowerShell only: start here instead of the workspace root (checked by the resolver). */
  startPath?: string;
}

/**
 * Test runs only: the session neither saves to nor reads the user's PSReadLine history file
 * (and so never takes its cross-process lock). Up/Down still recall this session's commands.
 */
export const ISOLATE_HISTORY_POWERSHELL = 'Set-PSReadLineOption -HistorySaveStyle SaveNothing -ErrorAction SilentlyContinue';

export interface LaunchSpec {
  file: string;
  args: string[];
  cwd: string;
  cwdLabel: string;
  /** Extra environment for this session. `WSLENV` is appended to, not replaced. */
  env?: Record<string, string>;
}

/**
 * PowerShell: replaces the prompt with `PS <folder>>` only when it is still
 * PowerShell's built-in prompt, after profiles have run. A prompt from
 * $PROFILE, oh-my-posh, Starship etc. is left alone. Constant text: no user
 * data is ever inserted into it. It runs before the first prompt; it is not
 * recorded by PSReadLine (up-arrow / saved history), but shows up as entry 1
 * of the session's `Get-History`.
 */
export const SHORT_PROMPT_POWERSHELL =
  "if ((Get-Command prompt -CommandType Function -ErrorAction SilentlyContinue).Definition -match 'SessionState\\.Path\\.CurrentLocation') {" +
  ' function global:prompt {' +
  ' $p = $executionContext.SessionState.Path.CurrentLocation.ProviderPath;' +
  " if ($p -eq $HOME) { $n = '~' } else { $n = Split-Path -Leaf $p; if (-not $n) { $n = $p } };" +
  " \"PS $n$('>' * ($nestedPromptLevel + 1)) \" } }";

/**
 * WSL bash: PROMPT_DIRTRIM=1 makes `\w` in the prompt show `.../folder`
 * instead of the full path. It only affects prompts that use `\w` and is
 * ignored by other shells; a value set in ~/.bashrc wins.
 */
export const SHORT_PROMPT_WSL_ENV = { PROMPT_DIRTRIM: '1', WSLENV: 'PROMPT_DIRTRIM/u' } as const;

/** Builds structured launch arguments. Folder and distribution names are never concatenated into a command string. */
export function buildLaunch(input: LaunchInput): LaunchSpec {
  const { profile, executable, workspaceRoot, startIn, homeDir } = input;
  if (profile.kind === 'wsl') {
    if (!profile.distro) throw new Error('WSL profile without distribution');
    const env = input.shortPrompt ? { ...SHORT_PROMPT_WSL_ENV } : undefined;
    if (startIn === 'home') {
      return {
        file: executable,
        args: ['--distribution', profile.distro, '--cd', '~'],
        cwd: homeDir,
        cwdLabel: `~ (${profile.distro} home)`,
        ...(env ? { env } : {}),
      };
    }
    if (!input.linuxPath) throw new Error('WSL launch requires a resolved Linux path');
    return {
      file: executable,
      args: ['--distribution', profile.distro, '--cd', input.linuxPath],
      cwd: workspaceRoot,
      cwdLabel: input.linuxPath,
      ...(env ? { env } : {}),
    };
  }
  const cwd = startIn === 'home' ? homeDir : (input.startPath ?? workspaceRoot);
  const commands = [input.isolateHistory ? ISOLATE_HISTORY_POWERSHELL : '', input.shortPrompt ? SHORT_PROMPT_POWERSHELL : ''].filter(Boolean);
  const args = commands.length ? ['-NoLogo', '-NoExit', '-Command', commands.join('; ')] : ['-NoLogo'];
  return { file: executable, args, cwd, cwdLabel: startIn === 'home' ? `~ (${homeDir})` : cwd };
}
