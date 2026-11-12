// What the sidebar shows for a workspace's Git state. Clean workspaces stay quiet: only the
// branch. Line totals appear only when lines were added or removed; changes without changed
// lines (a rename, a mode change, a binary file, new untracked files) get a small dot instead,
// explained in the tooltip.
import type { GitStatus } from '../../../shared/types';

export interface GitLabel {
  /** Branch name, or "detached at 1a2b3c4". */
  branch: string;
  /** Shown only when at least one line was added or removed. */
  lines: { added: string; removed: string } | null;
  /** A change that has no line totals to show. */
  dot: boolean;
  /** Tooltip: every number in full. */
  tooltip: string;
  /** For screen readers and the row's description. */
  summary: string;
}

/** 1234 -> "1,234"; up to 9,999 in full, then 12.3k, 8.5M. */
export function shortCount(n: number): string {
  if (n < 10_000) return n.toLocaleString('en-US');
  if (n < 1_000_000) return `${trim(n / 1000)}k`;
  return `${trim(n / 1_000_000)}M`;
}
const trim = (x: number) => (x >= 100 ? Math.round(x).toString() : x.toFixed(1).replace(/\.0$/, ''));

const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;

export function gitLabel(s: GitStatus): GitLabel {
  const branch = s.branch ?? `detached at ${s.detached ?? '?'}`;
  const known = s.added !== null && s.removed !== null;
  const added = s.added ?? 0;
  const removed = s.removed ?? 0;
  const hasLines = known && added + removed > 0;
  const lines = hasLines ? { added: `+${shortCount(added)}`, removed: `−${shortCount(removed)}` } : null;
  const changed = s.changedFiles > 0 || s.untracked > 0;
  const dot = changed && !hasLines;

  const tip: string[] = [];
  tip.push(s.branch ? `Branch: ${s.branch}${s.initial ? ' (no commits yet)' : ''}` : `Detached HEAD at commit ${s.detached ?? '?'}`);
  if (s.upstream) {
    const ab = [s.ahead > 0 ? `${plural(s.ahead, 'commit')} ahead` : '', s.behind > 0 ? `${plural(s.behind, 'commit')} behind` : ''].filter(Boolean).join(', ');
    tip.push(ab ? `${ab} ${s.upstream}` : `Up to date with ${s.upstream}`);
  }
  if (s.changesNotChecked) {
    tip.push(
      "Changes not checked: this repository's own Git settings name a filter program, which Git would start to compare files. " +
        'SplitNest does not start programs that a repository configures.',
    );
    return { branch, lines: null, dot: false, tooltip: tip.join('\n'), summary: `Git branch ${branch}, changes not checked` };
  }
  if (!changed) tip.push('No changes');
  if (s.changedFiles > 0) {
    if (!known) tip.push(`${plural(s.changedFiles, 'changed file')}; lines could not be counted (Git took too long or failed)`);
    else if (hasLines) tip.push(`${plural(s.changedFiles, 'changed file')}: ${added.toLocaleString('en-US')} lines added, ${removed.toLocaleString('en-US')} removed`);
    else tip.push(`${plural(s.changedFiles, 'changed file')}, no lines added or removed (for example a renamed file, a changed file mode or a binary file)`);
  }
  // Git lists a new folder as one entry, so the number of entries is not a number of files.
  if (s.untracked > 0) tip.push('Untracked files present (their lines are not counted)');
  if (changed) tip.push('Compared with the last commit, staged and unstaged changes together.');

  const summary = [
    `Git branch ${branch}`,
    hasLines ? `${added} lines added, ${removed} removed` : '',
    dot && s.changedFiles > 0 ? plural(s.changedFiles, 'changed file') : '',
    s.untracked > 0 ? 'untracked files present' : '',
  ]
    .filter(Boolean)
    .join(', ');
  return { branch, lines, dot, tooltip: tip.join('\n'), summary };
}
