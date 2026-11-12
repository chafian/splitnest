import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { listDirectory, resolveInsideRoot, sortEntries } from '../../src/main/file-explorer';
import { allIconNames, fileIconName, folderIconName } from '../../src/renderer/features/explorer/file-icons';
import { parentOf, quotePosix, quotePowerShell, terminalPathText, toWindowsPath } from '../../src/renderer/features/explorer/paths';

const ROOT = 'C:\\code\\proj';

describe('explorer path confinement', () => {
  it('resolves nested relative paths with either separator', () => {
    expect(resolveInsideRoot(ROOT, '')).toBe(ROOT);
    expect(resolveInsideRoot(ROOT, 'src/main')).toBe('C:\\code\\proj\\src\\main');
    expect(resolveInsideRoot(ROOT, 'src\\main\\')).toBe('C:\\code\\proj\\src\\main');
    expect(resolveInsideRoot(ROOT, "it's & ünï ⚡")).toBe("C:\\code\\proj\\it's & ünï ⚡");
  });

  it.each([
    '..',
    '../secret',
    'src/../../x',
    './src',
    'C:\\Windows',
    'C:/Windows',
    '\\\\server\\share',
    'file.txt:stream',
    'a\u0000b',
    'x'.repeat(5000),
    42,
    null,
  ])('rejects %j', (bad) => {
    expect(resolveInsideRoot(ROOT, bad)).toBeNull();
  });

  it('sorts folders first, then names naturally and case-insensitively', () => {
    const sorted = sortEntries([
      { name: 'b10.ts', kind: 'file', symlink: false },
      { name: 'B2.ts', kind: 'file', symlink: false },
      { name: 'zeta', kind: 'directory', symlink: false },
      { name: 'Alpha', kind: 'directory', symlink: false },
      { name: 'a.ts', kind: 'file', symlink: false },
    ]);
    expect(sorted.map((e) => e.name)).toEqual(['Alpha', 'zeta', 'a.ts', 'B2.ts', 'b10.ts']);
  });
});

describe.skipIf(process.platform !== 'win32')('listDirectory on a real folder', () => {
  let root: string;
  beforeAll(() => {
    root = mkdtempSync(path.join(tmpdir(), 'tw-explorer-'));
    mkdirSync(path.join(root, 'src'));
    mkdirSync(path.join(root, "dir 'q' & ⚡"));
    writeFileSync(path.join(root, 'package.json'), '{}');
    writeFileSync(path.join(root, 'src', 'index.ts'), '');
    // A junction (no admin rights needed) pointing at src.
    execFileSync('cmd.exe', ['/d', '/c', 'mklink', '/J', path.join(root, 'link'), path.join(root, 'src')], { stdio: 'ignore' });
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it('lists names and kinds, directories first, marking links', async () => {
    const result = await listDirectory(root, '');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.entries).toEqual([
      { name: "dir 'q' & ⚡", kind: 'directory', symlink: false },
      { name: 'link', kind: 'directory', symlink: true },
      { name: 'src', kind: 'directory', symlink: false },
      { name: 'package.json', kind: 'file', symlink: false },
    ]);
    expect(result.truncated).toBe(false);
  });

  it('lists subfolders and reports missing ones and escapes', async () => {
    expect(await listDirectory(root, 'src')).toMatchObject({ ok: true, entries: [{ name: 'index.ts', kind: 'file' }] });
    expect(await listDirectory(root, 'nope')).toMatchObject({ ok: false, error: { code: 'FOLDER_MISSING' } });
    expect(await listDirectory(root, 'package.json')).toMatchObject({ ok: false, error: { code: 'FOLDER_MISSING' } });
    expect(await listDirectory(root, '../')).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } });
  });
});

describe('file icons', () => {
  it('maps file names, patterns, extensions and defaults', () => {
    expect(fileIconName('package.json')).toBe('nodejs');
    expect(fileIconName('README.md')).toBe('readme');
    expect(fileIconName('layout.test.ts')).toBe('test-ts');
    expect(fileIconName('forge.env.d.ts')).toBe('typescript-def');
    expect(fileIconName('vite.main.config.ts')).toBe('vite');
    expect(fileIconName('vitest.config.mts')).toBe('vitest');
    expect(fileIconName('App.tsx')).toBe('react_ts');
    expect(fileIconName('main.ts')).toBe('typescript');
    expect(fileIconName('build.PS1')).toBe('powershell');
    expect(fileIconName('Makefile')).toBe('makefile');
    expect(fileIconName('.env.production')).toBe('tune');
    expect(fileIconName('noext')).toBe('document');
    expect(fileIconName('weird.')).toBe('document');
    expect(folderIconName('src')).toBe('folder-src');
    expect(folderIconName('.github')).toBe('folder-github');
    expect(folderIconName('Node_Modules')).toBe('folder-node');
    expect(folderIconName('random')).toBe('folder-base');
  });

  it('bundles an SVG for every icon the map can produce', () => {
    const dir = path.join(process.cwd(), 'src', 'renderer', 'assets', 'file-icons');
    const missing = [...allIconNames()].filter((n) => !existsSync(path.join(dir, `${n}.svg`)));
    expect(missing).toEqual([]);
    expect(existsSync(path.join(dir, 'LICENSE'))).toBe(true);
  });
});

describe('inserting paths into terminals', () => {
  it('quotes for PowerShell without expansion', () => {
    expect(quotePowerShell("C:\\it's $HOME `x`")).toBe("'C:\\it''s $HOME `x`'");
    expect(terminalPathText({ shell: 'powershell', workspaceRoot: 'C:\\p\\', relativePath: 'src/a b.ts' })).toBe("'C:\\p\\src\\a b.ts'");
  });

  it('quotes for POSIX shells and prefers the mapped Linux root', () => {
    expect(quotePosix("it's $(rm -rf ~)")).toBe(`'it'\\''s $(rm -rf ~)'`);
    expect(terminalPathText({ shell: 'wsl', workspaceRoot: 'C:\\p', relativePath: 'src/x.ts', linuxRoot: '/mnt/c/p' })).toBe("'/mnt/c/p/src/x.ts'");
    expect(terminalPathText({ shell: 'wsl', workspaceRoot: 'C:\\p', relativePath: 'src/x.ts', linuxRoot: '~ (Ubuntu home)' })).toBe("'src/x.ts'");
    expect(terminalPathText({ shell: 'wsl', workspaceRoot: 'C:\\p', relativePath: '', linuxRoot: null })).toBe("'.'");
  });

  it('builds Windows paths and parents', () => {
    expect(toWindowsPath('C:\\p', '')).toBe('C:\\p');
    expect(toWindowsPath('C:\\p\\', 'a/b')).toBe('C:\\p\\a\\b');
    expect(parentOf('a/b/c')).toBe('a/b');
    expect(parentOf('a')).toBe('');
  });
});
