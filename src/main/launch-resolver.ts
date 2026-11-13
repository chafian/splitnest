// Turns a validated session request into a concrete launch, checking the
// workspace, profile, executable and starting directory along the way.
import { withinFolder } from './agent-sessions';
import { stat } from 'node:fs/promises';
import type { Workspace } from '../shared/types';
import type { Runner } from './exec';
import type { LaunchResolver } from './session-broker';
import { buildLaunch, discoverShells, type DiscoveredShells, type ExistsFn, type ShellEnvironment } from './shells';
import { resolveWslDirectory } from './wsl';

export const isDirectory = async (p: string): Promise<boolean> => {
  try {
    return (await stat(p)).isDirectory();
  } catch {
    return false;
  }
};

export class ShellCache {
  private current: Promise<DiscoveredShells> | null = null;

  constructor(private readonly environment: ShellEnvironment) {}

  get(refresh = false): Promise<DiscoveredShells> {
    if (!this.current || refresh) {
      this.current = discoverShells(this.environment).catch((error) => {
        this.current = null;
        throw error;
      });
    }
    return this.current;
  }
}

export interface ResolverDeps {
  getWorkspace(id: string): Workspace | undefined;
  getShells(): Promise<DiscoveredShells>;
  isDirectory(p: string): Promise<boolean>;
  exists: ExistsFn;
  run: Runner;
  env: NodeJS.ProcessEnv;
  homeDir: string;
  /** Test runs only: PowerShell sessions don't read or write the shared PSReadLine history. */
  isolatePowerShellHistory?: boolean;
}

export function createLaunchResolver(deps: ResolverDeps): LaunchResolver {
  return async (request) => {
    const workspace = deps.getWorkspace(request.workspaceId);
    if (!workspace) {
      return { ok: false, error: { code: 'WORKSPACE_NOT_FOUND', message: 'The workspace no longer exists.' } };
    }
    const { discovery, executables } = await deps.getShells();
    const profile = discovery.profiles.find((p) => p.id === request.profileId);
    if (!profile) {
      return {
        ok: false,
        error: { code: 'UNKNOWN_PROFILE', message: `The shell profile “${request.profileId}” is not available on this machine.` },
      };
    }
    const executable = executables.get(profile.id);
    if (!executable || !(await deps.exists(executable))) {
      return { ok: false, error: { code: 'SHELL_NOT_FOUND', message: `${profile.label} could not be found.` } };
    }
    if (request.startIn === 'workspace-root' && !(await deps.isDirectory(workspace.rootPath))) {
      return {
        ok: false,
        error: {
          code: 'FOLDER_MISSING',
          message: 'The workspace folder is missing or inaccessible.',
          detail: workspace.rootPath,
          fallback: 'start-in-home',
        },
      };
    }
    if (request.startPath !== undefined) {
      // Resuming an agent where it ran: only inside this workspace (WSL maps that folder below).
      if (request.startIn !== 'workspace-root' || !withinFolder(request.startPath, workspace.rootPath)) {
        return { ok: false, error: { code: 'INVALID_REQUEST', message: 'That folder is not inside this workspace.' } };
      }
      if (!(await deps.isDirectory(request.startPath))) {
        return { ok: false, error: { code: 'FOLDER_MISSING', message: 'The folder the agent ran in is missing.', detail: request.startPath } };
      }
    }
    let linuxPath: string | undefined;
    if (profile.kind === 'wsl' && request.startIn === 'workspace-root') {
      const resolved = await resolveWslDirectory(deps.run, executable, profile.distro!, request.startPath ?? workspace.rootPath, deps.env);
      if (!resolved.ok) return resolved;
      linuxPath = resolved.linuxPath;
    }
    const launch = buildLaunch({
      profile,
      executable,
      workspaceRoot: workspace.rootPath,
      startIn: request.startIn,
      homeDir: deps.homeDir,
      linuxPath,
      shortPrompt: request.shortPrompt === true,
      isolateHistory: deps.isolatePowerShellHistory === true,
      ...(request.startPath !== undefined ? { startPath: request.startPath } : {}),
    });
    return { ok: true, launch, profileLabel: profile.label };
  };
}
