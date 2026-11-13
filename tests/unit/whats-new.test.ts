import { describe, expect, it } from 'vitest';
import { compareVersions, releaseNotesUrl, whatsNewDecision } from '../../src/renderer/features/updates/whats-new';
import { DEFAULT_SETTINGS, SCHEMA_VERSION } from '../../src/shared/types';
import { parsePersistedState } from '../../src/shared/validation';

describe("what's new", () => {
  it('orders versions like semver', () => {
    expect(compareVersions('0.2.1', '0.2.0')).toBe(1);
    expect(compareVersions('0.10.0', '0.9.9')).toBe(1);
    expect(compareVersions('1.0.0', '1.0.0')).toBe(0);
    expect(compareVersions('0.3.0-beta.1', '0.3.0')).toBe(-1);
    expect(compareVersions('0.3.0-beta.2', '0.3.0-beta.1')).toBe(1);
    expect(compareVersions('0.3.0-beta.10', '0.3.0-beta.9')).toBe(1);
    expect(compareVersions('0.3.0-rc.1', '0.3.0-beta.5')).toBe(1);
    expect(compareVersions('0.3.0-beta', '0.3.0-beta.1')).toBe(-1);
    expect(compareVersions('x', '0.1.0')).toBeNaN();
  });

  it('shows the notice once after updating to a newer version', () => {
    expect(whatsNewDecision({ lastVersionSeen: '0.2.0', updateNoticeSeen: true }, '0.2.1')).toEqual({ kind: 'show', version: '0.2.1' });
    expect(whatsNewDecision({ lastVersionSeen: '0.2.1', updateNoticeSeen: true }, '0.2.1')).toEqual({ kind: 'none' });
  });

  it('shows it after updating from 0.2.0, which did not save the version', () => {
    expect(whatsNewDecision({ lastVersionSeen: null, updateNoticeSeen: true }, '0.2.1')).toEqual({ kind: 'show', version: '0.2.1' });
  });

  it('stays quiet on a first install, a downgrade and odd versions', () => {
    expect(whatsNewDecision({ lastVersionSeen: null, updateNoticeSeen: false }, '0.2.1')).toEqual({ kind: 'record', version: '0.2.1' });
    expect(whatsNewDecision({ lastVersionSeen: '0.3.0', updateNoticeSeen: true }, '0.2.1')).toEqual({ kind: 'record', version: '0.2.1' });
    expect(whatsNewDecision({ lastVersionSeen: '0.2.1', updateNoticeSeen: true }, 'dev')).toEqual({ kind: 'none' });
  });

  it('links to the release on GitHub', () => {
    expect(releaseNotesUrl('0.2.1')).toBe('https://github.com/chafian/splitnest/releases/tag/v0.2.1');
    expect(releaseNotesUrl('../x')).toBe('https://github.com/chafian/splitnest/releases');
  });

  it('keeps a valid saved version and drops anything else', () => {
    const parse = (v: unknown) => {
      const r = parsePersistedState({ schemaVersion: SCHEMA_VERSION, workspaces: [], activeWorkspaceId: null, settings: { ...DEFAULT_SETTINGS, lastVersionSeen: v } });
      return r.ok ? r.state.settings.lastVersionSeen : 'invalid';
    };
    expect(parse('0.2.1')).toBe('0.2.1');
    expect(parse('0.3.0-beta.1')).toBe('0.3.0-beta.1');
    expect(parse('<script>')).toBe(null);
    expect(parse(5)).toBe(null);
    expect(DEFAULT_SETTINGS.lastVersionSeen).toBe(null);
  });
});
