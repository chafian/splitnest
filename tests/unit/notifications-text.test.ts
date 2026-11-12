import { describe, expect, it } from 'vitest';
import { kindEnabled, noticeAgentLabel, noticeBody, noticeTitle, parseAgentNotice, plainText } from '../../src/shared/notifications';
import { DEFAULT_SETTINGS } from '../../src/shared/types';
import { isId } from '../../src/shared/validation';

describe('notification text', () => {
  it("titles are SplitNest's own wording", () => {
    expect(noticeTitle('permission', 'Claude Code')).toBe('Claude Code needs permission');
    expect(noticeTitle('question', 'Codex')).toBe('Codex has a question');
    expect(noticeTitle('auth', 'Codex')).toBe('Codex needs sign-in');
    expect(noticeTitle('needs-you', 'Claude Code')).toBe('Claude Code needs you');
    expect(noticeTitle('maybe', 'Aider')).toBe('Aider may need you');
    expect(noticeTitle('done', 'Claude Code')).toBe('Claude Code finished');
    expect(noticeTitle('error', 'Codex')).toBe('Codex stopped with an error');
  });

  it('agent label: known agents by name; other programs by their validated app name', () => {
    expect(noticeAgentLabel('claude', 'codex')).toBe('Claude Code');
    expect(noticeAgentLabel(null, 'my-tool')).toBe('my-tool');
    expect(noticeAgentLabel(null, 'bad name!')).toBe('An agent');
    expect(noticeAgentLabel(null, null)).toBe('An agent');
  });

  it('second line: workspace and the name the user gave the tab; else the agent; session title and message only with details', () => {
    const base = { workspace: 'car-rental', label: 'Claude Code', session: 'Fix login: password is hunter2', message: 'Allow rm -rf build?' };
    expect(noticeBody({ ...base, tabName: 'Backend', details: false })).toBe('car-rental · Backend');
    expect(noticeBody({ ...base, tabName: null, details: false })).toBe('car-rental · Claude Code');
    expect(noticeBody({ ...base, tabName: null, details: true })).toBe('car-rental · Fix login: password is hunter2\nAllow rm -rf build?');
    expect(noticeBody({ ...base, tabName: 'Backend', details: true })).toBe('car-rental · Backend\nAllow rm -rf build?');
    expect(noticeBody({ ...base, workspace: null, tabName: null, details: false })).toBe('Claude Code');
  });

  it('plain text: control and direction characters removed, whitespace collapsed, length capped', () => {
    expect(plainText('a\u001b[2Jb\nc‮d', 50)).toBe('a [2Jb cd');
    expect(plainText('   ', 10)).toBeNull();
    expect(plainText('x'.repeat(20), 10)).toBe(`${'x'.repeat(9)}…`);
    expect(plainText('🙂'.repeat(5), 3)).toBe('🙂🙂…');
  });

  it('kinds follow their settings (estimated ones need both switches)', () => {
    const s = { ...DEFAULT_SETTINGS };
    expect(['permission', 'done', 'error', 'maybe'].map((k) => kindEnabled(k as never, s))).toEqual([true, true, true, false]);
    expect(kindEnabled('maybe', { ...s, notifyEstimated: true })).toBe(true);
    expect(kindEnabled('maybe', { ...s, notifyEstimated: true, notifyNeedsYou: false })).toBe(false);
    expect(kindEnabled('question', { ...s, notifyNeedsYou: false })).toBe(false);
  });
});

describe('what main accepts from the page', () => {
  const ok = { workspaceId: 'w1', tabId: 't1', kind: 'permission', agent: 'claude', app: 'claude-code', details: false, session: null, message: null };
  it('a well-formed notice', () => {
    expect(parseAgentNotice(ok, isId)).toEqual(ok);
    expect(parseAgentNotice({ ...ok, agent: null, app: null }, isId)).toMatchObject({ agent: null, app: null });
  });
  it('anything else is refused whole', () => {
    for (const bad of [
      null,
      'x',
      { ...ok, workspaceId: '../x' },
      { ...ok, tabId: 'a'.repeat(65) },
      { ...ok, kind: 'urgent' },
      { ...ok, agent: 'skynet' },
      { ...ok, app: 'two words' },
      { ...ok, session: 5 },
      { ...ok, message: 'x'.repeat(5000) },
    ]) {
      expect(parseAgentNotice(bad, isId)).toBeNull();
    }
  });
});
