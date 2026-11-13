// Agent detection in WSL terminals (src/main/wsl-processes.ts and the WSL part of agent-monitor.ts).
// The scan output below has the shape WSL_SCAN_SCRIPT prints; the script itself is run against a
// real distribution by tests/e2e/run-e2e.mjs.
import { describe, expect, it } from 'vitest';
import { AgentMonitor } from '../../src/main/agent-monitor';
import path from 'node:path';
import { AgentSessionTracker } from '../../src/main/agent-sessions';
import {
  findWslAgent,
  linuxToWindowsPath,
  newWslMarker,
  parseWslHome,
  parseWslSnapshot,
  withWslMarker,
  wslHomeForWindows,
  WSL_MARKER,
  WSL_SCAN_SCRIPT,
} from '../../src/main/wsl-processes';
import { parseAgentResume, resumeForShell, type AgentResume } from '../../src/shared/agent-resume';
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

describe('WSL resume: paths and records', () => {
  it('reads the Linux home from a scan, and refuses anything odd', () => {
    expect(parseWslHome(`11\t10\t${M1}\tbash\t-bash\nHOME\t/home/me\n`)).toBe('/home/me');
    expect(parseWslHome('HOME\t/root/\n')).toBe('/root');
    expect(parseWslHome('HOME\trelative\n')).toBeNull();
    expect(parseWslHome('HOME\t/home/../etc\n')).toBeNull();
    expect(parseWslHome('nothing')).toBeNull();
  });

  it('gives Linux folders in Windows form: /mnt/<drive> as the drive, the rest inside the distribution', () => {
    expect(linuxToWindowsPath('Ubuntu-22.04', '/mnt/c/Users/me/car-rental')).toBe('C:\\Users\\me\\car-rental');
    expect(linuxToWindowsPath('Ubuntu-22.04', '/mnt/d')).toBe('D:\\');
    expect(linuxToWindowsPath('Ubuntu-22.04', '/home/me/api/')).toBe('\\\\wsl.localhost\\Ubuntu-22.04\\home\\me\\api');
    expect(linuxToWindowsPath('Ubuntu-22.04', 'relative')).toBeNull();
    expect(linuxToWindowsPath('Ubuntu-22.04', '/home/me/../../etc')).toBeNull();
    expect(linuxToWindowsPath('Ubuntu-22.04', '/home/me\\x')).toBeNull();
    expect(linuxToWindowsPath('bad\\name', '/home/me')).toBeNull();
    // The home is read through \\wsl.localhost; a home on a Windows drive isn't used.
    expect(wslHomeForWindows('Ubuntu-22.04', '/home/me')).toBe('\\\\wsl.localhost\\Ubuntu-22.04\\home\\me');
    expect(wslHomeForWindows('Ubuntu-22.04', '/mnt/c/Users/me')).toBeNull();
  });

  it('a record from WSL resumes exactly only in WSL, a Windows one only in PowerShell; it keeps the WSL mark when saved', () => {
    const fromWsl: AgentResume = { agent: 'claude', sessionId: 'ff7e99ad-614e-4263-8b68-9515e5f3d720', cwd: 'C:\\code\\w1', exact: true, at: 1, wsl: true };
    expect(resumeForShell(fromWsl, true)).toBe(fromWsl);
    expect(resumeForShell(fromWsl, false)).toMatchObject({ sessionId: null, exact: false });
    const fromWindows: AgentResume = { ...fromWsl, wsl: undefined };
    delete fromWindows.wsl;
    expect(resumeForShell(fromWindows, false)).toBe(fromWindows);
    expect(resumeForShell(fromWindows, true)).toMatchObject({ sessionId: null });
    expect(parseAgentResume(fromWsl)).toEqual(fromWsl);
    expect(parseAgentResume({ ...fromWsl, wsl: 'yes' })).not.toHaveProperty('wsl');
    // A folder inside the distribution is a valid saved folder too.
    expect(parseAgentResume({ ...fromWsl, cwd: '\\\\wsl.localhost\\Ubuntu\\home\\me\\api' })?.cwd).toBe('\\\\wsl.localhost\\Ubuntu\\home\\me\\api');
  });

  it("the monitor finds Claude Code's conversation in a WSL terminal through its Linux pid and reports it in Windows form", async () => {
    const HOME = '\\\\wsl.localhost\\Ubuntu\\home\\me';
    const ID = 'ff7e99ad-614e-4263-8b68-9515e5f3d720';
    const files: Record<string, string> = {
      [path.join(HOME, '.claude', 'sessions', '20.json')]: JSON.stringify({ pid: 20, sessionId: ID, cwd: '/mnt/c/code/w1/api', kind: 'interactive', name: 'Fix login redirect' }),
    };
    const homes: string[] = [];
    const reports: (AgentResume | null)[] = [];
    let scan = [row(11, 10, M1, 'bash', '-bash'), row(20, 11, M1, 'claude', 'claude'), 'HOME\t/home/me'].join('\n');
    const monitor = new AgentMonitor({
      sessions: () => [{ sessionId: 'w1', ownerId: 1, pid: 700, wsl: true, cwd: 'C:\\code\\w1', distro: 'Ubuntu', marker: M1, linuxCwd: '/mnt/c/code/w1' }],
      report: () => undefined,
      powershellPath: 'unused',
      log: () => undefined,
      snapshot: async () => [],
      wslSnapshot: async () => scan,
      resume: {
        tracker: new AgentSessionTracker({ home: 'C:\\Users\\me', readText: async () => null, list: async () => [], mtimeMs: async () => null, now: () => 5 }),
        report: (_o, _s, r) => reports.push(r),
        wslTracker: (home) => {
          homes.push(home);
          return new AgentSessionTracker({ home, readText: async (f) => files[f] ?? null, list: async () => [], mtimeMs: async () => null, now: () => 5 });
        },
      },
    });
    const tick = () => (monitor as unknown as { tick(): Promise<void> }).tick();
    await tick();
    expect(homes).toEqual([HOME]);
    expect(reports).toEqual([{ agent: 'claude', sessionId: ID, cwd: 'C:\\code\\w1\\api', exact: true, at: 5, title: 'Fix login redirect', wsl: true }]);
    // Unchanged: nothing new is reported; the same tracker is kept.
    await tick();
    expect(reports).toHaveLength(1);
    expect(homes).toHaveLength(1);
    // Claude exits: the record goes.
    scan = [row(11, 10, M1, 'bash', '-bash'), 'HOME\t/home/me'].join('\n');
    await tick();
    expect(reports[1]).toBeNull();
    monitor.stop();
  });
});
