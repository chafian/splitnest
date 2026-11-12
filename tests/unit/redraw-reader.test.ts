import { afterEach, describe, expect, it } from 'vitest';
import { appTerminal, firstRows, write } from './xterm-node';

const { RedrawReader } = await import('../../src/renderer/features/terminal/redraw-reader');
type Reader = InstanceType<typeof RedrawReader>;

const open: Reader[] = [];
afterEach(() => {
  for (const r of open.splice(0)) r.dispose();
});
function reader(cols: number, rows = 12, want = 4): Reader {
  const r = new RedrawReader(cols, rows, '11', want);
  open.push(r);
  return r;
}
/** The rows the reader reports (null: gave up), or 'pending' when it has not decided after `ms`. */
function rowsOf(r: Reader, ms = 500): Promise<string[] | null | 'pending'> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve('pending'), ms);
    r.onRows((rows) => {
      clearTimeout(timer);
      resolve(rows);
    });
  });
}
/** What a terminal configured like SplitNest's shows for the same text: the reference. */
async function xtermRows(cols: number, text: string, n: number): Promise<string[]> {
  const term = appTerminal(cols, 12);
  await write(term, text);
  const rows = firstRows(term, n);
  term.dispose();
  return rows;
}

const HOME = '\x1b[H';
const SHOW = '\x1b[?25h'; // the console shows the cursor again when its redraw is complete

describe('RedrawReader: first rows of a console redraw, laid out by xterm', () => {
  it('a cursor-forward with an absurd count neither throws nor allocates; the next output is read as usual', async () => {
    const r = reader(23);
    // Before: ' '.repeat(9999999999) -> RangeError: Invalid string length.
    expect(() => r.feed(`${HOME}\x1b[9999999999C`)).not.toThrow();
    expect(() => r.feed('x\r\nnext line\r\n')).not.toThrow();
    r.feed(`third\r\n\r\n${SHOW}`);
    // The cursor stops at the last column (as in any terminal): 'x' is the 23rd cell.
    expect(await rowsOf(r)).toEqual([' '.repeat(22) + 'x', 'next line', 'third', '']);
    expect(await xtermRows(23, `${HOME}\x1b[9999999999Cx\r\nnext line\r\nthird\r\n\r\n`, 4)).toEqual([' '.repeat(22) + 'x', 'next line', 'third', '']);
  });

  it('a count that would be a 400 MB string before is just a cursor move', async () => {
    const r = reader(23);
    const before = process.memoryUsage().heapUsed;
    r.feed(`${HOME}ab\x1b[400000000Cz\r\n${SHOW}`);
    expect(await rowsOf(r)).toEqual(['ab' + ' '.repeat(20) + 'z', '', '', '']);
    expect(process.memoryUsage().heapUsed - before).toBeLessThan(50 * 1024 * 1024);
  });

  it('a combining mark takes no cell: at 4 columns "e\\u0301abcZ" is "e\\u0301abc" then "Z"', async () => {
    const text = 'éabcZ';
    const r = reader(4);
    r.feed(`${HOME}${text}\r\n${SHOW}`);
    const rows = await rowsOf(r);
    expect(rows).toEqual(['éabc', 'Z', '', '']);
    expect(rows).toEqual(await xtermRows(4, `${HOME}${text}\r\n`, 4));
  });

  it('Arabic text with a combining mark wraps after four letters, the mark staying with its letter', async () => {
    const text = 'بَتثجح'; // beh + fatha, teh, theh, jeem, hah
    const r = reader(4);
    r.feed(`${HOME}${text}\r\n${SHOW}`);
    const rows = await rowsOf(r);
    expect(rows).toEqual(['بَتثج', 'ح', '', '']);
    expect(rows).toEqual(await xtermRows(4, `${HOME}${text}\r\n`, 4));
  });

  it('a double-width character that does not fit at the end of a row moves to the next row', async () => {
    const text = 'abc中Z';
    const r = reader(4);
    r.feed(`${HOME}${text}\r\n${SHOW}`);
    const rows = await rowsOf(r);
    expect(rows).toEqual(['abc', '中Z', '', '']);
    expect(rows).toEqual(await xtermRows(4, `${HOME}${text}\r\n`, 4));
  });

  it('reads a redraw captured from the system ConPTY (conhost 10.0.26100, resize to 30x12)', async () => {
    const redraw =
      '\x1b[?25l\x1b[8;12;30t\x1b[Hhijabcdefghijabcdefghij end   \r\n' +
      'SB-006 abcdefghijabcdefghijabcdefghijabcdefghij end\x1b[K\r\n' +
      'SB-007 abcdefghijabcdefghijabcdefghijabcdefghij end\x1b[K\r\n' +
      'PS>\x1b[K\x1b[8;5H\x1b[?25h';
    const r = reader(30);
    r.feed(redraw);
    // Spaces the console wrote are text (only cells never written are left out).
    expect(await rowsOf(r)).toEqual(['hijabcdefghijabcdefghij end   ', 'SB-006 abcdefghijabcdefghijabc', 'defghijabcdefghij end', 'SB-007 abcdefghijabcdefghijabc']);
  });

  it('ignores output before cursor-home, also when the sequence is split between two chunks', async () => {
    const r = reader(20);
    r.feed('tail of earlier output\r\nmore\x1b[?25l\x1b');
    r.feed('[Hfirst\r\nsecond\r\n');
    r.feed(`third\r\nfourth\r\n${SHOW}`);
    expect(await rowsOf(r)).toEqual(['first', 'second', 'third', 'fourth']);
  });

  it('waits while the first rows are still arriving, and is done once the cursor is below them', async () => {
    const r = reader(20);
    r.feed(`${HOME}one\r\ntw`);
    r.feed('o\r\nthree\r\n');
    const pending = rowsOf(r);
    r.feed('four\r\nfive');
    expect(await pending).toEqual(['one', 'two', 'three', 'four']);
  });

  it('a redraw that never shows the cursor: after a short quiet time the rows above the cursor are used', async () => {
    const r = reader(20);
    r.feed(`${HOME}one\r\ntwo\r\nthr`);
    // The cursor's own row may be incomplete: it is left blank (a blank row matches anything).
    expect(await rowsOf(r)).toEqual(['one', 'two', '', '']);
  });

  it('no cursor-home at all: nothing is reported (the caller falls back after its own wait)', async () => {
    const r = reader(20);
    r.feed('just output\r\nwithout a redraw\r\n');
    expect(await rowsOf(r, 150)).toBe('pending');
  });

  it('gives up (null) on far more output than a redraw, instead of reading on', async () => {
    const r = reader(20);
    r.feed(`${HOME}start\r\n`);
    r.feed('x'.repeat(300 * 1024));
    expect(await rowsOf(r)).toBeNull();
  });

  it('gives up when the first rows have scrolled out of reach before they could be read', async () => {
    const r = reader(20, 12);
    r.feed(`${HOME}` + 'line\r\n'.repeat(5000));
    expect(await rowsOf(r)).toBeNull();
  });

  it('reports once, and not at all after dispose', async () => {
    const r = reader(20);
    let calls = 0;
    r.onRows(() => calls++);
    r.dispose();
    r.feed(`${HOME}a\r\nb\r\nc\r\nd\r\ne\r\n`);
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(calls).toBe(0);
  });
});
