// Keeps each task's summary (sidebar row, Changes panel header) current, without polling Git.
//
// It runs only when the Git status service has just checked a task's workspace (the user selected
// it, came back to the window, saved a file, or its terminal output settled; see git-status.ts), so
// it follows exactly the same triggers and limits. Summaries have their own queue: one at a time,
// never in Git status's queue, so a slow summary (WSL, a large task) never delays the branch shown
// for other workspaces. A request for a task whose summary is being computed is remembered and
// runs once more afterwards (several requests meanwhile become one).
import type { TaskSummary, WorkspaceTask } from '../shared/tasks';
import type { Workspace } from '../shared/types';

export interface TaskSummaryDeps {
  /** The summary, or null when there is none to show (folder gone, Git failed, a repository filter…). */
  summarize(task: WorkspaceTask): Promise<TaskSummary | null>;
  workspaces(): readonly Workspace[];
  /** Agent tasks and Git status are on. */
  enabled(): boolean;
  publish(workspaceId: string, summary: TaskSummary | null): void;
}

const same = (a: TaskSummary | null | undefined, b: TaskSummary | null) => JSON.stringify(a ?? null) === JSON.stringify(b);

export class TaskSummaries {
  private readonly last = new Map<string, TaskSummary | null>();
  private readonly queue: string[] = [];
  private running: string | null = null;
  private readonly again = new Set<string>();
  private disposed = false;
  /** Summaries computed so far (tests and diagnostics). */
  runs = 0;

  constructor(private readonly deps: TaskSummaryDeps) {}

  /** The Git status of this workspace was just checked: bring its summary up to date (tasks only). */
  request(workspaceId: string): void {
    if (this.disposed || !this.deps.enabled() || !this.taskOf(workspaceId)) return;
    if (this.running === workspaceId) {
      this.again.add(workspaceId);
      return;
    }
    if (this.queue.includes(workspaceId)) return;
    this.queue.push(workspaceId);
    void this.pump();
  }

  /** Every summary computed so far (for the page when it loads). */
  all(): Record<string, TaskSummary> {
    const out: Record<string, TaskSummary> = {};
    for (const [id, s] of this.last) if (s) out[id] = s;
    return out;
  }

  /** The workspace list or the settings changed: forget removed tasks, clear everything when turned off. */
  sync(): void {
    if (this.disposed) return;
    const on = this.deps.enabled();
    for (const id of [...this.last.keys()]) {
      if (on && this.taskOf(id)) continue;
      const had = this.last.get(id);
      this.last.delete(id);
      if (had) this.deps.publish(id, null);
    }
  }

  dispose(): void {
    this.disposed = true;
    this.queue.length = 0;
  }

  private taskOf(workspaceId: string): WorkspaceTask | null {
    return this.deps.workspaces().find((w) => w.id === workspaceId)?.task ?? null;
  }

  private async pump(): Promise<void> {
    if (this.running !== null) return;
    while (this.queue.length > 0 && !this.disposed) {
      const id = this.queue.shift()!;
      const task = this.taskOf(id);
      if (!task || !this.deps.enabled()) continue;
      this.running = id;
      this.runs++;
      const summary = await this.deps.summarize(task).catch(() => null);
      this.running = null;
      // Removed or turned off meanwhile: nothing to show.
      if (this.disposed || !this.taskOf(id) || !this.deps.enabled()) continue;
      if (!same(this.last.get(id), summary)) {
        this.last.set(id, summary);
        this.deps.publish(id, summary);
      }
      if (this.again.delete(id) && !this.queue.includes(id)) this.queue.push(id);
    }
  }
}
