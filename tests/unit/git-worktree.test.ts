import { describe, expect, it } from 'vitest';
import {
  fromGitPath,
  isStrictlyInside,
  parseGitVersion,
  parseLeftRight,
  parseWorktreeList,
  parseNameStatus,
  parseNumstat,
  parsePaths,
  isSafeRelative,
  removeRefusal,
  samePath,
  suffixed,
  taskBranch,
  taskSlug,
  versionAtLeast,
  worktreesDir,
} from '../../src/main/git-worktree';
import { isTaskName } from '../../src/shared/tasks';

describe('task names', () => {
  it('accepts 1–80 characters after trimming, without control characters', () => {
    expect(isTaskName('Fix the login form')).toBe(true);
    expect(isTaskName('  x  ')).toBe(true);
    expect(isTaskName('a'.repeat(80))).toBe(true);
    expect(isTaskName('a'.repeat(81))).toBe(false);
    expect(isTaskName('   ')).toBe(false);
    expect(isTaskName('')).toBe(false);
    expect(isTaskName('a\nb')).toBe(false);
    expect(isTaskName('a\u0007')).toBe(false);
    expect(isTaskName(42)).toBe(false);
    expect(isTaskName(null)).toBe(false);
  });

  it('slugs are lowercase ASCII letters, digits and single hyphens', () => {
    expect(taskSlug('Fix the login form!')).toBe('fix-the-login-form');
    expect(taskSlug('  --Add   API v2__tests--  ')).toBe('add-api-v2-tests');
    expect(taskSlug('Café résumé')).toBe('cafe-resume');
    expect(taskSlug('../../etc/passwd')).toBe('etc-passwd');
    expect(taskSlug('C:\\Windows\\System32')).toBe('c-windows-system32');
    expect(taskSlug('feature/branch.lock')).toBe('feature-branch-lock');
  });

  it('a name with nothing usable has no slug', () => {
    expect(taskSlug('!!!')).toBeNull();
    expect(taskSlug('日本語')).toBeNull();
    expect(taskSlug('---')).toBeNull();
  });

  it('slugs are at most 40 characters and never end with a hyphen', () => {
    const s = taskSlug('a'.repeat(39) + ' bcd')!;
    expect(s.length).toBeLessThanOrEqual(40);
    expect(s.endsWith('-')).toBe(false);
    expect(taskSlug('x'.repeat(80))).toBe('x'.repeat(40));
  });

  it('device names Windows reserves get a suffix', () => {
    for (const n of ['con', 'NUL', 'Aux', 'prn', 'com1', 'lpt9']) expect(taskSlug(n)).toBe(`${n.toLowerCase()}-task`);
    expect(taskSlug('console')).toBe('console');
  });

  it('suffixes and branches', () => {
    expect(suffixed('fix', 1)).toBe('fix');
    expect(suffixed('fix', 2)).toBe('fix-2');
    expect(taskBranch('fix-2')).toBe('splitnest/fix-2');
  });
});

describe('paths', () => {
  it('task folders go next to the main worktree', () => {
    expect(worktreesDir('C:\\code\\app')).toBe('C:\\code\\app.worktrees');
    expect(worktreesDir('C:/code/app/')).toBe('C:\\code\\app.worktrees');
    expect(worktreesDir('C:\\My Projects\\web app')).toBe('C:\\My Projects\\web app.worktrees');
    expect(worktreesDir('\\\\server\\share\\repo')).toBe('\\\\server\\share\\repo.worktrees');
  });

  it('a repository at a drive or share root has no folder next to it', () => {
    expect(worktreesDir('C:\\')).toBeNull();
    expect(worktreesDir('C:/')).toBeNull();
    expect(worktreesDir('\\\\server\\share\\')).toBeNull();
  });

  it('Git paths in Windows form', () => {
    expect(fromGitPath('C:/Users/me/app')).toBe('C:\\Users\\me\\app');
    expect(fromGitPath('C:/Users/me/app/')).toBe('C:\\Users\\me\\app');
    expect(fromGitPath('//server/share/app')).toBe('\\\\server\\share\\app');
    expect(fromGitPath('C:/')).toBe('C:\\');
  });

  it('same folder ignores case and separators; inside means strictly inside', () => {
    expect(samePath('C:/Code/App', 'c:\\code\\app\\')).toBe(true);
    expect(samePath('C:\\code\\app', 'C:\\code\\app2')).toBe(false);
    expect(isStrictlyInside('C:\\code\\app.worktrees\\fix', 'C:/code/app.worktrees')).toBe(true);
    expect(isStrictlyInside('C:\\code\\app.worktrees', 'C:\\code\\app.worktrees')).toBe(false);
    expect(isStrictlyInside('C:\\code\\app.worktrees-evil\\x', 'C:\\code\\app.worktrees')).toBe(false);
    expect(isStrictlyInside('C:\\code\\app.worktrees\\..\\app', 'C:\\code\\app.worktrees')).toBe(false);
  });
});

describe('Git output', () => {
  const list = [
    'worktree C:/code/app',
    'HEAD 1111111111111111111111111111111111111111',
    'branch refs/heads/main',
    '',
    'worktree C:/code/app.worktrees/fix',
    'HEAD 2222222222222222222222222222222222222222',
    'branch refs/heads/splitnest/fix',
    'locked',
    '',
    'worktree C:/code/app.worktrees/gone',
    'HEAD 3333333333333333333333333333333333333333',
    'detached',
    'prunable gitdir file points to non-existent location',
    '',
  ];

  it('worktree list, NUL-separated (Git 2.36+)', () => {
    const entries = parseWorktreeList(list.join('\0'), true);
    expect(entries).toEqual([
      { path: 'C:\\code\\app', head: '1'.repeat(40), branch: 'main', bare: false, detached: false, locked: false, prunable: false },
      { path: 'C:\\code\\app.worktrees\\fix', head: '2'.repeat(40), branch: 'splitnest/fix', bare: false, detached: false, locked: true, prunable: false },
      { path: 'C:\\code\\app.worktrees\\gone', head: '3'.repeat(40), branch: null, bare: false, detached: true, locked: false, prunable: true },
    ]);
  });

  it('worktree list, line-separated (older Git), CRLF too', () => {
    expect(parseWorktreeList(list.join('\n'), false)).toEqual(parseWorktreeList(list.join('\0'), true));
    expect(parseWorktreeList(list.join('\r\n'), false)).toEqual(parseWorktreeList(list.join('\0'), true));
  });

  it('a bare main repository, and paths with spaces', () => {
    const e = parseWorktreeList(['worktree C:/repos/app.git', 'bare', '', 'worktree C:/My Projects/x y', 'HEAD ab', 'branch refs/heads/a b', ''].join('\0'), true);
    expect(e[0]).toMatchObject({ bare: true, branch: null });
    expect(e[1]).toMatchObject({ path: 'C:\\My Projects\\x y', branch: 'a b' });
  });

  it('versions', () => {
    expect(parseGitVersion('git version 2.39.0.windows.2')).toEqual([2, 39, 0]);
    expect(parseGitVersion('git version 2.34.1\n')).toEqual([2, 34, 1]);
    expect(parseGitVersion('git version 3.0')).toEqual([3, 0, 0]);
    expect(parseGitVersion('nope')).toBeNull();
    expect(versionAtLeast([2, 39, 0], [2, 36])).toBe(true);
    expect(versionAtLeast([2, 36, 0], [2, 36])).toBe(true);
    expect(versionAtLeast([2, 34, 1], [2, 36])).toBe(false);
    expect(versionAtLeast([3, 0, 0], [2, 38])).toBe(true);
    expect(versionAtLeast(null, [2, 36])).toBe(false);
  });

  it('why worktree remove refused', () => {
    expect(removeRefusal("fatal: 'C:/x' contains modified or untracked files, use --force to delete it")).toBe('dirty');
    expect(removeRefusal("fatal: cannot remove a locked working tree;\nuse 'remove -f -f' to override or unlock first")).toBe('locked');
    expect(removeRefusal('error: failed to delete')).toBeNull();
  });

  it('left/right counts', () => {
    expect(parseLeftRight('2\t5\n')).toEqual([2, 5]);
    expect(parseLeftRight('0 0')).toEqual([0, 0]);
    expect(parseLeftRight('x')).toBeNull();
  });
});

describe('review output', () => {
  it('name-status with renames and copies', () => {
    expect(parseNameStatus(['M', 'a.txt', 'R087', 'old name.txt', 'new name.txt', 'D', 'gone', 'C100', 'x', 'y', 'A', 'src/n.js', ''].join('\0'))).toEqual([
      { status: 'M', path: 'a.txt' },
      { status: 'R', path: 'new name.txt', oldPath: 'old name.txt' },
      { status: 'D', path: 'gone' },
      { status: 'C', path: 'y', oldPath: 'x' },
      { status: 'A', path: 'src/n.js' },
    ]);
  });

  it('numstat: counts, binary files, renames', () => {
    const m = parseNumstat(['1\t0\ta.txt', '-\t-\tlogo.bin', '0\t0\t', 'old name.txt', 'new name.txt', '3\t2\tsrc/n.js', ''].join('\0'));
    expect([...m.entries()]).toEqual([
      ['a.txt', { added: 1, removed: 0 }],
      ['logo.bin', { added: null, removed: null }],
      ['new name.txt', { added: 0, removed: 0 }],
      ['src/n.js', { added: 3, removed: 2 }],
    ]);
  });

  it('path lists and which paths may go back to Git', () => {
    expect(parsePaths('a\0b c\0\0')).toEqual(['a', 'b c']);
    for (const ok of ['a.txt', 'src/x y.js', '*.txt', '.github/ci.yml']) expect(isSafeRelative(ok)).toBe(true);
    for (const bad of ['', '/etc', 'C:/x', 'a\\b', '../x', 'a/../b', 'a//b', './a', 'a/', ':(glob)x', 'a\0b']) expect(isSafeRelative(bad)).toBe(false);
  });
});
