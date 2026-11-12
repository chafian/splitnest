// Starting restored terminals, one at a time or all together, without ever
// creating two sessions for the same terminal.
//
// Restoring a layout never starts anything. "Start" always creates a *new*
// shell with the tab's selected profile in its saved working directory; old
// processes are not resumed and no commands are replayed.
import type { SessionStatus } from '../../../shared/types';

export type StartOutcome = 'running' | 'failed' | 'skipped';

/**
 * Joins concurrent start requests: while one start is in flight, every other
 * caller (a second click, "Start all", Ctrl+Shift+R) gets the same promise
 * instead of starting another process.
 */
export class StartGate {
  private inflight: Promise<StartOutcome> | null = null;

  get busy(): boolean {
    return this.inflight !== null;
  }

  run(task: () => Promise<StartOutcome>): Promise<StartOutcome> {
    if (this.inflight) return this.inflight;
    const promise = task()
      .catch((): StartOutcome => 'failed')
      .finally(() => {
        if (this.inflight === promise) this.inflight = null;
      });
    this.inflight = promise;
    return promise;
  }
}

/** The view of one terminal that bulk start and the restore notice need. */
export interface RestoredTerminal {
  tabId: string;
  label: string;
  status: SessionStatus;
  /** True once a session in this terminal has ever reached "running". */
  hasStarted: boolean;
  errorMessage: string | null;
}

export interface RestoreSummary {
  /** Not started yet: "Start all shells" applies to these. */
  pending: RestoredTerminal[];
  starting: RestoredTerminal[];
  /** Tried and failed without ever running; each gets a Retry action. */
  failed: RestoredTerminal[];
  /** Notice is shown only while something is still pending, starting or failed. */
  visible: boolean;
}

/**
 * Summarises the restored (not newly created) terminals of one workspace.
 * Terminals that are running, or that ran and later exited, are no longer
 * "restored" and are left alone.
 */
export function summarizeRestore(terminals: RestoredTerminal[]): RestoreSummary {
  const pending = terminals.filter((t) => t.status === 'idle');
  const starting = terminals.filter((t) => t.status === 'starting' && !t.hasStarted);
  const failed = terminals.filter((t) => t.status === 'failed' && !t.hasStarted);
  return { pending, starting, failed, visible: pending.length + starting.length + failed.length > 0 };
}

export interface BulkStartTarget {
  tabId: string;
  /** Current status, read at the moment the target's turn comes. */
  status(): SessionStatus;
  /** Starts (or joins an in-flight start of) this terminal. */
  start(): Promise<StartOutcome>;
}

export interface BulkStartResult {
  started: string[];
  failed: string[];
  skipped: string[];
}

/**
 * Starts every target that is still idle, at most `concurrency` at a time.
 * A failure never stops the others or undoes sessions that already started.
 * Terminals that became live in the meantime (started individually) are
 * skipped; one already starting is joined, not duplicated.
 */
export async function startAll(
  targets: BulkStartTarget[],
  options: { concurrency?: number; onSettled?(tabId: string, outcome: StartOutcome): void } = {},
): Promise<BulkStartResult> {
  const result: BulkStartResult = { started: [], failed: [], skipped: [] };
  const queue = [...targets];
  const worker = async () => {
    for (let target = queue.shift(); target; target = queue.shift()) {
      const status = target.status();
      const outcome: StartOutcome = status === 'idle' || status === 'starting' ? await target.start() : 'skipped';
      (outcome === 'running' ? result.started : outcome === 'failed' ? result.failed : result.skipped).push(target.tabId);
      options.onSettled?.(target.tabId, outcome);
    }
  };
  const workers = Math.max(1, Math.min(options.concurrency ?? 3, queue.length));
  await Promise.all(Array.from({ length: workers }, worker));
  return result;
}

/** Guards "Start all shells" against repeated clicks per workspace. */
export class BulkStartTracker {
  private readonly running = new Set<string>();

  isRunning(workspaceId: string): boolean {
    return this.running.has(workspaceId);
  }

  /** Runs `job` unless one is already running for this workspace (then returns null). */
  async run<T>(workspaceId: string, job: () => Promise<T>): Promise<T | null> {
    if (this.running.has(workspaceId)) return null;
    this.running.add(workspaceId);
    try {
      return await job();
    } finally {
      this.running.delete(workspaceId);
    }
  }
}
