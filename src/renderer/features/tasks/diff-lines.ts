// A unified diff (as Git prints it, or as main builds it for an untracked file) as rows to show:
// hunk headers, added, removed and unchanged lines with their old and new line numbers. The text is
// only ever shown as text (React escapes it); nothing in it is interpreted.

export interface DiffRow {
  kind: 'hunk' | 'add' | 'del' | 'ctx' | 'meta';
  text: string;
  /** Line number before / after (null where the line doesn't exist on that side). */
  oldNo: number | null;
  newNo: number | null;
}

/** At most this many rows are shown for one file (the rest is summarised). */
export const MAX_DIFF_ROWS = 10_000;

export function diffRows(text: string, max = MAX_DIFF_ROWS): { rows: DiffRow[]; hidden: number } {
  const rows: DiffRow[] = [];
  let oldNo = 0;
  let newNo = 0;
  let inHunk = false;
  let hidden = 0;
  const lines = text.split('\n');
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  for (const raw of lines) {
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    let row: DiffRow | null = null;
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/.exec(line);
    if (hunk) {
      oldNo = Number(hunk[1]);
      newNo = Number(hunk[2]);
      inHunk = true;
      row = { kind: 'hunk', text: line, oldNo: null, newNo: null };
    } else if (!inHunk) {
      // Git's file header: only what says something to a reader (renames, modes, binary).
      if (/^(rename|copy) (from|to) |^(new|deleted) file mode |^old mode |^new mode |^Binary files /.test(line)) row = { kind: 'meta', text: line, oldNo: null, newNo: null };
    } else if (line.startsWith('+')) {
      row = { kind: 'add', text: line.slice(1), oldNo: null, newNo: newNo++ };
    } else if (line.startsWith('-')) {
      row = { kind: 'del', text: line.slice(1), oldNo: oldNo++, newNo: null };
    } else if (line.startsWith(' ')) {
      row = { kind: 'ctx', text: line.slice(1), oldNo: oldNo++, newNo: newNo++ };
    } else if (line.startsWith('\\')) {
      row = { kind: 'meta', text: line, oldNo: null, newNo: null }; // "\ No newline at end of file"
    } else if (line.startsWith('diff --git ')) {
      inHunk = false; // a second file (a rename shows as one)
    }
    if (!row) continue;
    if (rows.length < max) rows.push(row);
    else hidden++;
  }
  return { rows, hidden };
}

/** "+12 −3", "binary", or "new" for an untracked file whose lines aren't counted. */
export function changeCounts(c: { added: number | null; removed: number | null; binary: boolean; kind: string }): string {
  if (c.binary) return 'binary';
  if (c.added === null && c.removed === null) return c.kind === 'untracked' ? 'new' : '';
  return `+${c.added ?? 0} −${c.removed ?? 0}`;
}
