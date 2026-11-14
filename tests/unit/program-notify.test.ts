import { describe, expect, it } from 'vitest';
import { KittyNotices, parseOsc777, parseOsc9 } from '../../src/renderer/features/terminal/program-notify';
import { AgentNotifier, MESSAGE_LIMIT, MESSAGE_MERGE_MS, type AgentEvent, type NotifySettings, type Where } from '../../src/renderer/features/notifications/agent-notifier';
import type { AgentView } from '../../src/renderer/features/terminal/agent-status';
import { installCommandScripts, pathWith, SPLITNEST_CMD, SPLITNEST_PS1, SPLITNEST_SH } from '../../src/main/command-scripts';
import { buildLaunch } from '../../src/main/shells';
import { kindEnabled, noticeTitle } from '../../src/shared/notifications';

const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64');

describe('notification escape codes', () => {
  it('OSC 9: an iTerm2 message, never a ConEmu command (Windows Terminal progress, folder)', () => {
    expect(parseOsc9('Codex wants to run a command')).toEqual({ title: null, body: 'Codex wants to run a command' });
    expect(parseOsc9('4;1;50')).toBeNull(); // progress bar
    expect(parseOsc9('4;0')).toBeNull();
    expect(parseOsc9('9;C:\\code')).toBeNull(); // current folder
    expect(parseOsc9('1')).toBeNull();
    expect(parseOsc9('')).toBeNull();
    expect(parseOsc9('2 tests failed')).toEqual({ title: null, body: '2 tests failed' });
  });

  it('OSC 777: notify;title;body, the body may contain ;', () => {
    expect(parseOsc777('notify;Build;Done; 3 warnings')).toEqual({ title: 'Build', body: 'Done; 3 warnings' });
    expect(parseOsc777('notify;;Only a body')).toEqual({ title: null, body: 'Only a body' });
    expect(parseOsc777('notify;Only a title')).toEqual({ title: 'Only a title', body: null });
    expect(parseOsc777('preexec')).toBeNull();
    expect(parseOsc777('notify;;')).toBeNull();
  });

  it('OSC 99: title and body, base64 or plain, in chunks', () => {
    const k = new KittyNotices();
    expect(k.feed(`i=splitnest:d=0:p=title:e=1;${b64('Build ✓')}`)).toBeNull();
    expect(k.feed(`i=splitnest:p=body:e=1;${b64('Tests passed; café 中文')}`)).toEqual({ title: 'Build ✓', body: 'Tests passed; café 中文' });
    expect(k.feed(';Hello')).toEqual({ title: 'Hello', body: null });
    expect(k.feed('i=1:d=0;Hel')).toBeNull();
    expect(k.feed('i=1;lo')).toEqual({ title: 'Hello', body: null });
    expect(k.feed('i=1:p=close;')).toBeNull();
    expect(k.feed('i=1:p=icon;abc')).toBeNull();
  });
});

describe('program messages in the notifier', () => {
  const ON: NotifySettings = { notifyNeedsYou: true, notifyFinished: true, notifyErrors: true, notifyPrograms: true, notifyEstimated: false, notifyWindows: true };
  const view = (over: Partial<AgentView> = {}): AgentView => ({
    id: null,
    label: 'PowerShell',
    state: 'idle',
    kind: null,
    title: null,
    message: 'Tests passed',
    progress: null,
    source: 'protocol',
    attention: false,
    confirmed: true,
    ...over,
  });
  function setup(settings: Partial<NotifySettings> = {}) {
    let now = 1_000_000;
    const events: (AgentEvent & { where: Where })[] = [];
    const env = { focused: true, looking: new Set<string>() };
    const n = new AgentNotifier({
      settings: () => ({ ...ON, ...settings }),
      looking: (id) => env.focused && env.looking.has(id),
      windowFocused: () => env.focused,
      deliver: (e, where) => events.push({ ...e, where }),
      withdraw: () => undefined,
      setTimer: () => 0,
      clearTimer: () => undefined,
      now: () => now,
    });
    return { n, events, env, advance: (ms: number) => (now += ms) };
  }

  it('notifies in the app, or in Windows when SplitNest is in the background, and lists the tab in the inbox', () => {
    const { n, events, env } = setup();
    n.message('t1', 'w1', view());
    expect(events.map((e) => [e.kind, e.where])).toEqual([['message', 'in-app']]);
    expect(n.inbox().map((i) => [i.tabId, i.kind])).toEqual([['t1', 'message']]);
    env.focused = false;
    n.message('t2', 'w1', view());
    expect(events[1]!.where).toBe('windows');
    // Seen: it leaves the inbox.
    env.focused = true;
    env.looking.add('t1');
    n.reviewSeen();
    expect(n.inbox().map((i) => i.tabId)).toEqual(['t2']);
  });

  it('nothing for the tab on screen, nor with the setting off', () => {
    const a = setup();
    a.env.looking.add('t1');
    a.n.message('t1', 'w1', view());
    expect(a.events).toHaveLength(0);
    expect(a.n.inbox()).toHaveLength(0);
    const b = setup({ notifyPrograms: false });
    b.n.message('t1', 'w1', view());
    expect(b.events).toHaveLength(0);
    expect(b.n.inbox()).toHaveLength(0);
  });

  it('one notification per event: a message right after another notice of the tab is dropped', () => {
    const { n, events, advance } = setup();
    n.message('t1', 'w1', view());
    advance(MESSAGE_MERGE_MS - 1);
    n.message('t1', 'w1', view({ message: 'second' }));
    expect(events).toHaveLength(1);
    advance(2);
    n.message('t1', 'w1', view({ message: 'third' }));
    expect(events.map((e) => e.view.message)).toEqual(['Tests passed', 'third']);
  });

  it('at most MESSAGE_LIMIT per tab per minute', () => {
    const { n, events, advance } = setup();
    for (let i = 0; i < MESSAGE_LIMIT.count + 3; i++) {
      n.message('t1', 'w1', view({ message: `m${i}` }));
      advance(MESSAGE_MERGE_MS + 1);
    }
    expect(events).toHaveLength(MESSAGE_LIMIT.count);
    advance(MESSAGE_LIMIT.windowMs);
    n.message('t1', 'w1', view({ message: 'later' }));
    expect(events.at(-1)!.view.message).toBe('later');
  });

  it('keeps a blocked agent in the inbox as blocked', () => {
    const { n } = setup();
    n.update('t1', 'w1', view({ id: 'codex', label: 'Codex', state: 'needs-action', kind: 'permission', message: null }));
    n.message('t1', 'w1', view({ id: 'codex', label: 'Codex' }));
    expect(n.inbox().map((i) => i.kind)).toEqual(['permission']);
  });

  it('is its own kind of notification, with SplitNest wording', () => {
    expect(noticeTitle('message', 'PowerShell')).toBe('PowerShell sent a notification');
    expect(kindEnabled('message', { ...ON, notifyPrograms: false })).toBe(false);
  });
});

describe('the splitnest command', () => {
  it('writes its scripts once and leaves unchanged ones alone', async () => {
    const files = new Map<string, string>();
    const writes: string[] = [];
    const fs = {
      mkdir: async () => undefined,
      readText: async (f: string) => files.get(f) ?? null,
      writeText: async (f: string, t: string) => {
        writes.push(f);
        files.set(f, t);
      },
    };
    const dirs = await installCommandScripts('C:\\Data\\SplitNest\\bin', fs);
    expect(dirs).toEqual({ windows: 'C:\\Data\\SplitNest\\bin\\windows', wsl: 'C:\\Data\\SplitNest\\bin\\wsl' });
    expect(writes).toEqual(['C:\\Data\\SplitNest\\bin\\windows\\splitnest.cmd', 'C:\\Data\\SplitNest\\bin\\windows\\lib\\splitnest.ps1', 'C:\\Data\\SplitNest\\bin\\wsl\\splitnest']);
    await installCommandScripts('C:\\Data\\SplitNest\\bin', fs);
    expect(writes).toHaveLength(3);
    // Line endings each shell needs; the sh script must not contain a CR.
    expect(SPLITNEST_CMD).toContain('\r\n');
    expect(SPLITNEST_SH).not.toContain('\r');
    expect(SPLITNEST_SH.startsWith('#!/bin/sh\n')).toBe(true);
    expect(SPLITNEST_PS1).toContain('${e}]99;i=splitnest${d}:p=${p}:e=1;${b64}${bel}');
  });

  it('appends its folder to PATH once, after the user’s own folders', () => {
    expect(pathWith({ Path: 'C:\\Windows;C:\\Tools' }, 'C:\\bin')).toEqual({ key: 'Path', value: 'C:\\Windows;C:\\Tools;C:\\bin' });
    expect(pathWith({ PATH: 'C:\\bin;C:\\Windows' }, 'c:\\BIN')).toEqual({ key: 'PATH', value: 'C:\\bin;C:\\Windows' });
    expect(pathWith({}, 'C:\\bin')).toEqual({ key: 'Path', value: 'C:\\bin' });
  });

  it('is on the PATH of PowerShell and WSL sessions', () => {
    const path = { key: 'Path', value: 'C:\\Windows;C:\\bin' };
    const ps = buildLaunch({
      profile: { id: 'windows-powershell', kind: 'windows-powershell', label: 'Windows PowerShell' },
      executable: 'powershell.exe',
      workspaceRoot: 'C:\\code',
      startIn: 'workspace-root',
      homeDir: 'C:\\Users\\a',
      path,
    });
    expect(ps.env).toEqual({ Path: 'C:\\Windows;C:\\bin' });
    const wsl = buildLaunch({
      profile: { id: 'wsl:Ubuntu', kind: 'wsl', label: 'Ubuntu', distro: 'Ubuntu' },
      executable: 'wsl.exe',
      workspaceRoot: 'C:\\code',
      startIn: 'home',
      homeDir: 'C:\\Users\\a',
      shortPrompt: true,
      path,
    });
    expect(wsl.env).toMatchObject({ PROMPT_DIRTRIM: '1', Path: 'C:\\Windows;C:\\bin' });
  });
});
