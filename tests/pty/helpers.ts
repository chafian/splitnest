import { execFile } from 'node:child_process';
import * as nodePty from 'node-pty';
import { createRequire } from 'node:module';
import { SessionManager } from '../../src/pty-host/session-manager';
import { installForkGuard } from '../../src/pty-host/fork-guard';
import { ISOLATE_HISTORY_POWERSHELL } from '../../src/main/shells';
import type { HostEvent, SpawnSpec } from '../../src/shared/pty-protocol';

const require = createRequire(import.meta.url);
export const SYSTEM_ROOT = process.env.SystemRoot ?? 'C:\\Windows';

// Like the PTY host: the guard is installed once for the whole process, before any session.
export const refusedForks: string[] = [];
installForkGuard(require('node:child_process'), (m) => refusedForks.push(m));
export const WINDOWS_POWERSHELL = `${SYSTEM_ROOT}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`;

 
const ANSI = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(\x07|\x1b\\)|\x1b[()][0-9A-Za-z]|\x1b[=>78]/g;
// The system ConPTY renders blanks it skips over as "cursor forward" (CSI n C), e.g. the space
// after a prompt: count them as spaces, as a terminal displays them.
export const stripAnsi = (s: string) => s.replace(/\x1b\[(\d*)C/g, (_m, n: string) => ' '.repeat(Number(n || 1))).replace(ANSI, '');

export class Harness {
  readonly events: HostEvent[] = [];
  readonly manager: SessionManager;
  private readonly outputs = new Map<string, string>();
  autoAck = true;

  constructor() {
    this.manager = new SessionManager(nodePty, (event) => {
      this.events.push(event);
      if (event.type === 'data') {
        this.outputs.set(event.sessionId, (this.outputs.get(event.sessionId) ?? '') + event.data);
        if (this.autoAck) this.manager.ack(event.sessionId, event.data.length);
      }
    });
  }

  output(sessionId: string): string {
    return stripAnsi(this.outputs.get(sessionId) ?? '');
  }

  rawLength(sessionId: string): number {
    return this.outputs.get(sessionId)?.length ?? 0;
  }

  spawn(sessionId: string, overrides: Partial<SpawnSpec> = {}): void {
    this.manager.spawn({
      sessionId,
      file: WINDOWS_POWERSHELL,
      // Never the user's history file (test commands, and its lock while shells are killed).
      args: ['-NoLogo', '-NoProfile', '-NoExit', '-Command', ISOLATE_HISTORY_POWERSHELL],
      cwd: process.env.USERPROFILE ?? SYSTEM_ROOT,
      cols: 200,
      rows: 40,
      ...overrides,
    });
  }

  pid(sessionId: string): number {
    const e = this.events.find((x) => x.type === 'spawned' && x.sessionId === sessionId);
    if (!e || e.type !== 'spawned') throw new Error(`session ${sessionId} did not spawn`);
    return e.pid;
  }

  exit(sessionId: string) {
    const e = this.events.find((x) => x.type === 'exit' && x.sessionId === sessionId);
    return e && e.type === 'exit' ? e : undefined;
  }

  async waitForOutput(sessionId: string, pattern: string | RegExp, timeoutMs = 20_000): Promise<void> {
    await waitFor(() => {
      const text = this.output(sessionId);
      return typeof pattern === 'string' ? text.includes(pattern) : pattern.test(text);
    }, timeoutMs, `output ${pattern} in ${sessionId}. Last output: ${this.output(sessionId).slice(-400)}`);
  }

  async waitForExit(sessionId: string, timeoutMs = 15_000) {
    await waitFor(() => !!this.exit(sessionId), timeoutMs, `exit of ${sessionId}`);
    return this.exit(sessionId)!;
  }

  dispose(): void {
    this.manager.killAll();
  }
}

export async function waitFor(predicate: () => boolean, timeoutMs: number, what: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Direct child process IDs of `pid` (via CIM, without involving the shell under test). */
export function childPids(pid: number): Promise<number[]> {
  return new Promise((resolve) => {
    execFile(
      WINDOWS_POWERSHELL,
      ['-NoProfile', '-NonInteractive', '-Command', `Get-CimInstance Win32_Process -Filter "ParentProcessId=${pid}" | ForEach-Object { $_.ProcessId }`],
      { windowsHide: true, timeout: 20_000 },
      (_err, stdout) => resolve(String(stdout).split(/\s+/).filter(Boolean).map(Number)),
    );
  });
}

/** Console hosts (ConPTY's conhost.exe / OpenConsole.exe) that are children of this process. */
export function consoleHostPids(): Promise<number[]> {
  return new Promise((resolve) => {
    execFile(
      WINDOWS_POWERSHELL,
      ['-NoProfile', '-NonInteractive', '-Command', `Get-CimInstance Win32_Process -Filter "ParentProcessId=${process.pid}" | Where-Object { $_.Name -in 'conhost.exe','OpenConsole.exe' } | ForEach-Object { $_.ProcessId }`],
      { windowsHide: true, timeout: 20_000 },
      (_err, stdout) => resolve(String(stdout).split(/\s+/).filter(Boolean).map(Number)),
    );
  });
}

/** Waits for the PowerShell prompt so input is not typed before PSReadLine is ready. */
export async function ready(h: Harness, sessionId: string): Promise<void> {
  await h.waitForOutput(sessionId, /PS [A-Z]:\\.*>/);
}

export const IS_WINDOWS = process.platform === 'win32';
