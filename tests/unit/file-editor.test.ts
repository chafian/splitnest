import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { decodeText, encodeText, readTextFile, statTextFile, writeTextFile } from '../../src/main/file-editor';
import { findPaneOfTab, listFileTabs, listPanes, listTerminalTabs } from '../../src/shared/layout';
import { emptyState, LIMITS, SCHEMA_VERSION, type PersistedState } from '../../src/shared/types';
import { normalizeRelativeFilePath, parsePersistedState } from '../../src/shared/validation';
import { detectEol, detectIndent } from '../../src/renderer/features/editor/text-format';
import { languageFor } from '../../src/renderer/features/editor/editor-languages';
import { reducer } from '../../src/renderer/features/workspaces/workspace-state';

const ANY_HASH = '0'.repeat(64);
let root: string;
let outside: string;

beforeAll(() => {
  const base = mkdtempSync(path.join(tmpdir(), 'tw-editor-'));
  root = path.join(base, 'project');
  outside = path.join(base, 'outside');
  mkdirSync(path.join(root, 'src'), { recursive: true });
  mkdirSync(outside);
  writeFileSync(path.join(root, 'src', 'app.ts'), 'const a = 1;\r\nexport default a;\r\n');
  writeFileSync(path.join(root, 'bom.txt'), Buffer.from([0xef, 0xbb, 0xbf, ...Buffer.from('héllo')]));
  writeFileSync(path.join(root, 'wide.txt'), Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('ünï ⚡', 'utf16le')]));
  writeFileSync(path.join(root, 'latin1.txt'), Buffer.from([0x63, 0x61, 0x66, 0xe9])); // "café" in Windows-1252
  writeFileSync(path.join(root, 'image.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0x0d]));
  writeFileSync(path.join(root, 'big.log'), Buffer.alloc(LIMITS.maxEditorFileBytes + 1, 0x61));
  writeFileSync(path.join(outside, 'secret.txt'), 'outside');
  // A junction needs no administrator rights on Windows.
  symlinkSync(outside, path.join(root, 'linked'), 'junction');
});

afterAll(() => rmSync(path.dirname(root), { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));

describe('reading files for the editor', () => {
  it('reads UTF-8 and reports the version (mtime) used for conflict checks', async () => {
    const r = await readTextFile(root, 'src/app.ts');
    expect(r).toMatchObject({ ok: true, content: 'const a = 1;\r\nexport default a;\r\n', encoding: 'utf8', readOnly: null });
  });

  it('keeps BOM and UTF-16 encodings, and opens undecodable text read-only', async () => {
    expect(await readTextFile(root, 'bom.txt')).toMatchObject({ ok: true, content: 'héllo', encoding: 'utf8bom' });
    expect(await readTextFile(root, 'wide.txt')).toMatchObject({ ok: true, content: 'ünï ⚡', encoding: 'utf16le' });
    const latin = await readTextFile(root, 'latin1.txt');
    expect(latin.ok && latin.readOnly).toMatch(/read-only/);
  });

  it('refuses binary, oversized, missing, folder and escaping paths', async () => {
    expect(await readTextFile(root, 'image.png')).toMatchObject({ ok: false, error: { code: 'BINARY_FILE' } });
    expect(await readTextFile(root, 'big.log')).toMatchObject({ ok: false, error: { code: 'FILE_TOO_LARGE' } });
    expect(await readTextFile(root, 'nope.txt')).toMatchObject({ ok: false, error: { code: 'FILE_NOT_FOUND' } });
    expect(await readTextFile(root, 'src')).toMatchObject({ ok: false, error: { code: 'NOT_A_FILE' } });
    for (const bad of ['../outside/secret.txt', 'C:\\Windows\\win.ini', '\\\\server\\share\\x', 'src/app.ts:stream', 'src/../../x']) {
      expect(await readTextFile(root, bad)).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } });
    }
  });

  it('opens a file reached through a junction to outside the workspace read-only', async () => {
    const r = await readTextFile(root, 'linked/secret.txt');
    expect(r.ok && r.readOnly).toMatch(/outside the workspace/);
  });
});

describe('saving files', () => {
  it('saves in place, preserving encoding, and returns the new version', async () => {
    const before = await readTextFile(root, 'wide.txt');
    if (!before.ok) throw new Error('read failed');
    const saved = await writeTextFile(root, { path: 'wide.txt', content: 'edited ⚡', encoding: before.encoding, expectedHash: before.hash });
    expect(saved.ok).toBe(true);
    const bytes = readFileSync(path.join(root, 'wide.txt'));
    expect([bytes[0], bytes[1]]).toEqual([0xff, 0xfe]);
    expect(bytes.subarray(2).toString('utf16le')).toBe('edited ⚡');
  });

  it('detects a change made on disk after opening, and overwrites only when asked', async () => {
    const opened = await readTextFile(root, 'src/app.ts');
    if (!opened.ok) throw new Error('read failed');
    writeFileSync(path.join(root, 'src', 'app.ts'), 'changed by git\n');
    const future = new Date(Date.now() + 5000);
    utimesSync(path.join(root, 'src', 'app.ts'), future, future);
    const conflict = await writeTextFile(root, { path: 'src/app.ts', content: 'mine\n', encoding: 'utf8', expectedHash: opened.hash });
    expect(conflict).toMatchObject({ ok: false, error: { code: 'CONFLICT' } });
    expect(readFileSync(path.join(root, 'src', 'app.ts'), 'utf8')).toBe('changed by git\n');
    const forced = await writeTextFile(root, { path: 'src/app.ts', content: 'mine\n', encoding: 'utf8', expectedHash: opened.hash, overwrite: true });
    expect(forced.ok).toBe(true);
    expect(readFileSync(path.join(root, 'src', 'app.ts'), 'utf8')).toBe('mine\n');
    const stat = await statTextFile(root, 'src/app.ts');
    expect(stat.ok && forced.ok && stat.hash).toBe(forced.ok ? forced.hash : -1);
  });

  it('never creates files, never writes outside the workspace, and validates input', async () => {
    expect(await writeTextFile(root, { path: 'new.txt', content: 'x', encoding: 'utf8', expectedHash: ANY_HASH })).toMatchObject({ ok: false, error: { code: 'FILE_NOT_FOUND' } });
    const link = await readTextFile(root, 'linked/secret.txt');
    const out = await writeTextFile(root, { path: 'linked/secret.txt', content: 'pwned', encoding: 'utf8', expectedHash: link.ok ? link.hash : ANY_HASH });
    expect(out).toMatchObject({ ok: false, error: { code: 'READ_ONLY' } });
    expect(readFileSync(path.join(outside, 'secret.txt'), 'utf8')).toBe('outside');
    expect(await writeTextFile(root, { path: '../outside/secret.txt', content: 'x', encoding: 'utf8', expectedHash: ANY_HASH })).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } });
    expect(await writeTextFile(root, { path: 'bom.txt', content: 'x', encoding: 'latin1' as never, expectedHash: ANY_HASH })).toMatchObject({ ok: false, error: { code: 'INVALID_REQUEST' } });
    expect(await writeTextFile(root, { path: 'bom.txt', content: 'x'.repeat(LIMITS.maxEditorFileBytes + 1), encoding: 'utf8', expectedHash: ANY_HASH })).toMatchObject({ ok: false, error: { code: 'FILE_TOO_LARGE' } });
  });

  it('round-trips encodings', () => {
    for (const encoding of ['utf8', 'utf8bom', 'utf16le'] as const) {
      expect(decodeText(encodeText('a ⚡ é\r\n', encoding))).toEqual({ content: 'a ⚡ é\r\n', encoding, valid: true });
    }
  });
});

describe('editor helpers', () => {
  it('detects line endings and indentation', () => {
    expect(detectEol('a\r\nb\r\n')).toBe('CRLF');
    expect(detectEol('a\nb\n')).toBe('LF');
    expect(detectEol('one line')).toBe('LF');
    expect(detectIndent('{\n    a\n        b\n}')).toBe('    ');
    expect(detectIndent('{\n  a\n    b\n}')).toBe('  ');
    expect(detectIndent('{\n\ta\n\t\tb\n}')).toBe('\t');
  });

  it('picks a language from the file name', () => {
    expect(languageFor('App.tsx').label).toBe('TypeScript JSX');
    expect(languageFor('pom.xml').label).toBe('XML');
    expect(languageFor('Application.java').label).toBe('Java');
    expect(languageFor('Dockerfile').label).toBe('Dockerfile');
    expect(languageFor('.env.local').label).toBe('Env');
    expect(languageFor('build.ps1').label).toBe('PowerShell');
    expect(languageFor('notes').label).toBe('Plain text');
  });
});

describe('file tabs in the layout', () => {
  const ws = { id: 'w', name: 'w', rootPath: 'C:\\code\\w', layout: null, activePaneId: null };
  const base = (): PersistedState => {
    let s = reducer(emptyState(), { type: 'addWorkspace', workspace: ws });
    s = reducer(s, { type: 'addPane', workspaceId: 'w', paneId: 'T', tabId: 't1', splitId: 's1', profileId: 'pwsh' });
    return s;
  };

  it('opens a file in a new pane beside the terminal and adds more files to it', () => {
    let s = reducer(base(), { type: 'addPane', workspaceId: 'w', paneId: 'E', tabId: 'f1', splitId: 's2', profileId: '', filePath: 'src/app.ts', direction: 'row', targetPaneId: 'T' });
    s = reducer(s, { type: 'addTab', workspaceId: 'w', paneId: 'E', tabId: 'f2', profileId: '', filePath: 'package.json' });
    const layout = s.workspaces[0]!.layout;
    expect(listPanes(layout).map((p) => p.id)).toEqual(['T', 'E']);
    expect(listFileTabs(layout)).toEqual([
      { id: 'f1', kind: 'file', path: 'src/app.ts' },
      { id: 'f2', kind: 'file', path: 'package.json' },
    ]);
    expect(listTerminalTabs(layout).map((t) => t.id)).toEqual(['t1']);
    expect(findPaneOfTab(layout, 'f2')!.activeTabId).toBe('f2');
    // Terminal-only actions leave file tabs alone.
    s = reducer(s, { type: 'renameTab', workspaceId: 'w', tabId: 'f1', name: 'X' });
    s = reducer(s, { type: 'setTabProfile', workspaceId: 'w', tabId: 'f1', profileId: 'pwsh' });
    expect(listFileTabs(s.workspaces[0]!.layout)[0]).toEqual({ id: 'f1', kind: 'file', path: 'src/app.ts' });
    // Saved as schema 3 and loads back; contents are never part of the state.
    const json = JSON.parse(JSON.stringify(s));
    const back = parsePersistedState(json);
    expect(back.ok && back.state.schemaVersion).toBe(SCHEMA_VERSION);
    expect(back.ok && listFileTabs(back.state.workspaces[0]!.layout).map((t) => t.path)).toEqual(['src/app.ts', 'package.json']);
  });

  it('rejects unsafe file tab paths in saved state', () => {
    for (const bad of ['../x', 'C:/x', '/etc/passwd', 'a/./b', 'a\u0000b', '', 'x:stream', 'trailing. ']) expect(normalizeRelativeFilePath(bad)).toBeNull();
    expect(normalizeRelativeFilePath('src\\main\\App.java')).toBe('src/main/App.java');
    const state = (tab: object) => ({ ...emptyState(), workspaces: [{ ...ws, layout: { type: 'pane', id: 'p', activeTabId: 't', tabs: [tab] } }] });
    expect(parsePersistedState(state({ id: 't', kind: 'file', path: '../../secret' })).ok).toBe(false);
    expect(parsePersistedState(state({ id: 't', kind: 'weird', profileId: 'pwsh' })).ok).toBe(false);
    expect(parsePersistedState(state({ id: 't', kind: 'file', path: 'src/a.ts' })).ok).toBe(true);
  });

  it('still loads schema 2 files', () => {
    const v2 = { ...emptyState(), schemaVersion: 2, workspaces: [{ ...ws, layout: { type: 'pane', id: 'p', activeTabId: 't', tabs: [{ id: 't', profileId: 'pwsh' }] } }] };
    const r = parsePersistedState(v2);
    expect(r.ok && r.state.schemaVersion).toBe(3);
  });
});
