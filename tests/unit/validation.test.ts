import { describe, expect, it } from 'vitest';
import { emptyState, LIMITS } from '../../src/shared/types';
import {
  isAbsoluteWindowsPath,
  isAllowedExternalUrl,
  isProfileId,
  parsePersistedState,
  validateCreateSessionRequest,
} from '../../src/shared/validation';

const workspace = (over: Record<string, unknown> = {}) => ({
  id: 'w1',
  name: 'Project',
  rootPath: 'C:\\code\\project',
  layout: { type: 'pane', id: 'p1', profileId: 'pwsh' },
  activePaneId: 'p1',
  ...over,
});

const state = (over: Record<string, unknown> = {}) => ({ ...emptyState(), workspaces: [workspace()], activeWorkspaceId: 'w1', ...over });

describe('persisted state validation', () => {
  it('accepts a valid state', () => {
    const result = parsePersistedState(state());
    expect(result.ok).toBe(true);
  });

  it('reports unsupported schema versions separately', () => {
    const result = parsePersistedState({ ...state(), schemaVersion: 99 });
    expect(result).toMatchObject({ ok: false, unsupportedVersion: 99 });
  });

  it.each([
    ['non-object', 'nope'],
    ['missing workspaces', { schemaVersion: 1 }],
    ['relative root path', state({ workspaces: [workspace({ rootPath: 'relative\\dir' })] })],
    ['bad id', state({ workspaces: [workspace({ id: '../etc' })] })],
    ['duplicate workspace ids', state({ workspaces: [workspace(), workspace()] })],
    ['unknown profile id', state({ workspaces: [workspace({ layout: { type: 'pane', id: 'p1', profileId: 'cmd; rm -rf /' } })] })],
    [
      'split with one child',
      state({ workspaces: [workspace({ layout: { type: 'split', id: 's', direction: 'row', children: [{ type: 'pane', id: 'p1', profileId: 'pwsh' }], sizes: [1] } })] }),
    ],
    [
      'negative size',
      state({
        workspaces: [
          workspace({
            layout: {
              type: 'split',
              id: 's',
              direction: 'row',
              children: [
                { type: 'pane', id: 'p1', profileId: 'pwsh' },
                { type: 'pane', id: 'p2', profileId: 'pwsh' },
              ],
              sizes: [-1, 2],
            },
          }),
        ],
      }),
    ],
    ['empty name', state({ workspaces: [workspace({ name: '   ' })] })],
  ])('rejects %s', (_label, raw) => {
    expect(parsePersistedState(raw).ok).toBe(false);
  });

  it('rejects layouts nested deeper than the limit', () => {
    let node: Record<string, unknown> = { type: 'pane', id: 'leaf0', profileId: 'pwsh' };
    for (let i = 0; i < LIMITS.maxLayoutDepth + 1; i++) {
      node = { type: 'split', id: `s${i}`, direction: 'row', children: [node, { type: 'pane', id: `x${i}`, profileId: 'pwsh' }], sizes: [0.5, 0.5] };
    }
    expect(parsePersistedState(state({ workspaces: [workspace({ layout: node })] })).ok).toBe(false);
  });

  it('clamps settings instead of rejecting them and repairs dangling references', () => {
    const result = parsePersistedState(
      state({
        activeWorkspaceId: 'missing',
        settings: { fontSize: 400, scrollback: -5, startShellsOnRestore: 'yes', defaultProfileId: 'evil' },
        workspaces: [workspace({ activePaneId: 'gone' })],
      }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.state.settings).toMatchObject({
      fontSize: LIMITS.fontSize.max,
      scrollback: LIMITS.scrollback.min,
      startShellsOnRestore: false,
      defaultProfileId: null,
    });
    expect(result.state.activeWorkspaceId).toBe('w1');
    expect(result.state.workspaces[0]!.activePaneId).toBe('p1');
  });
});

describe('input validators', () => {
  it('recognises profile ids', () => {
    expect(isProfileId('pwsh')).toBe(true);
    expect(isProfileId('windows-powershell')).toBe(true);
    expect(isProfileId('wsl:Ubuntu-22.04')).toBe(true);
    expect(isProfileId('wsl:')).toBe(false);
    expect(isProfileId('wsl:a b')).toBe(false);
    expect(isProfileId('cmd')).toBe(false);
  });

  it('accepts absolute Windows paths with spaces, unicode, apostrophes and metacharacters', () => {
    expect(isAbsoluteWindowsPath("C:\\Users\\me\\proj with space 'quote' $HOME;&`x`(1)!%PATH%^ ünï⚡")).toBe(true);
    expect(isAbsoluteWindowsPath('\\\\server\\share\\dir')).toBe(true);
    expect(isAbsoluteWindowsPath('\\\\wsl.localhost\\Ubuntu\\home\\me')).toBe(true);
    expect(isAbsoluteWindowsPath('relative')).toBe(false);
    expect(isAbsoluteWindowsPath('C:\\bad\nline')).toBe(false);
    expect(isAbsoluteWindowsPath('C:\\' + 'x'.repeat(LIMITS.maxPathLength))).toBe(false);
  });

  it('validates session creation requests including numeric bounds', () => {
    const ok = { workspaceId: 'w1', paneId: 'p1', profileId: 'pwsh', startIn: 'workspace-root', cols: 80, rows: 24 };
    expect(validateCreateSessionRequest(ok)).toEqual({ ...ok, shortPrompt: false });
    expect(() => validateCreateSessionRequest({ ...ok, cols: 0 })).toThrow();
    expect(() => validateCreateSessionRequest({ ...ok, rows: 1e9 })).toThrow();
    expect(() => validateCreateSessionRequest({ ...ok, cols: 80.5 })).toThrow();
    expect(() => validateCreateSessionRequest({ ...ok, profileId: 'C:\\evil.exe' })).toThrow();
    expect(() => validateCreateSessionRequest({ ...ok, startIn: '/etc' })).toThrow();
    expect(() => validateCreateSessionRequest({ ...ok, workspaceId: 'x'.repeat(65) })).toThrow();
    expect(() => validateCreateSessionRequest(null)).toThrow();
  });

  it('allows only http(s) external URLs', () => {
    expect(isAllowedExternalUrl('https://example.com/a?b')).toBe(true);
    expect(isAllowedExternalUrl('http://localhost:3000')).toBe(true);
    for (const bad of ['file:///C:/Windows/System32/calc.exe', 'javascript:alert(1)', 'ms-settings:', 'vscode://x', 'not a url', 42]) {
      expect(isAllowedExternalUrl(bad)).toBe(false);
    }
  });
});
