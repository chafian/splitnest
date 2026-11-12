import type { IMarker, Terminal } from '@xterm/xterm';
import { describe, expect, it } from 'vitest';
import { allRows, appTerminal, write } from './xterm-node';

const { lineEndingAt, lineStartingAt, partOfLineAbove, removeCutLinePart } = await import('../../src/renderer/features/terminal/cut-line');
type Outcome = 'removed' | 'later' | 'gone';

/** A marker on the buffer row with exactly this text (the last such row). */
function markRow(term: Terminal, text: string, which: 'first' | 'last' = 'last'): IMarker {
  const buf = term.buffer.active;
  const rows = allRows(term);
  const y = which === 'last' ? rows.lastIndexOf(text) : rows.indexOf(text);
  if (y < 0) throw new Error(`no row "${text}"`);
  return term.registerMarker(y - (buf.baseY + buf.cursorY));
}
const remove = (term: Terminal, marker: IMarker, text: string) => new Promise<Outcome>((resolve) => removeCutLinePart(term, { marker, text }, resolve));
const state = (term: Terminal) => {
  const b = term.buffer.active;
  return { rows: allRows(term), cursor: `${b.cursorX},${b.cursorY}`, baseY: b.baseY, size: `${term.cols}x${term.rows}`, viewportY: b.viewportY };
};

/**
 * A 20x6 terminal as it is after a resize cut a line: the complete line in scrollback, then the
 * console's part of it ("hij end") as a line of its own, then `between` other lines, then a line
 * the program really printed with the same text, then more output and a prompt with typed text.
 */
async function cutLineScene(between = 0, after = 6): Promise<Terminal> {
  const term = appTerminal(20, 6);
  let s = 'first\r\nSB-143 abcdefghij end\r\nhij end\r\n';
  for (let i = 1; i <= between; i++) s += `between ${i}\r\n`;
  s += 'hij end\r\n';
  for (let i = 1; i <= after; i++) s += `after ${i}\r\n`;
  await write(term, s + 'PS> ty');
  return term;
}

describe('logical lines in the buffer', () => {
  it('joins wrapped rows; a row that continues a line starts none', async () => {
    const term = appTerminal(10, 6);
    await write(term, 'abcdefghijKLMNOPQRSTuvw\r\nshort\r\n');
    const buf = term.buffer.active;
    expect(allRows(term).slice(0, 4)).toEqual(['abcdefghij', '~KLMNOPQRST', '~uvw', 'short']);
    expect(lineStartingAt(buf, 0)).toEqual({ text: 'abcdefghijKLMNOPQRSTuvw', rows: 3 });
    expect(lineStartingAt(buf, 1)).toBeNull();
    expect(lineEndingAt(buf, 2)).toEqual({ text: 'abcdefghijKLMNOPQRSTuvw', rows: 3 });
    expect(lineEndingAt(buf, 1)).toBeNull(); // the line goes on below
    expect(lineEndingAt(buf, 3)).toEqual({ text: 'short', rows: 1 });
  });

  it('a part is a shorter line equal to the end of the line above it; an equal or different line is not', async () => {
    const term = appTerminal(30, 8);
    await write(term, 'SB-143 abcdefghij end\r\nhij end\r\nhij end\r\nother\r\nSB-143 abcdefghij end\r\nSB-143 abcdefghij end\r\n');
    const buf = term.buffer.active;
    expect(partOfLineAbove(buf, 1)).toEqual({ text: 'hij end', rows: 1 });
    expect(partOfLineAbove(buf, 2)).toBeNull(); // same text as the line above, not its end only
    expect(partOfLineAbove(buf, 3)).toBeNull();
    expect(partOfLineAbove(buf, 5)).toBeNull();
    expect(partOfLineAbove(buf, 0)).toBeNull();
  });
});

describe('removeCutLinePart: one row range leaves scrollback, nothing else changes', () => {
  it('removes the part just above the screen and keeps the real line with the same text', async () => {
    const term = await cutLineScene(0, 4);
    const before = state(term);
    // 5 rows above "PS> ty": [hij end (real), after 1..4]; the part is the row above the screen.
    expect(before.rows.slice(before.baseY - 1, before.baseY + 1)).toEqual(['hij end', 'hij end']);
    const marker = markRow(term, 'hij end', 'first');
    expect(await remove(term, marker, 'hij end')).toBe('removed');
    const after = state(term);
    const expected = [...before.rows];
    expected.splice(expected.indexOf('hij end'), 1);
    expect(after.rows).toEqual(expected);
    expect(after.rows.filter((r) => r === 'hij end')).toHaveLength(1);
    expect(after).toMatchObject({ cursor: before.cursor, size: before.size, baseY: before.baseY - 1, viewportY: before.baseY - 1 });
    // The terminal goes on as usual: typing continues on the prompt row, new lines scroll.
    await write(term, 'ped\r\nnext\r\n');
    expect(allRows(term).slice(-3)).toEqual(['PS> typed', 'next', '']);
  });

  it('removes a part that is a few rows above the screen', async () => {
    const term = await cutLineScene(0, 7);
    const before = state(term);
    const marker = markRow(term, 'hij end', 'first');
    expect(before.baseY - marker.line).toBe(4);
    expect(await remove(term, marker, 'hij end')).toBe('removed');
    const expected = [...before.rows];
    expected.splice(expected.indexOf('hij end'), 1);
    expect(state(term)).toMatchObject({ rows: expected, cursor: before.cursor, size: before.size });
  });

  it('removes a part of several rows', async () => {
    const term = appTerminal(10, 5);
    // The line above: 3 rows at 10 columns. Its part: the last 13 characters, 2 rows.
    await write(term, 'SB-9 abcdefghijklmnopqrstu\r\nefghijklmnopqrstu\r\nreal 1\r\nreal 2\r\nreal 3\r\nreal 4\r\nreal 5\r\nPS> ');
    const before = state(term);
    expect(before.rows.slice(0, 5)).toEqual(['SB-9 abcde', '~fghijklmno', '~pqrstu', 'efghijklmn', '~opqrstu']);
    const buf = term.buffer.active;
    const marker = term.registerMarker(3 - (buf.baseY + buf.cursorY));
    expect(partOfLineAbove(buf, 3)).toEqual({ text: 'efghijklmnopqrstu', rows: 2 });
    expect(await remove(term, marker, 'efghijklmnopqrstu')).toBe('removed');
    const expected = [...before.rows];
    expected.splice(3, 2);
    expect(state(term)).toMatchObject({ rows: expected, cursor: before.cursor, size: before.size });
  });

  it('a part the console padded with spaces when it redrew the row is still recognised and removed', async () => {
    // Seen at 150 % scaling: the redraw wrote "e for the resize check" followed by eight spaces.
    const term = appTerminal(60, 6);
    await write(term, 'KEEP-24 preserved output line for the resize check\r\ne for the resize check        \r\nKEEP-25\r\nKEEP-26\r\nKEEP-27\r\nKEEP-28\r\nKEEP-29\r\nPS> ');
    const buf = term.buffer.active;
    expect(buf.getLine(1)!.translateToString(true)).toBe('e for the resize check        '); // written spaces are text for xterm
    expect(partOfLineAbove(buf, 1)).toEqual({ text: 'e for the resize check', rows: 1 });
    const before = state(term);
    const marker = term.registerMarker(1 - (buf.baseY + buf.cursorY));
    expect(await remove(term, marker, 'e for the resize check')).toBe('removed');
    const expected = [...before.rows];
    expected.splice(1, 1);
    expect(state(term)).toMatchObject({ rows: expected, cursor: before.cursor });
  });

  it('with the cursor in the middle of the prompt row, the cursor returns to the same cell', async () => {
    const term = await cutLineScene(0, 4);
    await write(term, '\x1b[3D'); // three cells back, as when editing the command line
    const before = state(term);
    expect(await remove(term, markRow(term, 'hij end', 'first'), 'hij end')).toBe('removed');
    expect(state(term).cursor).toBe(before.cursor);
    await write(term, 'X');
    expect(allRows(term).at(-1)).toBe('PS>Xty');
  });

  const untouched: [string, (term: Terminal) => Promise<void> | void, Outcome, number?][] = [
    ['while the part is still on the screen (the console still shows it)', () => undefined, 'later', 2],
    ['while the cursor is not on the last row (rows below it would be lost)', (term) => write(term, '\x1b[2A'), 'later'],
    ['while the user reads scrollback', (term) => term.scrollLines(-2), 'later'],
    // (Selecting needs an opened terminal; here only the answer of hasSelection() matters.)
    ['while text is selected', (term) => void (term.hasSelection = () => true), 'later'],
    ['when the row no longer holds the recorded text', () => undefined, 'gone'],
    ['when the part is further above the screen than the screen is high', () => undefined, 'gone', 30],
    ['in the alternate screen (a full-screen program)', (term) => write(term, '\x1b[?1049h'), 'later'],
  ];
  for (const [name, prepare, outcome, afterLines] of untouched) {
    it(`does nothing ${name}: "${outcome}"`, async () => {
      const term = await cutLineScene(0, afterLines ?? 4);
      const marker = markRow(term, 'hij end', 'first');
      await prepare(term);
      const before = state(term);
      const text = name.includes('no longer') ? 'something else' : 'hij end';
      expect(await remove(term, marker, text)).toBe(outcome);
      expect(state(term)).toEqual(before);
    });
  }

  it('never removes a line the program printed: a marker on a row that is not a part gives "gone"', async () => {
    const term = await cutLineScene(1, 5);
    const before = state(term);
    // The second "hij end" follows "between 1": it is not the end of the line above it.
    expect(await remove(term, markRow(term, 'hij end', 'last'), 'hij end')).toBe('gone');
    expect(state(term)).toEqual(before);
  });

  it('a disposed marker (the buffer was cleared) gives "gone"', async () => {
    const term = await cutLineScene(0, 4);
    const marker = markRow(term, 'hij end', 'first');
    term.clear();
    const before = state(term);
    expect(await remove(term, marker, 'hij end')).toBe('gone');
    expect(state(term)).toEqual(before);
  });

  it('survives re-wrapping: the marker follows the part when the width changes before it is removed', async () => {
    const term = await cutLineScene(0, 4);
    const marker = markRow(term, 'hij end', 'first');
    term.resize(12, 6); // "SB-143 abcdefghij end" now takes two rows
    term.resize(20, 6);
    const before = state(term);
    expect(await remove(term, marker, 'hij end')).toBe('removed');
    const expected = [...before.rows];
    expected.splice(expected.indexOf('hij end'), 1);
    expect(state(term).rows).toEqual(expected);
  });
});
