// A real xterm.js in Node for tests of code that lays text out with it. Nothing is rendered: the
// terminal is never opened, it only parses and keeps its buffer. xterm needs these globals to load.
import type { Terminal as XTerm } from '@xterm/xterm';

const g = globalThis as Record<string, unknown>;
g.window ??= globalThis;
g.self ??= globalThis;
if (!('navigator' in globalThis)) Object.defineProperty(globalThis, 'navigator', { value: { userAgent: 'node', platform: 'Win32' }, configurable: true });

export const { Terminal } = await import('@xterm/xterm');
export const { Unicode11Addon } = await import('@xterm/addon-unicode11');

/** The options that decide layout in SplitNest's terminals (terminal-controller.ts). */
export const WINDOWS_PTY = { backend: 'conpty' as const, buildNumber: 26100 };

/** A terminal configured like SplitNest's: Unicode 11 widths, ConPTY row handling, reflow of the cursor line. */
export function appTerminal(cols: number, rows: number, scrollback = 1000): XTerm {
  const term = new Terminal({ cols, rows, scrollback, allowProposedApi: true, reflowCursorLine: true, windowsPty: WINDOWS_PTY });
  term.loadAddon(new Unicode11Addon());
  term.unicode.activeVersion = '11';
  return term;
}

export const write = (term: XTerm, data: string) => new Promise<void>((resolve) => term.write(data, resolve));

/** Every buffer row as text (trailing blanks removed), wrapped rows marked with a leading '~'. */
export function allRows(term: XTerm): string[] {
  const buf = term.buffer.active;
  return Array.from({ length: buf.length }, (_, y) => {
    const line = buf.getLine(y)!;
    return (line.isWrapped ? '~' : '') + line.translateToString(true);
  });
}

export const firstRows = (term: XTerm, n: number) => Array.from({ length: n }, (_, y) => term.buffer.active.getLine(y)?.translateToString(true) ?? '');
