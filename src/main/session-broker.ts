// Session authorization and ownership. Every terminal session belongs to one
// renderer (webContents) and one workspace pane. Requests for sessions the
// caller does not own are rejected.
import { randomUUID } from 'node:crypto';
import type { HostEvent, HostRequest } from '../shared/pty-protocol';
import {
  LIMITS,
  type AppError,
  type CreateSessionRequest,
  type CreateSessionResult,
  type Result,
  type SessionEvent,
} from '../shared/types';
import { isId, isInt, validateCreateSessionRequest, ValidationError } from '../shared/validation';
import type { LaunchSpec } from './shells';
import { newWslMarker, withWslMarker } from './wsl-processes';

export interface HostTransport {
  send(request: HostRequest): void;
}

export type LaunchResolver = (request: CreateSessionRequest) => Promise<Result<{ launch: LaunchSpec; profileLabel: string }>>;

/** Delivers an event to the owning renderer. Returns false when the owner no longer exists. */
export type Deliver = (ownerId: number, event: SessionEvent) => boolean;

export interface BrokerLog {
  info(message: string): void;
  warn(message: string): void;
}

interface SessionRecord {
  id: string;
  ownerId: number;
  workspaceId: string;
  paneId: string;
  status: 'starting' | 'running' | 'closing';
  /** Process id of the shell (set once spawned). */
  pid?: number;
  /** WSL sessions: Linux processes are not visible as Windows processes. */
  wsl?: boolean;
  /** WSL sessions: the distribution, and the marker its processes inherit (wsl-processes.ts). */
  distro?: string;
  marker?: string;
  /** WSL sessions started in a folder: that folder's Linux path (what `--cd` got). */
  linuxCwd?: string;
  /** The folder the shell was started in. */
  cwd?: string;
}

export interface SessionProcess {
  sessionId: string;
  ownerId: number;
  pid: number;
  wsl: boolean;
  /** The folder the shell started in (Windows path; for WSL, what was passed to wsl.exe). */
  cwd: string;
  /** WSL sessions: the distribution and the marker its Linux processes carry. */
  distro?: string;
  marker?: string;
  /** WSL sessions started in a folder: its Linux path. */
  linuxCwd?: string;
}

interface PendingSpawn {
  resolve(result: { ok: true; pid: number; repaintsOnResize: boolean } | { ok: false; message: string }): void;
  timer: NodeJS.Timeout;
}

export interface BrokerOptions {
  spawnTimeoutMs?: number;
  idFactory?: () => string;
  /** Output arrived from a session in this workspace (Git status checks follow terminal activity). */
  onOutput?: (workspaceId: string) => void;
}

const forbidden = (message: string): AppError => ({ code: 'FORBIDDEN', message });

export class SessionBroker {
  private readonly sessions = new Map<string, SessionRecord>();
  private readonly pending = new Map<string, PendingSpawn>();
  private readonly creating = new Set<string>();
  private readonly exitWaiters = new Set<() => void>();
  private readonly spawnTimeoutMs: number;
  private readonly idFactory: () => string;
  private readonly onOutput: (workspaceId: string) => void;

  constructor(
    private readonly transport: HostTransport,
    private readonly resolveLaunch: LaunchResolver,
    private readonly deliver: Deliver,
    private readonly log: BrokerLog,
    options: BrokerOptions = {},
  ) {
    this.spawnTimeoutMs = options.spawnTimeoutMs ?? 15000;
    this.idFactory = options.idFactory ?? randomUUID;
    this.onOutput = options.onOutput ?? (() => undefined);
  }

  liveCount(ownerId?: number): number {
    let n = 0;
    for (const s of this.sessions.values()) if (ownerId === undefined || s.ownerId === ownerId) n++;
    return n;
  }

  /** Sessions (starting or running) in one workspace: finishing a task waits until there are none. */
  liveInWorkspace(workspaceId: string): number {
    let n = 0;
    for (const s of this.sessions.values()) if (s.workspaceId === workspaceId) n++;
    return n;
  }

  async create(ownerId: number, raw: unknown): Promise<CreateSessionResult> {
    let request: CreateSessionRequest;
    try {
      request = validateCreateSessionRequest(raw);
    } catch (error) {
      const message = error instanceof ValidationError ? error.message : 'invalid request';
      return { ok: false, error: { code: 'INVALID_REQUEST', message } };
    }
    if (this.sessions.size >= LIMITS.maxSessions) {
      return { ok: false, error: { code: 'LIMIT_REACHED', message: `At most ${LIMITS.maxSessions} sessions can run at once.` } };
    }
    const paneKey = `${ownerId}:${request.paneId}`;
    const busy =
      this.creating.has(paneKey) ||
      [...this.sessions.values()].some((s) => s.ownerId === ownerId && s.paneId === request.paneId && s.status !== 'closing');
    if (busy) return { ok: false, error: { code: 'INVALID_REQUEST', message: 'This pane already has a session.' } };

    this.creating.add(paneKey);
    try {
      const resolved = await this.resolveLaunch(request);
      if (!resolved.ok) return resolved;
      const sessionId = this.idFactory();
      // WSL: a marker every Linux process of this terminal inherits, so agents can be found there.
      const distro = request.profileId.startsWith('wsl:') ? request.profileId.slice(4) : undefined;
      const marker = distro ? newWslMarker() : undefined;
      const env = marker ? withWslMarker(marker, resolved.launch.env) : resolved.launch.env;
      const record: SessionRecord = {
        id: sessionId,
        ownerId,
        workspaceId: request.workspaceId,
        paneId: request.paneId,
        status: 'starting',
        cwd: resolved.launch.cwd,
      };
      this.sessions.set(sessionId, record);
      const spawned = await new Promise<{ ok: true; pid: number; repaintsOnResize: boolean } | { ok: false; message: string }>((resolve) => {
        const timer = setTimeout(() => {
          this.pending.delete(sessionId);
          resolve({ ok: false, message: 'the terminal backend did not respond' });
        }, this.spawnTimeoutMs);
        this.pending.set(sessionId, { resolve, timer });
        this.transport.send({
          type: 'spawn',
          spec: {
            sessionId,
            file: resolved.launch.file,
            args: resolved.launch.args,
            cwd: resolved.launch.cwd,
            ...(env ? { env } : {}),
            cols: request.cols,
            rows: request.rows,
          },
        });
      });
      if (!spawned.ok) {
        this.sessions.delete(sessionId);
        this.transport.send({ type: 'kill', sessionId });
        this.log.warn(`session spawn failed: ${spawned.message}`);
        return { ok: false, error: { code: 'SPAWN_FAILED', message: 'The shell could not be started.', detail: spawned.message } };
      }
      if (record.status === 'closing') {
        // Closed while starting.
        this.transport.send({ type: 'kill', sessionId });
      } else {
        record.status = 'running';
        record.pid = spawned.pid;
        record.wsl = request.profileId.startsWith('wsl:');
        if (distro && marker) Object.assign(record, { distro, marker });
        const cdAt = resolved.launch.args.indexOf('--cd');
        const linuxCwd = distro && cdAt >= 0 ? resolved.launch.args[cdAt + 1] : undefined;
        if (linuxCwd && linuxCwd.startsWith('/')) record.linuxCwd = linuxCwd;
      }
      this.log.info(`session started (${resolved.profileLabel})`);
      return { ok: true, sessionId, cwdLabel: resolved.launch.cwdLabel, profileLabel: resolved.profileLabel, repaintsOnResize: spawned.repaintsOnResize };
    } finally {
      this.creating.delete(paneKey);
    }
  }

  private owned(ownerId: number, sessionId: unknown): SessionRecord | null {
    if (!isId(sessionId)) return null;
    const record = this.sessions.get(sessionId);
    if (!record || record.ownerId !== ownerId) return null;
    return record;
  }

  input(ownerId: number, sessionId: unknown, data: unknown): Result<object> {
    if (typeof data !== 'string' || data.length > LIMITS.maxInputChunk) {
      return { ok: false, error: { code: 'INVALID_REQUEST', message: 'input is invalid' } };
    }
    const record = this.owned(ownerId, sessionId);
    if (!record) return { ok: false, error: forbidden('session not owned by caller') };
    if (record.status !== 'running') return { ok: false, error: { code: 'SESSION_NOT_FOUND', message: 'session is not running' } };
    this.transport.send({ type: 'input', sessionId: record.id, data });
    return { ok: true };
  }

  resize(ownerId: number, sessionId: unknown, cols: unknown, rows: unknown): Result<object> {
    if (!isInt(cols, 2, LIMITS.maxCols) || !isInt(rows, 1, LIMITS.maxRows)) {
      return { ok: false, error: { code: 'INVALID_REQUEST', message: 'size is out of range' } };
    }
    const record = this.owned(ownerId, sessionId);
    if (!record) return { ok: false, error: forbidden('session not owned by caller') };
    if (record.status === 'running') this.transport.send({ type: 'resize', sessionId: record.id, cols, rows });
    return { ok: true };
  }

  ack(ownerId: number, sessionId: unknown, chars: unknown): Result<object> {
    if (!isInt(chars, 0, 64 * 1024 * 1024)) return { ok: false, error: { code: 'INVALID_REQUEST', message: 'ack is invalid' } };
    const record = this.owned(ownerId, sessionId);
    if (!record) return { ok: false, error: forbidden('session not owned by caller') };
    this.transport.send({ type: 'ack', sessionId: record.id, chars });
    return { ok: true };
  }

  close(ownerId: number, sessionId: unknown): Result<object> {
    const record = this.owned(ownerId, sessionId);
    if (!record) return { ok: false, error: forbidden('session not owned by caller') };
    if (record.status === 'closing') return { ok: true };
    const wasStarting = record.status === 'starting';
    record.status = 'closing';
    if (!wasStarting) this.transport.send({ type: 'kill', sessionId: record.id });
    return { ok: true };
  }

  /** Running sessions and their shell process ids (for agent detection). */
  runningProcesses(): SessionProcess[] {
    const out: SessionProcess[] = [];
    for (const s of this.sessions.values()) {
      if (s.status === 'running' && s.pid) {
        out.push({ sessionId: s.id, ownerId: s.ownerId, pid: s.pid, wsl: s.wsl === true, cwd: s.cwd ?? '', ...(s.distro && s.marker ? { distro: s.distro, marker: s.marker } : {}), ...(s.linuxCwd ? { linuxCwd: s.linuxCwd } : {}) });
      }
    }
    return out;
  }

  /** True if this owner has this running session (agent scan requests are checked against it). */
  owns(ownerId: number, sessionId: unknown): boolean {
    return this.owned(ownerId, sessionId)?.status === 'running';
  }

  closeAllForOwner(ownerId: number): void {
    for (const record of this.sessions.values()) if (record.ownerId === ownerId) this.close(ownerId, record.id);
  }

  handleHostEvent(event: HostEvent): void {
    switch (event.type) {
      case 'spawned':
      case 'spawn-failed': {
        const pending = this.pending.get(event.sessionId);
        if (!pending) {
          // Spawn timed out earlier; make sure the late process does not linger.
          if (event.type === 'spawned') this.transport.send({ type: 'kill', sessionId: event.sessionId });
          return;
        }
        clearTimeout(pending.timer);
        this.pending.delete(event.sessionId);
        pending.resolve(event.type === 'spawned' ? { ok: true, pid: event.pid, repaintsOnResize: event.repaintsOnResize } : { ok: false, message: event.message });
        return;
      }
      case 'data': {
        const record = this.sessions.get(event.sessionId);
        if (!record || record.status === 'closing') return;
        if (!this.deliver(record.ownerId, { type: 'data', sessionId: record.id, data: event.data })) {
          this.close(record.ownerId, record.id);
          return;
        }
        this.onOutput(record.workspaceId);
        return;
      }
      case 'resized': {
        const record = this.sessions.get(event.sessionId);
        if (!record || record.status === 'closing') return;
        this.deliver(record.ownerId, { type: 'resized', sessionId: record.id, cols: event.cols, rows: event.rows });
        return;
      }
      case 'exit': {
        const record = this.sessions.get(event.sessionId);
        if (!record) return;
        this.sessions.delete(event.sessionId);
        this.deliver(record.ownerId, { type: 'exit', sessionId: record.id, exitCode: event.exitCode });
        this.log.info(`session exited (code ${event.exitCode ?? 'unknown'})`);
        this.notifyExitWaiters();
        return;
      }
      default:
        return;
    }
  }

  /** The PTY host process stopped: every session it owned has ended. */
  handleHostExit(reason: string): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.resolve({ ok: false, message: reason });
    }
    this.pending.clear();
    for (const record of this.sessions.values()) {
      this.deliver(record.ownerId, { type: 'exit', sessionId: record.id, exitCode: null, reason });
    }
    this.sessions.clear();
    this.notifyExitWaiters();
  }

  private notifyExitWaiters(): void {
    for (const waiter of [...this.exitWaiters]) waiter();
  }

  /** Ends every session and waits (bounded) for the processes to exit. */
  async shutdown(timeoutMs: number): Promise<void> {
    for (const record of this.sessions.values()) record.status = 'closing';
    this.transport.send({ type: 'kill-all' });
    if (this.sessions.size === 0) return;
    await new Promise<void>((resolve) => {
      const done = () => {
        clearTimeout(timer);
        this.exitWaiters.delete(waiter);
        resolve();
      };
      const waiter = () => {
        if (this.sessions.size === 0) done();
      };
      const timer = setTimeout(done, timeoutMs);
      this.exitWaiters.add(waiter);
    });
  }
}
