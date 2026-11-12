// Owns pseudoterminal processes. Runs inside the PTY host utility process and
// is also driven directly by integration tests with real node-pty.
import type { IDisposable, IPty, IPtyForkOptions, IWindowsPtyForkOptions } from 'node-pty';
import { FLOW, type HostEvent, type HostRequest, type SpawnSpec } from '../shared/pty-protocol';

export interface PtyModule {
  spawn(file: string, args: string[], options: IPtyForkOptions | IWindowsPtyForkOptions): IPty;
}

interface Session {
  id: string;
  pty: IPty;
  pending: string[];
  pendingChars: number;
  unacked: number;
  paused: boolean;
  batchTimer: NodeJS.Timeout | null;
  killTimer: NodeJS.Timeout | null;
  killRequested: boolean;
  exited: boolean;
  disposables: IDisposable[];
  /** When the last resize was applied, and when output last arrived (ms timestamps). */
  resizedAt: number;
  dataAt: number;
  /** Output has arrived since the last resize was applied (its redraw can come within the same ms). */
  dataSinceResize: boolean;
  /** A resize held back until the console's redraw for the previous one has arrived. */
  heldResize: { cols: number; rows: number; timer: NodeJS.Timeout } | null;
}

export interface SessionManagerOptions {
  env?: Record<string, string>;
  /** Grace period to collect trailing output after the process exits. */
  exitFlushMs?: number;
  /** If a killed PTY does not report exit within this time, report it anyway. */
  killTimeoutMs?: number;
}

/**
 * Variables that describe the session SplitNest was *launched from*, not the user's environment.
 * They appear when SplitNest is started from inside an AI agent CLI or another terminal
 * (never when launched from Start or Explorer) and must not reach new shells: an agent run in a
 * SplitNest tab would believe it is a child of that other session (Claude Code: "Transcript
 * saving is off — inherited CLAUDE_CODE_CHILD_SESSION marker"), and some carry that session's
 * private IPC socket/token. Exact names only, so user configuration such as
 * CLAUDE_CODE_USE_BEDROCK or API keys the user set is kept.
 */
const PARENT_SESSION_VARS = new Set(
  [
    // Claude Code session markers and IPC
    'CLAUDECODE',
    'CLAUDE_PID',
    'CLAUDE_CODE_ENTRYPOINT',
    'CLAUDE_CODE_CHILD_SESSION',
    'CLAUDE_CODE_SESSION_ID',
    'CLAUDE_CODE_SESSION_ATTENDED',
    'CLAUDE_CODE_MESSAGING_SOCKET',
    'CLAUDE_CODE_MESSAGING_TOKEN',
    'CLAUDE_CODE_TUI_JUST_SWITCHED',
    'CLAUDE_CODE_SSE_PORT',
    // Codex sandbox markers
    'CODEX_SANDBOX',
    'CODEX_SANDBOX_NETWORK_DISABLED',
    // Generic "running under an agent" markers
    'AI_AGENT',
    'WARP_CLI_AGENT_PROTOCOL_VERSION',
    // Another terminal's identity (SplitNest sets its own TERM_PROGRAM below)
    'TERM_PROGRAM_VERSION',
    'WT_SESSION',
    'WT_PROFILE_ID',
    // VS Code terminal hooks (point at that VS Code window's IPC)
    'VSCODE_INJECTION',
    'VSCODE_GIT_IPC_HANDLE',
    'VSCODE_GIT_ASKPASS_NODE',
    'VSCODE_GIT_ASKPASS_MAIN',
    'VSCODE_GIT_ASKPASS_EXTRA_ARGS',
    'VSCODE_IPC_HOOK_CLI',
  ].map((n) => n.toUpperCase()),
);

/** Removes variables that belong to this app's runtime or to the session it was launched from. */
export function buildShellEnv(source: NodeJS.ProcessEnv): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined) continue;
    if (/^ELECTRON_/i.test(key) || /^VITE_/i.test(key) || /^NODE_ENV$/i.test(key)) continue;
    if (/^TW_E2E/i.test(key)) continue; // SplitNest's own test switches
    if (PARENT_SESSION_VARS.has(key.toUpperCase())) continue;
    env[key] = value;
  }
  // GIT_ASKPASS only when VS Code set it (its helper needs that VS Code window); a user's own stays.
  const askpassMain = Object.keys(source).some((k) => k.toUpperCase() === 'VSCODE_GIT_ASKPASS_MAIN');
  if (askpassMain) for (const k of Object.keys(env)) if (k.toUpperCase() === 'GIT_ASKPASS') delete env[k];
  env.TERM_PROGRAM = 'SplitNest';
  env.COLORTERM = 'truecolor';
  return env;
}

/** Adds per-session variables. `WSLENV` is a `:`-separated list, so it is extended rather than replaced. */
export function mergeSessionEnv(base: Record<string, string>, extra: Record<string, string> | undefined): Record<string, string> {
  if (!extra) return base;
  const env = { ...base };
  for (const [key, value] of Object.entries(extra)) {
    const existingKey = Object.keys(env).find((k) => k.toUpperCase() === key.toUpperCase()) ?? key;
    if (key.toUpperCase() === 'WSLENV' && env[existingKey]) {
      const parts = env[existingKey]!.split(':').filter(Boolean);
      for (const item of value.split(':')) if (item && !parts.includes(item)) parts.push(item);
      env[existingKey] = parts.join(':');
    } else {
      env[existingKey] = value;
    }
  }
  return env;
}

function errorMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return raw.split('\n')[0]?.slice(0, 300) ?? 'unknown error';
}

/** Diagnostics only: TW_DIAG_CONPTY=bundled selects node-pty's bundled conpty.dll. */
const bundledConpty = process.platform === 'win32' && process.env.TW_DIAG_CONPTY === 'bundled';
/** The system ConPTY redraws its whole screen after each resize. */
const repaintsOnResize = process.platform === 'win32' && !bundledConpty;
/**
 * After a resize the console sends its redraw a few milliseconds later. The next resize waits
 * until that output has arrived and gone quiet (or the cap passes): applied earlier, the redraw
 * for the old size would reach the terminal after it had already taken the new size, and be laid
 * out at the wrong width (seen as a garbled row at the scrollback boundary during divider drags).
 */
const REDRAW_QUIET_MS = 30;
const REDRAW_MAX_WAIT_MS = 250;

export class SessionManager {
  private readonly sessions = new Map<string, Session>();
  private readonly env: Record<string, string>;
  private readonly exitFlushMs: number;
  private readonly killTimeoutMs: number;

  constructor(
    private readonly pty: PtyModule,
    private readonly emit: (event: HostEvent) => void,
    options: SessionManagerOptions = {},
  ) {
    this.env = options.env ?? buildShellEnv(process.env);
    this.exitFlushMs = options.exitFlushMs ?? 60;
    this.killTimeoutMs = options.killTimeoutMs ?? 4000;
  }

  get size(): number {
    return this.sessions.size;
  }

  has(sessionId: string): boolean {
    return this.sessions.has(sessionId);
  }

  handle(request: HostRequest): void {
    switch (request.type) {
      case 'spawn':
        this.spawn(request.spec);
        break;
      case 'input':
        this.write(request.sessionId, request.data);
        break;
      case 'resize':
        this.resize(request.sessionId, request.cols, request.rows);
        break;
      case 'ack':
        this.ack(request.sessionId, request.chars);
        break;
      case 'kill':
        this.kill(request.sessionId);
        break;
      case 'kill-all':
        this.killAll();
        break;
    }
  }

  spawn(spec: SpawnSpec): void {
    if (this.sessions.has(spec.sessionId)) {
      this.emit({ type: 'spawn-failed', sessionId: spec.sessionId, message: 'duplicate session id' });
      return;
    }
    let pty: IPty;
    try {
      pty = this.pty.spawn(spec.file, spec.args, {
        name: 'xterm-256color',
        cols: spec.cols,
        rows: spec.rows,
        cwd: spec.cwd,
        env: mergeSessionEnv(this.env, spec.env),
        // Windows' own (system) ConPTY, not node-pty's bundled conpty.dll 1.23. The bundled one
        // never repaints after a resize: it relies on the terminal reflowing its screen exactly as
        // conhost does, and xterm.js reflows differently (trailing blanks of finished lines, the
        // cursor column), so output ended up on the wrong rows after resizing. The system ConPTY
        // repaints the screen after a resize. tests/e2e/run-resize.mjs compares xterm's screen with
        // the console's own: 30 of 64 checks passed with the bundled one, 63 of 64 with this one.
        // Its kill path would fork a helper; fork-guard.ts makes that safe (no second instance).
        // Diagnostics: TW_DIAG_CONPTY=bundled selects the bundled one again.
        useConptyDll: bundledConpty,
      });
    } catch (error) {
      this.emit({ type: 'spawn-failed', sessionId: spec.sessionId, message: errorMessage(error) });
      return;
    }
    const session: Session = {
      id: spec.sessionId,
      pty,
      pending: [],
      pendingChars: 0,
      unacked: 0,
      paused: false,
      batchTimer: null,
      killTimer: null,
      killRequested: false,
      exited: false,
      disposables: [],
      resizedAt: 0,
      dataAt: 0,
      dataSinceResize: false,
      heldResize: null,
    };
    this.sessions.set(spec.sessionId, session);
    session.disposables.push(pty.onData((data) => this.onData(session, data)));
    session.disposables.push(pty.onExit(({ exitCode }) => this.onExit(session, exitCode)));
    // The system ConPTY redraws its screen after every resize; the bundled one never does.
    this.emit({ type: 'spawned', sessionId: spec.sessionId, pid: pty.pid, repaintsOnResize: process.platform === 'win32' && !bundledConpty });
  }

  write(sessionId: string, data: string): void {
    const s = this.sessions.get(sessionId);
    if (!s || s.exited || s.killRequested) return;
    s.pty.write(data);
  }

  resize(sessionId: string, cols: number, rows: number): void {
    const s = this.sessions.get(sessionId);
    if (!s || s.exited || s.killRequested) return;
    if (s.heldResize) {
      // Only the newest size matters; it is confirmed once applied.
      s.heldResize.cols = cols;
      s.heldResize.rows = rows;
      return;
    }
    const wait = this.redrawWait(s);
    if (wait > 0) {
      s.heldResize = { cols, rows, timer: setTimeout(() => this.applyHeldResize(s), wait) };
      return;
    }
    this.applyResize(s, cols, rows);
  }

  /** How long the console's redraw for the previous resize may still be arriving (0: done). */
  private redrawWait(s: Session): number {
    if (!repaintsOnResize || s.resizedAt === 0) return 0;
    const now = Date.now();
    const sinceResize = now - s.resizedAt;
    if (sinceResize >= REDRAW_MAX_WAIT_MS) return 0;
    if (s.dataSinceResize && now - s.dataAt >= REDRAW_QUIET_MS) return 0;
    return Math.min(REDRAW_QUIET_MS, REDRAW_MAX_WAIT_MS - sinceResize);
  }

  private applyHeldResize(s: Session): void {
    const held = s.heldResize;
    if (!held) return;
    if (s.exited || s.killRequested) {
      s.heldResize = null;
      return;
    }
    const wait = this.redrawWait(s);
    if (wait > 0) {
      held.timer = setTimeout(() => this.applyHeldResize(s), wait);
      return;
    }
    s.heldResize = null;
    this.applyResize(s, held.cols, held.rows);
  }

  private applyResize(s: Session, cols: number, rows: number): void {
    // Output read so far was produced at the old size: send it before the confirmation.
    this.flush(s);
    try {
      s.pty.resize(cols, rows);
    } catch {
      // The process may have exited between checks; exit is reported separately.
    }
    s.resizedAt = Date.now();
    s.dataSinceResize = false;
    this.emit({ type: 'resized', sessionId: s.id, cols, rows });
  }

  /** The renderer reports characters it has finished rendering. */
  ack(sessionId: string, chars: number): void {
    const s = this.sessions.get(sessionId);
    if (!s) return;
    s.unacked = Math.max(0, s.unacked - chars);
    if (s.paused && s.unacked <= FLOW.lowWatermark) this.resumePty(s);
  }

  kill(sessionId: string): void {
    const s = this.sessions.get(sessionId);
    if (!s || s.killRequested) return;
    s.killRequested = true;
    // Drain output so ConPTY can shut down; output after a close request is not delivered.
    this.resumePty(s);
    this.clearBatch(s);
    this.clearHeldResize(s);
    s.pending = [];
    s.pendingChars = 0;
    if (!s.exited) {
      try {
        s.pty.kill();
      } catch {
        // Already gone.
      }
    }
    s.killTimer = setTimeout(() => this.finish(s, null), this.killTimeoutMs);
  }

  killAll(): void {
    for (const id of [...this.sessions.keys()]) this.kill(id);
  }

  private onData(s: Session, data: string): void {
    if (s.killRequested) return;
    s.dataAt = Date.now();
    s.dataSinceResize = true;
    s.pending.push(data);
    s.pendingChars += data.length;
    if (s.pendingChars >= FLOW.maxBatchChars) this.flush(s);
    else if (!s.batchTimer) s.batchTimer = setTimeout(() => this.flush(s), FLOW.batchMs);
  }

  private flush(s: Session): void {
    this.clearBatch(s);
    if (s.pending.length === 0) return;
    const data = s.pending.join('');
    s.pending = [];
    s.pendingChars = 0;
    s.unacked += data.length;
    this.emit({ type: 'data', sessionId: s.id, data });
    if (!s.paused && !s.exited && s.unacked >= FLOW.highWatermark) {
      try {
        s.pty.pause();
        s.paused = true;
      } catch {
        // Ignore: pausing is an optimisation, not required for correctness.
      }
    }
  }

  private onExit(s: Session, exitCode: number): void {
    if (s.exited) return;
    s.exited = true;
    // ConPTY can deliver the last output shortly after the exit notification.
    setTimeout(() => this.finish(s, exitCode), this.exitFlushMs);
  }

  private finish(s: Session, exitCode: number | null): void {
    if (!this.sessions.has(s.id)) return;
    this.clearHeldResize(s);
    if (!s.killRequested) this.flush(s);
    this.clearBatch(s);
    if (s.killTimer) clearTimeout(s.killTimer);
    for (const d of s.disposables) d.dispose();
    s.disposables = [];
    this.sessions.delete(s.id);
    this.emit({ type: 'exit', sessionId: s.id, exitCode });
  }

  private resumePty(s: Session): void {
    if (!s.paused) return;
    s.paused = false;
    try {
      s.pty.resume();
    } catch {
      // Ignore.
    }
  }

  private clearHeldResize(s: Session): void {
    if (s.heldResize) clearTimeout(s.heldResize.timer);
    s.heldResize = null;
  }

  private clearBatch(s: Session): void {
    if (s.batchTimer) {
      clearTimeout(s.batchTimer);
      s.batchTimer = null;
    }
  }
}
