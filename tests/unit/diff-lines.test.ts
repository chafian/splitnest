import { describe, expect, it } from 'vitest';
import { changeCounts, diffRows } from '../../src/renderer/features/tasks/diff-lines';

const gitDiff = [
  'diff --git a/a.txt b/a.txt',
  'index 5626abf..814f4a4 100644',
  '--- a/a.txt',
  '+++ b/a.txt',
  '@@ -1,3 +1,4 @@ function x() {',
  ' one',
  '-two',
  '+TWO',
  '+three',
  ' four',
  '@@ -10 +11 @@',
  '-last',
  '\\ No newline at end of file',
  '+last',
  '',
].join('\n');

describe('diff rows', () => {
  it('numbers lines on both sides and drops Git’s file header', () => {
    const { rows, hidden } = diffRows(gitDiff);
    expect(hidden).toBe(0);
    expect(rows.map((r) => [r.kind, r.oldNo, r.newNo, r.text])).toEqual([
      ['hunk', null, null, '@@ -1,3 +1,4 @@ function x() {'],
      ['ctx', 1, 1, 'one'],
      ['del', 2, null, 'two'],
      ['add', null, 2, 'TWO'],
      ['add', null, 3, 'three'],
      ['ctx', 3, 4, 'four'],
      ['hunk', null, null, '@@ -10 +11 @@'],
      ['del', 10, null, 'last'],
      ['meta', null, null, '\\ No newline at end of file'],
      ['add', null, 11, 'last'],
    ]);
  });

  it('a line that looks like a header inside a hunk is content', () => {
    const { rows } = diffRows(['@@ -1,2 +1,2 @@', '---- a/x', '++++ b/y', ''].join('\n'));
    expect(rows.slice(1).map((r) => [r.kind, r.text])).toEqual([
      ['del', '--- a/x'],
      ['add', '+++ b/y'],
    ]);
  });

  it('renames and binary files show their header line', () => {
    const text = ['diff --git a/old b/new', 'similarity index 90%', 'rename from old', 'rename to new', 'Binary files a/x and b/x differ', ''].join('\n');
    expect(diffRows(text).rows.map((r) => r.text)).toEqual(['rename from old', 'rename to new', 'Binary files a/x and b/x differ']);
  });

  it('CRLF files: the carriage return is not part of the line', () => {
    expect(diffRows('@@ -1 +1 @@\r\n-a\r\n+b\r\n').rows.map((r) => r.text)).toEqual(['@@ -1 +1 @@', 'a', 'b']);
  });

  it('a new untracked file as main builds it', () => {
    const { rows } = diffRows('@@ -0,0 +1,2 @@\n+# notes\n+first\n');
    expect(rows.map((r) => [r.kind, r.newNo])).toEqual([
      ['hunk', null],
      ['add', 1],
      ['add', 2],
    ]);
  });

  it('very long diffs are cut at the row limit', () => {
    const text = '@@ -0,0 +1,50 @@\n' + Array.from({ length: 50 }, (_, i) => `+${i}`).join('\n');
    const { rows, hidden } = diffRows(text, 10);
    expect(rows).toHaveLength(10);
    expect(hidden).toBe(41);
  });

  it('counts', () => {
    expect(changeCounts({ added: 3, removed: 1, binary: false, kind: 'modified' })).toBe('+3 −1');
    expect(changeCounts({ added: null, removed: null, binary: true, kind: 'added' })).toBe('binary');
    expect(changeCounts({ added: null, removed: null, binary: false, kind: 'untracked' })).toBe('new');
  });
});
