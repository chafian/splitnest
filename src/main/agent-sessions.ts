// Which agent conversation runs in a terminal, so it can be resumed after a restart.
//
// Measured with Claude Code 2.1.322 and Codex 0.166.0 (docs/TESTING.md, "Agent session resume,
// phase 1"):
// - Claude Code keeps `~/.claude/sessions/<pid>.json` while it runs, with the current `sessionId`
//   and `cwd`. The pid is the agent process that process detection finds under the tab's shell,
//   so the session is exact. `/clear` switches to a new id and the file follows, so it is read
//   again on every scan. The file is deleted when Claude exits.
// - Codex records sessions in `~/.codex/sessions/YYYY/MM/DD/rollout-…-<id>.jsonl`, written by its
//   shared app-server, not by the process in the tab. A tab that started `codex resume <id>` has
//   the id in its command line. Otherwise a rollout is matched by folder and time; anything but
//   exactly one match gives no id, and SplitNest offers Codex's own picker instead of guessing.
// - Gemini CLI (from its source, google-gemini/gemini-cli: Storage, ProjectRegistry,
//   ChatRecordingService) writes `~/.gemini/tmp/<project>/chats/session-<time>-<id8>.jsonl` as soon
//   as a session starts; the first line holds `sessionId`, `startTime` and `kind`. `<project>` is
//   the slug that `~/.gemini/projects.json` maps the folder to (`{"projects": {"<lowercased
//   path>": "<slug>"}}`), or, in older versions, the SHA-256 of the folder path. Like Codex: the
//   id from `gemini --resume <id>` in the tab's command line, else exactly one session started
//   after the agent in a project inside the workspace folder, else no id (Resume then runs
//   `gemini --resume`, its most recent conversation there).
//
// Only session metadata is read (Claude: the small live file; Codex and Gemini: the first line of a
// session file, and Gemini's project list). Conversation content is never read, logged or sent anywhere. Both formats are
// undocumented, so every value is validated and anything unexpected means "no id".
import { createHash } from 'node:crypto';
import path from 'node:path';
import type { AgentResume, ResumableAgent } from '../shared/agent-resume';
import { cleanTitle, isResumableAgent, isResumeId } from '../shared/agent-resume';
import type { ProcessInfo } from '../shared/agents';

export interface AgentSessionDeps {
  home: string;
  readText(file: string, maxBytes: number): Promise<string | null>;
  /** Entries of a folder (names only), or [] when it doesn't exist. */
  list(dir: string): Promise<string[]>;
  mtimeMs(file: string): Promise<number | null>;
  now(): number;
}

/** What the tracker knows about one terminal session's agent process. */
interface Tracked {
  agent: ResumableAgent;
  pid: number;
  firstSeen: number;
  folder: string;
  last: AgentResume | null;
}

const LIVE_FILE_MAX = 64 * 1024;
const ROLLOUT_HEAD_MAX = 512 * 1024;
const GEMINI_HEAD_MAX = 64 * 1024;
const PROJECTS_MAX = 1024 * 1024;
/** A Codex rollout must start no earlier than this before the agent was first seen (scan interval slack). */
const CODEX_SLACK_MS = 15_000;

const absolute = (p: unknown): p is string => typeof p === 'string' && p.length > 2 && p.length < 4096 && path.win32.isAbsolute(p) && !/[\0\r\n]/.test(p);

/** Claude Code's live file for `pid`: its current session, or null if absent or unexpected. */
export function parseClaudeLiveFile(text: string, pid: number): { sessionId: string; cwd: string; title: string | null } | null {
  try {
    const d = JSON.parse(text) as Record<string, unknown>;
    if (d.pid !== pid || d.kind !== 'interactive' || !isResumeId(d.sessionId) || !absolute(d.cwd)) return null;
    // Claude's own name for the conversation (`name`); whether it is saved is the page's choice (resumeTitles).
    return { sessionId: d.sessionId, cwd: d.cwd, title: cleanTitle(d.name) };
  } catch {
    return null;
  }
}

/** A Codex rollout's first line (`session_meta`): id, folder and start time. */
export function parseCodexRolloutHead(firstLine: string): { id: string; cwd: string; startedAt: number } | null {
  try {
    const d = JSON.parse(firstLine) as { type?: unknown; payload?: Record<string, unknown> };
    const p = d.payload;
    if (d.type !== 'session_meta' || !p || !isResumeId(p.id) || !absolute(p.cwd) || typeof p.timestamp !== 'string') return null;
    const startedAt = Date.parse(p.timestamp);
    return Number.isFinite(startedAt) ? { id: p.id, cwd: p.cwd, startedAt } : null;
  } catch {
    return null;
  }
}

/** Gemini CLI's project list (`~/.gemini/projects.json`): lowercased folder path -> project slug. */
export function parseGeminiProjects(text: string): { folder: string; slug: string }[] {
  try {
    const d = JSON.parse(text) as { projects?: unknown };
    if (!d.projects || typeof d.projects !== 'object') return [];
    return Object.entries(d.projects as Record<string, unknown>)
      .filter((e): e is [string, string] => absolute(e[0]) && typeof e[1] === 'string' && /^[a-z0-9-]{1,100}$/.test(e[1]))
      .slice(0, 2000)
      .map(([folder, slug]) => ({ folder, slug }));
  } catch {
    return [];
  }
}

/** A Gemini CLI session file's first line: its id and start time (subagent sessions are skipped). */
export function parseGeminiSessionHead(firstLine: string): { id: string; startedAt: number } | null {
  try {
    const d = JSON.parse(firstLine) as Record<string, unknown>;
    if (!isResumeId(d.sessionId) || typeof d.startTime !== 'string' || d.kind === 'subagent') return null;
    const startedAt = Date.parse(d.startTime);
    return Number.isFinite(startedAt) ? { id: d.sessionId, startedAt } : null;
  } catch {
    return null;
  }
}

/** Older Gemini CLI versions named a project's folder after the SHA-256 of its path. */
export const geminiLegacyProjectDir = (folder: string): string => createHash('sha256').update(folder).digest('hex');

/** The session id in an agent's own command line (`claude --resume <id>`, `codex resume <id>`, `gemini --resume <id>`). */
export function resumeIdFromCommandLine(agent: ResumableAgent, cmd: string): string | null {
  const args = cmd.match(/"[^"]*"|\S+/g)?.map((a) => a.replace(/^"|"$/g, '')) ?? [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    const next = args[i + 1];
    if ((agent === 'claude' || agent === 'gemini') && (a === '--resume' || a === '-r') && isResumeId(next)) return next;
    if ((agent === 'claude' || agent === 'gemini') && a.startsWith('--resume=') && isResumeId(a.slice(9))) return a.slice(9);
    if (agent === 'codex' && a === 'resume' && isResumeId(next)) return next;
  }
  return null;
}

/** Inside `folder` (or the folder itself), case-insensitively as on Windows. */
export function withinFolder(child: string, folder: string): boolean {
  const rel = path.win32.relative(folder.toLowerCase(), child.toLowerCase());
  return rel === '' || (!rel.startsWith('..') && !path.win32.isAbsolute(rel));
}

/** The one Codex rollout (or Gemini session) that can belong to this agent: started after it and in its folder. */
export function pickCodexRollout(candidates: readonly { id: string; cwd: string; startedAt: number }[], since: number, folder: string, claimed: ReadonlySet<string>): { id: string; cwd: string } | null {
  const fit = candidates.filter((c) => c.startedAt >= since - CODEX_SLACK_MS && withinFolder(c.cwd, folder) && !claimed.has(c.id));
  return fit.length === 1 ? { id: fit[0]!.id, cwd: fit[0]!.cwd } : null;
}

export class AgentSessionTracker {
  private readonly tracked = new Map<string, Tracked>();

  constructor(private readonly deps: AgentSessionDeps) {}

  /**
   * One scan's result for a terminal session: the agent process process detection found (or
   * none). Returns the session's resume information when it changed, `undefined` otherwise.
   */
  async update(sessionId: string, folder: string, agent: { id: string; process: ProcessInfo } | null): Promise<AgentResume | null | undefined> {
    const prev = this.tracked.get(sessionId);
    if (!agent || !isResumableAgent(agent.id)) {
      if (!prev) return undefined;
      this.tracked.delete(sessionId);
      return prev.last ? null : undefined; // the agent exited: nothing to resume
    }
    let t = prev;
    if (!t || t.pid !== agent.process.pid || t.agent !== agent.id) {
      t = { agent: agent.id, pid: agent.process.pid, firstSeen: this.deps.now(), folder, last: null };
      this.tracked.set(sessionId, t);
    }
    const next = await this.resolve(t, agent.process.cmd);
    const changed = !sameResume(t.last, next);
    t.last = next;
    return changed ? next : undefined;
  }

  forget(sessionId: string): void {
    this.tracked.delete(sessionId);
  }

  private async resolve(t: Tracked, cmd: string): Promise<AgentResume> {
    const at = this.deps.now();
    if (t.agent === 'claude') {
      const text = await this.deps.readText(path.join(this.deps.home, '.claude', 'sessions', `${t.pid}.json`), LIVE_FILE_MAX);
      const live = text ? parseClaudeLiveFile(text, t.pid) : null;
      if (live) return { agent: 'claude', sessionId: live.sessionId, cwd: live.cwd, exact: true, at, ...(live.title ? { title: live.title } : {}) };
      const fromCmd = resumeIdFromCommandLine('claude', cmd);
      // Keep an id already known: the live file can be briefly missing while Claude rewrites it.
      if (t.last?.sessionId) return { ...t.last, at };
      return { agent: 'claude', sessionId: fromCmd, cwd: t.folder, exact: fromCmd !== null, at };
    }
    const agent = t.agent;
    const fromCmd = resumeIdFromCommandLine(agent, cmd);
    if (fromCmd) return { agent, sessionId: fromCmd, cwd: t.last?.cwd ?? t.folder, exact: true, at };
    if (t.last?.sessionId) return { ...t.last, at };
    const claimed = new Set([...this.tracked.values()].filter((o) => o !== t && o.last?.sessionId).map((o) => o.last!.sessionId!));
    const since = t.firstSeen - CODEX_SLACK_MS;
    const candidates = agent === 'codex' ? await this.codexRollouts(since) : await this.geminiSessions(since, t.folder);
    const match = pickCodexRollout(candidates, t.firstSeen, t.folder, claimed);
    return match ? { agent, sessionId: match.id, cwd: match.cwd, exact: false, at } : { agent, sessionId: null, cwd: t.folder, exact: false, at };
  }

  /** First lines of Gemini CLI sessions written since `since`, in projects inside `folder`. */
  private async geminiSessions(since: number, folder: string): Promise<{ id: string; cwd: string; startedAt: number }[]> {
    const root = path.join(this.deps.home, '.gemini');
    // Project folder name under tmp/ -> the project's folder (in the workspace's own spelling).
    const projects = new Map<string, string>();
    const registry = await this.deps.readText(path.join(root, 'projects.json'), PROJECTS_MAX);
    for (const p of registry ? parseGeminiProjects(registry) : []) {
      if (!withinFolder(p.folder, folder)) continue;
      // The registry keeps paths lowercased; reuse the workspace folder's spelling for its part.
      projects.set(p.slug, p.folder.length >= folder.length ? folder + p.folder.slice(folder.length) : folder);
    }
    projects.set(geminiLegacyProjectDir(folder), folder);
    const out: { id: string; cwd: string; startedAt: number }[] = [];
    for (const [dirName, cwd] of [...projects].slice(0, 50)) {
      const dir = path.join(root, 'tmp', dirName, 'chats');
      for (const name of (await this.deps.list(dir)).filter((n) => /^session-[\w-]+\.jsonl$/.test(n)).slice(-500)) {
        const file = path.join(dir, name);
        const m = await this.deps.mtimeMs(file);
        if (m === null || m < since) continue;
        const head = await this.deps.readText(file, GEMINI_HEAD_MAX);
        const meta = head ? parseGeminiSessionHead(head.split('\n', 1)[0]!) : null;
        if (meta) out.push({ ...meta, cwd });
      }
    }
    return out;
  }

  /** First lines of Codex rollouts written since `since` (today's and yesterday's folders only). */
  private async codexRollouts(since: number): Promise<{ id: string; cwd: string; startedAt: number }[]> {
    const root = path.join(this.deps.home, '.codex', 'sessions');
    const out: { id: string; cwd: string; startedAt: number }[] = [];
    const days = new Set([since, this.deps.now()].map((t) => new Date(t)).map((d) => [d.getFullYear(), String(d.getMonth() + 1).padStart(2, '0'), String(d.getDate()).padStart(2, '0')].join(path.sep)));
    for (const day of days) {
      const dir = path.join(root, day);
      for (const name of (await this.deps.list(dir)).filter((n) => /^rollout-[\w-]+\.jsonl$/.test(n)).slice(0, 500)) {
        const file = path.join(dir, name);
        const m = await this.deps.mtimeMs(file);
        if (m === null || m < since) continue;
        const head = await this.deps.readText(file, ROLLOUT_HEAD_MAX);
        const meta = head ? parseCodexRolloutHead(head.split('\n', 1)[0]!) : null;
        if (meta) out.push(meta);
      }
    }
    return out;
  }
}

function sameResume(a: AgentResume | null, b: AgentResume | null): boolean {
  if (!a || !b) return a === b;
  return a.agent === b.agent && a.sessionId === b.sessionId && a.cwd === b.cwd && a.exact === b.exact && (a.title ?? null) === (b.title ?? null);
}
