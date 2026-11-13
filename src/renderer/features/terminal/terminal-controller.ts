// One controller per pane. Owns the xterm.js instance and the backend
// session, both outside React so output never triggers React renders and
// sessions survive layout changes and workspace switches.
import { Terminal, type IMarker } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { SearchAddon } from '@xterm/addon-search';
import { Unicode11Addon } from '@xterm/addon-unicode11';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { WebglAddon } from '@xterm/addon-webgl';
import '@xterm/xterm/css/xterm.css';
import { LIMITS, type AppError, type SessionEvent, type SessionStatus, type StartLocation } from '../../../shared/types';
import { api } from '../../api';
import type { AgentId } from '../../../shared/agents';
import { taskAgentCommand, type TaskAgent } from '../../../shared/tasks';
import { isResumableAgent, resumeCommand, resumeForShell, type AgentResume, type ResumableAgent } from '../../../shared/agent-resume';
import { agentFromTitle, deriveAgentView, hasTitleStatus, parseProgramStatus, PROGRAM_STATUS_REPLY, StatusRecords, titleLooksLikeShell, type AgentView } from './agent-status';
import { StartGate, type StartOutcome } from './bulk-start';
import { partOfLineAbove, removeCutLinePart, type CutLinePart } from './cut-line';
import { RedrawReader } from './redraw-reader';

/** Output silence after which a heuristically tracked agent counts as idle. */
const QUIET_AFTER_MS = 2000;
/** While a pane's size keeps changing (dragging), at most one size change per this interval. */
const RESIZE_INTERVAL_MS = 50;
/** A resize the PTY host does not confirm in this time is applied to xterm anyway. */
const RESIZE_ACK_TIMEOUT_MS = 1000;
/** How long held output waits for the console's redraw after a resize (it normally takes a few ms). */
const REDRAW_WAIT_MS = 200;
/** Output held after a resize is released after this long at the latest. */
const GATE_MAX_MS = 1000;
import { TERMINAL_FONT } from './terminal-theme';
import { searchDecorations, xtermTheme, type Theme } from '../appearance/themes';

/** How long a resumed agent has to appear among the shell's processes before the pane says it didn't. */
export const RESUME_CONFIRM_MS = 25_000;

export interface ControllerSnapshot {
  status: SessionStatus;
  sessionId: string | null;
  exitCode: number | null;
  exitReason: string | null;
  error: AppError | null;
  cwdLabel: string | null;
  profileLabel: string | null;
  startIn: StartLocation;
  hasStarted: boolean;
  /** Title set by the shell (OSC 0/2). Shown in the tooltip only; never replaces a tab name. */
  shellTitle: string | null;
  /** AI agent CLI running in this terminal and what it is doing, or null. */
  agent: AgentView | null;
  /** A resumed agent is starting (`waiting`), or didn't appear in time (`not-started`). */
  resuming: { agent: ResumableAgent; phase: 'waiting' | 'not-started' } | null;
}

export interface ControllerHooks {
  /** Gives the app a chance to handle a shortcut. Return true when handled. */
  onShortcut(event: KeyboardEvent): boolean;
  /** Called before a session starts so main sees the latest workspace state. */
  beforeStart(): Promise<void>;
  onFocus(paneId: string): void;
  /** Whether new sessions should shorten the folder in default prompts. */
  shortPrompt(): boolean;
  bindSession(sessionId: string, controller: TerminalController): void;
  /**
   * WSL tabs: Claude Code, Codex or Gemini CLI is (or is no longer) running here, from its own reports (process
   * detection can't see Linux processes). Resume then opens the agent's own list of conversations.
   */
  wslAgent(agent: ResumableAgent | null): void;
  /**
   * A plain shell is being started in this terminal: a conversation saved for Resume no longer
   * belongs to it (the agent isn't running here), so it must not be offered after the next restart.
   */
  forgetResume(): void;
  unbindSession(sessionId: string): void;
}

export interface ControllerOptions {
  paneId: string;
  workspaceId: string;
  fontSize: number;
  scrollback: number;
  theme: Theme;
  autoStart: boolean;
  /** With autoStart: once the shell's prompt is up, type this agent's command (a new agent task). */
  autoAgent?: TaskAgent;
  hooks: ControllerHooks;
}

const INPUT_CHUNK = 32 * 1024;

/**
 * The buffer row where the console's screen starts: the row near `estimate` from which xterm's
 * rows read the same as the redraw's first rows (from its first row with text on; trailing
 * spaces ignored). The nearest such row wins; null when none matches.
 */
export function findRedrawTop(rowText: (y: number) => string | null, redraw: string[], estimate: number, range: number): number | null {
  const want = redraw.map((r) => r.trimEnd());
  const first = want.findIndex((r) => r.trim().length >= 3);
  if (first < 0) return null;
  let best: number | null = null;
  for (let top = Math.max(0, estimate - range); top <= estimate + range; top++) {
    let ok = true;
    for (let j = first; j < want.length && ok; j++) {
      const t = rowText(top + j);
      if (t === null) {
        ok = j > first;
        break;
      }
      // A blank console row says nothing (xterm may still show the old text there).
      if (want[j] !== '' && t.trimEnd() !== want[j]) ok = false;
    }
    if (ok && (best === null || Math.abs(top - estimate) < Math.abs(best - estimate))) best = top;
  }
  return best;
}

interface LayoutBuffer {
  readonly length: number;
  getLine(y: number):
    | {
        isWrapped: boolean;
        getCell(x: number, cell?: CellLike): CellLike | undefined;
      }
    | undefined;
  getNullCell(): CellLike;
}
interface CellLike {
  getChars(): string;
  getWidth(): number;
}

/**
 * The logical lines from `topLine` to the cursor's line as the console lays them out at `cols`:
 * for each, the buffer row it starts on, how many of its leading rows stay in scrollback (the
 * console's top row may continue a line that began above it), and how many rows the console
 * gives it. Trailing spaces are not counted; the cursor's line counts up to the cursor.
 */
export function consoleLayout(buf: LayoutBuffer, topLine: number, cursorLineStart: number, cols: number, charsBeforeTop: number, cursorChars: number): { start: number; skip: number; rows: number; xtermRows: number }[] {
  const out: {
    start: number;
    skip: number;
    rows: number;
    xtermRows: number;
  }[] = [];
  const cell = buf.getNullCell();
  for (let y = topLine; y <= cursorLineStart;) {
    let end = y + 1;
    while (end < buf.length && buf.getLine(end)?.isWrapped) end++;
    const skipChars = y === topLine ? charsBeforeTop : 0;
    let rowsHere: number;
    if (y === cursorLineStart) {
      rowsHere = Math.floor(Math.max(0, cursorChars - skipChars) / cols) + 1;
    } else {
      // Cells up to the last non-space character of the line's last row.
      const last = buf.getLine(end - 1);
      let lastCells = 0;
      for (let x = cols - 1; x >= 0 && last; x--) {
        const c = last.getCell(x, cell);
        const ch = c?.getChars() ?? '';
        if (ch !== '' && ch !== ' ') {
          lastCells = x + Math.max(1, c!.getWidth());
          break;
        }
      }
      const cells = (end - 1 - y) * cols + lastCells - skipChars;
      rowsHere = Math.max(1, Math.ceil(cells / cols));
    }
    out.push({
      start: y,
      skip: Math.ceil(skipChars / cols),
      rows: rowsHere,
      xtermRows: end - y,
    });
    y = end;
  }
  return out;
}

/** `fn`, callable once (later calls do nothing). */
function once(fn: () => void): () => void {
  let called = false;
  return () => {
    if (called) return;
    called = true;
    fn();
  };
}

/** First characters of a buffer row (test diagnostics). */
function rowText(
  buf: {
    getLine(y: number): { translateToString(trim?: boolean): string } | undefined;
  },
  y: number,
): string {
  return buf.getLine(y)?.translateToString(true).slice(0, 14) ?? '';
}

export class TerminalController {
  readonly paneId: string;
  workspaceId: string;
  readonly element: HTMLDivElement;
  private readonly term: Terminal;
  private readonly fit = new FitAddon();
  readonly search = new SearchAddon();
  private readonly hooks: ControllerHooks;
  private snapshot: ControllerSnapshot;
  private readonly listeners = new Set<() => void>();
  private opened = false;
  private disposed = false;
  private resizeObserver: ResizeObserver | null = null;
  // Resizing (see scheduleFit / applyFit / onPtyResized).
  private fitTask: ReturnType<typeof setTimeout> | null = null;
  private lastFitAt = 0;
  /** The size the PTY has confirmed (or was started with). */
  private ptySize = { cols: 0, rows: 0 };
  /** The session's console redraws its screen after each resize (system ConPTY). */
  private repaintsOnResize = false;
  /**
   * Open after a confirmed resize until xterm is ready for the console's redraw: output waits in
   * `pending` meanwhile, and `reader` lays out the redraw's first rows.
   */
  private gate: {
    reader: RedrawReader;
    wait: ReturnType<typeof setTimeout> | null;
    /** Released at the latest then, whatever happens (output must never stall). */
    deadline: ReturnType<typeof setTimeout>;
  } | null = null;
  /** Output not yet given to xterm, in order (see `out`). */
  private pending: { data: string; done?: () => void; offset: number }[] = [];
  /** A piece of `pending` is being parsed by xterm (line-by-line mode). */
  private pumping = false;
  /** Parts of lines the console's top edge cut, still to be removed from scrollback (cut-line.ts). */
  private cutParts: CutLinePart[] = [];
  /** A part is being removed: nothing is written to xterm and it is not resized meanwhile. */
  private removing = false;
  private clearWanted = false;
  /** A size sent to the PTY and not yet confirmed. At most one at a time. */
  private resizeInFlight: { cols: number; rows: number; timer: ReturnType<typeof setTimeout> } | null = null;
  private autoStart: boolean;
  private autoAgent: TaskAgent | null;
  private restartPending: { profileId: string; startIn: StartLocation } | null = null;
  /** One start at a time: concurrent requests join the one in flight. */
  private readonly startGate = new StartGate();
  private titleTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly records = new StatusRecords();
  /** Search highlight colours of the current theme. */
  private decorations: ReturnType<typeof searchDecorations>;
  private isWsl = false;
  /** E2E diagnostics: false = use xterm's DOM renderer instead of WebGL. */
  private testWebgl = true;
  /** Tests only: the numbers behind each anchored resize (off unless enabled). */
  private testResizeLog: Record<string, number | string>[] | null = null;
  /** An exit signal (shell title/prompt back) arrived after the last scan said an agent runs. */
  private processAgentStale = false;
  private titleAgent: AgentId | null = null;
  private reportedThisRun = false;
  /** Last OSC 7501 bodies received (diagnostics for tests; never persisted or logged). */
  readonly statusLog: string[] = [];
  private processAgent: AgentId | null = null;
  private bellPending = false;
  private recentOutput = false;
  private lastOutputAt = 0;
  private lastPoke = 0;
  private resumeTimer: ReturnType<typeof setTimeout> | null = null;
  /** WSL tabs: the resumable agent last reported to the app (see ControllerHooks.wslAgent). */
  private wslResumeAgent: ResumableAgent | null = null;
  private activityTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(options: ControllerOptions) {
    this.paneId = options.paneId;
    this.workspaceId = options.workspaceId;
    this.hooks = options.hooks;
    this.autoStart = options.autoStart;
    this.autoAgent = options.autoAgent ?? null;
    this.snapshot = {
      status: 'idle',
      sessionId: null,
      exitCode: null,
      exitReason: null,
      error: null,
      cwdLabel: null,
      profileLabel: null,
      startIn: 'workspace-root',
      hasStarted: false,
      shellTitle: null,
      agent: null,
      resuming: null,
    };
    this.decorations = searchDecorations(options.theme);
    this.element = document.createElement('div');
    this.element.className = 'terminal-host';
    this.term = new Terminal({
      allowProposedApi: true,
      fontFamily: TERMINAL_FONT,
      fontSize: options.fontSize,
      lineHeight: 1.15,
      scrollback: options.scrollback,
      cursorBlink: true,
      cursorStyle: 'bar',
      theme: xtermTheme(options.theme),
      macOptionIsMeta: false,
      rightClickSelectsWord: false,
      screenReaderMode: false,
      // Rejoin the cursor's wrapped line on resize too. xterm skips it by default because Linux
      // shells redraw their line on SIGWINCH; under the bundled ConPTY nothing redraws it
      // (ConPTY sends nothing after a resize, PowerShell does not repaint its prompt), so a
      // prompt printed in a narrow pane stayed broken at the old width after widening
      // (tests/e2e/diag-reflow.mjs: 2-3 broken rows without this, 0 with it).
      reflowCursorLine: true,
      // ConPTY keeps no scrollback: when a pane grows it adds blank rows at the bottom. Without
      // this xterm (as on Linux) pulls lines back down from its scrollback instead, so its screen
      // and ConPTY's end up rows apart and new output overwrites the wrong lines (output written
      // over an earlier `ls` after resizing). tests/e2e/diag-reflow.mjs compares both screens:
      // 6 of 16 resize cases differed without this, 2 with it (long wrapped command lines whose
      // width changes). Needs the real build number: reflow stays on for builds >= 21376.
      ...(api.windowsBuild > 0 ? { windowsPty: { backend: 'conpty' as const, buildNumber: api.windowsBuild } } : {}),
      // OSC 8 hyperlinks from output: open only on Ctrl+click; main allows http(s) only.
      linkHandler: {
        allowNonHttpProtocols: false,
        activate: (event, uri) => {
          if (event.ctrlKey) void api.openExternal(uri);
        },
      },
    });
    this.term.loadAddon(this.fit);
    this.term.loadAddon(this.search);
    const unicode = new Unicode11Addon();
    this.term.loadAddon(unicode);
    this.term.unicode.activeVersion = '11';
    this.term.loadAddon(
      new WebLinksAddon((event, uri) => {
        // Links open only on a deliberate Ctrl+click, and only http(s) (checked again in main).
        if (event.ctrlKey) void api.openExternal(uri);
      }),
    );
    this.term.attachCustomKeyEventHandler((event) => this.onKey(event));
    this.term.onData((data) => this.sendInput(data));
    // Shells update the title on every prompt; coalesce so it never causes a render per command.
    this.term.onTitleChange((title) => {
      if (this.titleTimer) clearTimeout(this.titleTimer);
      this.titleTimer = setTimeout(() => {
        this.titleTimer = null;
        const clean = title.replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, 200) || null;
        if (clean === this.snapshot.shellTitle) return;
        // The shell put its own title back: the program that set one has exited.
        if (titleLooksLikeShell(clean ?? '')) this.endAgentRun(true, true);
        if (this.isWsl) {
          // WSL only (no process detection): Claude Code's exact title identifies it; a title
          // without its status glyph (the shell's own, e.g. user@host: ~) means it has gone.
          const fromTitle = agentFromTitle(clean);
          if (fromTitle) this.titleAgent = fromTitle;
          else if (this.titleAgent && !hasTitleStatus(clean)) this.endAgentRun(true, true);
        }
        this.update({ shellTitle: clean });
        this.refreshAgent();
        this.pokeAgentScan();
      }, 250);
    });
    // Erase-display (cls, Clear-Host, a program repainting): rows recorded as the console's part
    // of a cut line may now hold anything, so none of them is removed later (cut-line.ts).
    this.term.parser.registerCsiHandler({ final: 'J' }, () => {
      if (this.cutParts.length > 0) this.forgetCutParts();
      return false;
    });
    // Program Status Protocol (OSC 7501): agents report idle / working / blocked / done / error.
    this.term.parser.registerOscHandler(7501, (body) => {
      // Small ring buffer of report bodies for test diagnostics (exposed only via the E2E hook).
      this.statusLog.push(body.slice(0, 200));
      if (this.statusLog.length > 20) this.statusLog.shift();
      const command = parseProgramStatus(body);
      if (!command) return true;
      if (command.type === 'query') {
        // Feature detection: only answered to a live session (it goes to the program's input).
        const id = this.snapshot.sessionId;
        if (id && this.snapshot.status === 'running') api.writeSession(id, PROGRAM_STATUS_REPLY);
        return true;
      }
      if (command.type === 'clear' && command.id === '') {
        // The program withdrew all its status (Claude Code and Codex do this as they exit). It is
        // still a reporting program, so no guessing from output while its process winds down;
        // with no process detection (WSL) nothing identifies it any more, so the run ends.
        this.records.clearAll();
        this.bellPending = false;
        if (!this.processAgent) this.endAgentRun();
        else this.refreshAgent();
        return true;
      }
      if (command.type === 'report') this.reportedThisRun = true;
      if (this.records.apply(command)) this.refreshAgent();
      return true;
    });
    // Shell integration prompt marker (OSC 133;A): the shell's prompt is back, the program ended.
    this.term.parser.registerOscHandler(133, (body) => {
      if (body.startsWith('A')) this.endAgentRun(true, true);
      return false;
    });
    this.term.onBell(() => {
      this.bellPending = true;
      this.refreshAgent();
    });
    this.term.textarea?.addEventListener('focus', () => {
      this.acknowledgeAgent();
      this.hooks.onFocus(this.paneId);
    });
    this.element.addEventListener('contextmenu', (event) => {
      event.preventDefault();
      void this.copyOrPaste();
    });
    this.element.addEventListener('focusin', () => this.hooks.onFocus(this.paneId));
  }

  // ---------------------------------------------------------------- state

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = (): ControllerSnapshot => this.snapshot;

  private update(patch: Partial<ControllerSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...patch };
    for (const l of this.listeners) l();
  }

  get isLive(): boolean {
    return this.snapshot.status === 'running' || this.snapshot.status === 'starting';
  }

  // -------------------------------------------------------------- DOM life

  attach(container: HTMLElement, profileId: string): void {
    if (this.disposed) return;
    if (this.element.parentElement !== container) container.appendChild(this.element);
    if (!this.opened) {
      this.term.open(this.element);
      this.opened = true;
      try {
        // E2E diagnostics can compare against xterm's DOM renderer (setTestTermOptions({ webgl: false })).
        if (!this.testWebgl) throw new Error('WebGL disabled for diagnostics');
        const webgl = new WebglAddon();
        webgl.onContextLoss(() => webgl.dispose());
        this.term.loadAddon(webgl);
      } catch {
        // WebGL unavailable: xterm's DOM renderer remains active.
      }
    }
    if (!this.resizeObserver) {
      this.resizeObserver = new ResizeObserver(() => this.scheduleFit());
      this.resizeObserver.observe(this.element);
    }
    this.scheduleFit();
    if (this.autoStart) {
      this.autoStart = false;
      const agent = this.autoAgent;
      this.autoAgent = null;
      void (agent ? this.startAgent(profileId, agent) : this.start(profileId, 'workspace-root'));
    }
  }

  detach(): void {
    // Keep the terminal and session alive; React may re-parent the pane.
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
  }

  /*
   * Resizing. xterm and the shell must go through the same sizes at the same point in the output
   * stream, or their screens drift apart: the bundled ConPTY never repaints after a resize, so
   * xterm's reflow of what it already shows has to match ConPTY's own.
   *
   *  - ResizeObserver only schedules. The fit runs in a normal task, never inside an animation
   *    frame: xterm's WebGL renderer clears its canvas on resize and repaints in the next frame,
   *    so resizing during a frame showed an empty terminal for one frame (the flicker).
   *  - While a size keeps changing (dragging), one size change at most every RESIZE_INTERVAL_MS,
   *    and never two in flight: intermediate sizes are coalesced, the latest one always wins and
   *    the final one is always applied (also after a cancelled drag).
   *  - With a running session the PTY is resized first. The PTY host confirms with a 'resized'
   *    event sent after all output it read before the resize; xterm then finishes that output and
   *    only then takes the new size (onPtyResized). Output produced at the old size is therefore
   *    laid out at the old size, as it is in ConPTY.
   *  - Without a running session (idle, starting, exited) only xterm is resized.
   */
  private scheduleFit(): void {
    if (this.fitTask || this.disposed) return;
    const wait = Math.max(0, this.lastFitAt + RESIZE_INTERVAL_MS - Date.now());
    this.fitTask = setTimeout(() => {
      this.fitTask = null;
      this.applyFit();
    }, wait);
  }

  /** The size the pane has room for, or null while it is hidden or collapsed. */
  private proposedSize(): { cols: number; rows: number } | null {
    if (this.disposed || !this.opened) return null;
    if (this.element.clientWidth < 20 || this.element.clientHeight < 20) return null;
    const dims = this.fit.proposeDimensions();
    if (!dims || !Number.isFinite(dims.cols) || !Number.isFinite(dims.rows)) return null;
    return { cols: Math.max(2, Math.min(LIMITS.maxCols, dims.cols)), rows: Math.max(1, Math.min(LIMITS.maxRows, dims.rows)) };
  }

  private applyFit(): void {
    // One thing at a time: while xterm is being brought in line with a confirmed size (gate), or
    // a cut line's part is being removed, the next fit waits; both end with scheduleFit().
    if (this.gate || this.removing) return;
    const size = this.proposedSize();
    if (!size) return;
    const id = this.snapshot.sessionId;
    if (!id || this.snapshot.status !== 'running') {
      if (size.cols !== this.term.cols || size.rows !== this.term.rows) {
        this.lastFitAt = Date.now();
        this.term.resize(size.cols, size.rows);
      }
      return;
    }
    // One size change at a time; the latest size is picked up when it is confirmed.
    if (this.resizeInFlight) return;
    if (size.cols === this.ptySize.cols && size.rows === this.ptySize.rows) {
      // The PTY already has it (e.g. back to the same size); xterm follows if it differs.
      if (size.cols !== this.term.cols || size.rows !== this.term.rows) this.resizeTermAfterOutput(size.cols, size.rows);
      return;
    }
    this.lastFitAt = Date.now();
    const { cols, rows } = size;
    // Not assumed applied when sent: wait for the PTY host's confirmation (or give up after a while).
    this.resizeInFlight = { cols, rows, timer: setTimeout(() => this.onPtyResized(cols, rows, false), RESIZE_ACK_TIMEOUT_MS) };
    api.resizeSession(id, cols, rows);
    this.noteResize({ sent: `${cols}x${rows}`, term: `${this.term.cols}x${this.term.rows}` });
  }

  /**
   * The PTY applied a size (`fromHost`), or the confirmation did not arrive in time. Only the
   * request in flight counts.
   */
  private onPtyResized(cols: number, rows: number, fromHost: boolean): void {
    const f = this.resizeInFlight;
    this.noteResize({ confirmed: `${cols}x${rows}`, fromHost: String(fromHost), inFlight: f ? `${f.cols}x${f.rows}` : 'none' });
    if (!f || f.cols !== cols || f.rows !== rows) return;
    clearTimeout(f.timer);
    this.resizeInFlight = null;
    this.ptySize = { cols, rows };
    // Output received before the confirmation belongs to the old size: all of it goes to xterm
    // now, ahead of the resize.
    this.flushPending();
    // The console's redraw for this size follows; hold it until xterm is ready for it.
    if (fromHost && this.repaintsOnResize) this.openGate(cols, rows);
    this.resizeTermAfterOutput(cols, rows);
  }

  /** Resize xterm once it has processed everything written so far, then check for a newer size. */
  private resizeTermAfterOutput(cols: number, rows: number): void {
    if (!this.gate) this.flushPending();
    this.term.write('', () => {
      if (this.disposed) return;
      const done = () => {
        this.releaseGate();
        this.scheduleFit();
      };
      if (cols === this.term.cols && rows === this.term.rows) done();
      else if (this.gate) {
        // Any failure in the anchoring falls back to a plain resize: output must keep flowing.
        const safeDone = once(done);
        try {
          this.resizeAnchoredLikeConsole(cols, rows, safeDone, (error) => {
            this.noteResizeProblem(String(error));
            if (cols !== this.term.cols || rows !== this.term.rows) this.term.resize(cols, rows);
            safeDone();
          });
        } catch (error) {
          this.noteResizeProblem(String(error));
          if (cols !== this.term.cols || rows !== this.term.rows) this.term.resize(cols, rows);
          safeDone();
        }
      } else {
        this.term.resize(cols, rows);
        done();
      }
    });
  }

  /** Output from now on is held (in order) until releaseGate(); the console now has cols x rows. */
  private openGate(cols: number, rows: number): void {
    if (this.gate) return;
    const deadline = setTimeout(() => {
      this.noteResizeProblem('output held too long; released');
      this.releaseGate();
    }, GATE_MAX_MS);
    this.gate = { reader: new RedrawReader(cols, rows, this.term.unicode.activeVersion), wait: null, deadline };
  }

  // ---------------------------------------------------------------- output
  /**
   * Everything written to the terminal goes through here, so that it stays in order while output
   * is held (a resize being applied, a cut line's part being removed) and can be given to xterm
   * line by line while a cut line's part waits to leave the screen.
   */
  private out(data: string, done?: () => void): void {
    if (!this.gate && !this.removing && !this.pumping && this.pending.length === 0 && this.cutParts.length === 0) {
      this.term.write(data, done);
      return;
    }
    this.pending.push({ data, done, offset: 0 });
    this.pump();
  }

  private pump(): void {
    if (this.pumping || this.gate || this.removing || this.disposed) return;
    while (this.pending.length > 0) {
      const item = this.pending[0]!;
      if (this.cutParts.length === 0) {
        this.pending.shift();
        this.term.write(item.offset ? item.data.slice(item.offset) : item.data, item.done);
        continue;
      }
      // A line at a time, so a part is noticed, and removed, the moment it has left the screen
      // (it can only be reached while it is still close above it).
      const feed = item.data.indexOf('\n', item.offset);
      const end = feed < 0 ? item.data.length : feed + 1;
      const piece = item.data.slice(item.offset, end);
      item.offset = end;
      const last = end >= item.data.length;
      if (last) this.pending.shift();
      this.pumping = true;
      this.term.write(piece, () => {
        this.pumping = false;
        if (last) item.done?.();
        if (this.disposed) return;
        this.removeCutParts(() => this.pump());
      });
      return;
    }
  }

  /** Gives everything that waits to xterm at once (ahead of a resize, or when nothing needs watching). */
  private flushPending(): void {
    if (this.removing) return;
    const items = this.pending;
    this.pending = [];
    for (const item of items) this.term.write(item.offset ? item.data.slice(item.offset) : item.data, item.done);
  }

  /**
   * Removes the parts of cut lines that have scrolled off the screen (cut-line.ts), one at a
   * time, then calls `next`. While one is being removed nothing else reaches xterm: output waits
   * in `pending`, fits wait for `removing` to end, and everything given to xterm before is parsed
   * first (the empty write below).
   */
  private removeCutParts(next: () => void): void {
    this.cutParts = this.cutParts.filter((p) => !p.marker.isDisposed);
    const buf = this.term.buffer.active;
    const part = this.cutParts.find((p) => p.marker.line < buf.baseY);
    if (!part || this.gate || this.removing || this.resizeInFlight || this.disposed) {
      next();
      return;
    }
    this.removing = true;
    const finish = (outcome: 'removed' | 'later' | 'gone') => {
      if (this.disposed) return;
      this.noteResize({ cutLinePart: outcome });
      if (outcome !== 'later') {
        this.cutParts = this.cutParts.filter((p) => p !== part);
        part.marker.dispose();
      }
      this.removing = false;
      if (this.clearWanted) this.clear();
      this.scheduleFit();
      // Another one may be ready; 'later' ends the round (it is tried again with the next line).
      if (outcome === 'later') next();
      else this.removeCutParts(next);
    };
    this.term.write('', () => {
      if (this.disposed) return;
      try {
        removeCutLinePart(this.term, part, finish);
      } catch (error) {
        this.noteResizeProblem(String(error));
        finish('gone');
      }
    });
  }

  /** The row at `marker` should now hold the console's part of the line above it: remember it. */
  private recordCutPart(marker: IMarker): void {
    if (this.disposed || marker.isDisposed) return;
    const buf = this.term.buffer.active;
    const part = buf.type === 'normal' ? partOfLineAbove(buf, marker.line) : null;
    this.noteResize({ cutLinePart: part ? 'recorded' : 'not a part', rows: part?.rows ?? 0 });
    if (!part) {
      marker.dispose();
      return;
    }
    this.cutParts.push({ marker, text: part.text });
  }

  private forgetCutParts(): void {
    for (const p of this.cutParts) p.marker.dispose();
    this.cutParts = [];
  }

  /** Tests: problems in the resize path are recorded with the resize log (never thrown). */
  private noteResizeProblem(message: string): void {
    this.noteResize({ problem: message });
  }

  /** Tests only (off unless enabled): an entry in the resize log. */
  private noteResize(entry: Record<string, number | string>): void {
    if (!this.testResizeLog) return;
    this.testResizeLog.push({ t: Math.round(performance.now()), ...entry });
    if (this.testResizeLog.length > 200) this.testResizeLog.shift();
  }

  /** Calls `cb` once with the console redraw's top rows when they have arrived, or null after a wait. */
  private awaitRedraw(cb: (rows: string[] | null) => void): void {
    const g = this.gate;
    if (!g) {
      cb(null);
      return;
    }
    let called = false;
    const finish = (rows: string[] | null) => {
      if (called) return;
      called = true;
      if (g.wait) clearTimeout(g.wait);
      g.wait = null;
      cb(rows);
    };
    g.wait = setTimeout(() => finish(null), REDRAW_WAIT_MS);
    g.reader.onRows(finish);
  }

  /** Stops holding: the output that waited is written (with its flow-control acknowledgements). */
  private releaseGate(): void {
    const g = this.gate;
    if (!g) return;
    this.gate = null;
    if (g.wait) clearTimeout(g.wait);
    clearTimeout(g.deadline);
    g.reader.dispose();
    this.pump();
  }

  /**
   * Resize xterm so that its scrollback ends where the console's screen begins.
   *
   * The system ConPTY redraws its whole screen after a resize, but it has no scrollback: its
   * screen is all it knows. After re-wrapping, the console keeps the text of its top row at the
   * top (blank rows below when lines got shorter) and drops rows at the top only if the text up
   * to the cursor no longer fits. xterm instead keeps the cursor's row where it was and moves the
   * boundary with its scrollback: widening pulls scrollback rows onto the screen, narrowing pushes
   * screen rows into scrollback. The console's redraw then overwrote the pulled rows (lost) or
   * drew the pushed rows a second time (duplicated). Measured: widening a 22-column pane lost 21
   * of 150 numbered lines and doubled 7 (tests/e2e/run-resize.mjs, scenario S).
   *
   * So: re-wrap, then find the console's top row, and make it the top of xterm's screen before
   * the redraw (held meanwhile) is written. The top row is taken from the redraw itself (its first
   * rows, found in xterm's buffer near the expected place); an estimate from xterm's buffer is
   * used only when they cannot be matched. xterm's copy of the screen is not exact enough to rely
   * on alone: the console trims some trailing spaces and keeps others, and sends some wrapped
   * rows without their wrap. The boundary is moved with resizes that keep the screen filled.
   */
  private resizeAnchoredLikeConsole(cols: number, rows: number, done: () => void, fail: (error: unknown) => void): void {
    const term = this.term;
    const buf = term.buffer.active;
    if (buf.type !== 'normal' || cols === term.cols) {
      // Height only: with windowsPty, xterm adds and removes rows at the bottom like the console.
      term.resize(cols, rows);
      done();
      return;
    }
    const oldCols = term.cols;
    const log = this.testResizeLog
      ? {
          from: `${oldCols}x${term.rows}`,
          to: `${cols}x${rows}`,
          baseY0: buf.baseY,
          cursorY0: buf.cursorY,
          top0: rowText(buf, buf.baseY),
        }
      : null;
    // The console's top row. If it continues a line that began in scrollback, the console only
    // knows that continuation; anchor on the line's first row (markers on it survive reflow).
    let start = buf.baseY;
    while (start > 0 && buf.getLine(start)?.isWrapped) start--;
    const charsBeforeTop = (buf.baseY - start) * oldCols;
    const marker = term.registerMarker(start - (buf.baseY + buf.cursorY));
    // The cursor's place in its own line, to estimate its row after re-wrapping (xterm's cursor
    // row after a reflow can be off: a row padded with spaces splits off an extra row).
    let cursorStart = buf.baseY + buf.cursorY;
    while (cursorStart > 0 && buf.getLine(cursorStart)?.isWrapped) cursorStart--;
    const cursorChars = (buf.baseY + buf.cursorY - cursorStart) * oldCols + buf.cursorX;
    const cursorMarker = term.registerMarker(cursorStart - (buf.baseY + buf.cursorY));
    term.resize(cols, rows);
    const anchors = [marker, cursorMarker];
    if (anchors.some((m) => !m || m.isDisposed || m.line < 0) || marker!.line > cursorMarker!.line) {
      for (const m of anchors) m?.dispose();
      done();
      return;
    }
    const topLine = marker!.line;
    const cursorLineStart = cursorMarker!.line;
    for (const m of anchors) m!.dispose();
    // Estimate: rows counted as the console would lay them out without trailing spaces.
    const lines = consoleLayout(buf, topLine, cursorLineStart, cols, charsBeforeTop, cursorChars);
    let drop = Math.max(0, lines.reduce((n, l) => n + l.rows, 0) - rows);
    let estimate = topLine;
    // The row after a line the console's top edge cut (see below), or -1.
    let afterCutLine = -1;
    for (const [i, l] of lines.entries()) {
      if (drop < l.rows) {
        // The console's top row continues a line whose start is in scrollback, split at a point
        // that is not a row boundary at the new width: the console redraws only the rest of the
        // line, as a line of its own. Keep the whole line in scrollback and let the console's
        // part follow it, rather than writing it into the middle of the line. That part then
        // exists twice; it is removed once it has left the screen (cut-line.ts).
        const splitMidRow = i === 0 && charsBeforeTop % cols !== 0 && l.start !== cursorLineStart;
        estimate = splitMidRow ? l.start + l.xtermRows : l.start + l.skip + drop;
        if (splitMidRow) afterCutLine = estimate;
        break;
      }
      drop -= l.rows;
    }
    this.awaitRedraw((redrawRows) => {
      if (this.disposed) return;
      try {
        const found = redrawRows ? findRedrawTop((y) => (y < buf.length ? (buf.getLine(y)?.translateToString(true) ?? '') : null), redrawRows, estimate, rows * 2) : null;
        const top = found ?? estimate;
        if (top === afterCutLine) {
          // The console's part will be drawn on the row that becomes the top of the screen. Mark
          // that row now; what it holds is looked at after the redraw has been written.
          const finish = done;
          done = () => {
            const part = buf.type === 'normal' ? term.registerMarker(top - (buf.baseY + buf.cursorY)) : undefined;
            finish();
            if (part) this.out('', () => this.recordCutPart(part));
          };
        }
        const shift = top - buf.baseY;
        if (log && this.testResizeLog) {
          this.testResizeLog.push({
            ...log,
            baseY1: buf.baseY,
            estimate,
            found: found ?? 'none',
            redrawTop: redrawRows?.find((r) => r.trim()) ?? '',
            shift,
            topText: rowText(buf, top),
          });
          if (this.testResizeLog.length > 200) this.testResizeLog.shift();
        }
        const count = Math.min(Math.abs(shift), rows - 1, shift < 0 ? buf.baseY : rows);
        if (count === 0) {
          done();
          return;
        }
        // Move the boundary while keeping the screen filled (the redraw replaces it right after):
        //  - down by `count`: cursor on the last row, shrink by `count` (rows scroll into
        //    scrollback), grow back (blank rows at the bottom, as on the console);
        //  - up by `count`: cursor `count` rows above the bottom, shrink (the rows below it are
        //    removed), grow back with windowsPty unset (rows come back from scrollback at the top).
        const row = shift > 0 ? rows : rows - count;
        const cursorLine = buf.baseY + buf.cursorY;
        const cursorX = buf.cursorX;
        term.write(`\x1b[${row};1H`, () => {
          if (this.disposed) return;
          try {
            term.resize(cols, rows - count);
            const windowsPty = term.options.windowsPty;
            if (shift < 0) term.options.windowsPty = {};
            try {
              term.resize(cols, rows);
            } finally {
              term.options.windowsPty = windowsPty;
            }
            // Back to the cursor's own line (the redraw positions it again when there is one).
            const y = Math.min(rows - 1, Math.max(0, cursorLine - buf.baseY));
            term.write(`\x1b[${y + 1};${cursorX + 1}H`, () => {
              if (!this.disposed) done();
            });
          } catch (error) {
            fail(error);
          }
        });
      } catch (error) {
        fail(error);
      }
    });
  }

  private clearResizeState(): void {
    // Never lose held output (e.g. the shell's last lines before it exits).
    this.releaseGate();
    if (this.resizeInFlight) clearTimeout(this.resizeInFlight.timer);
    this.resizeInFlight = null;
    this.ptySize = { cols: 0, rows: 0 };
  }

  // --------------------------------------------------------------- session

  /**
   * Starts a new shell session. Safe to call repeatedly or concurrently (a
   * click plus "Start all shells"): while a start is in flight, callers join
   * it; a running terminal is left as it is.
   */
  start(profileId: string, startIn: StartLocation): Promise<StartOutcome> {
    if (this.disposed) return Promise.resolve('skipped');
    if (!this.startGate.busy && this.snapshot.status === 'running') return Promise.resolve('running');
    // Not while a start is in flight: this call then joins it, and it may be a Resume.
    if (!this.startGate.busy) this.hooks.forgetResume();
    return this.startGate.run(() => this.startSession(profileId, startIn));
  }

  /**
   * Resume an agent conversation (TerminalTab.resume): a new PowerShell in the folder the agent
   * ran in, then, once the prompt is up, the resume command typed visibly at it. Nothing else is
   * run. If the agent isn't found running within RESUME_CONFIRM_MS, the pane says so.
   */
  async resume(profileId: string, r: AgentResume): Promise<StartOutcome> {
    if (this.disposed) return 'skipped';
    if (!this.startGate.busy && this.snapshot.status === 'running') return 'running';
    // The exact conversation only in the kind of shell it ran in. Otherwise (or for a WSL record
    // without an id) WSL starts in the workspace folder's Linux path and the agent's own list opens.
    const wsl = profileId.startsWith('wsl:');
    const use = resumeForShell(r, wsl);
    const inFolder = !wsl || use.sessionId !== null;
    const outcome = await this.startGate.run(() => (inFolder ? this.startSession(profileId, 'workspace-root', r.cwd) : this.startSession(profileId, 'workspace-root')));
    if (outcome !== 'running') return outcome;
    this.update({ resuming: { agent: r.agent, phase: 'waiting' } });
    if (!(await this.typeAtPrompt(resumeCommand(use)))) return outcome;
    if (this.resumeTimer) clearTimeout(this.resumeTimer);
    this.resumeTimer = setTimeout(() => {
      this.resumeTimer = null;
      if (this.snapshot.resuming?.phase === 'waiting') this.update({ resuming: { agent: r.agent, phase: 'not-started' } });
    }, RESUME_CONFIRM_MS);
    return outcome;
  }

  /**
   * A new agent task's first terminal: start the shell in the workspace (task) folder, then type the
   * agent's command at its prompt, visibly, as the user would. Only the agent's name is typed.
   */
  async startAgent(profileId: string, agent: TaskAgent): Promise<StartOutcome> {
    if (this.disposed) return 'skipped';
    const outcome = await this.start(profileId, 'workspace-root');
    if (outcome !== 'running') return outcome;
    await this.typeAtPrompt(taskAgentCommand(agent));
    return outcome;
  }

  /** Waits for the shell's prompt (output, then a quiet moment; at most 15 s) and types `command`. */
  private async typeAtPrompt(command: string): Promise<boolean> {
    const started = Date.now();
    // The prompt is up when output has started and then been quiet for a moment.
    while (!this.disposed && this.snapshot.status === 'running' && Date.now() - started < 15_000) {
      if (this.lastOutputAt >= started && Date.now() - this.lastOutputAt >= 600) break;
      await new Promise((res) => setTimeout(res, 100));
    }
    const id = this.snapshot.sessionId;
    if (this.disposed || !id || this.snapshot.status !== 'running') return false;
    api.writeSession(id, `${command}\r`);
    this.lastPoke = 0;
    this.pokeAgentScan();
    return true;
  }

  /** Hide the "didn't start" note. */
  dismissResuming(): void {
    if (this.resumeTimer) clearTimeout(this.resumeTimer);
    this.resumeTimer = null;
    if (this.snapshot.resuming) this.update({ resuming: null });
  }

  private async startSession(profileId: string, startIn: StartLocation, startPath?: string): Promise<StartOutcome> {
    this.update({ status: 'starting', error: null, exitCode: null, exitReason: null, startIn });
    this.isWsl = profileId.startsWith('wsl:');
    this.wslResumeAgent = null;
    if (this.snapshot.hasStarted) this.out('\r\n\x1b[2m──── new session ────\x1b[0m\r\n');
    this.clearResizeState();
    // Not running yet: this sizes xterm only, so the shell starts at the pane's real size.
    this.applyFit();
    const startSize = { cols: Math.max(2, this.term.cols), rows: Math.max(1, this.term.rows) };
    try {
      await this.hooks.beforeStart();
      const result = await api.createSession({
        workspaceId: this.workspaceId,
        paneId: this.paneId,
        profileId,
        startIn,
        ...startSize,
        shortPrompt: this.hooks.shortPrompt(),
        ...(startPath !== undefined ? { startPath } : {}),
      });
      if (this.disposed) {
        if (result.ok) void api.closeSession(result.sessionId);
        return 'skipped';
      }
      if (!result.ok) {
        this.update({ status: 'failed', error: result.error });
        return 'failed';
      }
      // The PTY started at startSize; if the pane changed meanwhile, the next fit resizes it.
      this.ptySize = startSize;
      this.repaintsOnResize = result.repaintsOnResize;
      this.update({
        status: 'running',
        sessionId: result.sessionId,
        cwdLabel: result.cwdLabel,
        profileLabel: result.profileLabel,
        hasStarted: true,
      });
      this.hooks.bindSession(result.sessionId, this);
      this.lastPoke = 0;
      this.pokeAgentScan(); // a script or alias may start an agent right away
      this.scheduleFit();
      return 'running';
    } catch {
      if (this.disposed) return 'skipped';
      this.update({ status: 'failed', error: { code: 'INTERNAL', message: 'Starting the shell failed unexpectedly.' } });
      return 'failed';
    }
  }

  /** Starts a fresh shell; a running session is ended first. */
  restart(profileId: string, startIn: StartLocation = this.snapshot.startIn): void {
    if (this.snapshot.status === 'running' && this.snapshot.sessionId) {
      this.restartPending = { profileId, startIn };
      void api.closeSession(this.snapshot.sessionId);
      return;
    }
    if (this.startGate.busy) return;
    void this.start(profileId, startIn);
  }

  handleEvent(event: SessionEvent): void {
    if (this.disposed || event.sessionId !== this.snapshot.sessionId) return;
    if (event.type === 'data') {
      const chars = event.data.length;
      const id = event.sessionId;
      // After a confirmed resize the console's redraw is in this output: the reader lays it out.
      this.gate?.reader.feed(event.data);
      this.out(event.data, () => api.ackSession(id, chars));
      this.noteOutput();
      return;
    }
    if (event.type === 'resized') {
      this.onPtyResized(event.cols, event.rows, true);
      return;
    }
    this.hooks.unbindSession(event.sessionId);
    this.clearResizeState();
    // Process exit ends every status record and detection for this session.
    this.processAgent = null;
    this.endAgentRun(false);
    const code = event.exitCode;
    const label = event.reason ? event.reason : code === null ? 'process ended' : `process exited with code ${code}`;
    this.out(`\r\n\x1b[2m[${label}]\x1b[0m\r\n`);
    if (this.resumeTimer) clearTimeout(this.resumeTimer);
    this.resumeTimer = null;
    this.update({ status: 'exited', exitCode: code, exitReason: event.reason ?? null, sessionId: null, agent: null, resuming: null });
    const again = this.restartPending;
    this.restartPending = null;
    if (again) void this.start(again.profileId, again.startIn);
  }

  // ------------------------------------------------------------ AI agents

  /** Main found (or lost) an agent CLI among this session's processes. */
  setProcessAgent(agent: AgentId | null): void {
    if (agent === this.processAgent) return;
    if (agent && agent === this.snapshot.resuming?.agent) this.dismissResuming(); // the resumed agent is running
    const previous = this.processAgent;
    this.processAgent = agent;
    this.processAgentStale = false;
    // The agent process is gone (or replaced by another one): nothing of its run carries over.
    // Not on null -> agent: an agent's first reports often arrive before the scan finds it.
    if (previous) this.endAgentRun(false);
    this.refreshAgent();
  }

  /**
   * The agent's run is over (process gone, shell prompt or title back, `clear`, session exit):
   * forget its identity, status, session title, bell and protocol use, so the next program in
   * this terminal starts clean.
   */
  private endAgentRun(refresh = true, agentExited = false): void {
    // The scan runs every few seconds: until it confirms, its last "agent running" is stale.
    if (agentExited && this.processAgent) {
      this.processAgentStale = true;
      this.pokeAgentScan();
    }
    this.records.clearAll();
    this.titleAgent = null;
    this.reportedThisRun = false;
    this.bellPending = false;
    this.recentOutput = false;
    if (refresh) this.refreshAgent();
  }

  /**
   * The user looked at or typed into this terminal: a pending bell and finished results
   * (done/error) count as seen. What the agent is waiting for (blocked) stays until it reports otherwise.
   */
  acknowledgeAgent(): void {
    const changed = this.bellPending || this.records.acknowledge();
    this.bellPending = false;
    if (changed) this.refreshAgent();
  }

  private noteOutput(): void {
    this.lastOutputAt = Date.now();
    // Activity only matters for the heuristic (agent identified, not reporting status itself).
    if (this.records.size > 0 || this.reportedThisRun || !this.snapshot.agent) return;
    if (!this.recentOutput) {
      this.recentOutput = true;
      this.refreshAgent();
    }
    if (!this.activityTimer) {
      const check = () => {
        if (Date.now() - this.lastOutputAt >= QUIET_AFTER_MS) {
          this.activityTimer = null;
          this.recentOutput = false;
          this.refreshAgent();
        } else {
          this.activityTimer = setTimeout(check, QUIET_AFTER_MS);
        }
      };
      this.activityTimer = setTimeout(check, QUIET_AFTER_MS);
    }
  }

  private refreshAgent(): void {
    if (this.disposed) return;
    const view =
      this.snapshot.status === 'running'
        ? deriveAgentView({
            summary: this.records.summary(),
            processAgent: this.processAgentStale ? null : this.processAgent,
            processDetection: !this.isWsl,
            titleAgent: this.titleAgent,
            shellTitle: this.snapshot.shellTitle,
            bellPending: this.bellPending,
            recentOutput: this.recentOutput,
            reportedThisRun: this.reportedThisRun,
          })
        : null;
    if (JSON.stringify(view) !== JSON.stringify(this.snapshot.agent)) this.update({ agent: view });
    // WSL: only while the shell runs (an exit, including SplitNest quitting, keeps the record).
    if (this.isWsl && this.snapshot.status === 'running') {
      const want: ResumableAgent | null = isResumableAgent(view?.id) ? view.id : null;
      if (want && want === this.snapshot.resuming?.agent) this.dismissResuming(); // the resumed agent is running
      if (want !== this.wslResumeAgent) {
        this.wslResumeAgent = want;
        this.hooks.wslAgent(want);
      }
    }
  }

  private pokeAgentScan(): void {
    const id = this.snapshot.sessionId;
    if (!id || Date.now() - this.lastPoke < 1500) return;
    this.lastPoke = Date.now();
    api.pokeAgentScan(id);
  }

  private sendInput(data: string): void {
    const id = this.snapshot.sessionId;
    if (!id || this.snapshot.status !== 'running') return;
    if (this.bellPending) this.acknowledgeAgent();
    for (let i = 0; i < data.length; i += INPUT_CHUNK) api.writeSession(id, data.slice(i, i + INPUT_CHUNK));
  }

  /** Ends the session (if any) and releases every resource. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.resumeTimer) clearTimeout(this.resumeTimer);
    const id = this.snapshot.sessionId;
    if (id) {
      this.hooks.unbindSession(id);
      void api.closeSession(id);
    }
    if (this.fitTask) clearTimeout(this.fitTask);
    // The session is closing: held output is dropped, not written to a terminal being disposed.
    this.pending = [];
    this.clearResizeState();
    this.forgetCutParts();
    if (this.titleTimer) clearTimeout(this.titleTimer);
    if (this.activityTimer) clearTimeout(this.activityTimer);
    this.resizeObserver?.disconnect();
    this.term.dispose();
    this.element.remove();
    this.listeners.clear();
  }

  // ------------------------------------------------------------ interaction

  private onKey(event: KeyboardEvent): boolean {
    if (event.type !== 'keydown') return true;
    const key = event.key.toLowerCase();
    if (event.ctrlKey && !event.altKey && !event.shiftKey && key === 'c' && this.term.hasSelection()) {
      void this.copySelection();
      event.preventDefault();
      return false;
    }
    if (event.ctrlKey && !event.altKey && key === 'v') {
      // Let the browser raise a native paste event, which xterm handles (bracketed paste aware).
      return false;
    }
    if (event.ctrlKey && event.shiftKey && !event.altKey && key === 'c') {
      void this.copySelection();
      event.preventDefault();
      return false;
    }
    if (this.hooks.onShortcut(event)) {
      event.preventDefault();
      event.stopPropagation();
      return false;
    }
    return true;
  }

  async copySelection(): Promise<boolean> {
    const text = this.term.getSelection();
    if (!text) return false;
    await api.writeClipboard(text);
    this.term.clearSelection();
    return true;
  }

  async paste(): Promise<void> {
    const text = await api.readClipboard();
    if (text) this.term.paste(text);
    this.term.focus();
  }

  /** Inserts text at the prompt like a paste (bracketed when supported); never presses Enter. */
  insertText(text: string): boolean {
    if (this.snapshot.status !== 'running') return false;
    this.term.paste(text);
    this.term.focus();
    return true;
  }

  private async copyOrPaste(): Promise<void> {
    if (!(await this.copySelection())) await this.paste();
  }

  focus(): void {
    this.term.focus();
  }

  setFontSize(size: number): void {
    this.term.options.fontSize = size;
    this.scheduleFit();
  }

  setScrollback(lines: number): void {
    this.term.options.scrollback = lines;
  }

  /** Tests: the terminal's current background colour. */
  themeBackground(): string | undefined {
    return this.term.options.theme?.background;
  }

  /** Settings › Appearance: colours (and search highlights) of this terminal. */
  setTheme(theme: Theme): void {
    this.term.options.theme = xtermTheme(theme);
    this.decorations = searchDecorations(theme);
  }

  clear(): void {
    if (this.removing) {
      // Not in the middle of removing a cut line's part: right after it.
      this.clearWanted = true;
      return;
    }
    this.clearWanted = false;
    this.forgetCutParts();
    this.term.clear();
  }

  /** Test support: plain text of the active buffer and terminal geometry. */
  /** E2E diagnostics: switch resize-related options to compare behaviours in one build. */
  setTestTermOptions(o: { reflowCursorLine?: boolean; windowsPtyBuild?: number; webgl?: boolean; resizeLog?: boolean }): void {
    if (o.resizeLog !== undefined) this.testResizeLog = o.resizeLog ? [] : null;
    // Only effective before the terminal is opened (the renderer is chosen in attach()).
    if (o.webgl !== undefined) this.testWebgl = o.webgl;
    if (o.reflowCursorLine !== undefined) this.term.options.reflowCursorLine = o.reflowCursorLine;
    if (o.windowsPtyBuild !== undefined) this.term.options.windowsPty = o.windowsPtyBuild > 0 ? { backend: 'conpty', buildNumber: o.windowsPtyBuild } : {};
  }

  /** Tests: the anchored resizes recorded since the log was enabled. */
  testResizes(): Record<string, number | string>[] {
    return this.testResizeLog ?? [];
  }

  /** Cursor row inside the viewport (tests compare it with what the shell reports). */
  cursorRow(): number {
    return this.term.buffer.active.cursorY;
  }

  /** Tests: cursor, viewport position and size, as xterm has them. */
  testGeometry(): { cursorX: number; cursorY: number; cols: number; rows: number; atBottom: boolean; renderer: 'webgl' | 'dom'; topLine: string } {
    const b = this.term.buffer.active;
    // The logical line that starts on the screen's top row ('' when that row continues a line).
    let topLine = '';
    if (!b.getLine(b.baseY)?.isWrapped) {
      for (let y = b.baseY; y < b.length; y++) {
        const line = b.getLine(y);
        if (!line || (y > b.baseY && !line.isWrapped)) break;
        topLine += line.translateToString(true);
      }
    }
    return { cursorX: b.cursorX, cursorY: b.cursorY, cols: this.term.cols, rows: this.term.rows, atBottom: b.viewportY === b.baseY, renderer: this.element.querySelector('canvas') ? 'webgl' : 'dom', topLine };
  }

  /** Tests: session output as if it had come from the PTY host (same path, including holds). */
  testFeed(data: string): boolean {
    const id = this.snapshot.sessionId;
    if (!id || this.disposed) return false;
    this.handleEvent({ type: 'data', sessionId: id, data });
    return true;
  }

  /** Buffer text for tests. `raw` keeps rows exactly as displayed (no joining of wrapped rows). */
  inspect(maxLines = 400, raw = false): { text: string; cols: number; rows: number; alternate: boolean } {
    const buffer = this.term.buffer.active;
    const lines: string[] = [];
    const start = Math.max(0, buffer.length - maxLines);
    for (let i = start; i < buffer.length; i++) {
      const line = buffer.getLine(i);
      const text = line?.translateToString(true) ?? '';
      // Join soft-wrapped rows back into one logical line.
      if (!raw && line?.isWrapped && lines.length > 0) lines[lines.length - 1] += text;
      else lines.push(text);
    }
    return { text: lines.join('\n'), cols: this.term.cols, rows: this.term.rows, alternate: buffer.type === 'alternate' };
  }

  findNext(query: string, caseSensitive: boolean): boolean {
    return this.search.findNext(query, { caseSensitive, incremental: false, decorations: this.decorations });
  }

  findPrevious(query: string, caseSensitive: boolean): boolean {
    return this.search.findPrevious(query, { caseSensitive, decorations: this.decorations });
  }

  clearSearch(): void {
    this.search.clearDecorations();
    this.term.clearSelection();
  }
}
