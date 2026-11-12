import { describe, expect, it } from 'vitest';
import type { GitStatus } from '../../src/shared/types';
import { gitLabel, shortCount } from '../../src/renderer/features/workspaces/git-label';

const status = (s: Partial<GitStatus>): GitStatus => ({
  branch: 'main',
  detached: null,
  initial: false,
  upstream: null,
  ahead: 0,
  behind: 0,
  changedFiles: 0,
  untracked: 0,
  changesNotChecked: false,
  added: 0,
  removed: 0,
  ...s,
});

describe('what the sidebar shows for Git', () => {
  it('a clean workspace: only the branch, no numbers, no dot', () => {
    const l = gitLabel(status({}));
    expect(l).toMatchObject({ branch: 'main', lines: null, dot: false });
    expect(l.tooltip).toContain('No changes');
  });

  it('lines added or removed: +added −removed', () => {
    expect(gitLabel(status({ changedFiles: 3, added: 120, removed: 6 })).lines).toEqual({ added: '+120', removed: '−6' });
    expect(gitLabel(status({ changedFiles: 1, added: 0, removed: 4 })).lines).toEqual({ added: '+0', removed: '−4' });
  });

  it('a rename (files changed, no lines): a dot, explained in the tooltip', () => {
    const l = gitLabel(status({ changedFiles: 1, added: 0, removed: 0 }));
    expect(l).toMatchObject({ lines: null, dot: true });
    expect(l.tooltip).toContain('1 changed file, no lines added or removed (for example a renamed file');
  });

  it('only untracked files: a dot; "Untracked files present", never a count (one entry can be a whole folder)', () => {
    for (const n of [1, 2]) {
      const l = gitLabel(status({ untracked: n }));
      expect(l).toMatchObject({ lines: null, dot: true, summary: 'Git branch main, untracked files present' });
      expect(l.tooltip).toContain('Untracked files present (their lines are not counted)');
      expect(l.tooltip).not.toMatch(/\d+ (new|untracked) files?/);
    }
  });

  it('tracked edits and untracked files: the line totals, and "Untracked files present" in tooltip and summary', () => {
    const l = gitLabel(status({ changedFiles: 1, added: 3, removed: 1, untracked: 1 }));
    expect(l).toMatchObject({ lines: { added: '+3', removed: '−1' }, dot: false, summary: 'Git branch main, 3 lines added, 1 removed, untracked files present' });
    expect(l.tooltip).toContain('1 changed file: 3 lines added, 1 removed');
    expect(l.tooltip).toContain('Untracked files present (their lines are not counted)');
  });

  it('lines that could not be counted: a dot, never "+0 −0"', () => {
    const l = gitLabel(status({ changedFiles: 4, added: null, removed: null }));
    expect(l).toMatchObject({ lines: null, dot: true });
    expect(l.tooltip).toContain('lines could not be counted');
  });

  it('detached HEAD, a branch without commits, upstream state', () => {
    expect(gitLabel(status({ branch: null, detached: '1a2b3c4' })).branch).toBe('detached at 1a2b3c4');
    expect(gitLabel(status({ initial: true })).tooltip).toContain('Branch: main (no commits yet)');
    expect(gitLabel(status({ upstream: 'origin/main' })).tooltip).toContain('Up to date with origin/main');
    expect(gitLabel(status({ upstream: 'origin/main', ahead: 2, behind: 1 })).tooltip).toContain('2 commits ahead, 1 commit behind origin/main');
  });

  it('large totals are shortened in the row and complete in the tooltip', () => {
    const l = gitLabel(status({ changedFiles: 900, added: 8_538_393, removed: 6 }));
    expect(l.lines).toEqual({ added: '+8.5M', removed: '−6' });
    expect(l.tooltip).toContain('8,538,393 lines added, 6 removed');
    expect([0, 999, 9_999, 10_000, 12_345, 999_499, 1_000_000, 123_456_789].map(shortCount)).toEqual(['0', '999', '9,999', '10k', '12.3k', '999k', '1M', '123M']);
  });

  it('a repository with its own filter programs: the branch only, and why', () => {
    const l = gitLabel(status({ changesNotChecked: true, added: null, removed: null }));
    expect(l).toMatchObject({ branch: 'main', lines: null, dot: false, summary: 'Git branch main, changes not checked' });
    expect(l.tooltip).toContain("Changes not checked: this repository's own Git settings name a filter program");
  });

  it('the summary for screen readers says what the row shows', () => {
    expect(gitLabel(status({})).summary).toBe('Git branch main');
    expect(gitLabel(status({ changedFiles: 2, added: 5, removed: 1 })).summary).toBe('Git branch main, 5 lines added, 1 removed');
    expect(gitLabel(status({ changedFiles: 1 })).summary).toBe('Git branch main, 1 changed file');
  });
});
