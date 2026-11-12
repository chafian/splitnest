import { describe, expect, it, vi } from 'vitest';

// terminal-controller imports the preload API and xterm; only the pure layout helper is tested.
vi.mock('../../src/renderer/api', () => ({ api: { windowsBuild: 26100 } }));
vi.mock('@xterm/xterm', () => ({ Terminal: class {} }));
vi.mock('@xterm/addon-fit', () => ({ FitAddon: class {} }));
vi.mock('@xterm/addon-search', () => ({ SearchAddon: class {} }));
vi.mock('@xterm/addon-unicode11', () => ({ Unicode11Addon: class {} }));
vi.mock('@xterm/addon-web-links', () => ({ WebLinksAddon: class {} }));
vi.mock('@xterm/addon-webgl', () => ({ WebglAddon: class {} }));

const { consoleLayout, findRedrawTop } = await import('../../src/renderer/features/terminal/terminal-controller');

describe('findRedrawTop (where the console screen starts in xterm\'s buffer)', () => {
  const buf = ['a', 'KEEP-01', 'KEEP-02', 'KEEP-03', 'KEEP-04', 'PS> '];
  const rowText = (y: number) => (y < buf.length ? buf[y]! : null);

  it('finds the row from which the buffer reads like the redraw, nearest to the estimate', () => {
    expect(findRedrawTop(rowText, ['KEEP-02', 'KEEP-03', 'KEEP-04', 'PS>'], 4, 10)).toBe(2);
  });

  it('a blank console row matches whatever xterm still shows there', () => {
    expect(findRedrawTop(rowText, ['KEEP-03', '', 'PS>'], 0, 10)).toBe(3);
  });

  it('returns null when nothing matches (the estimate is used then)', () => {
    expect(findRedrawTop(rowText, ['nowhere', 'KEEP-02'], 2, 10)).toBeNull();
  });
});

/** A buffer of rows `cols` wide; a row given as ['text', true] continues the previous one. */
function buffer(cols: number, rows: (string | [string, true])[]) {
  const lines = rows.map((r) => (Array.isArray(r) ? { text: r[0], wrapped: true } : { text: r, wrapped: false }));
  const cell = (ch: string) => ({ getChars: () => ch, getWidth: () => 1 });
  return {
    length: lines.length,
    getNullCell: () => cell(''),
    getLine: (y: number) => {
      const l = lines[y];
      if (!l) return undefined;
      return { isWrapped: l.wrapped, getCell: (x: number) => cell(x < l.text.length ? l.text[x]! : '') };
    },
    cols,
  };
}

describe('consoleLayout (rows as the console counts them)', () => {
  it('ignores trailing spaces that make xterm wrap a line onto an extra row', () => {
    // "abcdefgh" + 4 padding spaces at 10 columns: xterm has 2 rows, the console 1.
    const b = buffer(10, ['abcdefgh  ', ['  ', true], 'next', 'PS> ']);
    expect(consoleLayout(b, 0, 3, 10, 0, 4)).toEqual([
      { start: 0, skip: 0, rows: 1, xtermRows: 2 },
      { start: 2, skip: 0, rows: 1, xtermRows: 1 },
      { start: 3, skip: 0, rows: 1, xtermRows: 1 },
    ]);
  });

  it('counts real text across wrapped rows and the cursor line up to the cursor', () => {
    const b = buffer(5, ['abcde', ['fghij', true], ['k', true], 'PS> x', ['yz', true]]);
    // Line 1: 11 cells = 3 rows. Cursor line: cursor at char 7 -> second row.
    expect(consoleLayout(b, 0, 3, 5, 0, 7)).toEqual([
      { start: 0, skip: 0, rows: 3, xtermRows: 3 },
      { start: 3, skip: 0, rows: 2, xtermRows: 2 },
    ]);
  });

  it('a top row that continues a line from scrollback: only the continuation is on the console', () => {
    // At the old width the console's top row was the 2nd row of a 12-char line (5 chars before it).
    const b = buffer(6, ['abcdef', ['ghijkl', true], 'PS> ']);
    const [first] = consoleLayout(b, 0, 2, 6, 5, 4);
    // 12 - 5 = 7 cells -> 2 console rows; ceil(5 / 6) = 1 xterm row stays in scrollback.
    expect(first).toEqual({ start: 0, skip: 1, rows: 2, xtermRows: 2 });
  });
});
