// Workspace shell counts, from terminal lifecycle states (pure; testable).
import type { SessionStatus } from '../../../shared/types';

/**
 * Running shell sessions: terminals whose session is `running`, including
 * background tabs. Not counted: editor tabs (they have no status), shells
 * not started yet, still starting, failed to start, or exited.
 */
export function countRunningShells(statuses: Iterable<SessionStatus | null | undefined>): number {
  let n = 0;
  for (const s of statuses) if (s === 'running') n++;
  return n;
}

export function shellsRunningLabel(count: number): string {
  return count === 1 ? '1 shell running' : `${count} shells running`;
}
