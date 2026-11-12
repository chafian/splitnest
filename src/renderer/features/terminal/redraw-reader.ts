// The first rows of a console redraw, laid out by xterm itself.
//
// After a resize the system ConPTY redraws its whole screen from the top (cursor-home, then the
// rows). The controller needs the text of the first rows to find where the console's screen
// starts in the terminal's buffer (terminal-controller.ts, "Scrollback boundary"). Earlier this
// text was taken apart by hand, which got the layout wrong where a character is not one cell wide
// (combining marks, double-width characters) and trusted numbers found in the output (a
// cursor-forward count was used as a string length). Here an xterm that is never shown, with the
// terminal's size and Unicode rules, parses the redraw: its rows are by construction the rows the
// real terminal will have, and no escape sequence is interpreted by SplitNest.
import { Terminal } from '@xterm/xterm';
import { Unicode11Addon } from '@xterm/addon-unicode11';

/** Cursor to the top-left corner: where a redraw starts. */
const HOME = /\x1b\[(?:1;1)?H/;
/** Longest text kept while looking for HOME across chunk boundaries. */
const HOME_TAIL = 8;
/** A redraw is a screenful; anything much longer is other output, and reading stops. */
const MAX_CHARS = 256 * 1024;
/** Rows kept above the screen so the first rows survive output that scrolls. */
const SCROLLBACK = 1000;
/** No more output for this long after the redraw began: what has arrived is taken as it is. */
const QUIET_MS = 30;

export class RedrawReader {
  private readonly term: Terminal;
  private readonly firstLine: { readonly isDisposed: boolean };
  private seeking = '';
  private started = false;
  /** The console showed the cursor again (it hides it while drawing): the redraw is complete. */
  private shown = false;
  private chars = 0;
  private result: string[] | null | undefined;
  private listener: ((rows: string[] | null) => void) | null = null;
  private quiet: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;

  /**
   * @param unicodeVersion the terminal's `unicode.activeVersion` ('11' in SplitNest), so both use
   *   the same cell widths.
   * @param want number of rows to read from the top.
   */
  constructor(cols: number, rows: number, unicodeVersion: string, private readonly want = 4) {
    this.term = new Terminal({ cols: Math.max(2, cols), rows: Math.max(1, rows), scrollback: SCROLLBACK, allowProposedApi: true });
    if (unicodeVersion === '11') {
      this.term.loadAddon(new Unicode11Addon());
      this.term.unicode.activeVersion = '11';
    }
    // Disposed by xterm if the first row is ever trimmed from the buffer: the rows are lost then.
    this.firstLine = this.term.registerMarker(0);
    this.term.parser.registerCsiHandler({ prefix: '?', final: 'h' }, (params) => {
      if (params.includes(25)) this.shown = true;
      return false;
    });
  }

  /** Session output received since the resize was confirmed, in order. */
  feed(data: string): void {
    if (this.disposed || this.result !== undefined || !data) return;
    let text = data;
    if (!this.started) {
      this.seeking += data;
      const home = HOME.exec(this.seeking);
      if (!home) {
        this.seeking = this.seeking.slice(-HOME_TAIL);
        return;
      }
      text = this.seeking.slice(home.index);
      this.seeking = '';
      this.started = true;
    }
    this.chars += text.length;
    if (this.chars > MAX_CHARS) {
      this.resolve(null);
      return;
    }
    if (this.quiet) clearTimeout(this.quiet);
    this.quiet = null;
    this.term.write(text, () => this.check());
  }

  /** Calls `cb` once: with the first rows as xterm has them (cells never written left out), or null when they cannot be read. */
  onRows(cb: (rows: string[] | null) => void): void {
    if (this.result !== undefined) cb(this.result);
    else this.listener = cb;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.listener = null;
    if (this.quiet) clearTimeout(this.quiet);
    this.term.dispose();
  }

  private check(): void {
    if (this.disposed || this.result !== undefined) return;
    if (this.firstLine.isDisposed) {
      this.resolve(null);
      return;
    }
    const buf = this.term.buffer.active;
    const cursorLine = buf.baseY + buf.cursorY;
    if (this.shown || cursorLine >= this.want) {
      this.resolve(this.rows(this.want));
      return;
    }
    // Still drawing the first rows, or a redraw that never shows the cursor: wait a little.
    if (this.quiet) clearTimeout(this.quiet);
    this.quiet = setTimeout(() => {
      this.quiet = null;
      if (this.disposed || this.result !== undefined) return;
      // Rows above the cursor are complete; the cursor's row may not be, so it is left blank
      // (a blank row matches anything in findRedrawTop).
      const b = this.term.buffer.active;
      this.resolve(this.rows(Math.min(this.want, b.baseY + b.cursorY)));
    }, QUIET_MS);
  }

  /** The first `want` rows, the first `complete` of them with their text and the rest blank. */
  private rows(complete: number): string[] {
    const buf = this.term.buffer.active;
    return Array.from({ length: this.want }, (_, y) => (y < complete ? (buf.getLine(y)?.translateToString(true) ?? '') : ''));
  }

  private resolve(rows: string[] | null): void {
    this.result = rows;
    if (this.quiet) clearTimeout(this.quiet);
    this.quiet = null;
    const cb = this.listener;
    this.listener = null;
    cb?.(rows);
  }
}
