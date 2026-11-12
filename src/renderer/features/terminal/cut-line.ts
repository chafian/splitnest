// The console's part of a line that its top edge cut, and removing it from scrollback.
//
// The system ConPTY has no scrollback: its screen is all it knows. When the top row of its screen
// is the second or third row of a wrapped line and the width changes, the console re-wraps what it
// has, which is only the rest of that line, and redraws it as a line of its own. xterm still has
// the whole line (re-wrapped, in scrollback), so the rest of it now exists twice: at the end of
// the complete line, and as the console's own line on the top row of the screen. While it is on
// the console's screen xterm must show it there too (every position the console sends is relative
// to that screen). Once output has scrolled it off the console's screen, nothing refers to it any
// more, and it is removed from xterm's scrollback here.
//
// Which rows are such a part is known from where they came from (terminal-controller.ts registers
// a marker on the screen's top row when a resize cuts a line this way), never from their text: a
// line the program really printed with the same text is not touched. The text is only checked in
// addition, so that nothing is removed when the row has changed in the meantime.
//
// xterm has no API to delete a scrollback row. It is done with public operations only:
//   1. grow the terminal by the distance to the part (with `windowsPty` unset for this one call,
//      xterm takes the rows back from scrollback), so the part is on rows 1..k of the screen;
//   2. cursor to the top, delete k lines (DL): the rows below move up, k blank rows appear at the
//      bottom; cursor to the last row with text;
//   3. shrink back: xterm drops the rows below the cursor (the k blank ones) and returns the rest
//      to scrollback; then the cursor goes back where it was.
// Nothing else may be written to the terminal, and it must not be resized, between 1 and 3: the
// caller guarantees that (the controller holds all output and resizes meanwhile).
import type { IBuffer, IMarker, Terminal } from '@xterm/xterm';

/** A row range on the screen's top row(s) that repeats the end of the line above it. */
export interface CutLinePart {
  /** On the part's first row; follows it through scrolling and re-wrapping. */
  readonly marker: IMarker;
  /** The part's text when it was recorded. */
  readonly text: string;
}

type Rows = Pick<IBuffer, 'getLine' | 'length'>;

/** The logical line that starts on buffer row `y` (text of its rows joined, without trailing spaces), or null. */
export function lineStartingAt(buf: Rows, y: number): { text: string; rows: number } | null {
  const first = buf.getLine(y);
  if (!first || first.isWrapped) return null;
  let rows = 1;
  while (buf.getLine(y + rows)?.isWrapped) rows++;
  let text = '';
  // Rows that wrap are full: their cells are kept as they are. Spaces at the end of the line are
  // left out, written or not: the console pads rows with spaces when it redraws them.
  for (let i = 0; i < rows; i++) text += buf.getLine(y + i)!.translateToString(i === rows - 1);
  return { text: text.trimEnd(), rows };
}

/** The logical line whose last row is buffer row `y`, or null. */
export function lineEndingAt(buf: Rows, y: number): { text: string; rows: number } | null {
  if (y < 0 || buf.getLine(y + 1)?.isWrapped) return null;
  let start = y;
  while (start > 0 && buf.getLine(start)?.isWrapped) start--;
  const line = lineStartingAt(buf, start);
  return line && start + line.rows === y + 1 ? line : null;
}

/**
 * The line starting on row `y`, if it is (still) a part of the line above it: not empty, shorter
 * than that line, and equal to its end. Null otherwise.
 */
export function partOfLineAbove(buf: Rows, y: number): { text: string; rows: number } | null {
  const part = lineStartingAt(buf, y);
  const above = part ? lineEndingAt(buf, y - 1) : null;
  if (!part || !above || part.text.length === 0 || above.text.length <= part.text.length || !above.text.endsWith(part.text)) return null;
  return part;
}

/**
 * - 'removed': the part's rows are gone from scrollback; everything else is as it was.
 * - 'later':   it cannot be done right now (the part is still on the screen, the cursor is not on
 *              the last row, the user is reading scrollback or has selected text): try again.
 * - 'gone':    there is nothing (safe) to remove any more: the rows changed, the part is too far
 *              above the screen, or the buffer was cleared.
 */
export type RemoveOutcome = 'removed' | 'later' | 'gone';

/**
 * Removes `part` from the scrollback of `term` (see the top of this file). `done` is called once.
 * The terminal is touched only if every check passes, and is left exactly as it was otherwise.
 */
export function removeCutLinePart(term: Terminal, part: CutLinePart, done: (outcome: RemoveOutcome) => void): void {
  const buf = term.buffer.active;
  if (part.marker.isDisposed || part.marker.line < 0) return done('gone');
  if (buf.type !== 'normal') return done('later');
  const current = partOfLineAbove(buf, part.marker.line);
  if (!current || current.text !== part.text) return done('gone');
  const k = current.rows;
  const n = buf.baseY - part.marker.line;
  if (n < k) return done('later'); // (partly) on the screen: the console still shows it
  const rows = term.rows;
  const cols = term.cols;
  // Twice the height at most, so the temporary size stays reasonable for the renderer.
  if (n > rows) return done('gone');
  const x0 = buf.cursorX;
  const y0 = buf.cursorY;
  // Growing takes rows from scrollback only while the cursor is on the buffer's last row, and the
  // cursor must be restorable (not waiting to wrap past the last column).
  if (buf.baseY + y0 !== buf.length - 1 || x0 >= cols) return done('later');
  if (buf.viewportY !== buf.baseY || term.hasSelection()) return done('later');

  const windowsPty = term.options.windowsPty;
  term.options.windowsPty = {};
  try {
    term.resize(cols, rows + n);
  } finally {
    term.options.windowsPty = windowsPty;
  }
  if (buf.baseY !== part.marker.line || term.rows !== rows + n) {
    // The rows did not come back as expected: undo (the cursor is on the last row, so shrinking
    // returns exactly the rows that were taken).
    term.resize(cols, rows);
    return done('gone');
  }
  // Cursor home, delete the part's rows, cursor to the last row that has text.
  term.write(`\x1b[H\x1b[${k}M\x1b[${rows + n - k};1H`, () => {
    if (part.marker.isDisposed) {
      // Deleted. Shrinking drops the k blank rows below the cursor, then returns n - k rows.
      term.resize(cols, rows);
      term.write(`\x1b[${y0 + 1};${x0 + 1}H`, () => done('removed'));
      return;
    }
    // Not deleted (not expected): put the cursor on the last row so that shrinking only returns
    // rows to scrollback, and restore everything.
    term.write(`\x1b[${rows + n};1H`, () => {
      term.resize(cols, rows);
      term.write(`\x1b[${y0 + 1};${x0 + 1}H`, () => done('gone'));
    });
  });
}
