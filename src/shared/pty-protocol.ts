// Messages between the main process and the PTY host utility process.

export interface SpawnSpec {
  sessionId: string;
  file: string;
  args: string[];
  cwd: string;
  /** Extra variables for this session; `WSLENV` is appended to the inherited value. */
  env?: Record<string, string>;
  cols: number;
  rows: number;
}

export type HostRequest =
  | { type: 'spawn'; spec: SpawnSpec }
  | { type: 'input'; sessionId: string; data: string }
  | { type: 'resize'; sessionId: string; cols: number; rows: number }
  | { type: 'ack'; sessionId: string; chars: number }
  | { type: 'kill'; sessionId: string }
  | { type: 'kill-all' };

export type HostEvent =
  | { type: 'ready' }
  | { type: 'spawned'; sessionId: string; pid: number; repaintsOnResize: boolean }
  | { type: 'spawn-failed'; sessionId: string; message: string }
  | { type: 'data'; sessionId: string; data: string }
  /**
   * The PTY now has this size. Sent after every 'data' event that holds output read before the
   * resize, so the renderer can apply the size at the same point in the output stream.
   */
  | { type: 'resized'; sessionId: string; cols: number; rows: number }
  | { type: 'exit'; sessionId: string; exitCode: number | null }
  | { type: 'log'; level: 'info' | 'warn' | 'error'; message: string };

export const FLOW = {
  /** Pause the PTY when this many characters are sent but not yet rendered. */
  highWatermark: 512 * 1024,
  /** Resume once the renderer has caught up below this level. */
  lowWatermark: 128 * 1024,
  /** Coalesce output for this long before sending a batch. */
  batchMs: 4,
  /** Send immediately once a batch reaches this size. */
  maxBatchChars: 64 * 1024,
} as const;
