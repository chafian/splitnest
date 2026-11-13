// Detects AI agent CLIs running in SplitNest's PowerShell sessions by looking
// at the shell's child processes. One long-lived, hidden PowerShell answers
// process-table queries (Get-CimInstance Win32_Process), so no process is
// started per check. Command lines never leave this module and are not
// logged; only an agent id per session is reported.
//
// WSL sessions: their Linux processes are not visible to Windows (only wsl.exe
// is), so a helper inside each distribution in use lists the processes that
// carry the terminal's marker (wsl-processes.ts). The renderer also keeps using
// the agent's own OSC 7501 reports and terminal title there. Which conversation
// runs is not tracked for WSL (Resume opens the agent's own list there).
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import type { AgentResume } from '../shared/agent-resume';
import { findAgent, type AgentId, type ProcessInfo } from '../shared/agents';
import type { AgentSessionTracker } from './agent-sessions';
import type { SessionProcess } from './session-broker';
import { findWslAgent, parseWslSnapshot, WslScanHelper } from './wsl-processes';

export interface AgentMonitorDeps {
  sessions(): SessionProcess[];
  report(ownerId: number, sessionId: string, agent: AgentId | null): void;
  powershellPath: string;
  log(message: string): void;
  /** wsl.exe, for the helper that lists processes inside a distribution. */
  wslPath?: string;
  /** Injected for tests. */
  snapshot?(): Promise<ProcessInfo[]>;
  /** Injected for tests: one distribution's scan output (see WSL_SCAN_SCRIPT), or null for no answer. */
  wslSnapshot?(distro: string): Promise<string | null>;
  /** Which conversation each agent runs, for resuming it after a restart (see agent-sessions.ts). */
  resume?: { tracker: AgentSessionTracker; report(ownerId: number, sessionId: string, resume: AgentResume | null): void };
}

/** How often to look while something is happening, and when quiet. */
const ACTIVE_MS = 3000;
const QUIET_MS = 12_000;
const ACTIVE_WINDOW_MS = 30_000;

const SCRIPT = [
  "$ErrorActionPreference = 'SilentlyContinue'",
  '[Console]::OutputEncoding = [Text.Encoding]::UTF8',
  'while ($true) {',
  '  $line = [Console]::In.ReadLine()',
  '  if ($null -eq $line) { break }',
  "  $id = ($line -replace '[^0-9]', '')",
  '  foreach ($p in (Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId,Name,CommandLine)) {',
  '    $c = [string]$p.CommandLine',
  '    [Console]::Out.WriteLine(("{0}`t{1}`t{2}`t{3}" -f $p.ProcessId, $p.ParentProcessId, $p.Name, ($c -replace "[`t`r`n]", " ")))',
  '  }',
  "  [Console]::Out.WriteLine('<<END ' + $id + '>>')",
  '}',
].join('\n');

export function parseSnapshot(text: string): ProcessInfo[] {
  const out: ProcessInfo[] = [];
  for (const line of text.split(/\r?\n/)) {
    const [pid, ppid, name, ...rest] = line.split('\t');
    const p = Number(pid);
    const pp = Number(ppid);
    if (!Number.isInteger(p) || !Number.isInteger(pp) || !name) continue;
    out.push({ pid: p, ppid: pp, name, cmd: rest.join('\t') });
  }
  return out;
}

export class AgentMonitor {
  private helper: ChildProcessWithoutNullStreams | null = null;
  private buffer = '';
  /** The one query in flight; answers carrying another id (late, after a timeout) are discarded. */
  private waiting: { id: number; resolve(text: string | null): void } | null = null;
  private querySeq = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private activeUntil = 0;
  private scanning = false;
  private stopped = false;
  private readonly last = new Map<string, AgentId | null>();
  private readonly wslHelpers = new Map<string, WslScanHelper>();

  constructor(private readonly deps: AgentMonitorDeps) {}

  /** Something happened in a session (title change, start): look more often for a while. */
  poke(): void {
    this.activeUntil = Date.now() + ACTIVE_WINDOW_MS;
    if (!this.scanning) this.schedule(250);
  }

  start(): void {
    this.schedule(QUIET_MS);
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.helper?.kill();
    this.helper = null;
    for (const h of this.wslHelpers.values()) h.stop();
    this.wslHelpers.clear();
  }

  /** Forget a session that ended. */
  forget(sessionId: string): void {
    this.last.delete(sessionId);
    this.deps.resume?.tracker.forget(sessionId);
  }

  private schedule(ms: number): void {
    if (this.stopped) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.tick(), ms);
  }

  private async tick(): Promise<void> {
    const all = this.deps.sessions();
    const sessions = all.filter((s) => !s.wsl);
    const wslSessions = all.filter((s) => s.wsl && s.distro && s.marker);
    for (const id of [...this.last.keys()]) {
      if (all.some((s) => s.sessionId === id)) continue;
      this.last.delete(id);
      this.deps.resume?.tracker.forget(id);
    }
    if (wslSessions.length > 0 || this.wslHelpers.size > 0) await this.scanWsl(wslSessions);
    if (sessions.length > 0) {
      this.scanning = true;
      try {
        const processes = await (this.deps.snapshot ?? (() => this.query()))();
        for (const s of sessions) {
          const found = processes.length ? findAgent(processes, s.pid) : null;
          const agent = processes.length ? (found?.id ?? null) : (this.last.get(s.sessionId) ?? null);
          if ((this.last.get(s.sessionId) ?? null) !== agent || !this.last.has(s.sessionId)) {
            this.last.set(s.sessionId, agent);
            this.deps.report(s.ownerId, s.sessionId, agent);
          }
          // An empty snapshot is "no information": the resume record is left as it was.
          if (this.deps.resume && processes.length && !this.stopped) {
            const resume = await this.deps.resume.tracker.update(s.sessionId, s.cwd, found).catch(() => undefined);
            if (resume !== undefined && !this.stopped) this.deps.resume.report(s.ownerId, s.sessionId, resume);
          }
        }
      } catch {
        // A failed snapshot just means no update this round.
      } finally {
        this.scanning = false;
      }
    }
    this.schedule(Date.now() < this.activeUntil ? ACTIVE_MS : QUIET_MS);
  }

  /** WSL terminals, one helper per distribution in use; helpers of distributions no longer in use stop. */
  private async scanWsl(sessions: SessionProcess[]): Promise<void> {
    const distros = new Set(sessions.map((s) => s.distro!));
    for (const [d, h] of this.wslHelpers) {
      if (distros.has(d)) continue;
      h.stop();
      this.wslHelpers.delete(d);
    }
    for (const distro of distros) {
      let text: string | null;
      try {
        text = await (this.deps.wslSnapshot ?? ((d: string) => this.wslHelper(d)?.scan() ?? Promise.resolve(null)))(distro);
      } catch {
        text = null;
      }
      if (this.stopped) return;
      const byMarker = parseWslSnapshot(text ?? '');
      for (const s of sessions.filter((x) => x.distro === distro)) {
        // The terminal's own shell always carries its marker: none at all means no answer, not "no agent".
        const processes = byMarker.get(s.marker!);
        if (!processes?.length) continue;
        const agent = findWslAgent(processes)?.id ?? null;
        if (!this.last.has(s.sessionId) || this.last.get(s.sessionId) !== agent) {
          this.last.set(s.sessionId, agent);
          this.deps.report(s.ownerId, s.sessionId, agent);
        }
      }
    }
  }

  private wslHelper(distro: string): WslScanHelper | null {
    if (!this.deps.wslPath) return null;
    let h = this.wslHelpers.get(distro);
    if (!h) {
      h = new WslScanHelper(this.deps.wslPath, distro, this.deps.log);
      this.wslHelpers.set(distro, h);
    }
    return h;
  }

  private ensureHelper(): ChildProcessWithoutNullStreams | null {
    if (this.helper && this.helper.exitCode === null) return this.helper;
    try {
      const child = spawn(this.deps.powershellPath, ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', SCRIPT], {
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => {
        this.buffer += chunk;
        for (let m = /<<END (\d+)>>\r?\n?/.exec(this.buffer); m; m = /<<END (\d+)>>\r?\n?/.exec(this.buffer)) {
          const text = this.buffer.slice(0, m.index);
          this.buffer = this.buffer.slice(m.index + m[0].length);
          if (this.waiting && this.waiting.id === Number(m[1])) {
            const w = this.waiting;
            this.waiting = null;
            w.resolve(text);
          }
        }
        if (this.buffer.length > 8 * 1024 * 1024) this.buffer = ''; // never grow without bound
      });
      child.stderr.resume();
      child.on('exit', () => {
        this.waiting?.resolve(null);
        this.waiting = null;
        this.buffer = '';
        if (this.helper === child) this.helper = null;
      });
      child.on('error', () => this.deps.log('agent detection helper could not start'));
      this.helper = child;
      return child;
    } catch {
      this.deps.log('agent detection helper could not start');
      return null;
    }
  }

  private query(): Promise<ProcessInfo[]> {
    const helper = this.ensureHelper();
    if (!helper) return Promise.resolve([]);
    return new Promise((resolve) => {
      const id = ++this.querySeq;
      const timeout = setTimeout(() => {
        if (this.waiting?.id === id) this.waiting = null;
        resolve([]); // empty = "no information": the last result is kept
      }, 15_000);
      this.waiting = {
        id,
        resolve: (text) => {
          clearTimeout(timeout);
          resolve(text ? parseSnapshot(text) : []);
        },
      };
      helper.stdin.write(`scan ${id}\n`);
    });
  }
}
