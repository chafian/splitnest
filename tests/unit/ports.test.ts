import { describe, expect, it } from 'vitest';
import { AgentMonitor } from '../../src/main/agent-monitor';
import { decodeProcNetAddress, isLocalBind, parseWindowsListeners, parseWslListeners, terminalPorts, treeOf, type Listener } from '../../src/main/ports';
import { WSL_SCAN_SCRIPT } from '../../src/main/wsl-processes';
import type { ProcessInfo } from '../../src/shared/agents';

const p = (pid: number, ppid: number, name: string, cmd = name): ProcessInfo => ({ pid, ppid, name, cmd });
const MARK = '0123456789abcdef';

describe('listening sockets', () => {
  it('reads the Windows helper lines and ignores everything else', () => {
    const text = '10\t1\tnode.exe\tnode server.js\r\nPORT\t10\t0.0.0.0\t5173\r\nPORT\t10\t::1\t5173\r\nPORT\tx\t::\t1\r\nPORT\t11\t::\t70000\r\n<<END 3>>';
    expect(parseWindowsListeners(text)).toEqual([
      { pid: 10, address: '0.0.0.0', port: 5173 },
      { pid: 10, address: '::1', port: 5173 },
    ]);
  });

  it('decodes /proc/net/tcp and tcp6 addresses', () => {
    expect(decodeProcNetAddress('0100007F:1F90')).toEqual({ address: '127.0.0.1', port: 8080 });
    expect(decodeProcNetAddress('00000000:1435')).toEqual({ address: '0.0.0.0', port: 5173 });
    expect(decodeProcNetAddress('00000000000000000000000000000000:0BB8')).toEqual({ address: '::', port: 3000 });
    expect(decodeProcNetAddress('00000000000000000000000001000000:0BB8')).toEqual({ address: '::1', port: 3000 });
    expect(decodeProcNetAddress('0000000000000000FFFF00000100007F:0050')).toEqual({ address: '::ffff:127.0.0.1', port: 80 });
    expect(decodeProcNetAddress('B80D0120000000000000000001000000:0050')).toEqual({ address: 'other', port: 80 });
    expect(decodeProcNetAddress('0100007F:0000')).toBeNull();
    expect(decodeProcNetAddress('nonsense')).toBeNull();
  });

  it('reads the WSL helper lines by terminal marker', () => {
    const text = `11\t1\t${MARK}\tsh\tsh\nPORT\t${MARK}\t12\t00000000:1435\nPORT\tnot-a-marker\t12\t00000000:1435\nPORT\t${MARK}\t13\t0100007F:0BB8\n<<END 1>>`;
    expect(parseWslListeners(text).get(MARK)).toEqual([
      { pid: 12, address: '0.0.0.0', port: 5173 },
      { pid: 13, address: '127.0.0.1', port: 3000 },
    ]);
    expect(parseWslListeners(text).size).toBe(1);
  });

  it('counts only what localhost reaches: any address or loopback', () => {
    for (const a of ['0.0.0.0', '::', '127.0.0.1', '127.0.1.1', '::1', '::ffff:127.0.0.1']) expect(isLocalBind(a)).toBe(true);
    for (const a of ['192.168.1.20', '172.17.0.1', 'fe80::1', 'other']) expect(isLocalBind(a)).toBe(false);
  });
});

describe('ports of a terminal', () => {
  const processes = [
    p(100, 1, 'powershell.exe'), // the terminal's shell
    p(110, 100, 'node.exe', 'node vite'), // a dev server it started
    p(120, 100, 'claude.exe', 'claude'), // an agent…
    p(121, 120, 'node.exe', 'node server.js'), // …and a server the agent started
    p(200, 1, 'node.exe', 'node other.js'), // another terminal's program
    p(300, 300, 'System', 'System'), // its own parent: no loop
  ];
  const listeners: Listener[] = [
    { pid: 110, address: '::', port: 5173 },
    { pid: 110, address: '0.0.0.0', port: 5173 },
    { pid: 120, address: '127.0.0.1', port: 51234 }, // the agent's own (IDE connection)
    { pid: 121, address: '127.0.0.1', port: 3000 },
    { pid: 110, address: '192.168.1.5', port: 9000 }, // not reachable as localhost
    { pid: 200, address: '0.0.0.0', port: 8080 },
  ];

  it('the shell and everything under it, not the agent CLI itself, sorted and unique', () => {
    const tree = treeOf(processes, 100);
    expect([...tree].sort()).toEqual([100, 110, 120, 121]);
    expect(terminalPorts(listeners, tree, processes)).toEqual([3000, 5173]);
    expect(terminalPorts(listeners, treeOf(processes, 200), processes)).toEqual([8080]);
    expect(terminalPorts(listeners, treeOf(processes, 999), processes)).toEqual([]);
  });

  it('the agent monitor reports a terminal’s ports when they change, and only while enabled', async () => {
    const reports: [string, number[]][] = [];
    let enabled = true;
    let current = listeners;
    const monitor = new AgentMonitor({
      sessions: () => [{ sessionId: 's1', ownerId: 1, pid: 100, wsl: false, cwd: 'C:\\p' }],
      report: () => undefined,
      powershellPath: 'unused',
      log: () => undefined,
      snapshot: async () => processes,
      listeners: async () => current,
      ports: { enabled: () => enabled, report: (_o, id, ports) => reports.push([id, ports]) },
    });
    const tick = () => (monitor as unknown as { tick(): Promise<void> }).tick();
    await tick();
    await tick(); // unchanged: reported once
    current = listeners.filter((l) => l.port !== 3000); // the server stopped
    await tick();
    enabled = false; // the setting turned off: the chips go
    await tick();
    monitor.stop();
    expect(reports).toEqual([
      ['s1', [3000, 5173]],
      ['s1', [5173]],
      ['s1', []],
    ]);
  });

  it('WSL terminals: from the helper’s scan, asked with ports only while enabled', async () => {
    const reports: [string, number[]][] = [];
    const asked: boolean[] = [];
    const monitor = new AgentMonitor({
      sessions: () => [{ sessionId: 'w1', ownerId: 1, pid: 50, wsl: true, cwd: 'C:\\p', distro: 'Ubuntu', marker: MARK }],
      report: () => undefined,
      powershellPath: 'unused',
      log: () => undefined,
      wslSnapshot: async (_d, ports) => {
        asked.push(ports);
        return `11\t1\t${MARK}\tbash\tbash\n12\t11\t${MARK}\tpython3\tpython3 -m http.server\nPORT\t${MARK}\t12\t00000000:1F40\n`;
      },
      ports: { enabled: () => true, report: (_o, id, ports) => reports.push([id, ports]) },
    });
    await (monitor as unknown as { tick(): Promise<void> }).tick();
    monitor.stop();
    expect(asked).toEqual([true]);
    expect(reports).toEqual([['w1', [8000]]]);
  });

  it('the WSL scan script asks the kernel tables only for `scan <n> ports` and keeps its END marker numeric', () => {
    expect(WSL_SCAN_SCRIPT).toContain("case $q in *' ports')");
    expect(WSL_SCAN_SCRIPT).toContain('/proc/net/tcp6');
    expect(WSL_SCAN_SCRIPT).toContain("printf '<<END %s>>\\n' \"${n%% *}\"");
  });
});
