// The agent inbox (see "Inbox" in src/renderer/features/notifications/agent-notifier.ts): what is
// still waiting for the user, fed by the same real status reports as the notification tests.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentNotifier, DONE_SETTLE_MS, nextInboxItem, sortInbox, type InboxItem, type NotifySettings } from '../../src/renderer/features/notifications/agent-notifier';
import { deriveAgentView, parseProgramStatus, StatusRecords, type AgentView, type StatusCommand } from '../../src/renderer/features/terminal/agent-status';
import { inboxLabel, waitedLabel } from '../../src/renderer/features/notifications/AgentInbox';

const recordings = JSON.parse(readFileSync(path.join(__dirname, '..', 'fixtures', 'agent-status-recordings.json'), 'utf8')) as Record<string, { t: number; body: string }[]>;
const recording = (prefix: string) => Object.entries(recordings).find(([k]) => k.startsWith(prefix))![1];
const ON: NotifySettings = { notifyNeedsYou: true, notifyFinished: true, notifyErrors: true, notifyEstimated: false, notifyWindows: true };

function setup(settings: Partial<NotifySettings> = {}) {
  const env = { focused: true, looking: new Set<string>(), settings: { ...ON, ...settings }, changes: 0 };
  const n = new AgentNotifier({
    settings: () => env.settings,
    looking: (id) => env.focused && env.looking.has(id),
    windowFocused: () => env.focused,
    deliver: () => undefined,
    withdraw: () => undefined,
    setTimer: (fn, ms) => setTimeout(fn, ms),
    clearTimer: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
    now: () => Date.now(),
    inboxChanged: () => env.changes++,
  });
  const list = () => n.inbox().map((i) => `${i.tabId}:${i.kind}`);
  return { n, env, list };
}

/** One terminal tab running an agent that reports its state (as the terminal controller feeds it). */
function tab(n: AgentNotifier, tabId: string, app = 'claude-code') {
  const records = new StatusRecords();
  let reported = false;
  let running = true;
  const t0 = Date.now();
  const push = () => {
    const view: AgentView | null = running
      ? deriveAgentView({ summary: records.summary(), processAgent: app === 'codex' ? 'codex' : 'claude', processDetection: true, titleAgent: null, shellTitle: null, bellPending: false, recentOutput: false, reportedThisRun: reported })
      : null;
    n.update(tabId, 'ws1', view);
  };
  const report = (body: string) => {
    const c = parseProgramStatus(body.includes('app=') || body.startsWith('clear') ? body : `${body}:app=${app}`) as StatusCommand;
    if (c.type === 'clear' && c.id === '') {
      records.clearAll();
      reported = false;
      running = false; // the agent exits after its root clear in the recordings
    } else {
      if (c.type === 'report') reported = true;
      records.apply(c);
    }
    push();
  };
  return {
    report,
    exit() {
      running = false;
      records.clearAll();
      push();
    },
    async replay(rows: { t: number; body: string }[]) {
      for (const r of rows) {
        await vi.advanceTimersByTimeAsync(Math.max(0, r.t * 1000 - (Date.now() - t0)));
        report(r.body);
      }
    },
  };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('agent inbox', () => {
  it('lists a blocked agent from the moment it waits until it moves on; looking at the tab does not remove it', () => {
    const { n, env, list } = setup();
    const a = tab(n, 'A');
    a.report('state=working');
    expect(list()).toEqual([]);
    a.report('state=blocked:kind=permission');
    expect(list()).toEqual(['A:permission']);
    env.looking.add('A'); // the user opens the tab but hasn't answered
    n.reviewSeen();
    expect(list()).toEqual(['A:permission']);
    a.report('state=working'); // answered: the agent continues
    expect(list()).toEqual([]);
  });

  it('lists a blocked agent even when the user was looking at its tab when it started waiting', () => {
    const { n, env, list } = setup();
    env.looking.add('A');
    const a = tab(n, 'A');
    a.report('state=working');
    a.report('state=blocked:kind=question');
    expect(list()).toEqual(['A:question']);
  });

  it('a changed reason replaces the item and restarts its waiting time; a repeat does not', async () => {
    const { n } = setup();
    const a = tab(n, 'A');
    a.report('state=blocked:kind=permission');
    const first = n.inbox()[0]!.since;
    await vi.advanceTimersByTimeAsync(5000);
    a.report('state=blocked:kind=permission');
    expect(n.inbox()[0]!.since).toBe(first);
    a.report('state=blocked:kind=question');
    expect(n.inbox()).toHaveLength(1);
    expect(n.inbox()[0]).toMatchObject({ kind: 'question', since: first + 5000 });
  });

  it('a finished turn is listed after the settle time, until the user looks at the tab', async () => {
    const { n, env, list } = setup();
    const a = tab(n, 'A');
    a.report('state=working');
    a.report('state=done');
    expect(list()).toEqual([]); // not yet: it may work again
    await vi.advanceTimersByTimeAsync(DONE_SETTLE_MS);
    expect(list()).toEqual(['A:done']);
    env.looking.add('A');
    n.reviewSeen();
    expect(list()).toEqual([]);
  });

  it('a turn that finishes while the user watches it is not listed; neither is one that works again at once', async () => {
    const { n, env, list } = setup();
    env.looking.add('A');
    const a = tab(n, 'A');
    a.report('state=working');
    a.report('state=done');
    await vi.advanceTimersByTimeAsync(DONE_SETTLE_MS);
    expect(list()).toEqual([]);
    const b = tab(n, 'B');
    b.report('state=working');
    b.report('state=done');
    b.report('state=working');
    await vi.advanceTimersByTimeAsync(DONE_SETTLE_MS * 2);
    expect(list()).toEqual([]);
  });

  it('an unseen finished turn leaves when the agent works again, and stays when the agent exits', async () => {
    const { n, list } = setup();
    const a = tab(n, 'A');
    a.report('state=done');
    await vi.advanceTimersByTimeAsync(DONE_SETTLE_MS);
    expect(list()).toEqual(['A:done']);
    a.report('state=working');
    expect(list()).toEqual([]);
    const b = tab(n, 'B');
    b.report('state=done');
    await vi.advanceTimersByTimeAsync(DONE_SETTLE_MS);
    b.exit();
    expect(list()).toEqual(['B:done']);
  });

  it('a blocked agent that exits leaves the inbox; an error stays until seen', () => {
    const { n, env, list } = setup();
    const a = tab(n, 'A');
    a.report('state=blocked:kind=permission');
    a.exit();
    expect(list()).toEqual([]);
    const b = tab(n, 'B');
    b.report('state=error');
    b.exit();
    expect(list()).toEqual(['B:error']);
    env.looking.add('B');
    n.reviewSeen();
    expect(list()).toEqual([]);
  });

  it('order: blocked agents first (longest-waiting first), then errors, then finished', async () => {
    const { n, list } = setup();
    const done = tab(n, 'D');
    done.report('state=done');
    await vi.advanceTimersByTimeAsync(DONE_SETTLE_MS);
    tab(n, 'E').report('state=error');
    await vi.advanceTimersByTimeAsync(1000);
    tab(n, 'P1').report('state=blocked:kind=permission');
    await vi.advanceTimersByTimeAsync(1000);
    tab(n, 'P2').report('state=blocked:kind=question');
    expect(list()).toEqual(['P1:permission', 'P2:question', 'E:error', 'D:done']);
  });

  it('the "next agent" shortcut starts with the first and walks through all of them, skipping none', () => {
    const item = (tabId: string, kind: InboxItem['kind'], since: number) => ({ tabId, workspaceId: 'w', kind, since, view: {} as AgentView });
    const items = [item('D', 'done', 1), item('P2', 'question', 20), item('P1', 'permission', 10)];
    expect(sortInbox(items).map((i) => i.tabId)).toEqual(['P1', 'P2', 'D']);
    expect(nextInboxItem(items, null)?.tabId).toBe('P1');
    expect(nextInboxItem(items, 'other-tab')?.tabId).toBe('P1');
    expect(nextInboxItem(items, 'P1')?.tabId).toBe('P2');
    expect(nextInboxItem(items, 'P2')?.tabId).toBe('D');
    expect(nextInboxItem(items, 'D')?.tabId).toBe('P1');
    expect(nextInboxItem([item('P1', 'permission', 1)], 'P1')).toBeNull(); // already there, nothing else waits
    expect(nextInboxItem([], null)).toBeNull();
  });

  it('follows the notification settings: a kind that is turned off is not listed', async () => {
    const { n, list } = setup({ notifyFinished: false, notifyNeedsYou: false });
    const a = tab(n, 'A');
    a.report('state=blocked:kind=permission');
    a.report('state=working');
    a.report('state=done');
    await vi.advanceTimersByTimeAsync(DONE_SETTLE_MS);
    expect(list()).toEqual([]);
    tab(n, 'B').report('state=error');
    expect(list()).toEqual(['B:error']);
  });

  it('a closed tab leaves the inbox, and every change is announced', () => {
    const { n, env, list } = setup();
    tab(n, 'A').report('state=blocked:kind=permission');
    tab(n, 'B').report('state=error');
    const before = env.changes;
    expect(before).toBe(2);
    n.retain(new Set(['B']));
    expect(list()).toEqual(['B:error']);
    expect(env.changes).toBe(before + 1);
  });

  it('recorded Claude Code run: "needs permission" while it waits, then "finished", kept after Claude exits', async () => {
    const { n, list } = setup();
    const seen: string[] = [];
    const a = tab(n, 'A');
    const rows = recording('claude-code');
    for (const r of rows) {
      await a.replay([r]);
      const now = list().join(',');
      if (seen.at(-1) !== now) seen.push(now);
    }
    await vi.advanceTimersByTimeAsync(DONE_SETTLE_MS + 1000);
    const end = list().join(',');
    if (seen.at(-1) !== end) seen.push(end);
    expect(seen).toEqual(['', 'A:permission', '', 'A:done']);
  });

  it('recorded Codex runs: start-up lists nothing; a task lists "needs permission", then "finished" although `done` becomes `idle`', async () => {
    const start = setup();
    await tab(start.n, 'S', 'codex').replay(recording('codex-0.166.0 startup'));
    await vi.advanceTimersByTimeAsync(5000);
    expect(start.list()).toEqual([]);

    const { n, list } = setup();
    const seen: string[] = [];
    const a = tab(n, 'A', 'codex');
    for (const r of recording('codex-0.166.0 task')) {
      await a.replay([r]);
      const now = list().join(',');
      if (seen.at(-1) !== now) seen.push(now);
    }
    await vi.advanceTimersByTimeAsync(DONE_SETTLE_MS + 1000);
    const end = list().join(',');
    if (seen.at(-1) !== end) seen.push(end);
    expect(seen).toEqual(['', 'A:permission', '', 'A:done']);
  });
});

describe('agent inbox: button and rows', () => {
  it('says how long an agent has waited in short words', () => {
    expect([0, 59_000, 60_000, 59 * 60_000, 60 * 60_000, 23 * 3_600_000, 49 * 3_600_000, -5].map(waitedLabel)).toEqual(['now', 'now', '1 min', '59 min', '1 h', '23 h', '2 d', 'now']);
  });

  it('names the button after what is waiting', () => {
    expect(inboxLabel([])).toBe('Agent inbox: no agents are waiting');
    expect(inboxLabel([{ kind: 'permission' }])).toBe('Agent inbox: 1 needs you');
    expect(inboxLabel([{ kind: 'permission' }, { kind: 'question' }, { kind: 'done' }, { kind: 'error' }])).toBe('Agent inbox: 2 need you, 2 to look at');
    expect(inboxLabel([{ kind: 'done' }])).toBe('Agent inbox: 1 to look at');
  });
});
