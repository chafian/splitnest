// Listening TCP ports of each terminal, for the workspace's port chips. The process helpers
// (agent-monitor.ts, wsl-processes.ts) add listening sockets to their scan when asked:
// - Windows: `PORT <pid> <address> <port>` from Get-NetTCPConnection -State Listen;
// - WSL: `PORT <marker> <pid> <address:port in /proc/net/tcp hex>` for the terminal's own processes.
// A port belongs to a terminal when its process is the shell or runs under it. Ports of the agent
// CLI itself (Claude Code's IDE connection) are left out; a dev server it starts counts. Only
// sockets reachable as localhost count: bound to any address or to loopback.
import { agentOfProcess, type ProcessInfo } from '../shared/agents';

export interface Listener {
  pid: number;
  address: string;
  port: number;
}

/** At most this many ports per terminal (a program opening hundreds says nothing useful). */
export const MAX_PORTS = 32;

const validPort = (n: number) => Number.isInteger(n) && n > 0 && n < 65536;

/** Reachable from this PC as localhost: any address (0.0.0.0, ::) or loopback (127.x, ::1). */
export function isLocalBind(address: string): boolean {
  const a = address.toLowerCase();
  return a === '0.0.0.0' || a === '::' || a === '::1' || /^127\./.test(a) || /^::ffff:127\./.test(a) || a === '::ffff:0.0.0.0';
}

/** `PORT <pid> <address> <port>` lines of the Windows helper. */
export function parseWindowsListeners(text: string): Listener[] {
  const out: Listener[] = [];
  for (const line of text.split(/\r?\n/)) {
    const [tag, pid, address, port] = line.split('\t');
    if (tag !== 'PORT' || !address) continue;
    const p = Number(pid);
    const n = Number(port);
    if (Number.isInteger(p) && p > 0 && validPort(n) && out.length < 10_000) out.push({ pid: p, address, port: n });
  }
  return out;
}

/**
 * An address from /proc/net/tcp(6): IPv4 is one little-endian hex word (`0100007F:1F90` is
 * 127.0.0.1:8080); IPv6 is four of them. IPv6 is reduced to what matters here: `::`, `::1`, the
 * IPv4-mapped form, or `other`.
 */
export function decodeProcNetAddress(hex: string): { address: string; port: number } | null {
  const m = /^([0-9A-Fa-f]{8}|[0-9A-Fa-f]{32}):([0-9A-Fa-f]{4})$/.exec(hex);
  if (!m) return null;
  const port = parseInt(m[2]!, 16);
  if (!validPort(port)) return null;
  const words = m[1]!.match(/.{8}/g)!.map((w) => w.match(/../g)!.reverse().map((b) => parseInt(b, 16)));
  if (words.length === 1) return { address: words[0]!.join('.'), port };
  const bytes = words.flat();
  const zero = (from: number, to: number) => bytes.slice(from, to).every((b) => b === 0);
  if (zero(0, 16)) return { address: '::', port };
  if (zero(0, 15) && bytes[15] === 1) return { address: '::1', port };
  if (zero(0, 10) && bytes[10] === 0xff && bytes[11] === 0xff) return { address: `::ffff:${bytes.slice(12).join('.')}`, port };
  return { address: 'other', port };
}

/** `PORT <marker> <pid> <hex address>` lines of the WSL helper, by marker. */
export function parseWslListeners(text: string): Map<string, Listener[]> {
  const out = new Map<string, Listener[]>();
  for (const line of text.split('\n')) {
    const [tag, marker, pid, hex] = line.trim().split('\t');
    if (tag !== 'PORT' || !marker || !/^[0-9a-f]{16}$/.test(marker) || !hex) continue;
    const p = Number(pid);
    const a = decodeProcNetAddress(hex);
    if (!Number.isInteger(p) || p <= 0 || !a) continue;
    const list = out.get(marker) ?? [];
    if (list.length < 1000) list.push({ pid: p, ...a });
    out.set(marker, list);
  }
  return out;
}

/** The pids of `rootPid` and everything below it. */
export function treeOf(processes: readonly ProcessInfo[], rootPid: number): Set<number> {
  const children = new Map<number, number[]>();
  for (const p of processes) {
    if (p.pid === p.ppid) continue;
    const list = children.get(p.ppid) ?? [];
    list.push(p.pid);
    children.set(p.ppid, list);
  }
  const seen = new Set<number>([rootPid]);
  const queue = [rootPid];
  while (queue.length) {
    for (const c of children.get(queue.shift()!) ?? []) {
      if (seen.has(c)) continue;
      seen.add(c);
      queue.push(c);
    }
  }
  return seen;
}

/**
 * The ports one terminal listens on: sockets of `pids` (its processes), local binds only, not the
 * agent CLI's own. Sorted, unique, capped.
 */
export function terminalPorts(listeners: readonly Listener[], pids: ReadonlySet<number>, processes: readonly ProcessInfo[]): number[] {
  const agents = new Set(processes.filter((p) => pids.has(p.pid) && agentOfProcess(p)).map((p) => p.pid));
  const ports = new Set<number>();
  for (const l of listeners) if (pids.has(l.pid) && !agents.has(l.pid) && isLocalBind(l.address)) ports.add(l.port);
  return [...ports].sort((a, b) => a - b).slice(0, MAX_PORTS);
}

export const samePorts = (a: readonly number[], b: readonly number[]) => a.length === b.length && a.every((p, i) => p === b[i]);
