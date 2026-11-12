import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentNotifier, DONE_SETTLE_MS, noticeKindOf, type AgentEvent, type NotifySettings, type Where } from '../../src/renderer/features/notifications/agent-notifier';
import { deriveAgentView, parseProgramStatus, StatusRecords, type AgentView, type StatusCommand } from '../../src/renderer/features/terminal/agent-status';
import type { AgentId } from '../../src/shared/agents';

const recordings = JSON.parse(readFileSync(path.join(__dirname, '..', 'fixtures', 'agent-status-recordings.json'), 'utf8')) as Record<string, { t: number; body: string }[]>;
const recording = (prefix: string) => Object.entries(recordings).find(([k]) => k.startsWith(prefix))![1];

const ON: NotifySettings = { notifyNeedsYou: true, notifyFinished: true, notifyErrors: true, notifyEstimated: false, notifyWindows: true };

/** A notifier with a controllable window/tab situation; records what it delivers and withdraws. */
function setup(over: { settings?: Partial<NotifySettings> } = {}) {
  const log: string[] = [];
  const events: (AgentEvent & { where: Where })[] = [];
  const env = { focused: false, looking: new Set<string>(), settings: { ...ON, ...over.settings } };
  const t0 = Date.now();
  const at = () => ((Date.now() - t0) / 1000).toFixed(1);
  const n = new AgentNotifier({
    settings: () => env.settings,
    looking: (id) => env.focused && env.looking.has(id),
    windowFocused: () => env.focused,
    deliver: (e, where) => {
      events.push({ ...e, where });
      log.push(`${at()} ${where} ${e.kind} ${e.view.label}`);
    },
    withdraw: (id) => log.push(`${at()} withdraw ${id}`),
    setTimer: (fn, ms) => setTimeout(fn, ms),
    clearTimer: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
  });
  return { n, log, events, env };
}

/** Feeds status reports to one tab the way the terminal controller does, at their recorded times. */
function terminal(n: AgentNotifier, opts: { tabId?: string; processAgent?: AgentId | null; processDetection?: boolean } = {}) {
  const tabId = opts.tabId ?? 'tab1';
  const records = new StatusRecords();
  let reported = false;
  let processAgent = opts.processAgent ?? null;
  let bell = false;
  const t0 = Date.now();
  const push = () => {
    const view = deriveAgentView({
      summary: records.summary(),
      processAgent,
      processDetection: opts.processDetection ?? true,
      titleAgent: null,
      shellTitle: null,
      bellPending: bell,
      recentOutput: false,
      reportedThisRun: reported,
    });
    n.update(tabId, 'ws1', view);
    return view;
  };
  return {
    report(body: string) {
      const c = parseProgramStatus(body) as StatusCommand;
      if (c.type === 'clear' && c.id === '') {
        records.clearAll();
        reported = false;
        processAgent = null; // the agent exits after its root clear in these recordings
      } else {
        if (c.type === 'report') reported = true;
        records.apply(c);
      }
      return push();
    },
    async replay(rows: { t: number; body: string }[]) {
      for (const r of rows) {
        await vi.advanceTimersByTimeAsync(Math.max(0, r.t * 1000 - (Date.now() - t0)));
        this.report(r.body);
      }
    },
    setProcessAgent(a: AgentId | null) {
      processAgent = a;
      return push();
    },
    bell() {
      bell = true;
      return push();
    },
  };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('real recordings, SplitNest in the background', () => {
  it('Claude Code 2.1.316: needs permission → withdrawn when it continues → finished, even though it exits 1 s after `done`', async () => {
    const { n, log, env } = setup();
    await terminal(n, { processAgent: 'claude' }).replay(recording('claude-code-2.1.316'));
    await vi.advanceTimersByTimeAsync(5000);
    expect(log).toEqual(['19.9 windows permission Claude Code', '21.1 withdraw tab1', '24.4 windows done Claude Code']);
    // The "finished" notice stays after the exit until the user looks at the tab.
    env.focused = true;
    env.looking.add('tab1');
    n.reviewSeen();
    expect(log.at(-1)).toBe('28.9 withdraw tab1');
  });

  it('Codex 0.166.0: its `done` is replaced by `idle` 0.8 s later and still counts as finished, once', async () => {
    const { n, log } = setup();
    await terminal(n, { processAgent: 'codex' }).replay(recording('codex-0.166.0 task'));
    await vi.advanceTimersByTimeAsync(5000);
    expect(log).toEqual(['7.7 windows permission Codex', '8.9 withdraw tab1', '13.0 windows done Codex']);
  });

  it('Codex starting up (idle → working → idle, no prompt) is not "finished"', async () => {
    const { n, log } = setup();
    await terminal(n, { processAgent: 'codex' }).replay(recording('codex-0.166.0 startup'));
    await vi.advanceTimersByTimeAsync(10_000);
    expect(log).toEqual([]);
  });
});

describe('when and what', () => {
  it('the same report repeated notifies once; a new reason notifies again', () => {
    const { n, events } = setup();
    const t = terminal(n, { processAgent: 'claude' });
    t.report('state=blocked:kind=permission:app=claude-code');
    t.report('state=blocked:kind=permission:app=claude-code');
    t.report('state=blocked:kind=question:app=claude-code');
    t.report('state=blocked:app=claude-code');
    expect(events.map((e) => e.kind)).toEqual(['permission', 'question', 'needs-you']);
  });

  it('working again within the settle time after `done`: no "finished"', async () => {
    const { n, events } = setup();
    const t = terminal(n, { processAgent: 'claude' });
    t.report('state=working:app=claude-code');
    t.report('state=done:app=claude-code');
    await vi.advanceTimersByTimeAsync(DONE_SETTLE_MS - 100);
    t.report('state=working:app=claude-code');
    await vi.advanceTimersByTimeAsync(5000);
    expect(events).toEqual([]);
  });

  it('error notifies at once', () => {
    const { n, events } = setup();
    terminal(n, { processAgent: 'codex' }).report('state=error:app=codex');
    expect(events.map((e) => `${e.where} ${e.kind}`)).toEqual(['windows error']);
  });

  it('looking at the tab: nothing; focused on another tab, workspace or Settings: in-app notice', () => {
    const { n, events, env } = setup();
    env.focused = true;
    env.looking.add('tab1');
    terminal(n, { tabId: 'tab1', processAgent: 'claude' }).report('state=blocked:kind=permission:app=claude-code');
    terminal(n, { tabId: 'tab2', processAgent: 'claude' }).report('state=blocked:kind=permission:app=claude-code');
    expect(events.map((e) => `${e.tabId} ${e.where}`)).toEqual(['tab2 in-app']);
  });

  it('a notice is withdrawn once the user looks at its tab', () => {
    const { n, log, env } = setup();
    terminal(n, { processAgent: 'claude' }).report('state=blocked:kind=permission:app=claude-code');
    n.reviewSeen(); // window still in the background
    env.focused = true;
    env.looking.add('tab1');
    n.reviewSeen();
    n.reviewSeen();
    expect(log.filter((l) => l.includes('withdraw'))).toHaveLength(1);
  });

  it('an agent that exits while waiting: its "needs you" notice goes', () => {
    const { n, log } = setup();
    const t = terminal(n, { processAgent: 'claude' });
    t.report('state=blocked:kind=permission:app=claude-code');
    t.report('state=clear');
    expect(log.at(-1)).toMatch(/withdraw tab1$/);
  });

  it('a closed tab (or removed workspace) withdraws its notice', () => {
    const { n, log } = setup();
    terminal(n, { processAgent: 'claude' }).report('state=blocked:kind=permission:app=claude-code');
    n.retain(new Set());
    expect(log.at(-1)).toMatch(/withdraw tab1$/);
  });
});

describe('identity: Windows notifications only for a confirmed agent', () => {
  it('"needs you" from a report naming an agent that process detection has not found waits, then notifies once found', () => {
    const { n, events } = setup();
    const t = terminal(n, { processAgent: null });
    t.report('state=blocked:kind=permission:app=claude-code');
    expect(events).toEqual([]);
    t.setProcessAgent('claude');
    expect(events.map((e) => `${e.where} ${e.kind}`)).toEqual(['windows permission']);
  });

  it('a report claiming to be Claude Code from a terminal running Codex never raises a Windows notification', () => {
    const { n, events } = setup();
    terminal(n, { processAgent: 'codex' }).report('state=blocked:kind=permission:app=claude-code');
    expect(events).toEqual([]);
  });

  it('unconfirmed `done` / `error` fall back to the in-app notice', async () => {
    const { n, events } = setup();
    const t = terminal(n, { processAgent: null });
    t.report('state=done:app=claude-code');
    await vi.advanceTimersByTimeAsync(DONE_SETTLE_MS);
    t.report('state=error:app=claude-code');
    expect(events.map((e) => `${e.where} ${e.kind}`)).toEqual(['in-app done', 'in-app error']);
  });

  it('WSL tabs (no process detection): the report is enough', () => {
    const { n, events } = setup();
    terminal(n, { processDetection: false }).report('state=blocked:kind=question:app=claude-code');
    expect(events.map((e) => `${e.where} ${e.kind}`)).toEqual(['windows question']);
  });
});

describe('settings', () => {
  it('each kind can be turned off; with Windows notifications off, the in-app notice is used', async () => {
    const off = setup({ settings: { notifyNeedsYou: false, notifyFinished: false, notifyErrors: false } });
    const t = terminal(off.n, { processAgent: 'claude' });
    t.report('state=blocked:kind=permission:app=claude-code');
    t.report('state=error:app=claude-code');
    t.report('state=done:app=claude-code');
    await vi.advanceTimersByTimeAsync(DONE_SETTLE_MS);
    expect(off.events).toEqual([]);
    const inApp = setup({ settings: { notifyWindows: false } });
    terminal(inApp.n, { processAgent: 'claude' }).report('state=blocked:kind=permission:app=claude-code');
    expect(inApp.events.map((e) => e.where)).toEqual(['in-app']);
  });

  it('estimated "may need you" (a bell from an agent that does not report) only when enabled', () => {
    const quiet = setup();
    terminal(quiet.n, { processAgent: 'aider' }).bell();
    expect(quiet.events).toEqual([]);
    const on = setup({ settings: { notifyEstimated: true } });
    terminal(on.n, { processAgent: 'aider' }).bell();
    expect(on.events.map((e) => `${e.where} ${e.kind} ${e.view.label}`)).toEqual(['windows maybe Aider']);
  });
});

it('noticeKindOf: working and idle are never events', () => {
  const v = (state: AgentView['state'], extra: Partial<AgentView> = {}) => ({ state, kind: null, source: 'protocol', ...extra }) as AgentView;
  expect([v('working'), v('idle')].map(noticeKindOf)).toEqual([null, null]);
  expect(noticeKindOf(v('needs-action', { kind: 'auth' }))).toBe('auth');
  expect(noticeKindOf(v('needs-action', { source: 'heuristic' }))).toBe('maybe');
});
