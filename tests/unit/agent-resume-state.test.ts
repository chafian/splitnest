// Agent resume, phase 3: the conversation is kept with its terminal tab, survives the state file,
// and survives SplitNest quitting (but not the agent exiting on its own).
import { describe, expect, it } from 'vitest';
import { AgentMonitor } from '../../src/main/agent-monitor';
import { AgentSessionTracker } from '../../src/main/agent-sessions';
import { cleanTitle, parseAgentResume, resumeCommand, TITLE_MAX, type AgentResume } from '../../src/shared/agent-resume';
import { parseClaudeLiveFile } from '../../src/main/agent-sessions';
import { createLaunchResolver } from '../../src/main/launch-resolver';
import type { ProcessInfo } from '../../src/shared/agents';
import { emptyState, isTerminalTab, type PersistedState, type TerminalTab } from '../../src/shared/types';
import { parsePersistedState, validateCreateSessionRequest } from '../../src/shared/validation';
import { listPanes } from '../../src/shared/layout';
import { reducer } from '../../src/renderer/features/workspaces/workspace-state';

const ID = 'ff7e99ad-614e-4263-8b68-9515e5f3d720';
const RESUME: AgentResume = { agent: 'claude', sessionId: ID, cwd: 'C:\\code\\w1', exact: true, at: 1_794_435_013_307 };

function state(): PersistedState {
  let s = reducer(emptyState(), { type: 'addWorkspace', workspace: { id: 'w1', name: 'w1', rootPath: 'C:\\code\\w1', layout: null, activePaneId: null } });
  s = reducer(s, { type: 'addPane', workspaceId: 'w1', paneId: 'p1', splitId: 's1', profileId: 'pwsh' });
  return s;
}
const tab = (s: PersistedState): TerminalTab => {
  const t = listPanes(s.workspaces[0]!.layout)[0]!.tabs[0]!;
  if (!isTerminalTab(t)) throw new Error('not a terminal');
  return t;
};
const roundTrip = (s: PersistedState) => {
  const r = parsePersistedState(JSON.parse(JSON.stringify(s)));
  if (!r.ok) throw new Error(r.reason);
  return r.state;
};

describe('agent resume: kept with the tab', () => {
  it('is set, survives the state file, and is removed when the agent exits', () => {
    let s = reducer(state(), { type: 'setTabResume', workspaceId: 'w1', tabId: 'p1', resume: RESUME });
    expect(tab(s).resume).toEqual(RESUME);
    expect(tab(roundTrip(s)).resume).toEqual(RESUME);
    expect(reducer(s, { type: 'setTabResume', workspaceId: 'w1', tabId: 'p1', resume: { ...RESUME } })).toBe(s); // unchanged: no save
    s = reducer(s, { type: 'setTabResume', workspaceId: 'w1', tabId: 'p1', resume: null });
    expect('resume' in tab(s)).toBe(false);
  });

  it('renaming a tab, or clearing its name, keeps the conversation', () => {
    let s = reducer(state(), { type: 'setTabResume', workspaceId: 'w1', tabId: 'p1', resume: RESUME });
    s = reducer(s, { type: 'renameTab', workspaceId: 'w1', tabId: 'p1', name: 'Backend' });
    expect(tab(s)).toMatchObject({ name: 'Backend', resume: RESUME });
    s = reducer(s, { type: 'renameTab', workspaceId: 'w1', tabId: 'p1', name: '' });
    expect('name' in tab(s)).toBe(false);
    expect(tab(s).resume).toEqual(RESUME);
  });

  it('a damaged record in the state file loses only Resume, never the layout', () => {
    const s = JSON.parse(JSON.stringify(reducer(state(), { type: 'setTabResume', workspaceId: 'w1', tabId: 'p1', resume: RESUME })));
    s.workspaces[0].layout.tabs[0].resume = { ...RESUME, sessionId: '$(Start-Process calc)' };
    const r = parsePersistedState(s);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(tab(r.state).profileId).toBe('pwsh');
      expect('resume' in tab(r.state)).toBe(false);
    }
  });

  it('files written before Resume existed load unchanged', () => {
    const s = JSON.parse(JSON.stringify(state()));
    expect(tab(roundTrip(s))).toEqual({ id: 'p1', profileId: 'pwsh' });
  });
});

describe('agent resume: quitting keeps it', () => {
  it('the monitor reports the conversation while the agent runs, and nothing after it is stopped for a quit', async () => {
    const shell = 100;
    let procs: ProcessInfo[] = [{ pid: 300, ppid: shell, name: 'claude.exe', cmd: 'claude.exe' }];
    const reports: (AgentResume | null)[] = [];
    const tracker = new AgentSessionTracker({
      home: 'C:\\Users\\me',
      now: () => 5,
      readText: async (f) => (f.endsWith('\\300.json') ? JSON.stringify({ pid: 300, sessionId: ID, cwd: 'C:\\code\\w1', kind: 'interactive' }) : null),
      list: async () => [],
      mtimeMs: async () => null,
    });
    const monitor = new AgentMonitor({
      sessions: () => [{ sessionId: 's1', ownerId: 1, pid: shell, wsl: false, cwd: 'C:\\code\\w1' }],
      report: () => undefined,
      powershellPath: 'unused',
      log: () => undefined,
      snapshot: async () => procs,
      resume: { tracker, report: (_o, _s, r) => reports.push(r) },
    });
    const tick = () => (monitor as unknown as { tick(): Promise<void> }).tick();
    await tick();
    expect(reports).toEqual([{ agent: 'claude', sessionId: ID, cwd: 'C:\\code\\w1', exact: true, at: 5 }]);
    // SplitNest quits: main stops the monitor before the shells end, so the agent's end isn't reported.
    monitor.stop();
    procs = [];
    await tick();
    expect(reports).toHaveLength(1);
  });

  it('an agent exiting on its own clears it', async () => {
    const shell = 100;
    let procs: ProcessInfo[] = [{ pid: 300, ppid: shell, name: 'claude.exe', cmd: 'claude.exe' }];
    const reports: (AgentResume | null)[] = [];
    const tracker = new AgentSessionTracker({
      home: 'C:\\Users\\me',
      now: () => 5,
      readText: async () => JSON.stringify({ pid: 300, sessionId: ID, cwd: 'C:\\code\\w1', kind: 'interactive' }),
      list: async () => [],
      mtimeMs: async () => null,
    });
    const monitor = new AgentMonitor({
      sessions: () => [{ sessionId: 's1', ownerId: 1, pid: shell, wsl: false, cwd: 'C:\\code\\w1' }],
      report: () => undefined,
      powershellPath: 'unused',
      log: () => undefined,
      snapshot: async () => procs,
      resume: { tracker, report: (_o, _s, r) => reports.push(r) },
    });
    const tick = () => (monitor as unknown as { tick(): Promise<void> }).tick();
    await tick();
    procs = [{ pid: 310, ppid: shell, name: 'node.exe', cmd: 'node server.js' }];
    await tick();
    monitor.stop();
    expect(reports.at(-1)).toBeNull();
  });
});

describe('agent resume: what runs', () => {
  it('types only the agent resume command built from a validated id, or opens the agent picker', () => {
    expect(resumeCommand({ agent: 'claude', sessionId: ID })).toBe(`claude --resume ${ID}`);
    expect(resumeCommand({ agent: 'claude', sessionId: null })).toBe('claude --resume');
    expect(resumeCommand({ agent: 'codex', sessionId: ID })).toBe(`codex resume ${ID}`);
    expect(resumeCommand({ agent: 'codex', sessionId: null })).toBe('codex resume');
    // Anything that isn't a UUID never reaches the command line.
    expect(resumeCommand({ agent: 'claude', sessionId: `${ID}; Remove-Item -Recurse C:\\` })).toBe('claude --resume');
  });

  it('main starts the shell in the agent folder only inside the workspace, only for PowerShell, only if it exists', async () => {
    const root = 'C:\\code\\w1';
    const resolve = (isDirectory: (p: string) => boolean) =>
      createLaunchResolver({
        getWorkspace: (id) => (id === 'w1' ? { id: 'w1', name: 'w1', rootPath: root, layout: null, activePaneId: null } : undefined),
        getShells: async () => ({
          discovery: {
            profiles: [
              { id: 'windows-powershell', kind: 'windows-powershell', label: 'Windows PowerShell' },
              { id: 'wsl:Ubuntu', kind: 'wsl', label: 'Ubuntu', distro: 'Ubuntu' },
            ],
            wsl: { state: 'available' },
            fallbackProfileId: 'windows-powershell',
          },
          executables: new Map([
            ['windows-powershell', 'C:\\ps.exe'],
            ['wsl:Ubuntu', 'C:\\wsl.exe'],
          ]),
        }),
        isDirectory: async (p) => isDirectory(p),
        exists: async () => true,
        run: async () => ({ code: 0, stdout: Buffer.from('/mnt/c/code/w1'), stderr: Buffer.alloc(0), timedOut: false, notFound: false }),
        env: {},
        homeDir: 'C:\\Users\\me',
      });
    const req = (over: object) => validateCreateSessionRequest({ workspaceId: 'w1', paneId: 'p1', profileId: 'windows-powershell', startIn: 'workspace-root', cols: 80, rows: 24, ...over });
    const all = resolve(() => true);
    expect(await all(req({ startPath: 'C:\\code\\w1\\api' }))).toMatchObject({ ok: true, launch: { cwd: 'C:\\code\\w1\\api', cwdLabel: 'C:\\code\\w1\\api' } });
    expect(await all(req({ startPath: 'C:\\code\\w1-other' }))).toMatchObject({ ok: false, error: { code: 'INVALID_REQUEST' } });
    expect(await all(req({ startPath: 'C:\\code\\w1\\..\\..\\Windows' }))).toMatchObject({ ok: false });
    expect(await all(req({ startPath: 'C:\\code\\w1\\api', profileId: 'wsl:Ubuntu' }))).toMatchObject({ ok: false, error: { code: 'INVALID_REQUEST' } });
    expect(await resolve((p) => p === root)(req({ startPath: 'C:\\code\\w1\\gone' }))).toMatchObject({ ok: false, error: { code: 'FOLDER_MISSING' } });
    expect(() => req({ startPath: 'relative\\dir' })).toThrow();
    expect(() => req({ startPath: 'C:\\code\\w1', startIn: 'home' })).toThrow();
  });
});

describe('agent resume: conversation titles (setting "Show conversation titles for Resume")', () => {
  it('is on by default, and older settings without it load as on', () => {
    expect(emptyState().settings.resumeTitles).toBe(true);
    const s = JSON.parse(JSON.stringify(state()));
    delete s.settings.resumeTitles;
    expect(roundTrip(s).settings.resumeTitles).toBe(true);
  });

  it('a title is kept as plain text, capped, and survives the state file', () => {
    const titled = { ...RESUME, title: 'Fix login\u0007 redirect\u202e  (auth)' };
    const s = reducer(state(), { type: 'setTabResume', workspaceId: 'w1', tabId: 'p1', resume: parseAgentResume(titled)! });
    expect(tab(roundTrip(s)).resume?.title).toBe('Fix login redirect (auth)');
    expect(cleanTitle('x'.repeat(500))!.length).toBe(TITLE_MAX);
    expect(cleanTitle('   ')).toBeNull();
  });

  it('turning the setting off removes every saved title at once', () => {
    let s = reducer(state(), { type: 'setTabResume', workspaceId: 'w1', tabId: 'p1', resume: { ...RESUME, title: 'Refactor billing' } });
    s = reducer(s, { type: 'updateSettings', patch: { resumeTitles: false } });
    expect(tab(s).resume).toEqual(RESUME);
    expect(JSON.stringify(s)).not.toContain('Refactor billing');
  });

  it("main reads Claude Code's own name for the conversation from its live record", () => {
    const live = JSON.stringify({ pid: 7, sessionId: ID, cwd: 'C:\\code\\w1', kind: 'interactive', name: 'Fix login redirect', nameSource: 'derived' });
    expect(parseClaudeLiveFile(live, 7)).toEqual({ sessionId: ID, cwd: 'C:\\code\\w1', title: 'Fix login redirect' });
    expect(parseClaudeLiveFile(JSON.stringify({ ...JSON.parse(live), name: 42 }), 7)?.title).toBeNull();
  });
});

describe('agent resume: "Resume agents automatically"', () => {
  it('is off by default; only an explicit true turns it on', () => {
    expect(emptyState().settings.resumeAutomatically).toBe(false);
    const s = JSON.parse(JSON.stringify(state()));
    for (const v of [undefined, 'true', 1, null]) {
      s.settings.resumeAutomatically = v;
      expect(roundTrip(s).settings.resumeAutomatically).toBe(false);
    }
    s.settings.resumeAutomatically = true;
    expect(roundTrip(s).settings.resumeAutomatically).toBe(true);
  });
});
