// Agent detection in WSL terminals. Windows sees only wsl.exe, not the Linux processes behind it,
// so each WSL terminal gets a marker variable (SPLITNEST_TERMINAL=<random>, passed into Linux
// through WSLENV) that every process started in it inherits. One long-lived `sh` per
// distribution, started only while SplitNest has a terminal of that distribution running, lists
// the processes carrying a marker when asked: their pid, parent, marker, name and command line.
// Like the Windows helper (agent-monitor.ts), command lines stay in the main process and are
// never logged; only an agent id per terminal is reported. Only the user's own processes are
// readable (/proc/<pid>/environ), and nothing is written inside the distribution.
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { agentOfProcess, findAgent, type AgentId, type ProcessInfo } from '../shared/agents';

export const WSL_MARKER = 'SPLITNEST_TERMINAL';
const MARKER_VALUE = /^[0-9a-f]{16}$/;

export const newWslMarker = (): string => randomBytes(8).toString('hex');

/** The session's extra environment with the marker added (`WSLENV` lists it, `/u`: Windows to Linux only). */
export function withWslMarker(marker: string, env: Record<string, string> | undefined): Record<string, string> {
  const wslenv = [env?.WSLENV, `${WSL_MARKER}/u`].filter(Boolean).join(':');
  return { ...env, [WSL_MARKER]: marker, WSLENV: wslenv };
}

/**
 * Runs in the distribution (POSIX sh; grep, tr and head). For each `scan <n>` line on its input it
 * prints one line per marked process (`pid TAB ppid TAB marker TAB name TAB command line`), then
 * `<<END n>>`. `/proc/<pid>/stat` is cut after the last `)`, so a name with spaces can't shift
 * the parent pid.
 */
export const WSL_SCAN_SCRIPT = String.raw`export LC_ALL=C
while IFS= read -r q; do
  grep -s -z -H '^${WSL_MARKER}=' /proc/[0-9]*/environ | tr '\000' '\n' | while IFS= read -r m; do
    p=${'$'}{m#/proc/}; p=${'$'}{p%%/*}
    t=${'$'}{m#*:${WSL_MARKER}=}
    read -r s < /proc/$p/stat 2>/dev/null || continue
    s=${'$'}{s##*) }
    set -- $s
    read -r c < /proc/$p/comm 2>/dev/null || c=''
    a=$(tr '\000\t\n' '   ' < /proc/$p/cmdline 2>/dev/null | head -c 2000)
    printf '%s\t%s\t%s\t%s\t%s\n' "$p" "$2" "$t" "$c" "$a"
  done
  printf '<<END %s>>\n' "${'$'}{q#scan }"
done`;

/** One scan's answer: the marked processes of each terminal (by marker). */
export function parseWslSnapshot(text: string): Map<string, ProcessInfo[]> {
  const out = new Map<string, ProcessInfo[]>();
  for (const line of text.split('\n')) {
    const [pid, ppid, marker, name, ...rest] = line.split('\t');
    const p = Number(pid);
    const pp = Number(ppid);
    if (!Number.isInteger(p) || p <= 0 || !Number.isInteger(pp) || !marker || !MARKER_VALUE.test(marker) || name === undefined) continue;
    const list = out.get(marker) ?? [];
    if (list.length < 2000) list.push({ pid: p, ppid: pp, name: name.trim(), cmd: rest.join(' ').trim() });
    out.set(marker, list);
  }
  return out;
}

/**
 * The agent among one terminal's processes. Its shell is the process whose parent isn't marked
 * (WSL's own relay is not); the agent is that process or the nearest one below it, as in PowerShell tabs.
 */
export function findWslAgent(processes: readonly ProcessInfo[]): { id: AgentId; process: ProcessInfo } | null {
  const pids = new Set(processes.map((p) => p.pid));
  for (const root of processes.filter((p) => !pids.has(p.ppid))) {
    const own = agentOfProcess(root); // started as the terminal's program itself
    if (own) return { id: own.id, process: root };
    const found = findAgent(processes, root.pid);
    if (found) return found;
  }
  return null;
}

/** The long-lived `sh` in one distribution that answers scans. */
export class WslScanHelper {
  private child: ChildProcessWithoutNullStreams | null = null;
  private buffer = '';
  private waiting: { id: number; resolve(text: string | null): void } | null = null;
  private seq = 0;

  constructor(
    private readonly wslPath: string,
    readonly distro: string,
    private readonly log: (message: string) => void,
  ) {}

  /** The marked processes' lines, or null when there is no answer (the last result is then kept). */
  scan(timeoutMs = 10_000): Promise<string | null> {
    const child = this.ensure();
    if (!child) return Promise.resolve(null);
    this.waiting?.resolve(null);
    return new Promise((resolve) => {
      const id = ++this.seq;
      const timer = setTimeout(() => {
        if (this.waiting?.id === id) this.waiting = null;
        resolve(null);
      }, timeoutMs);
      this.waiting = {
        id,
        resolve: (text) => {
          clearTimeout(timer);
          resolve(text);
        },
      };
      child.stdin.write(`scan ${id}\n`);
    });
  }

  stop(): void {
    this.waiting?.resolve(null);
    this.waiting = null;
    this.child?.kill();
    this.child = null;
  }

  private ensure(): ChildProcessWithoutNullStreams | null {
    if (this.child && this.child.exitCode === null) return this.child;
    try {
      // Structured arguments: the distribution name is one argument, never part of a command string.
      const child = spawn(this.wslPath, ['--distribution', this.distro, '--exec', 'sh', '-c', WSL_SCAN_SCRIPT], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
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
        if (this.buffer.length > 4 * 1024 * 1024) this.buffer = '';
      });
      child.stderr.resume();
      child.on('exit', () => {
        this.waiting?.resolve(null);
        this.waiting = null;
        this.buffer = '';
        if (this.child === child) this.child = null;
      });
      child.on('error', () => this.log('WSL agent detection helper could not start'));
      this.child = child;
      return child;
    } catch {
      this.log('WSL agent detection helper could not start');
      return null;
    }
  }
}
