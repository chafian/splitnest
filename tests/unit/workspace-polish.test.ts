import { describe, expect, it } from 'vitest';
import { findPaneOfTab, listPanes } from '../../src/shared/layout';
import { DEFAULT_SETTINGS, emptyState, LIMITS, type PersistedState, type SessionStatus, type TerminalTab } from '../../src/shared/types';
import { normalizeTabName, parsePersistedState, validateCreateSessionRequest, validateSettings } from '../../src/shared/validation';
import { buildLaunch, ISOLATE_HISTORY_POWERSHELL, SHORT_PROMPT_POWERSHELL } from '../../src/main/shells';
import { mergeSessionEnv } from '../../src/pty-host/session-manager';
import {
  BulkStartTracker,
  StartGate,
  startAll,
  summarizeRestore,
  type BulkStartTarget,
  type StartOutcome,
} from '../../src/renderer/features/terminal/bulk-start';
import { tabLabel } from '../../src/renderer/features/terminal/tab-label';
import { computeChrome, toggleExplorer, toggleFocusMode, toggleSidebar } from '../../src/renderer/features/workspaces/chrome';
import { reducer } from '../../src/renderer/features/workspaces/workspace-state';

// ------------------------------------------------------------ fakes

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

/**
 * Mirrors TerminalController.start(): one StartGate per terminal, a running
 * terminal is left alone, and every real start "creates a session".
 */
class FakeTerminal {
  status: SessionStatus = 'idle';
  sessionsCreated = 0;
  private readonly gate = new StartGate();
  constructor(
    readonly tabId: string,
    private readonly createSession: () => Promise<boolean>,
  ) {}
  start(): Promise<StartOutcome> {
    if (!this.gate.busy && this.status === 'running') return Promise.resolve('running');
    return this.gate.run(async () => {
      this.status = 'starting';
      this.sessionsCreated++;
      const ok = await this.createSession();
      this.status = ok ? 'running' : 'failed';
      return ok ? 'running' : 'failed';
    });
  }
  target(): BulkStartTarget {
    return { tabId: this.tabId, status: () => this.status, start: () => this.start() };
  }
}

const flush = () => new Promise((r) => setTimeout(r, 0));

// ------------------------------------------------------------ starting

describe('starting restored terminals', () => {
  it('never creates two sessions for one terminal: clicks, Start all and Ctrl+Shift+R overlap', async () => {
    const gates = [deferred<boolean>(), deferred<boolean>(), deferred<boolean>()];
    const terms = gates.map((g, i) => new FakeTerminal(`t${i}`, () => g.promise));

    const click1 = terms[0]!.start();
    const click2 = terms[0]!.start(); // double click
    const bulk1 = startAll(terms.map((t) => t.target()));
    const bulk2 = startAll(terms.map((t) => t.target())); // second "Start all" while the first runs
    const shortcut = terms[1]!.start();
    await flush();
    gates.forEach((g) => g.resolve(true));
    const [r1, r2] = await Promise.all([bulk1, bulk2]);
    expect(await click1).toBe('running');
    expect(await click2).toBe('running');
    expect(await shortcut).toBe('running');
    expect(terms.map((t) => t.sessionsCreated)).toEqual([1, 1, 1]);
    expect(r1.started.sort()).toEqual(['t0', 't1', 't2']);
    expect(r2.failed).toEqual([]);

    // Starting again later leaves running terminals untouched.
    const again = await startAll(terms.map((t) => t.target()));
    expect(again.skipped.sort()).toEqual(['t0', 't1', 't2']);
    expect(terms.map((t) => t.sessionsCreated)).toEqual([1, 1, 1]);
  });

  it('keeps successful sessions running when another terminal fails', async () => {
    const outcomes: Record<string, boolean> = { a: true, b: false, c: true, d: false };
    const terms = Object.keys(outcomes).map((id) => new FakeTerminal(id, async () => outcomes[id]!));
    const settled: string[] = [];
    const result = await startAll(
      terms.map((t) => t.target()),
      { concurrency: 2, onSettled: (id, outcome) => settled.push(`${id}:${outcome}`) },
    );
    expect(result.started.sort()).toEqual(['a', 'c']);
    expect(result.failed.sort()).toEqual(['b', 'd']);
    expect(settled).toHaveLength(4);
    expect(terms.map((t) => t.status)).toEqual(['running', 'failed', 'running', 'failed']);

    // Retrying one failed terminal starts only that one.
    outcomes.b = true;
    expect(await terms[1]!.start()).toBe('running');
    expect(terms.map((t) => t.sessionsCreated)).toEqual([1, 2, 1, 1]);
  });

  it('treats a rejected start as a failure without stopping the rest', async () => {
    const boom = new FakeTerminal('x', () => Promise.reject(new Error('ipc down')));
    const fine = new FakeTerminal('y', async () => true);
    const result = await startAll([boom.target(), fine.target()], { concurrency: 1 });
    expect(result).toEqual({ started: ['y'], failed: ['x'], skipped: [] });
  });

  it('skips terminals that are no longer idle when their turn comes', async () => {
    const t = new FakeTerminal('t', async () => true);
    t.status = 'exited';
    expect(await startAll([t.target()])).toEqual({ started: [], failed: [], skipped: ['t'] });
    expect(t.sessionsCreated).toBe(0);
  });

  it('ignores a second "Start all" for the same workspace while one runs', async () => {
    const tracker = new BulkStartTracker();
    const gate = deferred<void>();
    let runs = 0;
    const first = tracker.run('w', async () => {
      runs++;
      await gate.promise;
      return 'done';
    });
    expect(tracker.isRunning('w')).toBe(true);
    expect(await tracker.run('w', async () => ++runs)).toBeNull();
    expect(await tracker.run('other', async () => 'ok')).toBe('ok');
    gate.resolve();
    expect(await first).toBe('done');
    expect(runs).toBe(1);
    expect(tracker.isRunning('w')).toBe(false);
  });

  it('summarises the notice: shown while anything is pending, starting or failed, hidden afterwards', () => {
    const t = (tabId: string, status: SessionStatus, hasStarted = false) => ({ tabId, label: tabId, status, hasStarted, errorMessage: null });
    const s = summarizeRestore([t('a', 'idle'), t('b', 'starting'), t('c', 'failed'), t('d', 'running', true)]);
    expect([s.pending, s.starting, s.failed].map((l) => l.map((x) => x.tabId))).toEqual([['a'], ['b'], ['c']]);
    expect(s.visible).toBe(true);
    // Terminals that ran (even if they later exited or are restarting) are no longer "restored".
    expect(summarizeRestore([t('a', 'running', true), t('b', 'exited', true), t('c', 'starting', true)]).visible).toBe(false);
  });
});

// ------------------------------------------------------------ tab names

const ws = (id: string) => ({ id, name: id, rootPath: `C:\\code\\${id}`, layout: null, activePaneId: null });

function onePane(): PersistedState {
  let s = reducer(emptyState(), { type: 'addWorkspace', workspace: ws('w') });
  s = reducer(s, { type: 'addPane', workspaceId: 'w', paneId: 'P', tabId: 't1', splitId: 's1', profileId: 'wsl:Ubuntu-22.04' });
  return reducer(s, { type: 'addTab', workspaceId: 'w', paneId: 'P', tabId: 't2', profileId: 'windows-powershell' });
}
const tab = (s: PersistedState, id: string) => findPaneOfTab(s.workspaces[0]!.layout, id)!.tabs.find((t) => t.id === id) as TerminalTab;

describe('terminal tab names', () => {
  it('renames, trims, limits length, and resets to the shell label when blank', () => {
    let s = reducer(onePane(), { type: 'renameTab', workspaceId: 'w', tabId: 't1', name: '  Backend  ' });
    expect(tab(s, 't1').name).toBe('Backend');
    expect(tab(s, 't2').name).toBeUndefined();
    s = reducer(s, { type: 'renameTab', workspaceId: 'w', tabId: 't2', name: 'x'.repeat(200) });
    expect(tab(s, 't2').name).toHaveLength(LIMITS.maxTabNameLength);
    s = reducer(s, { type: 'renameTab', workspaceId: 'w', tabId: 't1', name: '   ' });
    expect('name' in tab(s, 't1')).toBe(false);
    expect(normalizeTabName('Logs\u0007\n(tail)')).toBe('Logs (tail)');
    expect(normalizeTabName(42)).toBeNull();
  });

  it('persists names with the layout and keeps them through moves and shell changes', () => {
    let s = reducer(onePane(), { type: 'renameTab', workspaceId: 'w', tabId: 't2', name: 'Tests' });
    s = reducer(s, { type: 'addPane', workspaceId: 'w', paneId: 'Q', tabId: 'q1', splitId: 's2', profileId: 'pwsh', direction: 'row' });
    s = reducer(s, { type: 'moveTab', workspaceId: 'w', tabId: 't2', toPaneId: 'Q', toIndex: 0 });
    s = reducer(s, { type: 'setTabProfile', workspaceId: 'w', tabId: 't2', profileId: 'pwsh' });
    const reloaded = parsePersistedState(JSON.parse(JSON.stringify(s)));
    expect(reloaded.ok).toBe(true);
    if (!reloaded.ok) return;
    expect(tab(reloaded.state, 't2')).toEqual({ id: 't2', profileId: 'pwsh', name: 'Tests' });
  });

  it('drops a bad saved name instead of rejecting the whole file', () => {
    const state = { ...emptyState(), workspaces: [{ ...ws('w'), layout: { type: 'pane', id: 'p', activeTabId: 't', tabs: [{ id: 't', profileId: 'pwsh', name: { evil: true } }] } }] };
    const r = parsePersistedState(state);
    expect(r.ok && r.state.workspaces[0]!.layout).toEqual({ type: 'pane', id: 'p', activeTabId: 't', tabs: [{ id: 't', profileId: 'pwsh' }] });
  });

  it('shell title updates never replace a custom name', () => {
    const base = { customName: 'Backend', profileId: 'wsl:Ubuntu-22.04', shellLabel: 'Ubuntu-22.04' };
    for (const shellTitle of [null, 'chafian@host: ~/car-rental', 'vim server.ts', 'Backend']) {
      const l = tabLabel({ ...base, shellTitle });
      expect(l.primary).toBe('Backend');
      expect(l.secondary).toBe('Ubuntu-22.04');
    }
    expect(tabLabel({ ...base, shellTitle: 'vim server.ts' }).titleLine).toBe('vim server.ts');
    expect(tabLabel({ ...base, shellTitle: 'C:\\Windows\\System32\\wsl.exe' }).titleLine).toBeNull();
  });

  it('shows the shell name once when there is no custom name', () => {
    const l = tabLabel({ customName: undefined, profileId: 'windows-powershell', shellLabel: 'Windows PowerShell', shellTitle: 'Windows PowerShell' });
    expect(l).toEqual({ primary: 'PowerShell', secondary: null, defaultName: 'PowerShell', full: 'PowerShell', titleLine: null });
    // A custom name equal to the shell name is not repeated either.
    expect(tabLabel({ customName: 'powershell', profileId: 'windows-powershell', shellLabel: 'Windows PowerShell' }).secondary).toBeNull();
  });
});

// ------------------------------------------------------------ sidebars

describe('sidebars and focus mode', () => {
  const settings = { ...DEFAULT_SETTINGS, sidebarWidth: 300, explorerWidth: 280, sidebarCollapsed: false, explorerVisible: true, focusMode: false };

  it('focus mode hides both sidebars and turning it off restores visibility and widths', () => {
    const before = computeChrome(settings, 1600);
    expect(before).toMatchObject({ sidebar: 'expanded', sidebarWidth: 300, explorer: true, explorerWidth: 280 });
    const on = { ...settings, ...toggleFocusMode(settings) };
    expect(computeChrome(on, 1600)).toMatchObject({ sidebar: 'hidden', explorer: false, sidebarWidth: 0, explorerWidth: 0 });
    expect(on.sidebarWidth).toBe(300); // preferences untouched
    const off = { ...on, ...toggleFocusMode(on) };
    expect(computeChrome(off, 1600)).toEqual(before);

    // A collapsed rail and a hidden explorer come back exactly as they were too.
    const custom = { ...settings, sidebarCollapsed: true, explorerVisible: false };
    const roundTrip = { ...custom, ...toggleFocusMode(custom) };
    expect(computeChrome({ ...roundTrip, ...toggleFocusMode(roundTrip) }, 1600)).toEqual(computeChrome(custom, 1600));
  });

  it('sidebar and explorer toggles leave focus mode instead of fighting it', () => {
    const on = { ...settings, focusMode: true, explorerVisible: false };
    expect(toggleSidebar(on)).toEqual({ focusMode: false });
    expect(toggleExplorer(on)).toEqual({ focusMode: false, explorerVisible: true });
    expect(toggleSidebar(settings)).toEqual({ sidebarCollapsed: true });
    expect(toggleExplorer(settings)).toEqual({ explorerVisible: false });
  });

  it('clamps widths on small windows for display only, keeping terminals usable', () => {
    const narrow = computeChrome(settings, 900);
    expect(900 - narrow.sidebarWidth - narrow.explorerWidth).toBeGreaterThanOrEqual(LIMITS.minTerminalAreaWidth);
    expect(narrow.explorerWidth).toBe(240); // explorer gives way first
    expect(narrow.sidebarWidth).toBe(300);
    const tiny = computeChrome(settings, 720); // the minimum window width
    expect(tiny.explorerWidth).toBe(LIMITS.explorerWidth.min);
    expect(tiny.sidebarWidth).toBe(200);
    expect(720 - tiny.sidebarWidth - tiny.explorerWidth).toBe(LIMITS.minTerminalAreaWidth);
    // Never below the panel minimums, even if that squeezes the terminals.
    expect(computeChrome(settings, 500)).toMatchObject({ sidebarWidth: LIMITS.sidebarWidth.min, explorerWidth: LIMITS.explorerWidth.min });
    expect(computeChrome(settings, 1600)).toMatchObject({ sidebarWidth: 300, explorerWidth: 280 }); // restored when the window grows
    expect(computeChrome({ ...settings, sidebarCollapsed: true }, 1280).sidebarWidth).toBe(LIMITS.sidebarRailWidth);
    expect(computeChrome(settings, 1600, false).explorer).toBe(false); // welcome screen
  });
});

// ------------------------------------------------------------ short prompts

describe('short prompt paths', () => {
  const ps = { id: 'windows-powershell', kind: 'windows-powershell' as const, label: 'Windows PowerShell' };
  const wsl = { id: 'wsl:Ubuntu', kind: 'wsl' as const, label: 'Ubuntu', distro: 'Ubuntu' };
  const base = { executable: 'x.exe', workspaceRoot: 'C:\\code\\a', homeDir: 'C:\\Users\\me', startIn: 'workspace-root' as const };

  it('adds a constant prompt command for PowerShell and an env var for WSL only when enabled', () => {
    const on = buildLaunch({ ...base, profile: ps, shortPrompt: true });
    expect(on.args).toEqual(['-NoLogo', '-NoExit', '-Command', SHORT_PROMPT_POWERSHELL]);
    expect(SHORT_PROMPT_POWERSHELL).not.toContain('C:\\code'); // no user data inside the command
    expect(buildLaunch({ ...base, profile: ps }).args).toEqual(['-NoLogo']);
    expect(buildLaunch({ ...base, profile: wsl, linuxPath: '/mnt/c/code/a', shortPrompt: true }).env).toEqual({ PROMPT_DIRTRIM: '1', WSLENV: 'PROMPT_DIRTRIM/u' });
    expect(buildLaunch({ ...base, profile: wsl, startIn: 'home', shortPrompt: true }).env?.PROMPT_DIRTRIM).toBe('1');
    expect(buildLaunch({ ...base, profile: wsl, linuxPath: '/mnt/c/code/a' }).env).toBeUndefined();
  });

  it("test runs keep PowerShell away from the user's history file; normal launches are unchanged", () => {
    expect(buildLaunch({ ...base, profile: ps, shortPrompt: true, isolateHistory: true }).args).toEqual(['-NoLogo', '-NoExit', '-Command', `${ISOLATE_HISTORY_POWERSHELL}; ${SHORT_PROMPT_POWERSHELL}`]);
    expect(buildLaunch({ ...base, profile: ps, isolateHistory: true }).args).toEqual(['-NoLogo', '-NoExit', '-Command', ISOLATE_HISTORY_POWERSHELL]);
    expect(buildLaunch({ ...base, profile: ps, shortPrompt: true }).args.join(' ')).not.toContain('HistorySaveStyle');
  });

  it('appends to an existing WSLENV instead of replacing it', () => {
    expect(mergeSessionEnv({ Path: 'x', WSLENV: 'GOPATH/l:FOO' }, { PROMPT_DIRTRIM: '1', WSLENV: 'PROMPT_DIRTRIM/u' })).toEqual({
      Path: 'x',
      WSLENV: 'GOPATH/l:FOO:PROMPT_DIRTRIM/u',
      PROMPT_DIRTRIM: '1',
    });
    expect(mergeSessionEnv({ WslEnv: 'PROMPT_DIRTRIM/u' }, { WSLENV: 'PROMPT_DIRTRIM/u' })).toEqual({ WslEnv: 'PROMPT_DIRTRIM/u' });
    expect(mergeSessionEnv({ A: '1' }, { WSLENV: 'PROMPT_DIRTRIM/u' })).toEqual({ A: '1', WSLENV: 'PROMPT_DIRTRIM/u' });
    const base = { A: '1' };
    expect(mergeSessionEnv(base, undefined)).toBe(base);
  });

  it('is on by default, can be turned off, and the request flag is validated', () => {
    expect(validateSettings({}).shortPromptPaths).toBe(true);
    expect(validateSettings({ shortPromptPaths: false }).shortPromptPaths).toBe(false);
    const req = { workspaceId: 'w', paneId: 'p', profileId: 'pwsh', startIn: 'workspace-root', cols: 80, rows: 24 };
    expect(validateCreateSessionRequest({ ...req, shortPrompt: true }).shortPrompt).toBe(true);
    expect(validateCreateSessionRequest(req).shortPrompt).toBe(false);
    expect(() => validateCreateSessionRequest({ ...req, shortPrompt: 'yes' })).toThrow();
  });
});

// ------------------------------------------------------------ old files

describe('backward compatibility', () => {
  it('loads a schema-2 file written before tab names and sidebar settings existed', () => {
    const old = {
      schemaVersion: 2,
      activeWorkspaceId: 'w1',
      settings: { fontSize: 13, sidebarCollapsed: true, explorerVisible: false, explorerWidth: 300 },
      workspaces: [
        {
          id: 'w1',
          name: 'car-rental',
          rootPath: 'C:\\code\\car-rental',
          activePaneId: 'p1',
          layout: {
            type: 'split',
            id: 's1',
            direction: 'row',
            sizes: [0.5, 0.5],
            children: [
              { type: 'pane', id: 'p1', activeTabId: 'a', tabs: [{ id: 'a', profileId: 'wsl:Ubuntu-22.04' }, { id: 'b', profileId: 'pwsh' }] },
              { type: 'pane', id: 'p2', activeTabId: 'c', tabs: [{ id: 'c', profileId: 'windows-powershell' }] },
            ],
          },
        },
      ],
    };
    const r = parsePersistedState(old);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(listPanes(r.state.workspaces[0]!.layout).flatMap((p) => p.tabs)).toEqual([
      { id: 'a', profileId: 'wsl:Ubuntu-22.04' },
      { id: 'b', profileId: 'pwsh' },
      { id: 'c', profileId: 'windows-powershell' },
    ]);
    expect(r.state.settings).toMatchObject({
      fontSize: 13,
      sidebarCollapsed: true,
      explorerVisible: false,
      explorerWidth: 300,
      sidebarWidth: LIMITS.sidebarWidth.default,
      focusMode: false,
    });
  });

  it('clamps out-of-range sidebar widths and ignores a non-boolean focus mode', () => {
    expect(validateSettings({ sidebarWidth: 5000, focusMode: 'yes' })).toMatchObject({ sidebarWidth: LIMITS.sidebarWidth.max, focusMode: false });
    expect(validateSettings({ sidebarWidth: 10 }).sidebarWidth).toBe(LIMITS.sidebarWidth.min);
  });
});
