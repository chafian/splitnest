// Agent detection in WSL terminals (src/main/wsl-processes.ts and the WSL part of agent-monitor.ts).
// The scan output below has the shape WSL_SCAN_SCRIPT prints; the script itself is run against a
// real distribution by tests/e2e/run-e2e.mjs.
import { describe, expect, it } from 'vitest';
import { AgentMonitor } from '../../src/main/agent-monitor';
import { findWslAgent, newWslMarker, parseWslSnapshot, withWslMarker, WSL_MARKER, WSL_SCAN_SCRIPT } from '../../src/main/wsl-processes';
import type { AgentId } from '../../src/shared/agents';
import { mergeSessionEnv } from '../../src/pty-host/session-manager';

const M1 = 'a1b2c3d4e5f60718';
const M2 = '0f1e2d3c4b5a6978';
const row = (pid: number, ppid: number, marker: string, name: string, cmd: string) => [pid, ppid, marker, name, cmd].join('\t');

describe('WSL agent detection: the marker', () => {
  it('is random, and travels into Linux through WSLENV next to the variables already passed', () => {
    const m = newWslMarker();
    expect(m).toMatch(/^[0-9a-f]{16}$/);
    expect(newWslMarker()).not.toBe(m);
    expect(withWslMarker(m, undefined)).toEqual({ [WSL_MARKER]: m, WSLENV: `${WSL_MARKER}/u` });
    expect(withWslMarker(m, { PROMPT_DIRTRIM: '1', WSLENV: 'PROMPT_DIRTRIM/u' })).toEqual({ PROMPT_DIRTRIM: '1', [WSL_MARKER]: m, WSLENV: `PROMPT_DIRTRIM/u:${WSL_MARKER}/u` });
    // ...and the pty host appends that to the user's own WSLENV instead of replacing it.
    expect(mergeSessionEnv({ WSLENV: 'USERPROFILE/p' }, withWslMarker(m, undefined)).WSLENV).toBe(`USERPROFILE/p:${WSL_MARKER}/u`);
  });

  it('the scan script only reads /proc and prints; nothing in it comes from outside', () => {
    expect(WSL_SCAN_SCRIPT).toContain(`'^${WSL_MARKER}='`);
    // No writes (other than discarding errors), no deletions, no network.
    expect(WSL_SCAN_SCRIPT.replaceAll('2>/dev/null', '')).not.toMatch(/>\s*[/$~\w]|\brm\b|\btee\b|curl|wget/);
  });
});

describe('WSL agent detection: parsing a scan', () => {
  it("groups each terminal's processes by marker and drops malformed lines", () => {
    const text = [
      row(11, 10, M1, 'bash', '-bash'),
      row(42, 11, M1, 'node', 'node /usr/lib/node_modules/@google/gemini-cli/dist/index.js'),
      row(12, 9, M2, 'bash', '-bash'),
      row(0, 1, M1, 'x', 'bad pid'),
      row(13, 12, 'not-a-marker', 'claude', 'claude'),
      'garbage',
      '',
    ].join('\n');
    const map = parseWslSnapshot(text);
    expect([...map.keys()]).toEqual([M1, M2]);
    expect(map.get(M1)!.map((p) => p.pid)).toEqual([11, 42]);
  });

  it('finds the agent below the shell, nearest first, or the program the terminal runs itself', () => {
    const procs = parseWslSnapshot([row(11, 10, M1, 'bash', '-bash'), row(20, 11, M1, 'claude', '/home/me/.local/bin/claude'), row(21, 20, M1, 'node', 'node mcp-server.js')].join('\n')).get(M1)!;
    expect(findWslAgent(procs)).toMatchObject({ id: 'claude', process: { pid: 20 } });
    const npm = parseWslSnapshot([row(11, 10, M1, 'bash', '-bash'), row(30, 11, M1, 'node', 'node /usr/local/lib/node_modules/@openai/codex/bin/codex.js')].join('\n')).get(M1)!;
    expect(findWslAgent(npm)?.id).toBe('codex');
    const own = parseWslSnapshot(row(11, 10, M1, 'aider', '/home/me/.local/bin/aider')).get(M1)!;
    expect(findWslAgent(own)?.id).toBe('aider');
    const none = parseWslSnapshot([row(11, 10, M1, 'bash', '-bash'), row(31, 11, M1, 'vim', 'vim README.md')].join('\n')).get(M1)!;
    expect(findWslAgent(none)).toBeNull();
  });
});

describe('WSL agent detection: the monitor', () => {
  it('reports the agent of each WSL terminal, keeps the last answer when a scan has none, and stops helpers no longer needed', async () => {
    const reports: [string, AgentId | null][] = [];
    let wsl: Record<string, string | null> = {};
    let sessions = [
      { sessionId: 'w1', ownerId: 1, pid: 700, wsl: true, cwd: 'C:\\p', distro: 'Ubuntu', marker: M1 },
      { sessionId: 'w2', ownerId: 1, pid: 701, wsl: true, cwd: 'C:\\p', distro: 'Debian', marker: M2 },
    ];
    const asked: string[] = [];
    const monitor = new AgentMonitor({
      sessions: () => sessions,
      report: (_o, id, agent) => reports.push([id, agent]),
      powershellPath: 'unused',
      log: () => undefined,
      snapshot: async () => [],
      wslSnapshot: async (d) => {
        asked.push(d);
        return wsl[d] ?? null;
      },
    });
    const tick = () => (monitor as unknown as { tick(): Promise<void> }).tick();

    wsl = { Ubuntu: [row(11, 10, M1, 'bash', '-bash'), row(20, 11, M1, 'claude', 'claude')].join('\n'), Debian: row(12, 9, M2, 'bash', '-bash') };
    await tick();
    expect(reports).toEqual([
      ['w1', 'claude'],
      ['w2', null],
    ]);
    expect(asked.sort()).toEqual(['Debian', 'Ubuntu']);

    // No answer from Ubuntu (helper restarting, timeout): nothing changes.
    wsl = { Ubuntu: null, Debian: row(12, 9, M2, 'bash', '-bash') };
    await tick();
    expect(reports).toHaveLength(2);

    // Claude exits; Gemini starts in the Debian terminal.
    wsl = { Ubuntu: row(11, 10, M1, 'bash', '-bash'), Debian: [row(12, 9, M2, 'bash', '-bash'), row(50, 12, M2, 'node', 'node /usr/lib/node_modules/@google/gemini-cli/dist/index.js')].join('\n') };
    await tick();
    expect(reports.slice(2)).toEqual([
      ['w1', null],
      ['w2', 'gemini'],
    ]);

    // Only Debian is left: Ubuntu is no longer asked.
    sessions = sessions.filter((s) => s.distro === 'Debian');
    asked.length = 0;
    await tick();
    expect(asked).toEqual(['Debian']);
    monitor.stop();
  });
});
